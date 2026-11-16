import crypto from 'node:crypto';

function hash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 32);
}

function textOf(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }
  return String(value);
}

function firstText(...values) {
  for (const value of values) {
    const text = textOf(value).trim();
    if (text) return text;
  }
  return '';
}

function eventName(headers, payload) {
  return firstText(
    headers['x-github-event'],
    headers['x-event-type'],
    headers['x-webhook-event'],
    headers['x-event'],
    payload.type,
    payload.event,
    payload.action,
    'webhook'
  );
}

export async function test() {
  return { ok: true, detail: '等待外部 POST；把插件卡片里的地址配置到服务端' };
}

// 纯推送来源不需要轮询；保留 poll 以满足插件接口。
export async function poll() {
  return { items: [] };
}

/**
 * 把一个外部 webhook payload 转成一条通用条目。
 * 这里只做数据整形，不建任务、不决定要不要执行。
 */
export async function webhook(payload, ctx = {}) {
  if (!payload || typeof payload !== 'object') payload = { text: textOf(payload) };
  const headers = ctx.headers || {};
  const event = eventName(headers, payload);
  const repo = firstText(payload.repository?.full_name, payload.repo, payload.project);
  const issue = payload.issue || payload.pull_request || payload.object_attributes;
  const action = firstText(payload.action, payload.status);

  let title = firstText(
    payload.title,
    payload.subject,
    payload.name,
    issue?.title,
    issue?.name,
    payload.message
  );
  if (!title) {
    title = [event, action, repo].filter(Boolean).join(' · ') || '外部 Webhook 消息';
  }
  if (repo && !title.includes(repo)) title = `[${repo}] ${title}`;

  const content = firstText(
    payload.message,
    payload.body,
    payload.text,
    payload.content,
    payload.description,
    payload
  ).slice(0, 3000);

  const url = firstText(
    payload.url,
    payload.link,
    payload.html_url,
    issue?.html_url,
    payload.repository?.html_url
  );

  let occurredAt = null;
  const rawTime = firstText(payload.occurredAt, payload.timestamp, payload.created_at, payload.date);
  if (rawTime) {
    const date = new Date(rawTime);
    if (!Number.isNaN(date.getTime())) occurredAt = date.toISOString();
  }

  const externalId = firstText(
    headers['x-github-delivery'],
    headers['x-request-id'],
    payload.delivery,
    payload.id,
    payload.event_id,
    payload.uuid
  ) || hash(JSON.stringify(payload));

  const groupKey = repo && issue?.number ? `${repo}#${issue.number}` : '';
  return {
    items: [
      {
        externalId,
        kind: 'note',
        eventType: event,
        groupKey,
        title: title.slice(0, 120),
        content,
        url,
        occurredAt,
        meta: { event, action, repo }
      }
    ]
  };
}
