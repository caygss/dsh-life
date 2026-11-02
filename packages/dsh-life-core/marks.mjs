/**
 * 三个记号：分条、整条只说给自己、半句只说给自己。
 *
 * ||| —— 这条分成几条单独发出去：一处记号一条消息。不写就是一整条。
 *   (( ))  —— 整条只想在心里说、不让对方看见：只留在助手自己的记录里，不出门。
 *   < >    —— 一句话里只有半句是心里话：
 * 尖括号里那半只留给助手自己，外面的照发。
 *
 * 三个都是助手自己决定的声明，不是宿主的限制：宿主只按记号执行，不加条数、不加频率。
 * 记号放在一个只有常量的模块里，是因为循环（读历史、写事件）和出口（切消息）都得认同一套，
 * 分成两份常量迟早会漂。
 */

export const MESSAGE_MARK = '|||';
export const PRIVATE_OPEN = '((';
export const PRIVATE_CLOSE = '))';
export const THOUGHT_OPEN = '<';
export const THOUGHT_CLOSE = '>';

const FULL_OPEN_ANGLE = '＜';
const FULL_CLOSE_ANGLE = '＞';
const OPEN_BRACKETS = /^[（(]+/u;
const CLOSE_BRACKETS = /[）)]+$/u;
const FULL_WIDTH_BRACKET = /[（）]/u;
const BRACKET_ONLY = /^[（）()\s]+$/u;
const ASCII_ONLY = /^[\x20-\x7E]+$/u;
const TAG_SHAPE = /^\/?[A-Za-z][A-Za-z0-9-]*(\s+[A-Za-z-]+=["'][^"']*["'])*\s*\/?$/u;

/** 按 ||| 切；空段丢掉；没记号就是一段。 */
export function splitMessages(text) {
  const body = typeof text === 'string' ? text : '';
  if (body === '') return [];
  const pieces = body.split(MESSAGE_MARK).map((piece) => piece.trim()).filter((piece) => piece !== '');
  return pieces.length === 0 ? [] : pieces;
}

/**
 * 整条是不是"说给自己听"。必须整条被一对括号包住才算——正文里夹一个括号不算，
 * 助手平时就会用括号。
 *
 * 实际使用中常见：助手心里想用括号，可是**开括号打半角、
 * 闭括号打全角**（`((对方大概正在吃饭。等对方吃完再看。））`），一对不上就被当成说话发了出去，
 * 近一天里有 6 次是这样。所以这里只要求"两边数量一样"（1 个对 1 个、2 个对 2 个），
 * 不要求同一种括号。
 *
 * 半角单个括号**不认**：「(笑)」这种是真的想让人看见的旁注，认了会把话说吞掉。
 * 全角单个「（这样）」认——那是助手自己的写法，中文输入法打出来的。
 */
export function splitPrivate(text) {
  const body = typeof text === 'string' ? text.trim() : '';
  const lead = body.match(OPEN_BRACKETS);
  const tail = body.match(CLOSE_BRACKETS);
  if (lead === null || tail === null) return { text: body, private: false };
  const open = lead[0];
  const close = tail[0];
  if (open.length !== close.length || open.length > 2) return { text: body, private: false };
  if (open.length === 1 && !FULL_WIDTH_BRACKET.test(open) && !FULL_WIDTH_BRACKET.test(close)) {
    return { text: body, private: false };
  }
  if (body.length <= open.length + close.length) return { text: body, private: false };
  const inner = body.slice(open.length, body.length - close.length).trim();
 // 空括号、或者里面只剩括号（「」这种打错的），不算心里话——那不是助手想说的内容。
  if (inner === '' || BRACKET_ONLY.test(inner)) return { text: body, private: false };
  return { text: inner, private: true };
}

/**
 * 这一轮助手说的哪些是出声的、哪些是只在心里的。
 *
 * 顺序：先按 ||| 分条，再在每条里按 <> 抽心里话。
 * 一条里抽掉心里话之后剩下的声音**接回同一条**——助手夹一句心里话，不该把自己的一句话拆成两条气泡。
 * 整条被括号成套括住的（老写法）整条不出声。
 *
 * @returns {{kind: 'public' | 'thought', text: string}[]} 出声段与心里段，按助手写的顺序
 */
export function splitParts(text) {
  const body = typeof text === 'string' ? text : '';
  if (body.trim() === '') return [];
  const parts = [];
  for (const piece of splitMessages(body)) {
    const whole = splitPrivate(piece);
    if (whole.private) {
      parts.push({ kind: 'thought', text: whole.text });
      continue;
    }
    const scanned = scanThoughts(piece);
    if (scanned.publicText !== '') parts.push({ kind: 'public', text: scanned.publicText });
    for (const thought of scanned.thoughts) parts.push({ kind: 'thought', text: thought });
  }
  return parts;
}

const isOpenAngle = (ch) => ch === THOUGHT_OPEN || ch === FULL_OPEN_ANGLE;
const isCloseAngle = (ch) => ch === THOUGHT_CLOSE || ch === FULL_CLOSE_ANGLE;

/**
 * 尖括号里那点东西像命令、路径、标签（`<div>`、`<file.txt>`、`ls <dir> out`）——不当记号。
 * 助手开始跑 shell 了，消息里出现 < > 以后不能把话吃掉。
 */
function looksLikeMachinery(inner) {
  const trimmed = inner.trim();
  if (trimmed === '') return true;
  if (!ASCII_ONLY.test(trimmed)) return false;      // 里面有中文：是助手的话
  if (!/\s/u.test(trimmed)) return true;            // 纯 ASCII 又没空格：标签名、路径、变量
  return TAG_SHAPE.test(trimmed);                   // <div class="x"> 这种带属性的标签
}

/** 在一条（||| 之间的一段）里抽出 <> 里的话；剩下的原样接回去。 */
function scanThoughts(segment) {
  const thoughts = [];
  let out = '';
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i];
    if (!isOpenAngle(ch)) {
      out += ch;
      i += 1;
      continue;
    }
 // << 或 ＜＜：shell 的 heredoc，不是记号
    if (isOpenAngle(segment[i + 1] ?? '')) {
      out += ch;
      i += 1;
      continue;
    }
    let closeAt = -1;
    for (let k = i + 1; k < segment.length; k += 1) {
      if (isCloseAngle(segment[k])) { closeAt = k; break; }
    }
    if (closeAt < 0) {
      out += ch;
      i += 1;
      continue;
    }
    const inner = segment.slice(i + 1, closeAt);
    if (looksLikeMachinery(inner)) {
      out += segment.slice(i, closeAt + 1);
      i = closeAt + 1;
      continue;
    }
    thoughts.push(inner.trim());
 // 记号两边都是空白时收掉一个，免得助手的话中间空出一块
    let next = closeAt + 1;
    if (/\s$/u.test(out) && next < segment.length && /\s/u.test(segment[next])) next += 1;
    i = next;
  }
  return { publicText: out.trim(), thoughts };
}
