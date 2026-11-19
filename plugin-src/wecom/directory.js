/**
 * 企业微信通讯录：按 userid 查成员的姓名、部门、职位。
 * 用企业的 corpid + 一个能读通讯录的应用 Secret（自建应用，可见范围要包含这些成员）。
 * 智能机器人的长连接凭证查不了通讯录，所以单独配。
 */
const API = 'https://qyapi.weixin.qq.com/cgi-bin';
// 一个凭证一个 access_token，提前 5 分钟换新的。
const tokens = new Map();

export function directoryConfigured(config) {
  return Boolean(String(config.corpId || '').trim() && String(config.contactSecret || '').trim());
}

const HINTS = {
  40001: 'Secret 不对',
  40013: 'corpid 不对',
  60011: '这个应用没有通讯录权限（可见范围不包含对方）',
  60020: '主机 IP 不在企业可信 IP 里：到应用详情 →「企业可信 IP」加上这台机器的出口 IP'
};

function apiError(data, what) {
  const hint = HINTS[data.errcode];
  return new Error(`企业微信${what}失败：${data.errcode} ${data.errmsg || ''}${hint ? `（${hint}）` : ''}`.trim());
}

async function getJson(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`企业微信接口 HTTP ${res.status}`);
  return res.json();
}

async function accessToken(config, signal, { fresh = false } = {}) {
  const corpId = String(config.corpId).trim();
  const secret = String(config.contactSecret).trim();
  const key = `${corpId}\n${secret}`;
  const cached = tokens.get(key);
  if (!fresh && cached && cached.expiresAt > Date.now()) return cached.token;
  const data = await getJson(`${API}/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`, signal);
  if (data.errcode) throw apiError(data, '取 access_token');
  tokens.set(key, { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in || 7200) - 300) * 1000 });
  return data.access_token;
}

/** 调一次接口；token 过期（40014 / 42001）换新的再试一次。 */
async function call(config, signal, pathAndQuery) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await accessToken(config, signal, { fresh: attempt > 0 });
    const data = await getJson(`${API}/${pathAndQuery}&access_token=${encodeURIComponent(token)}`, signal);
    if (data.errcode === 40014 || data.errcode === 42001) continue;
    return data;
  }
  throw new Error('企业微信 access_token 一直无效');
}

/** 测试连接用：能不能拿到 token。 */
export async function checkDirectory(config, signal) {
  await accessToken(config, signal, { fresh: true });
}

/**
 * 查一批 userid：返回 [{ id, name, title, department, alias }]，查不到（不存在、没权限看）的跳过。
 * 凭证错、IP 不可信这类整体性错误直接抛出。
 */
export async function lookupMembers(config, userIds, { signal, log = () => {} } = {}) {
  if (!directoryConfigured(config)) return [];
  const departments = new Map();
  const departmentName = async (id) => {
    if (!departments.has(id)) {
      const data = await call(config, signal, `department/get?id=${encodeURIComponent(id)}`).catch(() => null);
      departments.set(id, data && !data.errcode ? String(data.department?.name || '') : '');
    }
    return departments.get(id);
  };
  const out = [];
  for (const userId of userIds) {
    const data = await call(config, signal, `user/get?userid=${encodeURIComponent(userId)}`);
    if (data.errcode) {
      // 成员不存在 / 不在可见范围：跳过这一个；其他错误（凭证、IP）整批都会失败，直接抛。
      if ([60111, 60011, 60123, 46004].includes(data.errcode)) {
        log(`通讯录里查不到 ${userId}（${data.errcode}）`);
        continue;
      }
      throw apiError(data, '查成员');
    }
    const main = data.main_department ?? (Array.isArray(data.department) ? data.department[0] : null);
    out.push({
      id: userId,
      name: String(data.name || '').trim(),
      title: String(data.position || '').trim(),
      department: main !== null && main !== undefined ? await departmentName(main) : '',
      alias: String(data.alias || '').trim()
    });
  }
  return out;
}
