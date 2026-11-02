/**
 * Segment detection.
 *
 * A segment is "one stretch of experience" — the unit that later becomes one
 * compressed memory package (an earlier design: ten-odd minutes up to a few
 * hours, time-adjacent and on one topic).
 *
 * This task implements the time/state/day/duration rules only. Topic coherence
 * needs vectors, so it is not claimed here; split reasons are recorded so a later
 * pass can add a coherence rule without rewriting this one.
 *
 * Rules, checked in this order when an event arrives while a segment is open:
 * 1. idle - the gap since the previous event exceeds idleGapMs
 * 2. day - the local calendar day changed
 * 3. state - the event is a boundary marker (a state change starts a stretch)
 * 4. duration - the open segment has already reached maxSegmentMs
 *
 * Boundary markers split a stretch but are not content, so a stretch with no
 * content events is dropped rather than kept as an empty package.
 *
 * A stretch smaller than minEvents / minChars is not its own memory: it folds into the
 * previous segment when the cut that created it was a state change (not idle/day/duration)
 * and no waking boundary sits in between. That is the fix for the production test
 * finding - a lone "在忙吗？" becoming a package that describes the record instead of the
 * day and scores mid-range against every query.
 */

export const DEFAULT_SEGMENT_RULES = Object.freeze({
 // Measured in the first real day: its own turns are 5-70 minutes apart, so a
 // 30-minute idle rule turned every single reply into its own one-line memory. With the
 // five-state machine writing boundaries, silence between two turns is not the end of a
 // stretch - sleep and state changes are. The idle rule now only catches a genuinely dead
 // log, and maxSegmentMs still caps a stretch at three hours.
  idleGapMs: 4 * 60 * 60 * 1000,
  maxSegmentMs: 3 * 60 * 60 * 1000,
  timeZone: 'UTC',
  boundaryOnlyKinds: Object.freeze(['state']),
 // production test : a state change next to one lone message produced a
 // one-line stretch ("在忙吗？"), which compressed into a memory that describes the record
 // instead of the day and scored mid-range against every query. A stretch smaller than
 // this is not its own memory; it joins the previous one when that is safe.
  minEvents: 2,
  minChars: 20,
 /** How far back a small stretch may be folded in. Same day, no waking in between. */
  mergeGapMs: 4 * 60 * 60 * 1000,
 /** How far forward it may be folded when nothing close precedes it (one awake period). */
  absorbGapMs: 12 * 60 * 60 * 1000,
});

export class LifeSegmentError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifeSegmentError';
    this.code = code;
  }
}

/** A boundary that ends sleep: content after it belongs to a new awake period. */
function isWakeBoundary(event) {
  const state = event !== null && typeof event === 'object' ? event.meta?.state : undefined;
  return state !== undefined && state !== null && typeof state === 'object'
    && (state.why === 'natural_wake' || state.why === 'called_wake');
}

const dayFormatters = new Map();

function dayFormatter(timeZone) {
  let formatter = dayFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function dayKey(iso, timeZone) {
  const parts = dayFormatter(timeZone).formatToParts(new Date(iso));
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return pick('year') + '-' + pick('month') + '-' + pick('day');
}

function requireRules(overrides) {
  const rules = { ...DEFAULT_SEGMENT_RULES, ...(overrides ?? {}) };
  if (!Number.isInteger(rules.idleGapMs) || rules.idleGapMs <= 0) throw new LifeSegmentError('invalid_idle_gap');
  if (!Number.isInteger(rules.maxSegmentMs) || rules.maxSegmentMs <= 0) throw new LifeSegmentError('invalid_max_segment');
  if (typeof rules.timeZone !== 'string' || rules.timeZone === '') throw new LifeSegmentError('invalid_time_zone');
  if (!Array.isArray(rules.boundaryOnlyKinds)) throw new LifeSegmentError('invalid_boundary_kinds');
  for (const key of ['minEvents', 'minChars', 'mergeGapMs', 'absorbGapMs']) {
    if (!Number.isInteger(rules[key]) || rules[key] < 0) throw new LifeSegmentError('invalid_merge_rule', key);
  }
  try { dayFormatter(rules.timeZone).format(new Date(0)); } catch { throw new LifeSegmentError('invalid_time_zone', rules.timeZone); }
  return rules;
}

/**
 * @param {Array<{seq:number, at:string, kind:string, text?:string}>} events ascending by seq
 * @param {object} [options] overrides for DEFAULT_SEGMENT_RULES
 */
export function splitSegments(events, options = {}) {
  if (!Array.isArray(events)) throw new LifeSegmentError('invalid_events');
  const rules = requireRules(options);

  const segments = [];
  const reasons = { idle: 0, day: 0, state: 0, duration: 0 };
  let open = null;
  let previous = null;
  let dropped = 0;
  let merged = 0;
  let lastCloseReason = null;
 // Set when a waking boundary has been seen since the last emitted segment. It stops a
 // small stretch right after waking from being folded back into the previous awake period.
  let sleepBrake = false;

  const smallEnoughToMerge = (segment) => segment.eventCount < rules.minEvents || segment.chars < rules.minChars;
 // idle / day / duration are real cuts: folding content back across them would undo the
 // rule that made the cut. A small stretch created by a state boundary is the case to fix.
  const mergeableReason = (closedBy) => closedBy !== 'idle' && closedBy !== 'day' && closedBy !== 'duration';

  const buildSegment = (closedBy) => {
    const kinds = {};
    let chars = 0;
    for (const event of open.content) {
      kinds[event.kind] = (kinds[event.kind] ?? 0) + 1;
      chars += typeof event.text === 'string' ? event.text.length : 0;
    }
    return {
      index: -1,
      startSeq: open.content[0].seq,
      endSeq: open.content[open.content.length - 1].seq,
      startAt: open.startAt,
      endAt: open.endAt,
      startTime: open.startTime,
      endTime: open.endTime,
      durationMs: open.endTime - open.startTime,
      eventCount: open.content.length,
      kinds,
      chars,
      openedBy: open.openedBy,
      closedBy,
      merged: 0,
      mergedRanges: [],
    };
  };

  const pushSegment = (segment) => {
    segment.index = segments.length;
    segments.push(segment);
    sleepBrake = false;
  };

 /** Folds `small` into `target`, either in front of it or behind it. */
  const absorbInto = (target, small, atFront) => {
    if (atFront) {
      target.startSeq = small.startSeq;
      target.startAt = small.startAt;
      target.startTime = small.startTime;
      target.openedBy = small.openedBy;
      target.mergedRanges.unshift([small.startSeq, small.endSeq]);
    } else {
      target.endSeq = small.endSeq;
      target.endAt = small.endAt;
      target.endTime = small.endTime;
      target.mergedRanges.push([small.startSeq, small.endSeq]);
    }
    target.durationMs = target.endTime - target.startTime;
    target.eventCount += small.eventCount;
    target.chars += small.chars;
    for (const [kind, count] of Object.entries(small.kinds)) {
      target.kinds[kind] = (target.kinds[kind] ?? 0) + count;
    }
    target.merged += 1;
    merged += 1;
  };

 // A stretch too small to be a memory waits here for something real to follow it, so it can
 // be folded into that instead of becoming a package on its own. Nothing is dropped: at
 // worst it is emitted as a segment by itself.
  let pendingSmall = null;
  let pendingWakeSince = false;

  const close = (closedBy) => {
    if (open === null) return;
    lastCloseReason = closedBy;
    if (open.content.length === 0) { dropped += 1; open = null; return; }
    const segment = buildSegment(closedBy);
    open = null;

    if (smallEnoughToMerge(segment)) {
      const previousSegment = segments.length === 0 ? null : segments[segments.length - 1];
      const canMergeBack = pendingSmall === null
        && previousSegment !== null
        && mergeableReason(closedBy)
        && mergeableReason(previousSegment.closedBy)
        && !sleepBrake
        && dayKey(segment.startAt, rules.timeZone) === dayKey(previousSegment.endAt, rules.timeZone)
        && segment.startTime - previousSegment.endTime <= rules.mergeGapMs;
      if (canMergeBack) { absorbInto(previousSegment, segment, false); return; }
      if (pendingSmall !== null) {
 // Two small stretches in a row join each other rather than becoming two memories.
        const canJoinPending = !pendingWakeSince
          && !sleepBrake
          && mergeableReason(closedBy)
          && mergeableReason(pendingSmall.closedBy)
          && dayKey(segment.startAt, rules.timeZone) === dayKey(pendingSmall.endAt, rules.timeZone)
          && segment.startTime - pendingSmall.endTime <= rules.absorbGapMs;
        if (canJoinPending) { absorbInto(pendingSmall, segment, false); return; }
        pushSegment(pendingSmall);
      }
      pendingSmall = segment;
      pendingWakeSince = false;
      return;
    }

    if (pendingSmall !== null) {
      const canAbsorbForward = !pendingWakeSince
        && !sleepBrake
        && segment.startTime - pendingSmall.endTime <= rules.absorbGapMs;
      if (canAbsorbForward) absorbInto(segment, pendingSmall, true);
      else pushSegment(pendingSmall);
      pendingSmall = null;
    }
    pushSegment(segment);
  };

  for (const event of events) {
    if (event === null || typeof event !== 'object') throw new LifeSegmentError('invalid_event');
    const time = Date.parse(event.at);
    if (!Number.isFinite(time)) throw new LifeSegmentError('invalid_event_time', String(event.at));
    if (previous !== null && !(event.seq > previous.seq)) {
      throw new LifeSegmentError('events_not_ascending', String(event.seq));
    }

    const isBoundary = rules.boundaryOnlyKinds.includes(event.kind);
    let split = null;
    if (open !== null) {
      if (time - open.lastTime > rules.idleGapMs) split = 'idle';
      else if (dayKey(event.at, rules.timeZone) !== dayKey(open.lastAt, rules.timeZone)) split = 'day';
      else if (time - open.startTime >= rules.maxSegmentMs) split = 'duration';
    }

    if (split !== null && !isBoundary) {
      reasons[split] += 1;
      close(split);
    }

    if (isBoundary) {
 // A state change is a boundary, not content, and it ends the open stretch whatever
 // the gap says. Labelling it 'state' (not 'idle') matters: the small-stretch fold
 // below keys off "this cut was a state change", and a lone line after a state change
 // was exactly the production failure.
      if (open !== null) { reasons.state += 1; close('state'); }
 // A waking boundary arms the brake *after* the close, so the stretch that ended
 // before waking may still be folded backwards while the new awake period may not.
      if (isWakeBoundary(event)) {
        sleepBrake = true;
        if (pendingSmall !== null) pendingWakeSince = true;
      }
      previous = event;
      continue;
    }

    if (open === null) {
      open = {
        openedBy: segments.length === 0 ? 'start' : lastCloseReason,
        startAt: event.at, endAt: event.at, startTime: time, lastTime: time, lastAt: event.at,
        content: [],
      };
    }
    open.endAt = event.at;
    open.endTime = time;
    open.lastTime = time;
    open.lastAt = event.at;
    open.content.push(event);
    previous = event;
  }

  close('end');
  if (pendingSmall !== null) pushSegment(pendingSmall);

  return {
    segments,
    stats: {
      eventCount: events.length,
      segmentCount: segments.length,
      dropped,
      merged,
      reasons,
      rules: { idleGapMs: rules.idleGapMs, maxSegmentMs: rules.maxSegmentMs, timeZone: rules.timeZone },
    },
  };
}
