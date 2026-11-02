/**
 * Correction closure.
 *
 * The owner's model, stated plainly: recall already hands it a group of memories, the agent
 * picks one, and picking the wrong sibling is not the interesting failure - 记错 is.
 * What has to work is the step after it: when the person says "不是那次，是上个月那天",
 * the correction has to *stick*. Three things make it stick, and all three happen in one
 * transaction:
 *
 * 1. the wrong package is withdrawn,
 * 2. a new package carrying the corrected text re-covers the *same log range*: the log
 * was never wrong, the compression or the telling of it was,
 * 3. a durable pointer 旧 -> 新 plus one log line, so the agent can later say "我记错过，
 * 助手纠正了我：那次其实是……".
 *
 * Without step 3 the wrong version disappears and the right one arrives with no relation
 * to it; both would be separate facts and the agent could keep mixing them.
 *
 * The replacement copies the old package's vector and keyword terms instead of calling a
 * model. That is deliberate, not a shortcut: the underlying source range is identical, no
 * model call belongs in a correction, and a package with no vector is invisible to
 * semantic recall - i.e. the correction would not be remembered at all. A later
 * re-embedding pass may overwrite the copy with `writeVector`; until then the copied
 * vector is an approximation under the same encoder name, and this comment is where that
 * is on the record.
 */
import { getPackage, insertPackage } from './packages.mjs';
import { extractTerms } from './encoder.mjs';
import { estimateTokens } from '../tokens.mjs';

/** Corrected memories stay short on purpose; a correction is a fix, not a new essay. */
const MAX_TEXT_CHARS = 500;

export class LifeCorrectionError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifeCorrectionError';
    this.code = code;
  }
}

function requireStore(store) {
  if (store === null || typeof store !== 'object' || typeof store.db !== 'object' || typeof store.atomic !== 'function') {
    throw new LifeCorrectionError('missing_store');
  }
}

function requireId(packageId) {
  if (typeof packageId !== 'string' || packageId === '') throw new LifeCorrectionError('invalid_package_id');
  return packageId;
}

function excerpt(text, max = 40) {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** "-fix", "-fix2",.. so a corrected memory can itself be corrected. */
function freeId(db, base) {
  let id = base;
  let suffix = 1;
  while (db.prepare('SELECT 1 FROM life_packages WHERE id=?').get(id) !== undefined) {
    suffix += 1;
    id = base + suffix;
  }
  return id;
}

/**
 * Records that one memory was wrong and what the right version is.
 *
 * @param {object} store life store handle
 * @param {string} fromPackageId the memory that was wrong
 * @param {object} input reason (required), text (required), at, id, importance,
 * occurredAt, subjects, ordinal, links
 * @returns {{from:object, to:object, eventSeq:number, correction:object}}
 */
export function correctPackage(store, fromPackageId, input) {
  requireStore(store);
  const fromId = requireId(fromPackageId);
  const options = input === null || typeof input !== 'object' ? {} : input;

  const reason = typeof options.reason === 'string' ? options.reason.trim() : '';
  if (reason === '') throw new LifeCorrectionError('reason_required');
  const text = typeof options.text === 'string' ? options.text.trim() : '';
  if (text === '') throw new LifeCorrectionError('text_required');
  if (text.length > MAX_TEXT_CHARS) throw new LifeCorrectionError('text_too_long', String(text.length));
  const rawAt = typeof options.at === 'string' && options.at !== '' ? options.at : new Date().toISOString();
  if (!Number.isFinite(Date.parse(rawAt))) throw new LifeCorrectionError('invalid_time', String(options.at));
  const at = new Date(Date.parse(rawAt)).toISOString();
  if (options.id !== undefined && (typeof options.id !== 'string' || options.id === '')) {
    throw new LifeCorrectionError('invalid_package_id');
  }

  return store.atomic((db) => {
    const old = getPackage(store, fromId);
    if (old === null) throw new LifeCorrectionError('package_not_found', fromId);
    if (old.status !== 'active') throw new LifeCorrectionError('already_withdrawn', fromId);

    const newId = freeId(db, options.id ?? (fromId + '-fix'));
    db.prepare('UPDATE life_packages SET status=? WHERE id=?').run('withdrawn', old.id);

    const replacement = insertPackage(db, {
      id: newId,
      kind: 'correction',
      text,
      tokens: estimateTokens(text),
      startSeq: old.startSeq,
      endSeq: old.endSeq,
      createdAt: at,
      importance: options.importance ?? old.importance,
      occurredAt: options.occurredAt ?? old.occurredAt ?? undefined,
      subjects: options.subjects ?? old.subjects,
      ordinal: options.ordinal ?? old.ordinal ?? undefined,
      links: [{ type: 'correction', from: old.id }, ...(Array.isArray(options.links) ? options.links : [])],
    });

 // The withdrawn record keeps a forward pointer too, so unpacking the old package with
 // allowWithdrawn shows where it went instead of leaving a dead end.
    const forwardLinks = [...(old.links ?? []), { type: 'corrected_by', to: newId }];
    db.prepare('UPDATE life_packages SET links_json=? WHERE id=?').run(JSON.stringify(forwardLinks), old.id);

    const insertTerm = db.prepare('INSERT OR IGNORE INTO life_package_terms(package_id, term) VALUES(?,?)');
    for (const term of extractTerms(text)) insertTerm.run(newId, term);
    db.prepare('INSERT OR IGNORE INTO life_package_vectors(package_id, encoder, dim, vector) ' +
      'SELECT ?, encoder, dim, vector FROM life_package_vectors WHERE package_id=?').run(newId, old.id);

    db.prepare('INSERT INTO life_corrections(from_package_id, to_package_id, reason, at) VALUES(?,?,?,?)')
      .run(old.id, newId, reason, at);

    const line = '已更正一条记忆（' + old.startSeq + '–' + old.endSeq + '）：' + excerpt(old.text) +
      ' → 更正为：' + excerpt(replacement.text) + ' 原因：' + reason;
    const info = db.prepare('INSERT INTO life_events(at, kind, role, text, meta_json) VALUES(?,?,?,?,?)')
      .run(at, 'note', 'system', line, JSON.stringify({ correction: { fromPackageId: old.id, toPackageId: newId, reason } }));

    return {
      from: getPackage(store, old.id),
      to: replacement,
      eventSeq: Number(info.lastInsertRowid),
      correction: { from: old.id, to: newId, reason, at },
    };
  });
}

/** The pointer for one package, or null. */
export function findCorrection(store, fromPackageId) {
  requireStore(store);
  const fromId = requireId(fromPackageId);
  const row = store.db
    .prepare('SELECT from_package_id, to_package_id, reason, at FROM life_corrections WHERE from_package_id=?')
    .get(fromId);
  if (row === undefined) return null;
  return { from: row.from_package_id, to: row.to_package_id, reason: row.reason, at: row.at };
}

/** Newest first, with both sides abbreviated for display. */
export function listCorrections(store, limit = 100) {
  requireStore(store);
  const cap = Number(limit);
  if (!Number.isInteger(cap) || cap <= 0) throw new LifeCorrectionError('invalid_limit', String(limit));
  return store.db
    .prepare('SELECT c.from_package_id, c.to_package_id, c.reason, c.at, f.text AS from_text, t.text AS to_text ' +
      'FROM life_corrections c ' +
      'JOIN life_packages f ON f.id=c.from_package_id ' +
      'JOIN life_packages t ON t.id=c.to_package_id ' +
      'ORDER BY c.id DESC LIMIT ?')
    .all(cap)
    .map((row) => ({
      from: row.from_package_id,
      to: row.to_package_id,
      reason: row.reason,
      at: row.at,
      fromText: excerpt(row.from_text),
      toText: excerpt(row.to_text),
    }));
}

/**
 * Walks 旧 -> 新 ->.. to the last version. A package that was never corrected returns
 * itself with steps 0, so callers do not have to special-case it.
 */
export function latestCorrection(store, packageId) {
  requireStore(store);
  let current = requireId(packageId);
  const seen = new Set([current]);
  let steps = 0;
  for (;;) {
    const pointer = findCorrection(store, current);
    if (pointer === null) break;
    if (seen.has(pointer.to)) throw new LifeCorrectionError('correction_cycle', pointer.to);
    seen.add(pointer.to);
    current = pointer.to;
    steps += 1;
  }
  return { packageId: current, steps, corrected: steps > 0 };
}
