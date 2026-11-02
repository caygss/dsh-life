/**
 * Five-factor scoring and sampling.
 *
 * score = w1*log(1+I) + w2*A + w3*R + w4*S + w5*Z - w6*X + noise
 * pick = softmax(score / T), sample - not top-1
 *
 * Why sampling instead of top-k: the agent's memory should surprise it a little. Always
 * taking the maximum makes the same few entries repeat every wake.
 *
 * The weights below are defaults, not all-ones. The factors arrive on very different
 * scales, so equal weights would let one factor dominate by amplitude alone: importance
 * is a small log, activation is a log with a floor, and the relevance family is a
 * similarity. With every weight at 1, importance drowns out relevance and activation
 * acts as a hard boost for whatever the agent had recalled once.
 *
 * The vector is expressed at |w| = sqrt(6) on purpose: sampling is softmax(score / T)
 * with T = 0.7, so its LENGTH is a temperature decision - shrinking it lets relevance
 * stop mattering, stretching it makes the pool repeat itself. The defaults encode a
 * ratio between the factors; the length is the temperature.
 *
 * What it is not: nobody has judged whether these selections read well. That is a
 * quality question, separate from the arithmetic here.
 */
import { activationValue } from './activation.mjs';

export const DEFAULT_WEIGHTS = Object.freeze({
  importance: 0.771,
  activation: 0.05,
  relevance: 2.023,
  association: 0.27,
  openLoop: 1.079,
  inhibition: 0.27,
});

export const DEFAULT_SAMPLING = Object.freeze({
  temperature: 0.7,
  count: 6,
  maxCount: 8,
  noise: 0,
});

export class LifeScoreError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifeScoreError';
    this.code = code;
  }
}

/** Deterministic PRNG so a sampled result can be reproduced in tests. */
export function createRng(seed = 1) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {object} factors importance(1-5), activation, relevance, association, openLoop, inhibition
 * @param {object} [weights]
 */
export function fiveFactorScore(factors, weights = DEFAULT_WEIGHTS) {
  if (factors === null || typeof factors !== 'object') throw new LifeScoreError('invalid_factors');
  const number = (value, name) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new LifeScoreError('invalid_factor', name);
    return numeric;
  };
  const importance = number(factors.importance, 'importance');
  if (importance < 1 || importance > 5) throw new LifeScoreError('importance_out_of_range', String(importance));
  const parts = {
    importance: weights.importance * Math.log1p(importance),
    activation: weights.activation * number(factors.activation ?? 0, 'activation'),
    relevance: weights.relevance * number(factors.relevance ?? 0, 'relevance'),
    association: weights.association * number(factors.association ?? 0, 'association'),
    openLoop: weights.openLoop * number(factors.openLoop ?? 0, 'openLoop'),
    inhibition: -weights.inhibition * number(factors.inhibition ?? 0, 'inhibition'),
  };
  let total = 0;
  for (const value of Object.values(parts)) total += value;
  return { total, parts };
}

/** Numerically stable softmax over an array of scores. */
export function softmax(scores, temperature = DEFAULT_SAMPLING.temperature) {
  if (!Array.isArray(scores) || scores.length === 0) return [];
  const scale = Number(temperature);
  if (!(scale > 0)) throw new LifeScoreError('invalid_temperature', String(temperature));
  const max = Math.max(...scores);
  const exps = scores.map((value) => Math.exp((value - max) / scale));
  const sum = exps.reduce((total, value) => total + value, 0);
  return exps.map((value) => value / sum);
}

/**
 * Samples distinct candidates without replacement by their softmax weight.
 * @returns {{selected:Array, probabilities:number[]}}
 */
export function sampleCandidates(candidates, options = {}) {
  if (!Array.isArray(candidates)) throw new LifeScoreError('invalid_candidates');
  const settings = { ...DEFAULT_SAMPLING, ...(options ?? {}) };
  const count = Math.min(Number(settings.count), Number(settings.maxCount), candidates.length);
  if (!Number.isInteger(count) || count < 0) throw new LifeScoreError('invalid_count', String(settings.count));
  if (candidates.length === 0) return { selected: [], probabilities: [] };

  const rng = settings.rng ?? createRng(settings.seed ?? 1);
  const probabilities = softmax(candidates.map((candidate) => candidate.score), settings.temperature);
  const remaining = candidates.map((candidate, index) => ({ candidate, weight: probabilities[index] }));
  const selected = [];
  while (selected.length < count && remaining.length > 0) {
    const total = remaining.reduce((sum, entry) => sum + entry.weight, 0);
    if (total <= 0) break;
    let target = rng() * total;
    let index = 0;
    for (; index < remaining.length; index += 1) {
      target -= remaining[index].weight;
      if (target <= 0) break;
    }
    const chosen = remaining.splice(Math.min(index, remaining.length - 1), 1)[0];
    selected.push(chosen.candidate);
  }
  return { selected, probabilities };
}

/**
 * Turns recall candidates into scored, sampled memories for the context.
 *
 * @param {object} input candidates, weights, sampling, now, activations(Map), links(Map),
 * openLoops(Set), recentPackageIds(string[]), noise?
 */
export function selectMemories(input) {
  if (input === null || typeof input !== 'object') throw new LifeScoreError('invalid_input');
  const candidates = input.candidates;
  if (!Array.isArray(candidates)) throw new LifeScoreError('invalid_candidates');
  const weights = { ...DEFAULT_WEIGHTS, ...(input.weights ?? {}) };
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const activations = input.activations instanceof Map ? input.activations : new Map();
  const links = input.links instanceof Map ? input.links : new Map();
  const openLoops = input.openLoops instanceof Set ? input.openLoops : new Set();
  const recent = Array.isArray(input.recentPackageIds) ? new Set(input.recentPackageIds) : new Set();
  const rng = input.sampling?.rng ?? createRng(input.sampling?.seed ?? input.seed ?? 1);

  const scored = candidates.map((candidate) => {
    const linkIds = links.get(candidate.packageId) ?? [];
    const linkedToCandidateSet = linkIds.filter((id) => candidates.some((other) => other.packageId === id)).length;
    const factors = {
      importance: candidate.importance ?? 3,
      activation: activationValue(activations.get(candidate.packageId) ?? [], now),
      relevance: candidate.total ?? candidate.relevance ?? 0,
      association: Math.min(1, linkedToCandidateSet / 3),
      openLoop: openLoops.has(candidate.packageId) ? 1 : 0,
 // Repetition suppression: something the agent just had in front of it starts lower.
      inhibition: recent.has(candidate.packageId) ? 1 : 0,
    };
    const { total, parts } = fiveFactorScore(factors, weights);
    return { ...candidate, factors, score: total, scoreParts: parts };
  });

  scored.sort((a, b) => b.score - a.score || (a.packageId < b.packageId ? -1 : 1));
  const { selected, probabilities } = sampleCandidates(scored, { ...input.sampling, rng });
  return {
    scored,
    selected,
    probabilities,
    weights,
    sampling: { temperature: input.sampling?.temperature ?? DEFAULT_SAMPLING.temperature, count: selected.length },
  };
}
