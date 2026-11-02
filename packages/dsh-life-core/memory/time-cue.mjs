/**
 * Relative-time cue parsing: make remembered time addressable.
 *
 * The problem: the time route scored every candidate against the *current* time,
 * so saying "四十天前" could not express a remembered time, and opening the route
 * did not by itself move the correct package to the top.
 *
 * The fix is not a better weight: the query has to be read. This module turns an
 * explicit relative-time phrase into (a) a target instant and (b) the phrase's own
 * imprecision, which becomes the candidate window. "三天前" is worth ±1 day;
 * "一个多月前" is worth ±10 and nothing pretends otherwise.
 *
 * Only explicit, closed-form phrases are recognised. When nothing matches the caller
 * keeps its previous behaviour; guessing a time from context is out of scope.
 */
export class LifeTimeCueError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LifeTimeCueError';
    this.code = code;
  }
}

const CJK_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const DAY = 24 * 60 * 60 * 1000;

/** Arabic or Chinese numerals up to the hundreds; returns null when unparseable. */
export function parseCount(text) {
  if (typeof text !== 'string' || text === '') return null;
  if (/^[0-9]+$/.test(text)) return Number(text);
  let total = 0;
  let current = 0;
  for (const char of text) {
    if (char === '百') {
      total += (current === 0 ? 1 : current) * 100;
      current = 0;
    } else if (char === '十') {
      total += (current === 0 ? 1 : current) * 10;
      current = 0;
    } else if (char in CJK_DIGITS) {
      current = CJK_DIGITS[char];
    } else {
      return null;
    }
  }
  return total + current;
}

const NUM = '([0-9]+|[零一二两三四五六七八九十百]+)';

/**
 * Patterns are ordered from most specific to least: "一个多月前" must win over
 * "一个月前", and "四十多天前" over "四十天前".
 */
const PATTERNS = [
  { re: /大前天/, days: () => 3, windowDays: () => 1 },
  { re: /前天/, days: () => 2, windowDays: () => 1 },
  { re: /昨天|昨日/, days: () => 1, windowDays: () => 1 },
  { re: /今天|今日/, days: () => 0, windowDays: () => 1 },
  { re: /上个?(?:星期|周)/, days: () => 7, windowDays: () => 3 },
  { re: /半个?月前/, days: () => 15, windowDays: () => 4 },
  { re: /快\s*一个\s*月\s*前/, days: () => 25, windowDays: () => 6 },
  { re: /整整\s*一个\s*月\s*前/, days: () => 30, windowDays: () => 5 },
  { re: /一个\s*多\s*个?\s*月\s*前/, days: () => 40, windowDays: () => 10 },
  { re: /一个\s*月\s*前/, days: () => 30, windowDays: () => 5 },
  { re: new RegExp(NUM + '\\s*个?\\s*多\\s*个?\\s*月\\s*前'), days: (n) => 30 * n + 15, windowDays: () => 10 },
  { re: new RegExp(NUM + '\\s*个?\\s*月\\s*前'), days: (n) => 30 * n, windowDays: () => 6 },
  { re: new RegExp(NUM + '\\s*个?\\s*(?:星期|周)\\s*前'), days: (n) => 7 * n, windowDays: () => 3 },
  { re: new RegExp(NUM + '\\s*多\\s*天\\s*前'), days: (n) => n + 2, windowDays: () => 8 },
  { re: new RegExp(NUM + '\\s*天\\s*前'), days: (n) => n, windowDays: (n) => (n <= 2 ? 1 : Math.min(6, Math.max(1, Math.round(n * 0.12)))) },
];

/**
 * @param {string} text query text
 * @returns {{matched:boolean, days?:number, windowDays?:number, phrase?:string}}
 */
export function parseRelativeTime(text) {
  if (typeof text !== 'string' || text === '') return { matched: false };
  for (const pattern of PATTERNS) {
    const match = pattern.re.exec(text);
    if (match === null) continue;
    let count = 1;
    if (match.length > 1) {
      const parsed = parseCount(match[1]);
      if (parsed === null || parsed <= 0) continue;
      count = parsed;
    }
    return {
      matched: true,
      days: pattern.days(count),
      windowDays: pattern.windowDays(count),
      phrase: match[0],
    };
  }
  return { matched: false };
}

/**
 * Turns a query into an absolute cue time plus the window its wording justifies.
 * An unrecognised phrase yields `at: null`, so callers can keep the old behaviour
 * instead of silently pretending they understood a time.
 */
export function resolveCueTime(text, nowMs) {
  if (!Number.isFinite(nowMs)) throw new LifeTimeCueError('invalid_now');
  const parsed = parseRelativeTime(text);
  if (!parsed.matched) return { at: null, windowDays: null, phrase: null };
  if (parsed.days < 0) throw new LifeTimeCueError('invalid_days');
  return {
    at: new Date(nowMs - parsed.days * DAY).toISOString(),
    windowDays: parsed.windowDays,
    phrase: parsed.phrase,
  };
}
