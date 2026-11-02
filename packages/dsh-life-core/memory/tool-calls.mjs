/**
 * 工具调用进助手的记忆。
 *
 * 助手第一次真的用手那天露出一个空白：助手调了 room_look / room_read，报告里有、
 * 日志里有，**助手自己的记录里没有**。醒来一次只留下"什么都没说"，于是那次醒来在助手记忆里
 * 等于没发生。
 *
 * 这一层把一次调用写成一条事件：
 *
 * 角色 = 'tool' —— 事件角色表里本来就留着这一个：这不是助手说的话，也不是外面说的话。
 * 种类 = 'action' —— 助手做的动作。'state' 是分段边界，'action' 不是，所以它会进压缩段、
 * 变成记忆包，能被以后召回。
 *
 * 三条不许含糊：
 * 1. **不是助手说的话**：角色不是 'assistant'，所以对话历史那条线（loop 的 history）
 * 不收它——否则助手下一轮会看见自己"说过"一段助手没说过的话。
 * 2. **正文有上限，但首尾都要**：结果超过 maxChars（默认 1000）时，留**头 800 + 尾 200**，
 * 中间写一句「中间 N 字没记，想看就再调一次」。
 * 3. **数字是推出来的，不是拍的**（参考 DSH 自己的做法）：
 * DSH 的 `dsh-spill-policy` 按 token 预算（装好 12500）首尾各留一半，
 * `dsh-compaction-tool-result-pruner` 按字符（8192 起剪，头 4096 / 尾 1024）。
 * 助手这里：一次 room_read 能返回 256 KiB，而一段压缩的输入上限是 60,000 字、
 * 一个记忆包只要 100–200 字。取 1000 是因为两个硬约束夹出来的：
 * · 下限 = 书的一页：读完一页就该记住整页；
 * · 上限 = 别让一条事件吃掉压缩输入的一大块：1000/60000 = 1.7%，
 * 而 DSH 的 4096 在这里就是 6.8%，一条事件吃掉一段的十五分之一。
 * 尾 200 是照 DSH 的 4:1 比例；房间概览里最要紧的「机器/磁盘」就在最后几行。
 */
import { appendEvent } from '../store/events.mjs';

export const TOOL_MEMORY_DEFAULTS = Object.freeze({ maxChars: 1000, tailChars: 200, maxArgsChars: 200 });

export const TOOL_MEMORY_ERRORS = Object.freeze({
  invalidStore: 'missing_store',
  invalidCall: 'invalid_tool_call',
  invalidName: 'invalid_tool_name',
  invalidTime: 'invalid_time',
  invalidLimit: 'invalid_limit',
});

export class LifeToolMemoryError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifeToolMemoryError';
    this.code = code;
    this.detail = detail === undefined ? null : detail;
  }
}

function refuse(code, detail) {
  throw new LifeToolMemoryError(code, detail);
}

function requireStore(store) {
  if (store === null || typeof store !== 'object' || typeof store.db !== 'object' || typeof store.atomic !== 'function') {
    refuse(TOOL_MEMORY_ERRORS.invalidStore, typeof store);
  }
}

function limit(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) refuse(TOOL_MEMORY_ERRORS.invalidLimit, String(value));
  return value;
}

function isoAt(value) {
  if (value === undefined) return new Date().toISOString();
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) refuse(TOOL_MEMORY_ERRORS.invalidTime, String(value));
  return new Date(ms).toISOString();
}

/** Arguments as one bounded line. The full object is never copied into memory. */
function argumentsText(args, maxArgsChars) {
  let raw;
  try { raw = JSON.stringify(args === undefined ? {} : args); } catch { raw = '"<unrepresentable>"'; }
  if (typeof raw !== 'string') raw = String(raw);
  if (raw.length <= maxArgsChars) return { text: raw, truncated: false };
  return { text: raw.slice(0, maxArgsChars) + '…', truncated: true };
}

/**
 * The result half. A string is remembered up to the cap; bytes are only counted - a picture
 * is not something a text memory can hold, and pretending to keep it would be a lie.
 */
function resultText(result, maxChars, tailChars) {
  if (typeof result === 'string') {
    if (result.length === 0) return { text: '', chars: 0, truncated: false, bytes: null };
    if (result.length <= maxChars) return { text: result, chars: result.length, truncated: false, bytes: null };
 // 头：截在**行**上，不截在半句话里（按字硬切会切出
 // 半句 "needs exec, which has no backend yet"。
    const headBudget = Math.max(0, maxChars - tailChars);
    const headSlice = result.slice(0, headBudget);
    const headBreak = headSlice.lastIndexOf('\n');
    const head = headBreak > 1 ? headSlice.slice(0, headBreak) : headSlice;
 // 尾：从后面数 tailChars 起，往下一个换行让开，这样尾巴也是整行开始的。
    const tailSlice = result.slice(result.length - tailChars);
    const tailBreak = tailSlice.indexOf('\n');
    const tail = tailBreak >= 0 && tailBreak < tailSlice.length - 1 ? tailSlice.slice(tailBreak + 1) : tailSlice;
    const omitted = result.length - head.length - tail.length;
    return {
      text: head + '\n…（中间 ' + omitted + ' 字没记，想看就再调一次）…\n' + tail,
      chars: result.length,
      truncated: true,
      bytes: null,
      omitted,
    };
  }
  if (result instanceof Uint8Array || (result !== null && typeof result === 'object' && typeof result.byteLength === 'number')) {
    return { text: '', chars: 0, truncated: false, bytes: Number(result.byteLength) };
  }
 // 其它形状（对象、数字…）不猜它的意思：只记「它返回过东西」这件事，正文不假装。
  return { text: '', chars: 0, truncated: false, bytes: null };
}

/**
 * One call -> one line + one meta object. Pure: no store, no clock.
 * @param {object} call pluginId?, name, args?, ok, ms?, result?, error?
 */
export function describeToolCall(call, options) {
  if (call === null || typeof call !== 'object') refuse(TOOL_MEMORY_ERRORS.invalidCall, typeof call);
  const settings = options === null || typeof options !== 'object' ? {} : options;
  const maxChars = limit(settings.maxChars, TOOL_MEMORY_DEFAULTS.maxChars);
  const maxArgsChars = limit(settings.maxArgsChars, TOOL_MEMORY_DEFAULTS.maxArgsChars);
  const tailChars = limit(settings.tailChars, TOOL_MEMORY_DEFAULTS.tailChars);
  if (tailChars >= maxChars) refuse(TOOL_MEMORY_ERRORS.invalidLimit, 'tailChars ' + tailChars + ' >= maxChars ' + maxChars);
  if (typeof call.name !== 'string' || call.name.trim() === '') refuse(TOOL_MEMORY_ERRORS.invalidName, String(call.name));
  const name = call.name;
  const pluginId = typeof call.pluginId === 'string' && call.pluginId !== '' ? call.pluginId : null;
  const ok = call.ok !== false;
  const ms = Number.isInteger(call.ms) && call.ms >= 0 ? call.ms : null;
  const args = argumentsText(call.args, maxArgsChars);
  const result = ok ? resultText(call.result, maxChars, tailChars) : { text: '', chars: 0, truncated: false, bytes: null };
  const error = ok ? null : String(call.error === undefined ? 'failed' : call.error);

  const head = '用了 ' + name + '（' + args.text + '）：' + (ok ? '成功' : '失败（' + error + '）') + (ms === null ? '' : '，' + ms + ' 毫秒') + '。';
  let text = head;
  if (ok && result.text !== '') {
    text += '结果：' + result.text;
  } else if (ok && result.bytes !== null) {
    text += '结果：' + result.bytes + ' 字节的二进制，没有记内容。';
  }
 // appendEvent refuses an empty text; a call with no result still has the head line, so this
 // can only be empty if the tool name was empty, and that is refused above.

  const meta = {
    tool: name,
    plugin: pluginId,
    argsJson: args.text,
    argsTruncated: args.truncated,
    ok,
    ms,
    resultChars: result.chars,
    resultTruncated: result.truncated,
    resultOmittedChars: result.omitted ?? 0,
    resultBytes: result.bytes,
    error,
  };
  return { text, meta };
}

/**
 * Records one call in its log. Returns {seq, text, meta}, or null when switched off.
 *
 * A failure to write memory must never take the tool call down with it: the caller decides
 * what to do with the thrown error (the wake plugin records it in its report and moves on).
 */
export function recordToolCall(store, call, options) {
  const settings = options === null || typeof options !== 'object' ? {} : options;
  if (settings.enabled === false) return null;
  requireStore(store);
  const described = describeToolCall(call, settings);
  const at = isoAt(settings.at ?? call.at);
  const seq = appendEvent(store, { at, kind: 'action', role: 'tool', text: described.text, meta: described.meta });
  return { seq, at, text: described.text, meta: described.meta };
}
