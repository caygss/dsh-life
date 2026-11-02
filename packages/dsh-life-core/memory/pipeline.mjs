/**
 * Compress one stretch and record what happened, whatever happens.
 *
 * This is the only entry point callers should use: compression plus a durable
 * attempt record, so a failure is visible and retryable instead of vanishing.
 */
import { compressSegment, compressSegmentAddressed } from './compress.mjs';
import { indexPackage, indexTerms, writeVector } from './index.mjs';
import { writePackage } from './packages.mjs';
import { recordAttempt, statusForErrorCode, acquireCompressionLock, releaseCompressionLock } from './attempts.mjs';

/**
 * @returns {Promise<{ok:boolean, package?:object, attemptId:number, errorCode?:string}>}
 */
export async function compressAndStore(input) {
  if (input === null || typeof input !== 'object') throw new TypeError('invalid_input');
  const { store, summarise, segment, events } = input;
  if (store === null || typeof store !== 'object' || typeof store.atomic !== 'function') throw new TypeError('missing_store');

 // Addressed mode writes the memory and its address in one call (schema v3). The
 // plain-text prompt stays available because it is the default: switching
 // it here is a caller decision, not a silent change of contract.
  const addressed = input.addressed === true;
  const compress = addressed ? compressSegmentAddressed : compressSegment;

 // An open lock means another pass is already compressing this stretch. Reporting that
 // is better than compressing twice: two packages for one range would either collide on
 // the range guard or silently double the memory. A crashed process leaves its lock
 // behind, and a lock older than the TTL is taken over rather than trusted forever.
  const lock = acquireCompressionLock(store, {
    startSeq: segment.startSeq,
    endSeq: segment.endSeq,
    promptVersion: input.promptVersion ?? null,
    model: input.modelId ?? null,
    ttlMs: input.lockTtlMs,
  });
  if (lock.acquired !== true) {
    return { ok: false, attemptId: null, errorCode: 'compression_locked', lock: lock.blockedBy };
  }

  let draft = null;
  let errorCode;
  try {
    draft = await compress({ summarise, segment, events, rules: input.rules, signal: input.signal });
  } catch (error) {
    errorCode = error?.code ?? 'unexpected_error';
 // 带地址的那条路要模型交 JSON；它要是没照格式答（address_* 这一类），
 // 退回老的那条只写回忆的路——宁可少记「关于谁 / 轻重」，也不要这段日子压根没记住。
 // 注意只退这一类：网络失败、超短、截断都不是格式问题，退了也一样。
    if (addressed === true && String(errorCode).startsWith('address_')) {
      try {
        draft = await compressSegment({ summarise, segment, events, rules: input.rules, signal: input.signal });
        errorCode = undefined;
      } catch (fallbackError) {
        errorCode = fallbackError?.code ?? errorCode;
      }
    }
  } finally {
    releaseCompressionLock(store, lock.lockId);
  }

  const attemptId = recordAttempt(store, {
    startSeq: segment.startSeq,
    endSeq: segment.endSeq,
    status: statusForErrorCode(errorCode),
    errorCode: errorCode ?? null,
    outputChars: draft === null ? null : draft.chars,
    promptVersion: input.promptVersion ?? (draft === null ? null : draft.promptVersion),
    model: draft === null ? (input.modelId ?? null) : draft.model,
  });

  if (draft === null) return { ok: false, attemptId, errorCode };

  const written = writePackage(store, {
    id: input.packageId ?? ('pkg-' + segment.startSeq + '-' + segment.endSeq),
    text: draft.text,
    tokens: draft.tokens,
    startSeq: segment.startSeq,
    endSeq: segment.endSeq,
    createdAt: input.createdAt,
 // 助手自己标的轻重（v9）；老提示词那条路没有这一格，仍旧按宿主给的走。
    importance: addressed ? (draft.importance ?? input.importance) : input.importance,
    occurredAt: addressed ? draft.occurredAt : undefined,
    subjects: addressed ? draft.subjects : undefined,
    ordinal: addressed ? draft.ordinal : undefined,
  });
 // 写进去不等于想得起来（的真实缺口）：召回走的是 life_package_vectors /
 // life_package_terms，压缩流水线以前**不写这两张表**，于是包写成了、却一条也搜不到。
 // 这里补上：有同步 encoder 就写向量（并写字面），没有就至少写字面，关键字那一路还能用。
  let indexed = null;
  try {
    const encoder = input.encoder;
    const embedder = input.embedder;
    if (embedder !== null && typeof embedder === 'object' && typeof embedder.encode === 'function') {
 // 远程/异步编码器（例如本地 8B 的 HTTP 服务）：先算出向量，再写入。
      const vector = await embedder.encode(written.text);
      indexed = {
        ...writeVector(store, { packageId: written.id, encoderName: embedder.name, vector }),
        terms: indexTerms(store, { packageId: written.id, text: written.text }).terms,
      };
    } else if (encoder !== null && typeof encoder === 'object' && typeof encoder.encode === 'function') {
      indexed = indexPackage(store, { packageId: written.id, text: written.text, encoder });
    } else {
      indexed = { ...indexTerms(store, { packageId: written.id, text: written.text }), dim: 0 };
    }
  } catch (error) {
 // 索引失败不影响包本身：包在，下一趟还能补；但不能假装索引过。
    indexed = { error: String(error?.code || error?.message || error) };
  }
  return { ok: true, attemptId, package: written, indexed };
}
