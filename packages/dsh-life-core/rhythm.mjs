/**
 * The agent's day: sleep pressure, circadian phase, and the wake cadence.
 *
 * Two-process model:
 * awake: S <- 1 - (1 - S) * exp(-dt / TAU_AWAKE) (18.2 h)
 * asleep: S <- S * exp(-dt / TAU_ASLEEP) (4.2 h)
 * alert(t) = 0.3 * sin(2*pi*(hour - PHI - 6)/24) + 0.5 (trough at PHI, peak 12 h later)
 * sleepiness = S + (0.8 - alert(t)) (alertness is subtracted)
 *
 * The subtraction is not cosmetic: adding alertness to pressure makes the agent sleepiest
 * at the circadian peak (16:00) and least sleepy at 04:00. That inversion was observed and
 * fixed; the theta values below are the result of the calibration sweep that followed.
 *
 * This is a *feeling*, not a switch. Crossing THETA means "the agent is
 * sleepy" and the agent may push on; only at THETA + DELTA can the agent no longer stay awake.
 * Nothing in here puts the agent to sleep on a schedule.
 *
 * Every constant is uncalibrated. The shape is what these tests pin down, not the
 * exact thresholds.
 */

export const RHYTHM = Object.freeze({
  tauAwakeHours: 18.2,
  tauAsleepHours: 4.2,
  circadianAmplitude: 0.3,
  circadianOffset: 0.5,
 /** Local hour of it biological low point (circadian trough). */
  phaseHour: 4,
 /** Feels sleepy above this. Calibrated over 30 simulated days. */
  theta: 1.0,
 /** Cannot hold on above theta + delta. */
  delta: 0.08,
 /** Naturally wakes below this. */
  wakeTheta: 0.6,
 /** The agent's local timezone: the circadian phase is local, not UTC. */
  timeZone: 'UTC',
});

export class LifeRhythmError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifeRhythmError';
    this.code = code;
  }
}

const HOUR_MS = 3_600_000;

function requireHours(value, name) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) throw new LifeRhythmError('invalid_duration', name);
  return numeric;
}

/** Sleep pressure after dt hours awake, starting from pressure. */
export function pressureAwake(pressure, dtHours, rules = RHYTHM) {
  const start = Math.min(1, Math.max(0, Number(pressure)));
  const dt = requireHours(dtHours, 'dtHours');
  return 1 - (1 - start) * Math.exp(-dt / rules.tauAwakeHours);
}

/** Sleep pressure after dt hours asleep. */
export function pressureAsleep(pressure, dtHours, rules = RHYTHM) {
  const start = Math.min(1, Math.max(0, Number(pressure)));
  const dt = requireHours(dtHours, 'dtHours');
  return start * Math.exp(-dt / rules.tauAsleepHours);
}

/**
 * Local hour of day. The circadian term is about the agent's body in its timezone,
 * so using UTC here would shift the whole day.
 */
export function localHour(atMs, timeZone = RHYTHM.timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(atMs));
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '0';
  return Number(pick('hour')) + Number(pick('minute')) / 60;
}

/** Circadian component in 0.2.0.8 for a local hour of day. */
export function circadian(hourOfDay, rules = RHYTHM) {
  const hour = Number(hourOfDay);
  if (!Number.isFinite(hour)) throw new LifeRhythmError('invalid_hour', String(hourOfDay));
 // Shifted by +6 h so the *trough* lands on phaseHour: sin is -1 six hours before its
 // zero crossing. With phaseHour 4 the low point is 04:00 and the peak is 16:00.
  return rules.circadianAmplitude * Math.sin((2 * Math.PI * (hour - rules.phaseHour - 6)) / 24) + rules.circadianOffset;
}

/**
 * Sleepiness = homeostatic pressure + how far the body clock is from "most awake".
 *
 * The circadian curve computed above is ALERTNESS: it troughs at phaseHour (04:00) and
 * peaks at 16:00. Adding it to sleep pressure inverted the day: the old form made the
 * agent sleepiest at 16:00 and least sleepy at 04:00, which is why
 * "cannot hold on any more" never fired in the evening and always fired in the afternoon.
 * Alertness therefore enters with a minus sign, normalised so its maximum contributes 0.
 */
export function sleepiness(pressure, hourOfDay, rules = RHYTHM) {
  const awake = rules.circadianOffset + rules.circadianAmplitude;
  return Number(pressure) + (awake - circadian(hourOfDay, rules));
}

/**
 * How the agent feels right now.
 * @returns {{pressure:number, circadian:number, sleepiness:number, sleepy:boolean, canHoldOn:boolean, mustSleep:boolean, canWake:boolean}}
 */
export function howTheAgentFeels(input) {
  if (input === null || typeof input !== 'object') throw new LifeRhythmError('invalid_input');
  const rules = { ...RHYTHM, ...(input.rules ?? {}) };
  const pressure = Number(input.pressure);
  if (!Number.isFinite(pressure) || pressure < 0 || pressure > 1) throw new LifeRhythmError('invalid_pressure', String(input.pressure));
  const atMs = input.at === undefined ? Date.now() : (typeof input.at === 'number' ? input.at : Date.parse(input.at));
  if (!Number.isFinite(atMs)) throw new LifeRhythmError('invalid_time', String(input.at));
  const hourOfDay = localHour(atMs, rules.timeZone);
  const level = sleepiness(pressure, hourOfDay, rules);
  return {
    pressure,
    hourOfDay,
    circadian: circadian(hourOfDay, rules),
    sleepiness: level,
    sleepy: level >= rules.theta,
    canHoldOn: level < rules.theta + rules.delta,
    mustSleep: level >= rules.theta + rules.delta,
    canWake: level <= rules.wakeTheta,
  };
}

/** Advances pressure across a stretch of being awake or asleep. */
export function advance(input) {
  if (input === null || typeof input !== 'object') throw new LifeRhythmError('invalid_input');
  const rules = { ...RHYTHM, ...(input.rules ?? {}) };
  const hours = requireHours(input.hours, 'hours');
  if (input.state !== 'awake' && input.state !== 'asleep') throw new LifeRhythmError('invalid_state', String(input.state));
  const next = input.state === 'asleep'
    ? pressureAsleep(input.pressure, hours, rules)
    : pressureAwake(input.pressure, hours, rules);
  return Math.min(1, Math.max(0, next));
}
