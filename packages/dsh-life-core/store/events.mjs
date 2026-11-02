/**
 * Append-only event log.
 *
 * The log is the only place original text lives, so two rules are enforced by the
 * database and not by the caller: no UPDATE, no DELETE (see the triggers in db.mjs).
 * Everything downstream — compression, unpacking, rolling — reads from here, and a
 * rolled-out day is archived, never erased.
 */
import { LifeStoreError } from './db.mjs';

export const EVENT_ROLES = Object.freeze(['user', 'assistant', 'system', 'tool']);
export const EVENT_KINDS = Object.freeze(['spoken', 'thought', 'action', 'observation', 'state', 'note', 'reply', 'opening']);

function requireText(value, field) {
  if (typeof value !== 'string' || value === '') throw new LifeStoreError('invalid_event_text', field);
  return value;
}

function requireEnum(value, allowed, field) {
  if (!allowed.includes(value)) throw new LifeStoreError('invalid_event_' + field, String(value));
  return value;
}

function normalizeMeta(meta) {
  if (meta === undefined) return '{}';
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) throw new LifeStoreError('invalid_event_meta');
  return JSON.stringify(meta);
}

function toRow(row) {
  return {
    seq: Number(row.seq),
    at: row.at,
    kind: row.kind,
    role: row.role,
    text: row.text,
    meta: row.meta_json === '{}' ? {} : JSON.parse(row.meta_json),
  };
}

/** Appends one event and returns its sequence number. */
export function appendEvent(store, event) {
  if (event === null || typeof event !== 'object') throw new LifeStoreError('invalid_event');
  const at = typeof event.at === 'string' && event.at !== '' ? event.at : new Date().toISOString();
  const kind = requireEnum(event.kind ?? 'spoken', EVENT_KINDS, 'kind');
  const role = requireEnum(event.role ?? 'user', EVENT_ROLES, 'role');
  const text = requireText(event.text, 'text');
  const meta = normalizeMeta(event.meta);
  return store.atomic((db) => {
    const info = db.prepare('INSERT INTO life_events(at, kind, role, text, meta_json) VALUES(?,?,?,?,?)')
      .run(at, kind, role, text, meta);
    return Number(info.lastInsertRowid);
  });
}

/** Reads an inclusive seq range. */
export function readRange(store, fromSeq, toSeq) {
  const from = Number(fromSeq);
  const to = Number(toSeq);
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) {
    throw new LifeStoreError('invalid_range', fromSeq + '..' + toSeq);
  }
  return store.db.prepare('SELECT * FROM life_events WHERE seq BETWEEN ? AND ? ORDER BY seq').all(from, to).map(toRow);
}

export function readAfter(store, seq, limit = 1000) {
  const from = Number(seq);
  const cap = Number(limit);
  if (!Number.isInteger(from) || from < 0) throw new LifeStoreError('invalid_seq', String(seq));
  if (!Number.isInteger(cap) || cap <= 0) throw new LifeStoreError('invalid_limit', String(limit));
  return store.db.prepare('SELECT * FROM life_events WHERE seq > ? ORDER BY seq LIMIT ?').all(from, cap).map(toRow);
}

export function readOne(store, seq) {
  const row = store.db.prepare('SELECT * FROM life_events WHERE seq=?').get(Number(seq));
  return row === undefined ? null : toRow(row);
}

export function countEvents(store) {
  return Number(store.db.prepare('SELECT COUNT(*) AS n FROM life_events').get().n);
}

export function lastSeq(store) {
  const row = store.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM life_events').get();
  return Number(row.m);
}
