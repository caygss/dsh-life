/**
 * Annotation-style withdrawal.
 *
 * Withdrawal never deletes: the package is marked withdrawn, and one line is appended
 * to the log saying what was withdrawn and why. The agent keeps knowing that something was
 * taken back and the reason for it - that is the whole point of the annotation style.
 * No closure walk, no pre-publication interception, no rewriting of history.
 *
 * The reason is required. A withdrawal without a reason would leave its with a hole
 * and no explanation.
 */
import { LifeStoreError } from '../store/db.mjs';
import { getPackage } from './packages.mjs';

export class LifeWithdrawalError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifeWithdrawalError';
    this.code = code;
  }
}

/**
 * @returns {{package:object, eventSeq:number}}
 */
export function withdrawPackage(store, packageId, input = {}) {
  if (store === null || typeof store !== 'object' || typeof store.db !== 'object') throw new LifeWithdrawalError('missing_store');
  if (typeof packageId !== 'string' || packageId === '') throw new LifeWithdrawalError('invalid_package_id');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason === '') throw new LifeWithdrawalError('reason_required');
  const at = typeof input.at === 'string' && input.at !== '' ? input.at : new Date().toISOString();
  if (!Number.isFinite(Date.parse(at))) throw new LifeWithdrawalError('invalid_time', String(input.at));

  return store.atomic((db) => {
    const record = getPackage(store, packageId);
    if (record === null) throw new LifeWithdrawalError('package_not_found', packageId);
    if (record.status === 'withdrawn') throw new LifeWithdrawalError('already_withdrawn', packageId);

    db.prepare('UPDATE life_packages SET status=? WHERE id=?').run('withdrawn', packageId);
    const excerpt = record.text.length > 40 ? record.text.slice(0, 40) + '…' : record.text;
    const line = '已撤回一条记忆（' + record.startSeq + '–' + record.endSeq + '）：' + excerpt + ' 原因：' + reason;
    const info = db.prepare('INSERT INTO life_events(at, kind, role, text, meta_json) VALUES(?,?,?,?,?)')
      .run(at, 'note', 'system', line, JSON.stringify({ withdrawal: { packageId, reason } }));
    return { package: { ...record, status: 'withdrawn' }, eventSeq: Number(info.lastInsertRowid) };
  });
}

/** Withdrawn packages stay visible to it on purpose, with the reason attached. */
export function listWithdrawals(store, limit = 100) {
  const packages = store.db
    .prepare("SELECT id, start_seq, end_seq, text FROM life_packages WHERE status='withdrawn' ORDER BY start_seq LIMIT ?")
    .all(limit);
  const notes = store.db.prepare("SELECT text, meta_json FROM life_events WHERE kind='note' ORDER BY seq DESC").all();
  const noteByPackage = new Map();
  for (const note of notes) {
    let meta;
    try { meta = JSON.parse(note.meta_json); } catch { continue; }
    const packageId = meta === null || typeof meta !== 'object' ? undefined : meta.withdrawal && meta.withdrawal.packageId;
    if (typeof packageId === 'string' && !noteByPackage.has(packageId)) noteByPackage.set(packageId, note.text);
  }
  return packages.map((row) => ({
    packageId: row.id,
    startSeq: Number(row.start_seq),
    endSeq: Number(row.end_seq),
    excerpt: row.text,
    note: noteByPackage.get(row.id) ?? null,
  }));
}
