// node --test 的报告器：失败的测试打成 GitHub Actions 的错误注解（::error），在提交和 PR 页面上直接看到
// 哪条挂了、为什么，不用翻日志。和默认的 spec 报告器一起用，见 .github/workflows/test.yml。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const data = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const prop = (text) => data(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

function relative(file) {
  const full = String(file).startsWith('file:') ? fileURLToPath(file) : String(file);
  return path.relative(process.cwd(), full).split(path.sep).join('/');
}

export default async function* annotations(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const { name, file, line, details } = event.data;
    const error = details?.error;
    // 父测试只是因为子测试失败才失败，子测试自己会报。
    if (error?.failureType === 'subtestsFailed') continue;
    const cause = error?.cause ?? error;
    const message = String(cause?.stack || cause?.message || cause || '失败').slice(0, 3000);
    const where = file ? `,file=${prop(relative(file))}${line ? `,line=${line}` : ''}` : '';
    yield `::error title=${prop(name)}${where}::${data(message)}\n`;
  }
}
