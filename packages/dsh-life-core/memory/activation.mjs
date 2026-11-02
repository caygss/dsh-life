/**
 * Activation records for the A factor.
 *
 * The design: activation follows ACT-R, and it counts only the times *the agent*
 * actually brought something to mind - never system exposure. So a row is written
 * when a memory is selected into it frame, not when it is merely indexed.
 *
 * A(t) = ln(sum over its recalls of (now - t)^-0.5), in seconds. Older recalls
 * decay with a square-root curve; many recent recalls add up.
 */
import { LifeStoreError } from '../store/db.mjs';

/** Seconds, floored so a recall "just now" cannot divide by zero into Infinity. */
const MIN_GAP_SECONDS = 1;

/**
 * ACT-R activation is a log, so it is normally negative. A package with no recall
 * history must not therefore score *higher* than one the agent thought about a minute ago,
 * so "never recalled" sits at the floor rather than at zero.
 */
export const ACTIVATION_FLOOR = -4;

export function recordActivation(store, packageId, at) {
  if (typeof packageId !== 'string' || packageId === '') throw new LifeStoreError('invalid_package_id');
  const when = typeof at === 'string' && at !== '' ? at : new Date().toISOString();
  if (!Number.isFinite(Date.parse(when))) throw new LifeStoreError('invalid_activation_time', String(at));
  return store.atomic((db) => {
    db.prepare('INSERT INTO life_activation(package_id, recalled_at) VALUES(?,?)').run(packageId, when);
    return { packageId, at: when };
  });
}

export function readActivations(store, packageId) {
  return store.db.prepare('SELECT recalled_at FROM life_activation WHERE package_id=? ORDER BY recalled_at')
    .all(String(packageId)).map((row) => row.recalled_at);
}

/** Union of every package that has at least one recall, for one query. */
export function readAllActivations(store) {
  const rows = store.db.prepare('SELECT package_id, recalled_at FROM life_activation ORDER BY package_id, recalled_at').all();
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.package_id)) map.set(row.package_id, []);
    map.get(row.package_id).push(row.recalled_at);
  }
  return map;
}

/**
 * ACT-R activation. Returns 0 for a package with no recall history: no activation
 * base rather than a negative number that would silently behave like a penalty.
 */
export function activationValue(timestamps, nowMs) {
  if (!Array.isArray(timestamps) || timestamps.length === 0) return ACTIVATION_FLOOR;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  let sum = 0;
  for (const stamp of timestamps) {
    const at = typeof stamp === 'number' ? stamp : Date.parse(stamp);
    if (!Number.isFinite(at)) continue;
    const gap = Math.max(MIN_GAP_SECONDS, (now - at) / 1000);
    sum += Math.pow(gap, -0.5);
  }
  if (sum <= 0) return ACTIVATION_FLOOR;
  return Math.max(ACTIVATION_FLOOR, Math.log(sum));
}
