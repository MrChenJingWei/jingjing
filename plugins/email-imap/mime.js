/** 只依赖 Node 内置能力的 MIME 解析：够读邮件正文，不追求完整 RFC 实现。 */

export function decodeWords(input) {
  return String(input || '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (all, charset, encoding, text) => {
    try {
      let buffer;
      if (encoding.toUpperCase() === 'B') {
        buffer = Buffer.from(text.replace(/\s+/g, ''), 'base64');
      } else {
        const bytes = [];
        for (let i = 0; i < text.length; i++) {
          if (text[i] === '_') { bytes.push(0x20); continue; }
          if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
            bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
            i += 2;
          } else {
            bytes.push(text.charCodeAt(i) & 0xff);
          }
        }
        buffer = Buffer.from(bytes);
      }
      return new TextDecoder(charset || 'utf-8').decode(buffer);
    } catch {
      return all;
    }
  });
}

export function parseHeaders(headerText) {
  const out = {};
  let key = null;
  for (const line of String(headerText || '').split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && key) {
      out[key] += ' ' + line.trim();
      continue;
    }
    const index = line.indexOf(':');
    if (index <= 0) continue;
    key = line.slice(0, index).trim().toLowerCase();
    out[key] = line.slice(index + 1).trim();
  }
  return out;
}

export function parseContentType(value) {
  const [type, ...rest] = String(value || 'text/plain').split(';');
  const params = {};
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    params[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim().replace(/^"|"$/g, '');
  }
  return { type: type.trim().toLowerCase(), params };
}

function decodeTransfer(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (enc === 'base64') {
    return Buffer.from(buffer.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  }
  if (enc === 'quoted-printable') {
    const text = buffer.toString('latin1').replace(/=\r?\n/g, '');
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
        bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(text.charCodeAt(i) & 0xff);
      }
    }
    return Buffer.from(bytes);
  }
  return buffer;
}

function decodeCharset(buffer, charset) {
  try {
    return new TextDecoder(charset || 'utf-8').decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractBody(buffer, headers, depth = 0) {
  const contentType = parseContentType(headers['content-type']);
  if (contentType.type.startsWith('multipart/') && contentType.params.boundary && depth < 3) {
    const raw = buffer.toString('latin1');
    const marker = `--${contentType.params.boundary}`;
    const chunks = raw.split(marker).slice(1, -1);
    let html = '';
    for (const chunk of chunks) {
      const trimmed = chunk.replace(/^\r?\n/, '');
      const split = trimmed.search(/\r?\n\r?\n/);
      if (split < 0) continue;
      const headerText = trimmed.slice(0, split);
      const bodyText = trimmed.slice(split).replace(/^\r?\n\r?\n/, '');
      const partHeaders = parseHeaders(headerText);
      const partType = parseContentType(partHeaders['content-type']);
      if (partType.type === 'text/plain') {
        const text = decodeCharset(decodeTransfer(Buffer.from(bodyText, 'latin1'), partHeaders['content-transfer-encoding']), partType.params.charset);
        if (text.trim()) return text.trim();
      }
      if (partType.type === 'text/html' && !html) {
        html = decodeCharset(decodeTransfer(Buffer.from(bodyText, 'latin1'), partHeaders['content-transfer-encoding']), partType.params.charset);
      }
      if (partType.type.startsWith('multipart/')) {
        const nested = extractBody(Buffer.from(bodyText, 'latin1'), partHeaders, depth + 1);
        if (nested.trim()) return nested.trim();
      }
    }
    return html ? htmlToText(html) : '';
  }

  const text = decodeCharset(decodeTransfer(buffer, headers['content-transfer-encoding']), contentType.params.charset);
  if (contentType.type === 'text/html') return htmlToText(text);
  return text.trim();
}

export function parseMessage(buffer) {
  const raw = buffer.toString('latin1');
  const split = raw.search(/\r?\n\r?\n/);
  const headerText = split >= 0 ? raw.slice(0, split) : raw;
  const bodyText = split >= 0 ? raw.slice(split).replace(/^\r?\n\r?\n/, '') : '';
  const headers = parseHeaders(headerText);
  const body = Buffer.from(bodyText, 'latin1');
  const text = extractBody(body, headers);
  const messageId = (headers['message-id'] || '').replace(/[<>]/g, '').trim();
  return {
    from: decodeWords(headers.from || ''),
    to: decodeWords(headers.to || ''),
    subject: decodeWords(headers.subject || '(无主题)'),
    date: headers.date || '',
    messageId,
    text: text.replace(/\r\n/g, '\n').slice(0, 12000)
  };
}
