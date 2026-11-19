// 「怎么写插件」：看随静静一起安装的插件文档（和当前版本一致、离线可看），
// 翻官方例子的源码，或者拿一份模板复制成「我的」插件。
import { $, state, changed, esc, md, toast, api, copyText } from './core.js';
import { icon, openDialog } from './ui.js';

const TITLE = { source: '怎么写任务来源插件', worker: '怎么写 Worker 插件' };
const EXAMPLE_LABEL = { source: '官方插件', worker: '内置 Worker' };

/** 文档里的标题（跳过代码块），和 md(levels) 生成的 id 一一对应。 */
function headingsOf(markdown) {
  const out = [];
  let inCode = false;
  for (const line of String(markdown).split('\n')) {
    if (line.trim().startsWith('```')) { inCode = !inCode; continue; }
    if (inCode) continue;
    const match = line.match(/^(#{1,4})\s+(.*)$/);
    if (match) out.push({ level: match[1].length, text: match[2].replace(/[`*]/g, '') });
  }
  return out;
}

function docView(data) {
  const all = headingsOf(data.markdown).map((h, index) => ({ ...h, index }));
  // 目录取总标题之下最高的那一级：来源插件文档是 ##，Worker 插件那一半是 ###。
  const top = Math.min(...all.filter((h) => h.level > 1).map((h) => h.level));
  const toc = all.filter((h) => h.level === top);
  return `
    ${toc.length ? `<nav class="pdocs-toc" aria-label="目录">${toc.map((h) => `<button type="button" class="fchip" data-pdocs-jump="pd-${h.index}">${esc(h.text)}</button>`).join('')}</nav>` : ''}
    <div class="pdocs-body prose">${md(data.markdown, { levels: true, idPrefix: 'pd' })}</div>`;
}

function filesView(kind, example, files) {
  return `
    <div class="pdocs-files-head">
      <button type="button" class="btn sm ghost" data-pdocs-back>${icon('chevronLeft', 'sm')}回到说明</button>
      <b>${esc(example?.name || '')}</b><span class="note">${esc(example?.description || '')}</span>
    </div>
    ${files.map((file) => `
      <div class="draft-file">
        <b>${esc(file.name)}</b><small>${file.size} 字节</small>
        ${file.content === null
          ? '<p class="note">文件太大（多半是打包好的产物），这里不展示。</p>'
          : `<pre>${esc(file.content)}</pre>`}
      </div>`).join('') || '<p class="note">这个例子没有可展示的文件。</p>'}`;
}

export async function openPluginDocs(kind = 'source') {
  let data;
  try {
    data = await api(`/api/plugin-docs/${kind}`);
  } catch (err) {
    toast(err.message);
    return;
  }
  const examples = data.examples || [];
  openDialog({
    title: TITLE[kind] || TITLE.source,
    desc: '这份说明随静静一起安装，和你现在用的版本一致，没网也能看。',
    wide: true,
    readonly: true,
    body: `
      <div class="pdocs" data-pdocs-kind="${esc(kind)}">
        <div class="pdocs-actions">
          <button type="button" class="btn sm primary" data-pdocs-template="${esc(kind)}">${icon('plus', 'sm')}拿一份模板</button>
          ${examples.length ? `
            <select data-pdocs-example="${esc(kind)}" aria-label="看例子">
              <option value="">看看${EXAMPLE_LABEL[kind]}怎么写的…</option>
              ${examples.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}
            </select>` : ''}
        </div>
        <div class="pdocs-made" hidden></div>
        <div class="pdocs-main">${docView(data)}</div>
      </div>`
  });
  const root = $('#dialog-body .pdocs');
  const main = root.querySelector('.pdocs-main');
  const scroller = () => main.closest('#dialog-body') || main;

  root.addEventListener('click', async (event) => {
    const jump = event.target.closest('[data-pdocs-jump]');
    if (jump) {
      main.querySelector(`#${CSS.escape(jump.dataset.pdocsJump)}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    if (event.target.closest('[data-pdocs-back]')) {
      main.innerHTML = docView(data);
      const select = root.querySelector('[data-pdocs-example]');
      if (select) select.value = '';
      scroller().scrollTop = 0;
      return;
    }
    const template = event.target.closest('[data-pdocs-template]');
    if (template) {
      await makeTemplate(kind, root, template);
      return;
    }
    const reveal = event.target.closest('[data-pdocs-reveal]');
    if (reveal) {
      try { await api('/api/plugin-docs/reveal', { method: 'POST', body: { id: reveal.dataset.pdocsReveal } }); } catch (err) { toast(err.message); }
      return;
    }
    const copy = event.target.closest('[data-pdocs-copy]');
    if (copy) copyText(copy.dataset.pdocsCopy, '路径已复制。');
  });

  root.querySelector('[data-pdocs-example]')?.addEventListener('change', async (event) => {
    const id = event.target.value;
    if (!id) { main.innerHTML = docView(data); return; }
    try {
      const { files } = await api(`/api/plugin-docs/${kind}/examples/${encodeURIComponent(id)}`);
      main.innerHTML = filesView(kind, examples.find((item) => item.id === id), files);
      scroller().scrollTop = 0;
    } catch (err) {
      toast(err.message);
    }
  });
}

async function makeTemplate(kind, root, button) {
  button.disabled = true;
  try {
    const made = await api(`/api/plugin-docs/${kind}/template`, { method: 'POST' });
    if (made.plugins) state.plugins = made.plugins;
    if (made.workers) state.workers = made.workers;
    state.pluginErrors = made.errors || state.pluginErrors;
    changed('plugins', 'workers');
    const box = root.querySelector('.pdocs-made');
    box.hidden = false;
    box.innerHTML = `
      <div>${icon('check', 'sm')}已复制成「我的」插件 <code>${esc(made.id)}</code>，默认停用：</div>
      <div class="pdocs-path"><code>${esc(made.dir)}</code></div>
      <div class="pdocs-made-actions">
        ${made.canReveal ? `<button type="button" class="btn xs" data-pdocs-reveal="${esc(made.id)}">${esc(made.revealLabel || '在 Finder 中打开')}</button>` : ''}
        <button type="button" class="btn xs ghost" data-pdocs-copy="${esc(made.dir)}">复制路径</button>
      </div>
      <p class="note">改好 <code>plugin.json</code> 和 <code>index.js</code> 后，在「设置 → 任务来源」点「重新加载」${kind === 'worker' ? '（Worker 插件也一起加载），再去「设置 → Worker」' : '，在列表里'}填配置、点测试。</p>`;
    box.scrollIntoView({ block: 'nearest' });
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-plugin-docs]');
  if (button) openPluginDocs(button.dataset.pluginDocs);
});
