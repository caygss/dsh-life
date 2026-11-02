/**
 * Compression attempts, recorded so a failed compression is a *pending* stretch
 * rather than a lost piece of it life.
 *
 * Why this exists: the compressed package is derived data. The events are the
 * original and they live in the append-only log. If an attempt fails — truncated
 * output, empty answer, any model error — that attempt is written down with its
 * range, so the same stretch can be compressed again later. What is lost in the
 * meantime is one particular rendering, not the experience itself.
 */
import { LifeStoreError } from '../store/db.mjs';

export const ATTEMPT_STATUSES = Object.freeze(['completed', 'truncated', 'empty', 'too_short', 'too_long', 'failed']);

/** Maps a LifeCompressError code onto an attempt status. */
export function statusForErrorCode(code) {
  switch (code) {
    case undefined: return 'completed';
    case 'compressed_output_truncated': return 'truncated';
    case 'compressed_output_empty': return 'empty';
    case 'compressed_output_too_short': return 'too_short';
    case 'compressed_output_too_long': return 'too_long';
    default: return 'failed';
  }
}

function toAttempt(row) {
  return {
    id: Number(row.id),
    startSeq: Number(row.start_seq),
    endSeq: Number(row.end_seq),
    attemptedAt: row.attempted_at,
    status: row.status,
    errorCode: row.error_code ?? null,
    outputChars: row.output_chars === null ? null : Number(row.output_chars),
    promptVersion: row.prompt_version ?? null,
    model: row.model ?? null,
  };
}

export function recordAttempt(store, attempt) {
  if (attempt === null || typeof attempt !== 'object') throw new LifeStoreError('invalid_attempt');
  const startSeq = Number(attempt.startSeq);
  const endSeq = Number(attempt.endSeq);
  if (!Number.isInteger(startSeq) || !Number.isInteger(endSeq) || endSeq < startSeq) {
    throw new LifeStoreError('invalid_attempt_range', startSeq + '..' + endSeq);
  }
  const status = attempt.status ?? 'completed';
  if (!ATTEMPT_STATUSES.includes(status)) throw new LifeStoreError('invalid_attempt_status', String(status));
  const attemptedAt = typeof attempt.attemptedAt === 'string' && attempt.attemptedAt !== ''
    ? attempt.attemptedAt
    : new Date().toISOString();
  return store.atomic((db) => {
    const info = db.prepare('INSERT INTO life_compression_attempts(start_seq, end_seq, attempted_at, status, error_code, output_chars, prompt_version, model) ' +
      'VALUES(?,?,?,?,?,?,?,?)')
      .run(startSeq, endSeq, attemptedAt, status, attempt.errorCode ?? null,
        Number.isInteger(attempt.outputChars) ? attempt.outputChars : null,
        attempt.promptVersion ?? null, attempt.model ?? null);
    return Number(info.lastInsertRowid);
  });
}

export function listAttempts(store, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 200;
  if (options.startSeq !== undefined) {
    return store.db.prepare('SELECT * FROM life_compression_attempts WHERE start_seq=? ORDER BY id LIMIT ?')
      .all(Number(options.startSeq), limit).map(toAttempt);
  }
  return store.db.prepare('SELECT * FROM life_compression_attempts ORDER BY id LIMIT ?').all(limit).map(toAttempt);
}

/**
 * Stretches that were attempted and never completed, and that have no active
 * package. These are the ones a later pass should retry.
 */
export function listPendingStretches(store, limit = 200) {
  return store.db.prepare(
    'SELECT a.start_seq AS start_seq, a.end_seq AS end_seq, COUNT(*) AS attempts, MAX(a.id) AS last_attempt ' +
    'FROM life_compression_attempts a ' +
    "WHERE a.status<>'completed' " +
    'AND NOT EXISTS (SELECT 1 FROM life_packages p WHERE p.status=\'active\' AND p.start_seq=a.start_seq AND p.end_seq=a.end_seq) ' +
    'GROUP BY a.start_seq, a.end_seq ORDER BY a.start_seq LIMIT ?',
  ).all(limit).map((row) => ({ startSeq: Number(row.start_seq), endSeq: Number(row.end_seq), attempts: Number(row.attempts) }));
}
/* ------------------------------------------------------------------------- *
 * Compression lock (borrowed from DSH compaction)
 *
 * DSH treats an unclosed `compaction/start` as a durable lock: a second compaction of
 * the same region reports busy instead of running in parallel. The same failure is
 * possible here - a process killed between "model answered" and "package written"
 * would otherwise be retried concurrently by the next pass.
 *
 * A lock row is taken over by age rather than cleared by a timer, because a crashed
 * process never gets to release anything.
 * ------------------------------------------------------------------------- */

export const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000;

/**
 * @returns {{acquired:true, lockId:number, replacedStale:boolean} | {acquired:false, blockedBy:object}}
 */
export function acquireCompressionLock(store, input = {}) {
  const startSeq = Number(input.startSeq);
  const endSeq = Number(input.endSeq);
  if (!Number.isInteger(startSeq) || !Number.isInteger(endSeq) || endSeq < startSeq) {
    throw new LifeStoreError('invalid_lock_range', startSeq + '..' + endSeq);
  }
  const ttlMs = Number.isFinite(input.ttlMs) ? input.ttlMs : DEFAULT_LOCK_TTL_MS;
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const startedAt = new Date(nowMs).toISOString();

  return store.atomic((db) => {
    const existing = db.prepare('SELECT * FROM life_compression_locks WHERE start_seq=? AND end_seq=?').get(startSeq, endSeq);
    let replacedStale = false;
    if (existing !== undefined) {
      const age = nowMs - Date.parse(existing.started_at);
      if (Number.isFinite(age) && age < ttlMs) {
        return { acquired: false, blockedBy: { lockId: Number(existing.id), startedAt: existing.started_at, ageMs: age } };
      }
      db.prepare('DELETE FROM life_compression_locks WHERE id=?').run(existing.id);
      replacedStale = true;
    }
    const info = db.prepare('INSERT INTO life_compression_locks(start_seq, end_seq, started_at, prompt_version, model) VALUES(?,?,?,?,?)')
      .run(startSeq, endSeq, startedAt, input.promptVersion ?? null, input.model ?? null);
    return { acquired: true, lockId: Number(info.lastInsertRowid), replacedStale };
  });
}

export function releaseCompressionLock(store, lockId) {
  const id = Number(lockId);
  if (!Number.isInteger(id) || id <= 0) throw new LifeStoreError('invalid_lock_id', String(lockId));
  return store.atomic((db) => {
    const info = db.prepare('DELETE FROM life_compression_locks WHERE id=?').run(id);
    return { released: Number(info.changes) > 0 };
  });
}

export function listOpenLocks(store) {
  return store.db.prepare('SELECT * FROM life_compression_locks ORDER BY start_seq').all().map((row) => ({
    lockId: Number(row.id),
    startSeq: Number(row.start_seq),
    endSeq: Number(row.end_seq),
    startedAt: row.started_at,
    promptVersion: row.prompt_version ?? null,
    model: row.model ?? null,
  }));
}
