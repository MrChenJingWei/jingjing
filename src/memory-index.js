/**
 * 记忆的可选增强：用本地 embedding 找「说法不同、意思相近」的记忆，给它们连 similar 边。
 *
 * - 只走 Ollama（settings.memory.embedding = { enabled, model }），默认关；
 * - 批处理还没向量化的记忆，向量存在 memory_vectors，换模型可以重算；
 * - 相似度超过阈值就连边，边会进入已有的「联想」召回，不需要在查询时再算 embedding；
 * - 不跟别的域连（memory.linkMemories 会按域过滤）。
 */
import { db, getSettings, now } from './db.js';
import * as memory from './memory.js';
import { embed } from './llm.js';

const MAX_EXISTING = 3000;

export function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function encode(vector) {
  const data = new DataView(new ArrayBuffer(vector.length * 4));
  for (let i = 0; i < vector.length; i += 1) data.setFloat32(i * 4, Number(vector[i]) || 0, true);
  return new Uint8Array(data.buffer);
}

function decode(blob) {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(Math.floor(bytes.byteLength / 4));
  for (let i = 0; i < out.length; i += 1) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/**
 * 索引一批还没有向量的记忆，并按相似度连边。
 * embedFn 可注入（测试用）；默认走 Ollama。返回 { indexed, linked, skipped }。
 */
export async function indexSimilarMemories({ embedFn = null, limit = 20, threshold = 0.72, maxEdges = 3 } = {}) {
  const settings = getSettings();
  const cfg = settings.memory?.embedding || {};
  if (!cfg.enabled || !cfg.model) return { indexed: 0, linked: 0, skipped: 'disabled' };

  // 没向量、或者换了模型：都重新算；旧模型的向量不参与比较。
  const rows = db.prepare(`
    SELECT m.id, m.text, m.domain FROM memories m
    LEFT JOIN memory_vectors v ON v.memory_id = m.id
    WHERE (v.memory_id IS NULL OR v.model <> ?) AND COALESCE(m.archived, 0) = 0 AND m.layer <> 'working'
    ORDER BY m.created_at DESC LIMIT ?
  `).all(cfg.model, limit);
  if (!rows.length) return { indexed: 0, linked: 0, skipped: 'nothing' };

  const vectors = await (embedFn || ((texts) => embed(texts, { settings })))(rows.map((row) => row.text));
  if (!Array.isArray(vectors) || vectors.length !== rows.length) return { indexed: 0, linked: 0, skipped: 'no-embedding' };

  const existing = db.prepare(`
    SELECT v.memory_id, v.vector, m.domain FROM memory_vectors v JOIN memories m ON m.id = v.memory_id
    WHERE COALESCE(m.archived, 0) = 0 AND v.model = ? LIMIT ?
  `).all(cfg.model, MAX_EXISTING).map((row) => ({ id: row.memory_id, domain: row.domain, vector: decode(row.vector) }));

  const put = db.prepare('INSERT OR REPLACE INTO memory_vectors(memory_id, model, dim, vector, updated_at) VALUES(?,?,?,?,?)');
  const stamp = now();
  let linked = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const vector = vectors[i];
    if (!Array.isArray(vector) || !vector.length) continue;
    put.run(row.id, cfg.model, vector.length, encode(vector), stamp);

    const scored = [];
    for (const other of existing) {
      if (other.id === row.id || other.domain !== row.domain) continue;
      const score = cosine(vector, other.vector);
      if (score >= threshold) scored.push({ id: other.id, score });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const hit of scored.slice(0, maxEdges)) {
      const weight = Math.min(1.2, 0.5 + (hit.score - threshold) * 2);
      if (memory.linkMemories(row.id, [hit.id], 'similar', weight)) linked += 1;
    }
    existing.push({ id: row.id, domain: row.domain, vector });
  }
  return { indexed: rows.length, linked, model: cfg.model };
}
