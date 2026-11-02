/**
 * Compression: one finished stretch of experience becomes one memory package
 *.
 *
 * The call happens OUTSIDE any write transaction: build the prompt, await the
 * model, validate the result, and only then hand a complete draft to the store.
 * That keeps SQLite free of network waits (see store/db.mjs).
 *
 * Two guards are enforced here:
 * - finish_reason 'length' means the output was cut; a truncated memory is
 * rejected instead of being stored as if complete.
 * - the output budget must be generous, because reasoning tokens are spent
 * before any visible text appears.
 */
import { estimateTokens } from '../tokens.mjs';

export const COMPRESS_PROMPT_VERSION = 'life-compress-v2';

/**
 * Kinds that mark where a stretch ended, not what happened in it. A merged segment can
 * span one of these (see segments.mjs), and rendering it would ask the model to write
 * about its own state changes as if they were events.
 */
export const BOUNDARY_KINDS = Object.freeze(['state']);

export const DEFAULT_COMPRESS_RULES = Object.freeze({
 // 12, not 40: for example a three-line stretch ("lights off / noted / bag still by
 // the door") was rejected as too short under the old rule.
 // Short and honest beats padded.
  minChars: 12,
  maxChars: 2000,
  targetChars: 160,
 // Reasoning tokens dominate the output, so the observed maximum is far below this cap.
 // The cap is deliberately generous: output is billed on actual usage, so headroom costs
 // nothing, while a truncated answer costs the whole stretch.
  maxOutputTokens: 32_768,
  maxInputChars: 60_000,
});

export const COMPRESS_SYSTEM = [
  '你在替助手整理记忆。',
  '把下面这一段刚过去的时间，用第一人称写成一段回忆，就像助手自己在心里回想这件事。',
  '规则：',
  '1. 只写这一段里真实发生过的内容，不补充、不推测、不美化。',
  '2. 第一人称，用助手自己的口吻，像随口想起，不像写报告。',
  '3. 长度 100–200 字，不要标题，不要分点，不要解释你在做什么。',
  '4. 写不出来就写得短一些，不要为了凑字数编内容。',
  '5. 每行开头标了是谁：「助手」是助手自己，「对方」是别人，「动作」是助手做过的事（不是助手说的话）。不要改变是谁说的、谁做的。',
  '6. 标着「助手心里（没说出口）」的行是助手想过、但没说出来也没做出来的：照实写成没说出来，不要写成助手说了、做了，也不要写成对方知道。',
].join('\n');

export class LifeCompressError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifeCompressError';
    this.code = code;
  }
}

function requireRules(overrides) {
  const rules = { ...DEFAULT_COMPRESS_RULES, ...(overrides ?? {}) };
  for (const key of ['minChars', 'maxChars', 'targetChars', 'maxOutputTokens', 'maxInputChars']) {
    if (!Number.isInteger(rules[key]) || rules[key] <= 0) throw new LifeCompressError('invalid_rule', key);
  }
  if (rules.minChars >= rules.maxChars) throw new LifeCompressError('invalid_rule', 'minChars >= maxChars');
  return rules;
}

/**
 * 「没说出口的」。
 *
 * 助手的心里话在库里是 kind='thought' 的行——想过、没发出去、对方不知道。
 * 压进回忆时如果和普通对话混在一起，就成了"助手说过"，那是把没发生的事写成发生过。
 * 所以渲染时就标明：这一行是心里的，不是嘴上的。
 */
export const UNSPOKEN_MARK = '助手心里（没说出口）';

function renderEventLine(event) {
  const time = typeof event.at === 'string' ? event.at : '';
  if (event.kind === 'thought') return '[' + time + '] ' + UNSPOKEN_MARK + '：' + event.text;
 // 工具调用是助手**做过的事**，不是助手说的话：标成「动作」，
 // 否则压缩时会写成"助手说助手用了 room_look"，把动作变成一句台词。
 // 'assistant' 就是助手自己说的那一侧；别的角色名一律按“不是助手”处理。
// 以前这里会把角色名原样写进标签，压缩出来的句子就成了第三人称的英文标签。
  const who = event.role === 'assistant' ? '助手'
    : event.role === 'user' ? '对方'
      : event.role === 'tool' ? '动作'
        : event.role;
  return '[' + time + '] ' + who + '：' + event.text;
}

export function buildCompressMessages(segment, events, options = {}) {
  if (segment === null || typeof segment !== 'object') throw new LifeCompressError('invalid_segment');
  if (!Array.isArray(events) || events.length === 0) throw new LifeCompressError('empty_segment');
  const rules = requireRules(options.rules);

  const content = events.filter((event) => !BOUNDARY_KINDS.includes(event.kind));
  if (content.length === 0) throw new LifeCompressError('empty_segment');
  const body = content.map(renderEventLine).join('\n');
  if (body.length > rules.maxInputChars) {
    throw new LifeCompressError('segment_too_long', body.length + ' > ' + rules.maxInputChars);
  }
  const header = [
    '这一段的时间：' + segment.startAt + ' → ' + segment.endAt,
    '共 ' + content.length + ' 条记录。',
  ].join('\n');

  return {
    messages: [
      { role: 'system', content: COMPRESS_SYSTEM },
      { role: 'user', content: header + '\n\n' + body },
    ],
    promptChars: body.length,
  };
}

/**
 * Compresses one finished segment. Never writes; returns a draft the caller commits.
 * @returns {Promise<{text:string, chars:number, usage:object|null, finishReason:string|null, elapsedMs:number, promptChars:number, promptVersion:string}>}
 */
export async function compressSegment(input) {
  if (input === null || typeof input !== 'object') throw new LifeCompressError('invalid_input');
  const { summarise, segment, events, rules: overrides, signal } = input;
 // The stretch is summarised by whatever house this runs in: the core knows there is
 // exactly one call to make, not which provider answers it.
  if (typeof summarise !== 'function') {
    throw new LifeCompressError('missing_summarise');
  }
  const rules = requireRules(overrides);
  const built = buildCompressMessages(segment, events, { rules });

  let result;
  try {
    result = await summarise({ messages: built.messages, maxTokens: rules.maxOutputTokens, signal });
  } catch (error) {
    throw new LifeCompressError('compress_call_failed', error?.code ?? 'unknown');
  }

  if (result.finishReason === 'length') throw new LifeCompressError('compressed_output_truncated');
  const text = (result.text ?? '').trim();
  if (text === '') throw new LifeCompressError('compressed_output_empty');
  if (text.length < rules.minChars) throw new LifeCompressError('compressed_output_too_short', String(text.length));
  if (text.length > rules.maxChars) throw new LifeCompressError('compressed_output_too_long', String(text.length));

  return {
    text,
    chars: text.length,
    tokens: estimateTokens(text),
    usage: result.usage ?? null,
    finishReason: result.finishReason ?? null,
    elapsedMs: result.elapsedMs ?? 0,
    promptChars: built.promptChars,
    promptVersion: COMPRESS_PROMPT_VERSION,
    model: result.model ?? null,
  };
}
/* ------------------------------------------------------------------------- *
 * Addressed compression
 *
 * The reason: a package that carries only its text can be found
 * when the question repeats a detail, but not when it points at *when* or
 * *which occurrence*. The address fields are useless unless the compressor
 * actually produces them, so this prompt asks for them in the same call that
 * writes the memory - no second pass, no separate extraction model.
 *
 * The plain-text prompt stays the default: a JSON contract that the model does
 * not follow would lose the memory entirely, so the caller opts in.
 * ------------------------------------------------------------------------- */

/**
 * Final version: the manner prohibition PLUS the per-sentence self-check, kept after
 * comparing variants on the same segments:
 *   without a manner rule     - often invented an action
 *   with rule + self-check    - rarely invented anything
 *   with rule, without check  - sometimes invented a feeling or guess
 * The check is worth its cost because compression runs while the agent sleeps: the extra
 * seconds never reach a conversation, and the thing it buys is not using words that
 * nobody said.
 */
// v9：一次调用里再要一个 importance（1–5）。
// 为什么要助手标而不是宿主算：轻重是助手的判断，不是事情的大小；宿主按规则算出来的只会是
// "提到谁/隔多久"这种代理指标。代价是同一个字段多几行提示词，调用次数不变。
export const COMPRESS_ADDRESS_PROMPT_VERSION = 'life-compress-address-v10';

/**
 * Phrases that describe the record instead of the day. Real run, : asked to
 * compress a single-line stretch the model wrote "记录里就这一行，别的什么都没留下" -
 * an instruction alone did not stop it, so the output is refused by name and the stretch
 * stays pending instead of becoming a memory that says nothing.
 */
export const META_NARRATION = Object.freeze([
  '记录里', '记录中', '这段记录', '这段话', '材料里', '上面说', '就这一行', '什么都没留下',
 // Real run : "就这三个字，没有别的" got past the first list.
  '就这三个字', '就这两句', '没有别的', '别的都', '只留下这一句',
]);

export const COMPRESS_ADDRESS_SYSTEM = [
  '你在替助手整理记忆。这一段刚过去的时间，要写成一条可以以后被找到的回忆。',
  '只输出一个 JSON 对象，不要代码块，不要解释。字段：',
  'memory：第一人称的一段回忆，60–160 字。给的材料少就写得短，不要为了凑字数补内容。',
  'occurred_at：这件事发生的时间，ISO 8601，带时区偏移。用记录里的时间，不要用现在的时间。',
  'subjects：2–4 个短词，每个 2–8 个字，用助手会说的词，不要用整句。',
  '  第 1 个必须是"这件事是关于谁/什么的"（例如：体检、妈妈、房东、猫、快递）。',
  '  后面的才写具体细节（例如：抽血、叮嘱、房租）。不知道是谁/什么的时候，宁可少写，不要跳过。',
  'ordinal：如果这是同一件事的第几次（例如第三次体检），填那个整数；判断不出就填 null。',
  'importance：1–5 的整数，这条回忆对你有多重——按你自己的感受标，不按事情大小。',
  '  5 = 会反复想起来、牵动你的；4 = 你会在意的；3 = 普通的一天；2 = 顺手一带；1 = 过眼就忘的小事。',
  '  必须真的区分：这一段里如果有你在意的事、还没解决的事、对方在意的事，就别写成 3；',
  '  整段都写 3 等于没标。分不出来的时候再写 3，但那是例外，不是默认。',
  '规则：',
  '1. 每行开头标了是谁：「助手」是助手自己，「对方」是别人，「动作」是助手做过的事（不是助手说的话）。不要改变是谁说的、谁做的。',
  '2. occurred_at 必须落在给定时间段内。',
  '3. subjects 里不要写「事情」「东西」「当时」这类空词。',
  '4. **只写「谁做了什么、谁说了什么」。不写「怎么做的、做得怎样」**——不写「别过头去」「摸黑」「撑着」「挨过去」「硬着头皮」这类方式或程度，也不写「过了几分钟」「没再放在外面」这种没有依据的细节。',
  '   写完后逐句自查：这句话里的每个动作，记录里有吗？没有就删掉。',
  '5. **直接写成回忆，不要描述记录本身**：不出现「记录里」「这段话」「上面说」「对方先说」这类说法，也不要把时间戳原样报出来。',
  '6. 拿不准的就略过，不要用「好像」「大概」含糊过去。',
  '7. 写不出来就写短一些，短比编好。',
  '8. **材料只有一两句话时，就照实写那一两句，不要评论它有多短**：不写「就短短一句」「没有说别的」「我看到的时候」「也就这几句」这类话。那些是记录的样子，不是助手经历的事。',
  '9. importance 必须是 1 到 5 的整数，不许小数、不许省略。',
  '10. 标着「助手心里（没说出口）」的行，是助手想过但没说出来、对方也不知道的：照实写成没说出来（例如「我没说，只在心里想」），不要写成助手说了、做了，也不要写成对方知道。',
].join('\n');

export function buildAddressMessages(segment, events, options = {}) {
  if (segment === null || typeof segment !== 'object') throw new LifeCompressError('invalid_segment');
  if (!Array.isArray(events) || events.length === 0) throw new LifeCompressError('empty_segment');
  const rules = requireRules(options.rules);
  const content = events.filter((event) => !BOUNDARY_KINDS.includes(event.kind));
  if (content.length === 0) throw new LifeCompressError('empty_segment');
  const body = content.map(renderEventLine).join('\n');
  if (body.length > rules.maxInputChars) {
    throw new LifeCompressError('segment_too_long', body.length + ' > ' + rules.maxInputChars);
  }
  const header = [
    '这一段的时间：' + segment.startAt + ' → ' + segment.endAt,
    '共 ' + content.length + ' 条记录。',
  ].join('\n');
  return {
    messages: [
      { role: 'system', content: COMPRESS_ADDRESS_SYSTEM },
      { role: 'user', content: header + '\n\n' + body },
    ],
    promptChars: body.length,
  };
}

function stripFence(content) {
  const text = content.trim();
  if (!text.startsWith('```')) return text;
  return text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
}

/**
 * Validates the addressed answer. Every failure is a code, never a silent default:
 * a memory that says "well, I don't know when this was" is worse than a retryable error.
 */
export function parseAddressOutput(content, rules = DEFAULT_COMPRESS_RULES) {
  const raw = stripFence(typeof content === 'string' ? content : '');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LifeCompressError('address_output_not_json');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LifeCompressError('address_output_not_object');
  }
  const text = typeof parsed.memory === 'string' ? parsed.memory.trim() : '';
  if (text === '') throw new LifeCompressError('compressed_output_empty');
  if (text.length < rules.minChars) throw new LifeCompressError('compressed_output_too_short', String(text.length));
  if (text.length > rules.maxChars) throw new LifeCompressError('compressed_output_too_long', String(text.length));
  for (const phrase of META_NARRATION) {
    if (text.includes(phrase)) throw new LifeCompressError('meta_narration', phrase);
  }

  const occurredRaw = parsed.occurred_at;
  if (typeof occurredRaw !== 'string' || occurredRaw.trim() === '') throw new LifeCompressError('address_missing_occurred_at');
  const occurredMs = Date.parse(occurredRaw);
  if (!Number.isFinite(occurredMs)) throw new LifeCompressError('address_invalid_occurred_at', occurredRaw);

  if (!Array.isArray(parsed.subjects) || parsed.subjects.length === 0) throw new LifeCompressError('address_missing_subjects');
  const subjects = [];
  for (const subject of parsed.subjects) {
    if (typeof subject !== 'string') throw new LifeCompressError('address_invalid_subject');
    const trimmed = subject.trim();
    if (trimmed === '' || trimmed.length > 12) throw new LifeCompressError('address_invalid_subject_length', trimmed);
    if (!subjects.includes(trimmed)) subjects.push(trimmed);
    if (subjects.length >= 6) break;
  }

  let ordinal = null;
  if (parsed.ordinal !== undefined && parsed.ordinal !== null) {
    ordinal = Number(parsed.ordinal);
    if (!Number.isInteger(ordinal) || ordinal < 1) throw new LifeCompressError('address_invalid_ordinal', String(parsed.ordinal));
  }

 // 轻重是助手自己标的（v9）。没写这一格不当成"助手说了算"：用中间值 3（= 普通），
 // 但写歪了（6、2.5、"很重"）要报错——那是模型没照要求答，不是助手给了一个轻的。
  let importance = 3;
  if (parsed.importance !== undefined && parsed.importance !== null) {
 // true/false 会被 Number 变成 1/0，那不是"助手标了一个 1"，是没照格式答。
    if (typeof parsed.importance === 'boolean') throw new LifeCompressError('address_invalid_importance', String(parsed.importance));
    const raw = Number(parsed.importance);
    if (!Number.isInteger(raw) || raw < 1 || raw > 5) throw new LifeCompressError('address_invalid_importance', String(parsed.importance));
    importance = raw;
  }

  return { text, occurredAt: new Date(occurredMs).toISOString(), subjects, ordinal, importance };
}

export async function compressSegmentAddressed(input) {
  if (input === null || typeof input !== 'object') throw new LifeCompressError('invalid_input');
  const { summarise, segment, events, rules: overrides, signal } = input;
  if (typeof summarise !== 'function') {
    throw new LifeCompressError('missing_summarise');
  }
  const rules = requireRules(overrides);
  const built = buildAddressMessages(segment, events, { rules });
  let result;
  try {
    result = await summarise({ messages: built.messages, maxTokens: rules.maxOutputTokens, signal });
  } catch (error) {
    throw new LifeCompressError('compress_call_failed', error?.code ?? 'unknown');
  }
  if (result.finishReason === 'length') throw new LifeCompressError('compressed_output_truncated');
  const address = parseAddressOutput(result.text, rules);
  return {
    ...address,
    chars: address.text.length,
    tokens: estimateTokens(address.text),
    usage: result.usage ?? null,
    finishReason: result.finishReason ?? null,
    elapsedMs: result.elapsedMs ?? 0,
    promptChars: built.promptChars,
    promptVersion: COMPRESS_ADDRESS_PROMPT_VERSION,
    model: result.model ?? null,
  };
}
