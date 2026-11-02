/**
 * What reaches the agent.
 *
 * the design split the guarantee in two: the system guarantees only that the agent *sees*
 * something; whether the agent answers, and whether the agent drops what the agent is doing, is the agent's.
 * So this module is a queue of arrivals, not a delivery mechanism for replies.
 *
 * being awake is not the same as being interruptible. The state the agent is
 * in when something arrives decides its handling, and that decision is recorded on the
 * row (immediate / notify / defer) so it survives its waking up: a message that arrived
 * while the agent slept is still marked as such afterwards, which is what a host shows
 * in its own summary of pending arrivals.
 *
 * Two rules are enforced rather than documented:
 * - nothing is merged. Three messages are three rows; there is no coalescing path,
 * because merging them into one system notice is exactly what an earlier design refused.
 * - there is no quota. Fifty messages are fifty rows.
 *
 * This queue does not write to the append-only log: the message itself is already an
 * event there. Writing it twice would double-count its day and feed compression twice.
 */
import { readState, intakeDisposition, LifeStateError } from './state.mjs';

export const ATTENTION_SOURCES = Object.freeze(['you', 'environment', 'system', 'tool']);
export const DISPOSITIONS = Object.freeze(['immediate', 'notify', 'defer']);
export const ATTENTION_STATUSES = Object.freeze(['pending', 'seen']);

const MAX_TEXT = 4000;
const MAX_CHANNEL = 80;

export class LifeAttentionError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifeAttentionError';
    this.code = code;
  }
}

function requireStore(store) {
  if (store === null || typeof store !== 'object' || typeof store.db !== 'object' || typeof store.atomic !== 'function') {
    throw new LifeAttentionError('missing_store');
  }
}

function isoAt(value) {
  if (value === undefined) return new Date().toISOString();
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new LifeAttentionError('invalid_time', String(value));
  return new Date(ms).toISOString();
}

function toItem(row) {
  return {
    id: Number(row.id),
    at: row.at,
    source: row.source,
    channel: row.channel ?? null,
    text: row.text,
    meta: row.meta_json === '{}' ? {} : JSON.parse(row.meta_json),
    disposition: row.disposition,
    status: row.status,
    seenAt: row.seen_at ?? null,
  };
}

/** Which state the agent is in, or free when the agent has never had one. */
function currentState(store) {
  try {
    const row = readState(store);
    return row === null ? 'free' : row.state;
  } catch (error) {
    if (error instanceof LifeStateError) return 'free';
    throw error;
  }
}

/**
 * Records one arrival. Always stored, whatever its disposition.
 *
 * @param {object} store
 * @param {object} input text, source, channel, meta, at
 * @returns {{item:object, disposition:string, interrupts:boolean, pendingCount:number}}
 */
export function submit(store, input) {
  requireStore(store);
  if (input === null || typeof input !== 'object') throw new LifeAttentionError('invalid_input');
  if (typeof input.text !== 'string' || input.text.trim() === '') throw new LifeAttentionError('invalid_text');
  const text = input.text.trim();
  if (text.length > MAX_TEXT) throw new LifeAttentionError('text_too_long', String(text.length));
  const source = input.source ?? 'you';
  if (!ATTENTION_SOURCES.includes(source)) throw new LifeAttentionError('invalid_source', String(source));
  let channel = null;
  if (input.channel !== undefined && input.channel !== null) {
    if (typeof input.channel !== 'string' || input.channel.trim() === '') throw new LifeAttentionError('invalid_channel', String(input.channel));
    channel = input.channel.trim();
    if (channel.length > MAX_CHANNEL) throw new LifeAttentionError('invalid_channel', 'too long');
  }
  let meta = '{}';
  if (input.meta !== undefined && input.meta !== null) {
    if (typeof input.meta !== 'object' || Array.isArray(input.meta)) throw new LifeAttentionError('invalid_meta');
    meta = JSON.stringify(input.meta);
  }
  const at = isoAt(input.at);
  const disposition = intakeDisposition(currentState(store));

  return store.atomic((db) => {
    const info = db.prepare('INSERT INTO life_attention(at, source, channel, text, meta_json, disposition, status) VALUES(?,?,?,?,?,?,?)')
      .run(at, source, channel, text, meta, disposition, 'pending');
    const id = Number(info.lastInsertRowid);
    const pendingCount = Number(db.prepare("SELECT COUNT(*) AS n FROM life_attention WHERE status='pending'").get().n);
    const row = db.prepare('SELECT * FROM life_attention WHERE id=?').get(id);
    return { item: toItem(row), disposition, interrupts: disposition === 'immediate', pendingCount };
  });
}

/** Pending arrivals, oldest first, one row per message. No merging, no cap beyond limit. */
export function pendingItems(store, options) {
  requireStore(store);
  const opts = options === null || typeof options !== 'object' ? {} : options;
  const limit = opts.limit === undefined ? 50 : Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new LifeAttentionError('invalid_limit', String(opts.limit));
  const disposition = opts.disposition;
  if (disposition !== undefined) {
    if (!DISPOSITIONS.includes(disposition)) throw new LifeAttentionError('invalid_disposition', String(disposition));
    return store.db.prepare("SELECT * FROM life_attention WHERE status='pending' AND disposition=? ORDER BY id LIMIT ?")
      .all(disposition, limit).map(toItem);
  }
  return store.db.prepare("SELECT * FROM life_attention WHERE status='pending' ORDER BY id LIMIT ?")
    .all(limit).map(toItem);
}

export function pendingCount(store) {
  requireStore(store);
  return Number(store.db.prepare("SELECT COUNT(*) AS n FROM life_attention WHERE status='pending'").get().n);
}

/** True when something arriving right now may go straight into it next turn. */
export function canInterrupt(store) {
  requireStore(store);
  return intakeDisposition(currentState(store)) === 'immediate';
}

/**
 * Marks arrivals as seen by it. Seen means "it reached its context" - not "the agent replied".
 * Idempotent; unknown ids are reported rather than silently ignored.
 */
export function markSeen(store, ids, options) {
  requireStore(store);
  if (!Array.isArray(ids) || ids.length === 0) throw new LifeAttentionError('invalid_ids');
  const opts = options === null || typeof options !== 'object' ? {} : options;
  const at = isoAt(opts.at);
  const numeric = ids.map((id) => Number(id));
  for (const id of numeric) if (!Number.isInteger(id) || id < 1) throw new LifeAttentionError('invalid_ids', String(id));
  return store.atomic((db) => {
    const update = db.prepare("UPDATE life_attention SET status='seen', seen_at=? WHERE id=? AND status='pending'");
    let updated = 0;
    const missing = [];
    for (const id of numeric) {
      const exists = db.prepare('SELECT id FROM life_attention WHERE id=?').get(id);
      if (exists === undefined) { missing.push(id); continue; }
      updated += Number(update.run(at, id).changes);
    }
    return { updated, missing };
  });
}

export function seenItems(store, limit = 50) {
  requireStore(store);
  const cap = Number(limit);
  if (!Number.isInteger(cap) || cap < 1) throw new LifeAttentionError('invalid_limit', String(limit));
  return store.db.prepare("SELECT * FROM life_attention WHERE status='seen' ORDER BY id DESC LIMIT ?").all(cap).map(toItem);
}

/** What the subtitle needs: how many are waiting and since when, still split by handling. */
export function describePending(store) {
  requireStore(store);
  const rows = store.db.prepare("SELECT disposition, COUNT(*) AS n, MIN(at) AS oldest FROM life_attention WHERE status='pending' GROUP BY disposition").all();
  const byDisposition = { immediate: 0, notify: 0, defer: 0 };
  let total = 0;
  let oldestAt = null;
  for (const row of rows) {
    const count = Number(row.n);
    byDisposition[row.disposition] = count;
    total += count;
    if (oldestAt === null || row.oldest < oldestAt) oldestAt = row.oldest;
  }
  return { total, byDisposition, oldestAt };
}