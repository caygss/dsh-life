/**
 * Waking up.
 *
 * Two things are counted separately, because conflating them is what produced the first
 * wrong version of this module:
 *
 * 1. an AWAKENING is a sleep -> awake transition, never an LLM call. If you talk to it
 * for half an hour after waking its, that is one awakening and thirty turns; the
 * state machine cannot produce a second transition while the agent is already awake.
 * 2. awakenings closer than mergeWindowMs (40 minutes) are the SAME awakening - the agent was
 * woken, dozed off for a few minutes, woken again. The group keeps the deepest score.
 *
 * Cost is a saturating function of the night's fragmentation, not a flat per-wake penalty:
 *
 * score_i = depthWeight(depth_i) * triggerFactor(trigger_i) (0.5/1.0/1.6 x called/natural)
 * F = sum of the group scores
 * lostHours = maxHours * (1 - exp(-F / f0)) (3h ceiling, f0 = 2)
 *
 * The ceiling exists because sleep cannot be MORE destroyed than destroyed, and the
 * exponential shape says what the literature does: the first interruption costs most, the
 * fifth costs little more than the fourth. A flat 1-2 hours per wake would exceed a whole
 * night after six calls, which is not a real state of the world.
 *
 * A natural night wake counts - its sleep is fragmented either way - but at half weight:
 * nobody called its, and the agent usually goes back under on its own.
 *
 * All constants are uncalibrated. The tests pin the shape: monotonic, bounded, deeper
 * costs more than lighter, called costs more than natural, and effective sleep never
 * goes below zero.
 */
export const DEPTHS = Object.freeze(['light', 'medium', 'deep']);
export const TRIGGERS = Object.freeze(['called', 'natural']);

export const WAKE_RULES = Object.freeze({
 /** Two awakenings inside this window are one awakening, keeping the deeper score. */
  mergeWindowMs: 40 * 60 * 1000,
 /** Asleep for less than 60 minutes is light, up to 180 is medium, beyond is deep. */
  depthMinutes: Object.freeze({ light: 60, medium: 180 }),
 /** Measured design values: shallow is easy to wake, deep is not. */
  successByDepth: Object.freeze({ light: 0.9, medium: 0.5, deep: 0.1 }),
  depthWeight: Object.freeze({ light: 0.5, medium: 1.0, deep: 1.6 }),
  triggerFactor: Object.freeze({ called: 1.0, natural: 0.5 }),
  fragmentation: Object.freeze({ maxHours: 3, f0: 2 }),
});

export class LifeWakeError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifeWakeError';
    this.code = code;
  }
}

function requireRules(overrides) {
  const rules = { ...WAKE_RULES, ...(overrides ?? {}) };
  if (!Number.isFinite(rules.mergeWindowMs) || rules.mergeWindowMs < 0) throw new LifeWakeError('invalid_merge_window');
  for (const depth of DEPTHS) {
    const chance = rules.successByDepth[depth];
    if (!(chance > 0 && chance <= 1)) throw new LifeWakeError('invalid_success_chance', depth);
    if (!(rules.depthWeight[depth] > 0)) throw new LifeWakeError('invalid_depth_weight', depth);
  }
  for (const trigger of TRIGGERS) {
    if (!(rules.triggerFactor[trigger] > 0)) throw new LifeWakeError('invalid_trigger_factor', trigger);
  }
  if (!(rules.fragmentation.maxHours > 0)) throw new LifeWakeError('invalid_max_hours');
  if (!(rules.fragmentation.f0 > 0)) throw new LifeWakeError('invalid_f0');
  return rules;
}

/** Deterministic PRNG, so a wake attempt can be reproduced in a test. */
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

/** How deeply the agent is asleep after this many minutes. */
export function sleepDepth(asleepMinutes, rules = WAKE_RULES) {
  const minutes = Number(asleepMinutes);
  if (!Number.isFinite(minutes) || minutes < 0) throw new LifeWakeError('invalid_asleep_minutes', String(asleepMinutes));
  const settings = requireRules(rules);
  if (minutes < settings.depthMinutes.light) return 'light';
  if (minutes <= settings.depthMinutes.medium) return 'medium';
  return 'deep';
}

export function wakeSuccessChance(depth, rules = WAKE_RULES) {
  if (!DEPTHS.includes(depth)) throw new LifeWakeError('invalid_depth', String(depth));
  return requireRules(rules).successByDepth[depth];
}

/**
 * One attempt to wake its. Success is a draw against the depth's chance; the caller then
 * forces the state transition (a called wake bypasses the minimum dwell time).
 *
 * @returns {{depth:string, chance:number, roll:number, woken:boolean}}
 */
export function attemptWake(input = {}) {
  const depth = input.depth;
  if (!DEPTHS.includes(depth)) throw new LifeWakeError('invalid_depth', String(depth));
  const rules = requireRules(input.rules);
  const rng = typeof input.rng === 'function' ? input.rng : createRng(input.seed ?? 1);
  const chance = rules.successByDepth[depth];
  const roll = rng();
  return { depth, chance, roll, woken: roll < chance };
}

/** Disruption score of one awakening. */
export function awakeningScore(input = {}) {
  const depth = input.depth;
  const trigger = input.trigger;
  if (!DEPTHS.includes(depth)) throw new LifeWakeError('invalid_depth', String(depth));
  if (!TRIGGERS.includes(trigger)) throw new LifeWakeError('invalid_trigger', String(trigger));
  const rules = requireRules(input.rules);
  return rules.depthWeight[depth] * rules.triggerFactor[trigger];
}

export function lostRecoveryHours(fragmentation, rules = WAKE_RULES) {
  const f = Number(fragmentation);
  if (!Number.isFinite(f) || f < 0) throw new LifeWakeError('invalid_fragmentation', String(fragmentation));
  const settings = requireRules(rules);
  if (f === 0) return 0;
  return settings.fragmentation.maxHours * (1 - Math.exp(-f / settings.fragmentation.f0));
}

/** Sleep the agent actually gets credit for; fragmentation can never make it negative. */
export function effectiveSleepHours(input = {}) {
  const actual = Number(input.actualHours);
  const lost = Number(input.lostHours ?? 0);
  if (!Number.isFinite(actual) || actual < 0) throw new LifeWakeError('invalid_actual_hours', String(input.actualHours));
  if (!Number.isFinite(lost) || lost < 0) throw new LifeWakeError('invalid_lost_hours', String(input.lostHours));
  return Math.max(0, actual - lost);
}

/**
 * Groups the night's awakenings and prices the fragmentation.
 *
 * @param {Array<{at:string, from:string, to:string, why?:string}>} stateEvents ascending
 * @returns {{awakenings:Array, fragmentation:number, lostHours:number, merged:number}}
 */
export function summarizeNight(stateEvents, options = {}) {
  if (!Array.isArray(stateEvents)) throw new LifeWakeError('invalid_events');
  const rules = requireRules(options.rules);
  const awakenings = [];
  let enteredAt = null;
  let previousTime = null;
  let group = null;
  let merged = 0;

  for (const event of stateEvents) {
    if (event === null || typeof event !== 'object') throw new LifeWakeError('invalid_event');
    const time = Date.parse(event.at);
    if (!Number.isFinite(time)) throw new LifeWakeError('invalid_event_time', String(event.at));
    if (previousTime !== null && time < previousTime) throw new LifeWakeError('events_not_ascending', String(event.at));
    previousTime = time;

 // Going back to sleep records when the next depth is measured from; it does not end the
 // merge window, because being woken twice inside 40 minutes is still one awakening.
    if (event.to === 'asleep') { enteredAt = time; continue; }
    if (event.from !== 'asleep') continue;
    if (enteredAt === null) throw new LifeWakeError('missing_sleep_entry', event.at);

    const asleepMinutes = (time - enteredAt) / 60000;
    const depth = sleepDepth(asleepMinutes, rules);
    const trigger = event.why === 'called_wake' ? 'called' : 'natural';
    const score = awakeningScore({ depth, trigger, rules });

    if (group !== null && time - group.time <= rules.mergeWindowMs) {
      group.mergedCount += 1;
      if (score > group.score) { group.score = score; group.depth = depth; }
      if (trigger === 'called' && !group.triggers.includes('called')) group.triggers.push('called');
      merged += 1;
      continue;
    }

    group = { time, at: event.at, depth, trigger, triggers: [trigger], score, asleepMinutes, mergedCount: 1 };
    awakenings.push(group);
    enteredAt = null;
  }

  const fragmentation = awakenings.reduce((total, entry) => total + entry.score, 0);
  return {
    awakenings: awakenings.map((entry) => ({
      at: entry.at,
      depth: entry.depth,
 // If the agent was called at any point inside the merged window, it was a called awakening.
      trigger: entry.triggers.includes('called') ? 'called' : 'natural',
      triggers: [...entry.triggers],
      asleepMinutes: Math.round(entry.asleepMinutes),
      score: entry.score,
      mergedCount: entry.mergedCount,
    })),
    fragmentation,
    lostHours: lostRecoveryHours(fragmentation, rules),
    merged,
  };
}