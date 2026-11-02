/**
 * Rolling a whole stretch out of the live context.
 *
 * Rolling is compression: the oldest day leaves the in-context history, its words are
 * already archived in the append-only log, and its packages stay searchable. Nothing
 * is deleted, and the cutoff is recorded so "what is still in view" is a fact rather
 * than a guess.
 *
 * Safety property enforced here: a roll is refused when any *content* event in the
 * range has no active package covering it. Boundary markers (state changes) are
 * exempt because they are never package content by design. Without this check a roll
 * could quietly drop moments from it view that no package can ever bring back.
 *
 * Lazy rolling: rolling is not a schedule. Nothing here
 * happens on its own; a host calls rollToFit only when the measured context is nearly
 * full. Real words in the context beat recalled packages, so the live window stays whole
 * for as long as it fits, and when a roll finally happens it only takes away what a
 * package can already answer for.
 */
import { LifeStoreError } from '../store/db.mjs';
import { estimateTokens } from '../tokens.mjs';

export const ROLL_BOUNDARY_KINDS = Object.freeze(['state']);

export class LifeRollError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifeRollError';
    this.code = code;
  }
}

export function lastRoll(store) {
  const row = store.db.prepare('SELECT * FROM life_rolls ORDER BY to_seq DESC LIMIT 1').get();
  if (row === undefined) return null;
  return {
    id: row.id,
    fromSeq: Number(row.from_seq),
    toSeq: Number(row.to_seq),
    packageIds: JSON.parse(row.package_ids_json),
    committedAt: row.committed_at,
  };
}

export function rolledThroughSeq(store) {
  return lastRoll(store)?.toSeq ?? 0;
}

/** Events still inside the live window, oldest first. */
export function activeHistory(store, options = {}) {
  const from = rolledThroughSeq(store);
  const limit = Number.isInteger(options.limit) ? options.limit : 10_000;
  return store.db.prepare('SELECT * FROM life_events WHERE seq > ? ORDER BY seq LIMIT ?').all(from, limit)
    .map((row) => ({ seq: Number(row.seq), at: row.at, kind: row.kind, role: row.role, text: row.text }));
}

/** Content events in (from, to] that no active package covers. */
export function uncoveredContentEvents(store, fromSeq, toSeq, boundaryKinds = ROLL_BOUNDARY_KINDS) {
  const placeholders = boundaryKinds.map(() => '?').join(',');
  return store.db.prepare(
    'SELECT e.seq FROM life_events e ' +
    'WHERE e.seq > ? AND e.seq <= ? ' +
    'AND e.kind NOT IN (' + placeholders + ') ' +
    "AND NOT EXISTS (SELECT 1 FROM life_packages p WHERE p.status='active' AND p.start_seq <= e.seq AND p.end_seq >= e.seq) " +
    'ORDER BY e.seq',
  ).all(fromSeq, toSeq, ...boundaryKinds).map((row) => Number(row.seq));
}

/**
 * Commits a roll: records the cutoff and the packages that cover it.
 * @returns {{roll:object, packages:string[], uncovered:number[]}}
 */
export function commitRoll(store, input = {}) {
  if (input === null || typeof input !== 'object') throw new LifeRollError('invalid_input');
  const toSeq = Number(input.toSeq);
  if (!Number.isInteger(toSeq) || toSeq <= 0) throw new LifeRollError('invalid_to_seq', String(input.toSeq));

  return store.atomic((db) => {
    const fromSeq = store.db.prepare('SELECT COALESCE(MAX(to_seq), 0) AS m FROM life_rolls').get().m;
    if (toSeq <= Number(fromSeq)) throw new LifeRollError('roll_not_forward', toSeq + ' <= ' + fromSeq);

    const uncovered = uncoveredContentEvents(store, Number(fromSeq), toSeq, input.boundaryKinds ?? ROLL_BOUNDARY_KINDS);
    if (uncovered.length > 0) {
      throw new LifeRollError('roll_uncovered_content', uncovered.slice(0, 10).join(','));
    }

    const packages = store.db.prepare("SELECT id FROM life_packages WHERE status='active' AND end_seq > ? AND start_seq <= ? ORDER BY start_seq")
      .all(Number(fromSeq), toSeq).map((row) => row.id);
    const id = input.id ?? 'roll-' + toSeq;
    const committedAt = typeof input.at === 'string' && input.at !== '' ? input.at : new Date().toISOString();
    db.prepare('INSERT INTO life_rolls(id, from_seq, to_seq, package_ids_json, committed_at) VALUES(?,?,?,?,?)')
      .run(id, Number(fromSeq), toSeq, JSON.stringify(packages), committedAt);
    return {
      roll: { id, fromSeq: Number(fromSeq), toSeq, packageIds: packages, committedAt },
      packages,
      uncovered: [],
    };
  });
}
/** Roles that are its side of the conversation. Bookkeeping (system receipts, tool rows)
 * never enters a fresh context: it is memory, not something either of them said. */
export const LIVE_WINDOW_ROLES = Object.freeze(['user', 'assistant']);

/**
 * How much of its own speech the live window may keep. Owner's call : the agent
 * said the agent would rather have the real words in the context than a recall of them, so the
 * default is generous. It is a ceiling, not a schedule: nothing rolls until the context
 * itself is nearly full.
 */
export const DEFAULT_ROLL_KEEP_TOKENS = 120_000;

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * What a fresh context would carry: its speech (both sides) still inside the window.
 * @returns {{fromSeq:number, events:number, tokens:number, chars:number,
 * firstSeq:number|null, lastSeq:number|null, parts:Array}}
 */
export function liveWindow(store, options = {}) {
  const after = Number.isInteger(options.afterSeq) ? options.afterSeq : rolledThroughSeq(store);
  const rows = store.db.prepare(
    "SELECT seq, at, role, kind, text FROM life_events WHERE seq > ? AND role IN ('user','assistant') ORDER BY seq",
  ).all(after);
  const parts = rows.map((row) => {
    const text = typeof row.text === 'string' ? row.text : '';
    return {
      seq: Number(row.seq),
      at: row.at,
      role: row.role,
      kind: row.kind,
      text,
      chars: text.length,
      tokens: estimateTokens(text),
    };
  });
  let tokens = 0;
  let chars = 0;
  for (const part of parts) {
    tokens += part.tokens;
    chars += part.chars;
  }
  return {
    fromSeq: after,
    events: parts.length,
    tokens,
    chars,
    firstSeq: parts.length === 0 ? null : parts[0].seq,
    lastSeq: parts.length === 0 ? null : parts[parts.length - 1].seq,
    parts,
  };
}

/**
 * The newest stretch of the live window that fits a token budget. Everything older is
 * what a roll may take away; nothing here is ever dropped from the log.
 */
export function seedSlice(store, options = {}) {
  const keepTokens = positiveInteger(options.keepTokens, DEFAULT_ROLL_KEEP_TOKENS);
  const window = liveWindow(store);
  const parts = [];
  let tokens = 0;
  let chars = 0;
  for (let index = window.parts.length - 1; index >= 0; index -= 1) {
    const part = window.parts[index];
 // The newest word always fits, even when it alone is bigger than the budget: a fresh
 // context that cannot hold the last thing the agent said is not a fresh context.
    if (parts.length > 0 && tokens + part.tokens > keepTokens) break;
    parts.unshift(part);
    tokens += part.tokens;
    chars += part.chars;
  }
  return {
    keepTokens,
    parts,
    events: parts.length,
    tokens,
    chars,
    windowTokens: window.tokens,
    windowEvents: window.events,
    droppedEvents: window.events - parts.length,
    droppedTokens: window.tokens - tokens,
    fromSeq: window.fromSeq,
  };
}

/**
 * Works out the smallest forward roll that leaves the live window inside the budget.
 * Never commits anything and never guesses: when the oldest part that would leave is not
 * covered by an active package, the cutoff stops right in front of it.
 * @returns {{needed:boolean, reason:string, fromSeq:number, toSeq:number|null,
 * keepTokens:number, keptTokens:number, keptEvents:number, freedTokens:number,
 * droppedEvents:number}}
 */
export function planRoll(store, options = {}) {
  const keepTokens = positiveInteger(options.keepTokens, DEFAULT_ROLL_KEEP_TOKENS);
  const fromSeq = rolledThroughSeq(store);
  const window = liveWindow(store);
  if (window.tokens <= keepTokens) {
    return {
      needed: false, reason: 'fits', fromSeq, toSeq: null, keepTokens,
      keptTokens: window.tokens, keptEvents: window.events, freedTokens: 0, droppedEvents: 0,
    };
  }
  const slice = seedSlice(store, { keepTokens });
  if (slice.parts.length === 0) {
    return {
      needed: false, reason: 'nothing_to_keep', fromSeq, toSeq: null, keepTokens,
      keptTokens: window.tokens, keptEvents: window.events, freedTokens: 0, droppedEvents: 0,
    };
  }
  let toSeq = slice.parts[0].seq - 1;
  const uncovered = uncoveredContentEvents(store, fromSeq, toSeq);
  if (uncovered.length > 0) toSeq = uncovered[0] - 1;
  if (toSeq <= fromSeq) {
    return {
      needed: false, reason: 'nothing_rollable', fromSeq, toSeq: null, keepTokens,
      keptTokens: window.tokens, keptEvents: window.events, freedTokens: 0, droppedEvents: 0,
    };
  }
  const kept = liveWindow(store, { afterSeq: toSeq });
  return {
    needed: true,
    reason: 'over_budget',
    fromSeq,
    toSeq,
    keepTokens,
    keptTokens: kept.tokens,
    keptEvents: kept.events,
    freedTokens: window.tokens - kept.tokens,
    droppedEvents: window.events - kept.events,
  };
}

/**
 * Rolls only as far as the budget needs, and only over stretches a package covers.
 * @returns {{rolled:boolean,..plan, roll?:object}}
 */
export function rollToFit(store, options = {}) {
  const plan = planRoll(store, options);
  if (plan.needed !== true) return { rolled: false, ...plan };
  const committed = commitRoll(store, { toSeq: plan.toSeq, at: options.at });
  return { rolled: true, ...plan, roll: committed.roll };
}
