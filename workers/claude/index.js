// 内置 Worker：Claude Code。调用本机 claude CLI 的非交互模式，用 stream-json 实时回传进度。
import crypto from 'node:crypto';
import { createLineParser, describeEvent } from './stream.js';

const USAGE_LIMIT = /hit your .{0,20}limit|usage limit|rate limit|limit (?:reached|exceeded)|resets \d/i;

export function detect(config, { settings, which }) {
  const bin = which('claude');
  const available = Boolean(bin) && settings.claude?.enabled !== false;
  return { available, detail: available ? bin : '未安装或已禁用' };
}

function withGuide(prompt, ctx) {
  return ctx.approvalGuide ? `${prompt}\n\n${ctx.approvalGuide}` : prompt;
}

function promptFor(task, ctx) {
  if (ctx.recovery) {
    return '（静静：服务重启打断了你上一次的执行。请先检查已经完成的部分，然后从中断的地方继续完成原来的任务。）';
  }
  const resume = ctx.resume;
  if (!resume) {
    // 主人在上一轮结果之后接着说：会话还在就只发这句话，Claude 记得前面做过什么；会话没了 task.prompt 里已经拼好了前几轮。
    if (ctx.followup?.text && ctx.sessionId) {
      return withGuide(`${ctx.followup.text}\n\n（静静：这是主人看完你上一轮的结果后接着说的，请在这个会话的基础上继续，已经做完的部分不要从头重做。）`, ctx);
    }
    return withGuide(task.prompt, ctx);
  }
  if (resume.answer) {
    return `${task.prompt}\n\n对「${resume.question}」，用户没有选给出的选项，而是这样决定：${resume.answer}\n请按用户的决定继续完成。`;
  }
  const picked = resume.choice >= 0 ? resume.options?.[resume.choice] ?? String(resume.choice) : '取消';
  return `${task.prompt}\n\n用户刚刚对「${resume.question}」选择了：${picked}。请在此基础上继续完成。`;
}

async function runOnce(bin, task, ctx, { resumeId, prompt }) {
  // 新会话预先指定 session id 并存为断点：服务重启后可以 --resume 接着跑，而不是从头再来。
  const sessionId = resumeId || crypto.randomUUID();
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  if (resumeId) args.push('--resume', resumeId);
  else args.push('--session-id', sessionId);
  // 静静明确允许改文件的任务（比如在插件草稿目录里写插件）才自动接受编辑；其他任务交给用户自己的权限配置。
  if (ctx.options?.allowEdits) args.push('--permission-mode', 'acceptEdits');
  await ctx.checkpoint({ sessionId });

  let final = null;
  let current = sessionId;
  const parser = createLineParser((event) => {
    if (event.type === 'system' && event.subtype === 'init' && event.session_id && event.session_id !== current) {
      current = event.session_id;
      ctx.checkpoint({ sessionId: current }).catch(() => {});
    }
    if (event.type === 'result') final = event;
    const text = describeEvent(event);
    if (text) ctx.emit(text);
  });
  // 工具权限交给 Claude Code 自身的用户配置和 macOS 账户权限，静静不覆盖。
  const result = await ctx.exec(bin, args, { cwd: ctx.workspace, onOutput: (chunk) => parser.push(chunk) });
  parser.flush();
  return { result, final, sessionId: final?.session_id || current };
}

export async function execute(task, ctx) {
  const bin = ctx.which('claude');
  if (!bin || ctx.settings.claude?.enabled === false) {
    return { status: 'failed', retryable: false, summary: '没有找到 claude 命令，或在设置里禁用了 Claude Code。' };
  }

  await ctx.emit('Claude Code 启动中…');
  let run = await runOnce(bin, task, ctx, { resumeId: ctx.sessionId, prompt: promptFor(task, ctx) });
  if (run.result.error === 'aborted') return { status: 'cancelled', summary: '任务已停止。' };

  // 断点里的会话还没真正建立（比如刚启动就被打断）：换一个新会话从头执行。
  const output = `${run.result.stderr}\n${run.result.stdout}`;
  if (!run.final && ctx.sessionId && /No conversation found|session.*not found/i.test(output)) {
    await ctx.emit('之前的会话不存在，重新开始执行…');
    run = await runOnce(bin, task, { ...ctx, recovery: null }, { resumeId: null, prompt: withGuide(task.prompt, ctx) });
    if (run.result.error === 'aborted') return { status: 'cancelled', summary: '任务已停止。' };
  }

  const { final, sessionId } = run;
  if (!final) {
    const tail = (run.result.stderr || run.result.stdout || '').slice(-800);
    return { status: 'failed', summary: `Claude Code 没有返回结果（退出码 ${run.result.code}）。\n${tail}` };
  }
  const text = String(final.result || '').trim();
  const cost = Number(final.total_cost_usd) || 0;
  const tokens = ctx.estimateTokens(text);
  if (final.is_error || (final.subtype && final.subtype !== 'success')) {
    // 用量到上限时 subtype 仍是 success，只有 is_error 和结果文字能看出来；马上重试也没用。
    if (USAGE_LIMIT.test(text)) {
      return { status: 'failed', retryable: false, summary: `Claude Code 的用量到上限了，等额度恢复后再试。\n${text.slice(-300)}`, sessionId, cost, tokens };
    }
    const kind = final.subtype && final.subtype !== 'success' ? `（${final.subtype}）` : '';
    return { status: 'failed', summary: `Claude Code 执行出错${kind}。\n${text.slice(-800)}`, sessionId, cost, tokens };
  }
  const approval = ctx.parseApproval(text);
  if (approval) {
    return { status: 'needs_approval', summary: approval.text, approval: approval.approval, sessionId, tokens, cost };
  }
  return { status: 'done', summary: text || 'Claude Code 没有输出文字结果。', sessionId, tokens, cost };
}
