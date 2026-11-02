/**
 * Package records: one compressed stretch of experience.
 *
 * Written after compression succeeded, and always with the log range it came from,
 * so unpacking can walk back to the original words.
 */
import { LifeStoreError } from '../store/db.mjs';

const STATUSES = ['active', 'withdrawn'];

function requireString(value, field) {
  if (typeof value !== 'string' || value === '') throw new LifeStoreError('invalid_package_' + field);
  return value;
}

function toPackage(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    kind: row.kind,
    status: row.status,
    text: row.text,
    tokens: Number(row.tokens),
    startSeq: Number(row.start_seq),
    endSeq: Number(row.end_seq),
    importance: Number(row.importance),
    links: row.links_json === '[]' ? [] : JSON.parse(row.links_json),
    occurredAt: row.occurred_at ?? null,
    subjects: row.subjects_json === '[]' ? [] : JSON.parse(row.subjects_json),
    ordinal: row.ordinal === null || row.ordinal === undefined ? null : Number(row.ordinal),
  };
}

/**
 * Addressable fields (schema v3). All three are optional so old callers keep working,
 * but a package without them can only be found by "this text looks similar", which is
 * exactly the failure this column set exists to fix.
 */
function normaliseAddress(draft) {
  let occurredAt = null;
  if (draft.occurredAt !== undefined && draft.occurredAt !== null) {
    if (typeof draft.occurredAt !== 'string' || !Number.isFinite(Date.parse(draft.occurredAt))) {
      throw new LifeStoreError('invalid_package_occurred_at', String(draft.occurredAt));
    }
    occurredAt = new Date(Date.parse(draft.occurredAt)).toISOString();
  }
  const rawSubjects = draft.subjects === undefined || draft.subjects === null ? [] : draft.subjects;
  if (!Array.isArray(rawSubjects)) throw new LifeStoreError('invalid_package_subjects');
  const subjects = [];
  for (const subject of rawSubjects) {
    if (typeof subject !== 'string') throw new LifeStoreError('invalid_package_subject', String(subject));
    const trimmed = subject.trim();
    if (trimmed === '' || trimmed.length > 40) throw new LifeStoreError('invalid_package_subject_length', trimmed);
    if (!subjects.includes(trimmed)) subjects.push(trimmed);
    if (subjects.length >= 8) break;
  }
  let ordinal = null;
  if (draft.ordinal !== undefined && draft.ordinal !== null) {
    ordinal = Number(draft.ordinal);
    if (!Number.isInteger(ordinal) || ordinal < 1) throw new LifeStoreError('invalid_package_ordinal', String(draft.ordinal));
  }
  return { occurredAt, subjects, ordinal };
}

/**
 * Inserts one package inside a transaction the caller already opened. Split out of
 * writePackage because a correction (corrected.mjs) has to withdraw the old package, insert
 * its replacement and record the pointer in ONE transaction - a half-applied correction
 * would leave it with neither version. Validation and the overlap guard are unchanged.
 */
export function insertPackage(db, draft) {
  if (draft === null || typeof draft !== 'object') throw new LifeStoreError('invalid_package');
  const id = requireString(draft.id, 'id');
  const kind = requireString(draft.kind ?? 'segment', 'kind');
  const status = draft.status ?? 'active';
  if (!STATUSES.includes(status)) throw new LifeStoreError('invalid_package_status', String(status));
  const text = requireString(draft.text, 'text');
  const createdAt = typeof draft.createdAt === 'string' && draft.createdAt !== '' ? draft.createdAt : new Date().toISOString();
  const tokens = Number.isInteger(draft.tokens) ? draft.tokens : 0;
  const startSeq = Number(draft.startSeq);
  const endSeq = Number(draft.endSeq);
  if (!Number.isInteger(startSeq) || !Number.isInteger(endSeq) || endSeq < startSeq) {
    throw new LifeStoreError('invalid_package_range', startSeq + '..' + endSeq);
  }
  const importance = draft.importance === undefined ? 3 : Number(draft.importance);
  if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
    throw new LifeStoreError('invalid_package_importance', String(draft.importance));
  }
  const address = normaliseAddress(draft);
  const overlapping = db.prepare('SELECT id FROM life_packages WHERE status=? AND start_seq<=? AND end_seq>=?')
    .get('active', endSeq, startSeq);
  if (overlapping !== undefined) throw new LifeStoreError('package_range_overlap', String(overlapping.id));
  db.prepare('INSERT INTO life_packages(id, created_at, kind, status, text, tokens, start_seq, end_seq, importance, links_json, occurred_at, subjects_json, ordinal) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, createdAt, kind, status, text, tokens, startSeq, endSeq, importance, JSON.stringify(draft.links ?? []),
      address.occurredAt, JSON.stringify(address.subjects), address.ordinal);
  return readPackage(db, id);
}

export function writePackage(store, draft) {
  if (store === null || typeof store !== 'object' || typeof store.atomic !== 'function') {
    throw new LifeStoreError('invalid_store');
  }
  return store.atomic((db) => insertPackage(db, draft));
}

function readPackage(db, id) {
  const row = db.prepare('SELECT * FROM life_packages WHERE id=?').get(id);
  return row === undefined ? null : toPackage(row);
}

export function getPackage(store, id) {
  return readPackage(store.db, String(id));
}

export function listPackages(store, options = {}) {
  const status = options.status ?? 'active';
  const limit = Number.isInteger(options.limit) ? options.limit : 100;
  return store.db.prepare('SELECT * FROM life_packages WHERE status=? ORDER BY start_seq LIMIT ?')
    .all(status, limit).map(toPackage);
}

export function countPackages(store, status = 'active') {
  return Number(store.db.prepare('SELECT COUNT(*) AS n FROM life_packages WHERE status=?').get(status).n);
}
