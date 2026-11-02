/**
 * Addressable memory fields (schema v3).
 *
 * The need: once the correct day was known, near-duplicate lines about the same
 * subject still could not be told apart - their cosine similarities sat inside the
 * noise band. Similarity cannot answer "which one" when the candidates are about
 * the same thing.
 *
 * So a package now carries what a question can actually point at:
 * occurredAt when it happened (not when it was written)
 * subjects what it was about, as short strings
 * ordinal which occurrence of that subject it was
 *
 * This module only *reads* those fields. Extraction is the compressor's job; keeping
 * the matching logic separate means a weak extractor shows up as missed fields rather
 * than as wrong answers hidden in a score.
 */
import { parseCount } from './time-cue.mjs';

const ORDINAL = /第\s*([0-9]+|[零一二两三四五六七八九十百]+)\s*(?:次|回)/;

/** "第三次" / "第3次" -> 3. Returns null when the text names no occurrence. */
export function parseOrdinal(text) {
  if (typeof text !== 'string' || text === '') return null;
  const match = ORDINAL.exec(text);
  if (match === null) return null;
  const value = parseCount(match[1]);
  return value !== null && value > 0 ? value : null;
}

/** Subjects that appear literally in the question. */
export function matchSubjects(subjects, text) {
  if (!Array.isArray(subjects) || subjects.length === 0) return [];
  if (typeof text !== 'string' || text === '') return [];
  return subjects.filter((subject) => typeof subject === 'string' && subject !== '' && text.includes(subject));
}

/**
 * @param {{occurredAt?:string|null, subjects?:string[], ordinal?:number|null}} address
 * @param {{text:string, cueTimeMs?:number, windowDays?:number}} query
 * @returns {{known:boolean, subjectHits:string[], subjectHit:boolean, timeHit:boolean, ordinalHit:boolean, dayErrorDays:number|null}}
 */
export function addressFactors(address, query) {
  const pkg = address === null || typeof address !== 'object' ? {} : address;
  const text = query !== null && typeof query === 'object' && typeof query.text === 'string' ? query.text : '';
  const subjects = Array.isArray(pkg.subjects) ? pkg.subjects : [];
  const subjectHits = matchSubjects(subjects, text);

  let timeHit = false;
  let dayErrorDays = null;
  const occurredMs = typeof pkg.occurredAt === 'string' ? Date.parse(pkg.occurredAt) : Number.NaN;
  const cueMs = query !== null && typeof query === 'object' ? query.cueTimeMs : undefined;
  if (Number.isFinite(occurredMs) && Number.isFinite(cueMs)) {
    dayErrorDays = Math.abs(cueMs - occurredMs) / (24 * 60 * 60 * 1000);
    const windowDays = Number.isFinite(query.windowDays) ? query.windowDays : 0;
    timeHit = dayErrorDays <= windowDays;
  }

  const askedOrdinal = parseOrdinal(text);
  const ordinalHit = askedOrdinal !== null && Number.isInteger(pkg.ordinal) && pkg.ordinal === askedOrdinal;

  return {
    known: subjects.length > 0 || Number.isFinite(occurredMs) || Number.isInteger(pkg.ordinal),
    subjectHits,
    subjectHit: subjectHits.length > 0,
    timeHit,
    ordinalHit,
    dayErrorDays: dayErrorDays === null ? null : Number(dayErrorDays.toFixed(3)),
  };
}
