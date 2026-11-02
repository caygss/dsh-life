/**
 * What the agent does while asleep.
 *
 * Sleep is the biggest "a stretch has ended" moment of the day, so this is when the
 * day gets digested: any stretch that never became a memory is compressed now. The
 * point is that the agent wakes up to "yesterday is over", not to a queue of unprocessed
 * hours.
 *
 * Deliberately does NOT do the diary or the weight update yet: those need the room
 * and the calibrated weights (the experiment). They are listed in the plan, not
 * pretended here.
 */
import { readRange } from '../store/events.mjs';
import { splitSegments } from './segments.mjs';
import { compressAndStore } from './pipeline.mjs';
import { listPackages } from './packages.mjs';
import { listPendingStretches } from './attempts.mjs';

export class LifeConsolidationError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifeConsolidationError';
    this.code = code;
  }
}

/** Stretches in the range that no active package covers yet. */
export function pendingSegments(store, fromSeq, toSeq, options = {}) {
  const events = readRange(store, fromSeq, toSeq);
  const overrides = options.boundaryKinds === undefined ? {} : { boundaryOnlyKinds: options.boundaryKinds };
  const { segments } = splitSegments(events, overrides);
  const covered = listPackages(store).map((pkg) => [pkg.startSeq, pkg.endSeq]);
  return {
    segments,
    events,
    pending: segments.filter((segment) => !covered.some(([start, end]) => start <= segment.startSeq && end >= segment.endSeq)),
  };
}

/**
 * Compresses every un-packaged stretch in the range. Idempotent: running it twice does
 * not create duplicates, and a failure stays pending for the next attempt.
 */
export async function consolidateRange(input) {
  if (input === null || typeof input !== 'object') throw new LifeConsolidationError('invalid_input');
  const { store, summarise } = input;
  if (store === null || typeof store !== 'object') throw new LifeConsolidationError('missing_store');
  const fromSeq = Number(input.fromSeq);
  const toSeq = Number(input.toSeq);
  if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq) || toSeq < fromSeq) {
    throw new LifeConsolidationError('invalid_range', fromSeq + '..' + toSeq);
  }

  const { events, pending, segments } = pendingSegments(store, fromSeq, toSeq, input.options);
  const results = [];
  for (const segment of pending) {
    const slice = events.filter((event) => event.seq >= segment.startSeq && event.seq <= segment.endSeq);
    results.push({ range: segment.startSeq + '-' + segment.endSeq, ...(await compressAndStore({ store, summarise, segment, events: slice, addressed: input.addressed === true })) });
  }
  return {
    segments: segments.length,
    pending: pending.length,
    compressed: results.filter((entry) => entry.ok).length,
    failed: results.filter((entry) => !entry.ok).length,
    stillPending: listPendingStretches(store).length,
    results,
  };
}
