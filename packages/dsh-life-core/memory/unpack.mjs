/**
 * Unpack a memory package back to the words it came from.
 *
 * The package is an index; the log is the content. So unpacking reads the recorded
 * seq range from life_events and renders it. It never rewrites, summarises or
 * re-orders the events.
 *
 * Budget: one unpack is capped. When the range is
 * larger than the budget the *beginning* of the stretch is returned and the caller is
 * told it was truncated, so a long day cannot silently flood the context.
 */
import { LifeStoreError } from '../store/db.mjs';
import { estimateTokens } from '../tokens.mjs';
import { getPackage } from './packages.mjs';

export const DEFAULT_UNPACK = Object.freeze({ maxTokens: 20_000, allowWithdrawn: false });

export class LifeUnpackError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifeUnpackError';
    this.code = code;
  }
}

function who(role) {
  if (role === 'user') return '对方';
  if (role === 'assistant') return '助手';
  if (role === 'tool') return '回执';
  return role;
}

export function renderEvent(event) {
  if (event === null || typeof event !== 'object') throw new LifeUnpackError('invalid_event');
  return '[' + event.at + '] ' + who(event.role) + '：' + event.text;
}

export function renderEvents(events) {
  if (!Array.isArray(events)) throw new LifeUnpackError('invalid_events');
  return events.map(renderEvent).join('\n');
}

/**
 * @returns {{package:object, events:Array, text:string, tokens:number, truncated:boolean, droppedEvents:number}}
 */
export function unpackPackage(store, packageId, options = {}) {
  if (store === null || typeof store !== 'object' || typeof store.db !== 'object') throw new LifeUnpackError('missing_store');
  const settings = { ...DEFAULT_UNPACK, ...(options ?? {}) };
  if (!Number.isInteger(settings.maxTokens) || settings.maxTokens <= 0) throw new LifeUnpackError('invalid_max_tokens');

  const record = getPackage(store, packageId);
  if (record === null) throw new LifeUnpackError('package_not_found', String(packageId));
  if (record.status === 'withdrawn' && settings.allowWithdrawn !== true) {
    throw new LifeUnpackError('package_withdrawn', String(packageId));
  }

  const rows = store.db.prepare('SELECT * FROM life_events WHERE seq BETWEEN ? AND ? ORDER BY seq')
    .all(record.startSeq, record.endSeq);
  const events = rows.map((row) => ({
    seq: Number(row.seq), at: row.at, kind: row.kind, role: row.role, text: row.text,
  }));
  if (events.length === 0) throw new LifeUnpackError('package_range_empty', record.startSeq + '..' + record.endSeq);

  const kept = [];
  let tokens = 0;
  for (const event of events) {
    const line = renderEvent(event);
    const cost = estimateTokens(line) + 1;
    if (tokens + cost > settings.maxTokens) break;
    kept.push(line);
    tokens += cost;
  }
  if (kept.length === 0) {
 // The very first event is bigger than the whole budget. Say so rather than
 // returning an empty unpack that looks like "nothing was there".
    throw new LifeUnpackError('unpack_budget_too_small', String(settings.maxTokens));
  }

  return {
    package: record,
    events: events.slice(0, kept.length),
    text: kept.join('\n'),
    tokens,
    truncated: kept.length < events.length,
    droppedEvents: events.length - kept.length,
  };
}
