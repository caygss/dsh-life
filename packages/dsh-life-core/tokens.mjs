/**
 * Token estimation for context budgeting.
 *
 * Calibration: measured on real traffic, not assumed.
 * Two real requests against the fixed model on the same synthetic Chinese corpus:
 * 9,099 chars -> 5,827 prompt tokens (0.640 tokens/char)
 * 358,108 chars -> 228,351 prompt tokens (0.638 tokens/char)
 * So one token is about 1.56 Chinese characters, not the 0.75 the earlier
 * byte-based rule of thumb implied; that estimate was 61% too high.
 *
 * This is still an estimate for budgeting, not provider-exact billing. Counting is
 * per code point, and metadata/markup is counted as text.
 */
export const DEFAULT_TOKEN_PROFILE = Object.freeze({
  cjkTokensPerChar: 0.64,
  asciiTokensPerChar: 0.25,
  otherTokensPerChar: 0.5,
});

/** Measured from evidence: Chinese characters per token. */
export const MEASURED_CJK_CHARS_PER_TOKEN = 1.56;

const CJK_RANGES = [
  [0x3040, 0x30ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xac00, 0xd7af],
  [0xf900, 0xfaff],
  [0xff00, 0xffef],
];

function isCjk(code) {
  for (const [lo, hi] of CJK_RANGES) {
    if (code >= lo && code <= hi) return true;
  }
  return false;
}

export function countKinds(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  let cjk = 0;
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code <= 0x7f) ascii += 1;
    else if (isCjk(code)) cjk += 1;
    else other += 1;
  }
  return { cjk, ascii, other };
}

export function estimateTokens(text, profile = DEFAULT_TOKEN_PROFILE) {
  const { cjk, ascii, other } = countKinds(text);
  const raw = cjk * profile.cjkTokensPerChar
    + ascii * profile.asciiTokensPerChar
    + other * profile.otherTokensPerChar;
  return Math.ceil(raw);
}

/** How many Chinese characters fit in a token budget under the measured profile. */
export function charsForTokens(tokens) {
  return Math.floor(tokens / DEFAULT_TOKEN_PROFILE.cjkTokensPerChar);
}
