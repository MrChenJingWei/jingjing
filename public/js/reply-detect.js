// 一轮做完的结果，收尾是不是在等主人回话：问了问题、给了可选的下一步、留了要主人定的事。
// 只在 Worker 没给结论（outcome）时用来推断；不依赖别的模块，服务端测试也能直接引用。

// 在等主人回话的说法：主动提出下一步、请主人定 / 选 / 确认。
const OFFER = new RegExp([
  '需要我', '要不要', '要我(?:帮|去|把|先|再|继续|接着|直接)',
  '是否(?:需要|要|继续|同意|可以|按)',
  '说一声', '告诉我(?:你|要|选|怎么|哪)',
  '请(?:你)?(?:确认|决定|选择|拍板|定一下|定夺)',
  '你(?:来)?(?:定|决定|确认|拍板|选)',
  '等你(?:确认|决定|拍板|回复|定)',
  '待(?:你|主人)(?:确认|决定|拍板)',
  '定下来', '选哪', '(?:哪个|哪种|哪一个|哪套)(?:方案|做法|更|好)',
  '下一步.{0,12}(?:怎么|要|是否|还是)'
].join('|'));

// 客套收尾，不算在等回话：「有问题随时告诉我」「如有需要再说」。
const POLITE = /随时|有(?:任何|其他)?问题|如有(?:其他)?(?:问题|需要|疑问)|还有什么/;

/** 只看收尾：去掉代码块和 Markdown 记号，取最后两段，拆成句子。 */
function closingSentences(text) {
  const plain = String(text || '')
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/[*_`>#]/g, '');
  const paragraphs = plain.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paragraphs.slice(-2).join('\n')
    .split(/(?<=[。！？!?；;])|\n/)
    .map((s) => s.trim().replace(/^[-•\d.、)\s]+/, ''))
    .filter(Boolean)
    .slice(-6);
}

/**
 * 收尾在等主人回话时，返回那一句（列表上显示它）；否则返回空字符串。
 * 从最后一句往前找：问句（？ / 吗）、或者主动提出下一步、请主人定的说法；客套话不算。
 */
export function awaitingReply(text) {
  const sentences = closingSentences(text);
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const sentence = sentences[i];
    if (POLITE.test(sentence)) continue;
    if (/[?？]|吗[。.!！]?$/.test(sentence) || OFFER.test(sentence)) return sentence.slice(0, 160);
  }
  return '';
}

export function endsWithQuestion(text) {
  return Boolean(awaitingReply(text));
}
