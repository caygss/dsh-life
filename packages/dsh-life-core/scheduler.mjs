/**
 * When the agent next surfaces.
 *
 * Two kinds of trigger, one assembly:
 * - timer: the agent calls itself. Interval is a mixture - a base draw plus a heavy tail -
 * because a plain uniform draw spaces the calls too evenly while a life should
 * cluster.
 * - event: something happened (you spoke, the environment changed). Never waits for
 * the timer; it is scheduled immediately, and if the agent is asleep it waits for it.
 *
 * Nothing here decides to wake the agent at a fixed clock time, and nothing forces
 * sleep: at most it reports that the agent cannot hold on any more.
 */
import { LifeRhythmError } from './rhythm.mjs';

export { LifeRhythmError };

export const CADENCE = Object.freeze({
  minMinutes: 5,
  maxMinutes: 70,
 /** Probability that this interval comes from the heavy tail instead of the base draw. */
  heavyTailChance: 0.3,
 /** Pareto shape for the tail: below 1 the mean is unbounded. */
  tailAlpha: 1.35,
 /** Ultradian period, minutes. */
  ultradianMinutes: 90,
  ultradianJitter: 0.25,
});

export function createRng(seed = 1) {
  let state = seed >>> 0;
 // 状态要能被读出来存下去：以前它只活在进程里，固定种子 + 每次重启重新播种
 // = 助手的"随机"间隔从头重复一遍。state 是 32 位无符号整数，落到 life_meta.scheduler_json。
  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  Object.defineProperty(next, 'state', {
    enumerable: true,
    get: () => state,
    set: (value) => { state = Number(value) >>> 0; },
  });
  return next;
}

function requireCadence(overrides) {
  const rules = { ...CADENCE, ...(overrides ?? {}) };
  if (!(rules.minMinutes > 0)) throw new LifeRhythmError('invalid_min_interval');
  if (!(rules.maxMinutes > rules.minMinutes)) throw new LifeRhythmError('invalid_max_interval');
  if (!(rules.heavyTailChance >= 0 && rules.heavyTailChance <= 1)) throw new LifeRhythmError('invalid_tail_chance');
  if (!(rules.tailAlpha > 0)) throw new LifeRhythmError('invalid_tail_alpha');
  return rules;
}

/**
 * One inter-wake interval in minutes: uniform base, sometimes replaced by a long tail.
 * The tail is a Pareto draw shifted onto the base range, so a long gap is possible but
 * a two-hour disappearance is not routine.
 */
export function drawInterval(rng, overrides) {
  const rules = requireCadence(overrides);
  const span = rules.maxMinutes - rules.minMinutes;
  const base = rules.minMinutes + rng() * span;
  if (rng() >= rules.heavyTailChance) return base;
  const u = Math.max(1e-9, rng());
  const tail = rules.minMinutes / Math.pow(u, 1 / rules.tailAlpha);
  return Math.min(Math.max(base, tail), rules.maxMinutes * 4);
}

/** Burstiness B = (sd - mean) / (sd + mean). Positive means clustered arrivals. */
export function burstiness(samples) {
  if (!Array.isArray(samples) || samples.length < 2) throw new LifeRhythmError('invalid_samples');
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (samples.length - 1);
  const sd = Math.sqrt(variance);
  if (sd + mean === 0) return 0;
  return (sd - mean) / (sd + mean);
}

/** Ultradian phase in minutes since the last cycle start, with jitter. */
export function ultradianPhase(rng, overrides) {
  const rules = requireCadence(overrides);
  const jitter = 1 + (rng() * 2 - 1) * rules.ultradianJitter;
  return rules.ultradianMinutes * jitter;
}

/**
 * Scheduler state machine over an injected clock.
 * The caller supplies now; nothing here reads the wall clock itself.
 */
export function createScheduler(options = {}) {
  const rules = requireCadence(options.cadence);
 // 随机数由调用方给（助手要能被存下来、被测试钉死），不给就是老样子。
  const rng = typeof options.rng === 'function' ? options.rng : createRng(1);
  const now = options.now ?? (() => Date.now());
 // 每次排下一次醒来，都把「下一次什么时候」和「随机数走到哪」交出去存盘。
  const onPlan = typeof options.onPlan === 'function' ? options.onPlan : null;
  const plan = () => {
    if (onPlan === null) return;
    onPlan({ nextAt, rngState: Number.isInteger(rng.state) ? rng.state : null, at: new Date(now()).toISOString() });
  };
  // The five-state machine owns whether the agent is asleep. When a stateOf getter is
 // supplied, this scheduler derives from it and refuses to keep a second copy - two
 // owners of "asleep" is how the day boundary ends up firing at the wrong moment.
  const stateOf = typeof options.stateOf === 'function' ? options.stateOf : null;
  let awake = options.awake ?? true;
  let nextAt = null;
  let pendingEvents = 0;
  const asleepNow = () => (stateOf === null ? !awake : stateOf() === 'asleep');

  const scheduleNext = () => {
    const minutes = drawInterval(rng, rules);
    nextAt = now() + minutes * 60_000;
    plan();
    return nextAt;
  };

 // 接上上一次进程留下的节奏：只在"还没到、而且就在 24 小时内"时接上。
 // 已经过点的（停机太久）不补一串醒来——重启不是助手的闹钟，poll 会重新抽一次间隔。
  if (Number.isFinite(options.nextAt)) {
    const restored = Number(options.nextAt);
    if (restored > now() && restored <= now() + 24 * 3600_000) nextAt = restored;
  }

  const requireOwnership = () => {
    if (stateOf !== null) throw new LifeRhythmError('state_owned_by_state_machine');
  };

  return {
    get asleep() { return asleepNow(); },
 /** True when this scheduler is the only owner (no stateOf getter was supplied). */
    get ownsSleepState() { return stateOf === null; },
    get nextAt() { return asleepNow() ? null : nextAt; },
    get pendingEvents() { return pendingEvents; },
 /** Timer trigger, or null when the next wake is still in the future. */
    poll() {
 // Asleep pauses the cadence rather than queueing it: when the agent wakes, a fresh
 // interval is drawn instead of firing a backlog of missed timers.
      if (asleepNow()) { nextAt = null; return null; }
      if (nextAt === null) scheduleNext();
      if (now() < nextAt) return null;
      const at = nextAt;
      scheduleNext();
      return { kind: 'timer', at, ultradianBudgetMinutes: ultradianPhase(rng, rules) };
    },
 /**
 * An event arrives. While awake it is due immediately; while asleep it waits, and
 * the count is what "已暂存 N 条" shows.
 */
    onEvent() {
      if (asleepNow()) { pendingEvents += 1; return { kind: 'deferred', pending: pendingEvents }; }
      return { kind: 'immediate', at: now() };
    },
 /** The agent decided to sleep. */
    fallAsleep() {
      requireOwnership();
      awake = false;
      nextAt = null;
      plan();
      return { awake: false, pending: pendingEvents };
    },
  /**
   * Hands over what arrived while the agent was asleep and clears the counter. The loop calls
 * this when the state machine leaves 'asleep'; with a stateOf getter the scheduler
 * cannot wake itself, so this is the only way the queue drains.
 */
    drainPending() {
      const released = pendingEvents;
      pendingEvents = 0;
      return released;
    },
  /** The agent woke, naturally or because it was called. */
    wakeUp() {
      requireOwnership();
      awake = true;
      const released = pendingEvents;
      pendingEvents = 0;
      scheduleNext();
      return { awake: true, released };
    },
  };
}
