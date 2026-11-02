import { assistantStepReading } from './step-timing.mjs';
import { types } from 'node:util';

const object = value => value !== null && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value);
const own = (value, key) => object(value) ? Object.getOwnPropertyDescriptor(value, key) : undefined;
const read = (value, key) => own(value, key)?.value;
const token = value => Number.isSafeInteger(value) && value >= 0;
const BASE = ['prompt_tokens', 'completion_tokens', 'total_tokens'];

/** Preserve only provider token counters, never arbitrary usage extensions/content. */
export function projectProviderUsage(usage) {
  if (!object(usage)) return null;
  const projected = {};
  for (const key of [...BASE, 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']) {
    if (own(usage, key)) projected[key] = token(read(usage, key)) ? read(usage, key) : null;
  }
  const details = read(usage, 'prompt_tokens_details');
  if (own(details, 'cached_tokens')) projected.prompt_tokens_details = { cached_tokens: token(read(details, 'cached_tokens')) ? read(details, 'cached_tokens') : null };
  else if (own(usage, 'prompt_tokens_details') && details != null && !object(details)) projected.prompt_tokens_details = { cached_tokens: null };
  return projected;
}

/** Verified means structurally consistent provider-reported counters, not billing proof. */
export function verifyRequestUsage(raw) {
  const unknown = { promptTokens: null, completionTokens: null, totalTokens: null, cacheHitTokens: null, cacheMissTokens: null, cacheStatus: 'unknown' };
  const usage = projectProviderUsage(raw);
  if (raw == null) return { ...unknown, usageStatus: 'absent' };
  if (!usage || !BASE.every(key => token(usage[key])) || usage.prompt_tokens + usage.completion_tokens !== usage.total_tokens) return { ...unknown, usageStatus: 'invalid' };
  const result = { ...unknown, usageStatus: 'verified', promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens };
  const hit = own(usage, 'prompt_cache_hit_tokens'), nested = own(usage.prompt_tokens_details, 'cached_tokens'), miss = own(usage, 'prompt_cache_miss_tokens');
  if (!hit && !nested && !miss) return { ...result, cacheStatus: 'absent' };
  const counters = [hit, nested, miss].filter(Boolean).map(d => d.value);
  if (counters.some(n => !token(n) || n > result.promptTokens)) return { ...result, cacheStatus: 'invalid' };
  if (hit && nested && hit.value !== nested.value) return { ...result, cacheStatus: 'conflict' };
  const h = hit?.value ?? nested?.value ?? null, m = miss?.value ?? null;
  if (h !== null && m !== null && h + m !== result.promptTokens) return { ...result, cacheStatus: 'conflict' };
  return { ...result, cacheStatus: 'verified', cacheHitTokens: h, cacheMissTokens: m };
}

export const GENERATION_RATE_BASIS = 'completion_tokens / first_model_delta_to_body_complete_seconds';
export const REQUEST_RATE_BASIS = 'completion_tokens / dispatch_to_body_complete_seconds';
const numericFields = ['elapsedMs','firstModelDeltaMs','firstTextMs','requestDurationMs','generationDurationMs','promptTokens','completionTokens','totalTokens','cacheHitTokens','cacheMissTokens','outputTokensPerSecond','requestOutputTokensPerSecond'];
const enums = {
  modelDeltaKind: ['none','reasoning','text','tool'],
  responseStatus: ['receiving','complete','interrupted','unknown'],
  transport: ['unknown','sse','json'], usageStatus: ['pending','verified','absent','invalid','unknown'],
  cacheStatus: ['unknown','verified','absent','invalid','conflict'],
  outputTokensPerSecondBasis: [null, GENERATION_RATE_BASIS], requestOutputTokensPerSecondBasis: [null, REQUEST_RATE_BASIS],
};
/** Re-project at the UI boundary; no IDs, URLs, body, tools or reasoning. */
export function projectRequestMetrics(event) {
  if (read(event, 'version') !== 1) return null;
  const result = { version: 1 };
  for (const [key, allowed] of Object.entries(enums)) {
    const value = read(event, key); if (!allowed.includes(value)) return null; result[key] = value;
  }
  for (const key of numericFields) {
    const value = read(event, key);
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || key.endsWith('Tokens') && !token(value))) return null;
    result[key] = value;
  }
  if (result.elapsedMs === null) return null;
  if (result.usageStatus !== 'verified' && ['promptTokens','completionTokens','totalTokens','cacheHitTokens','cacheMissTokens','outputTokensPerSecond','requestOutputTokensPerSecond'].some(key => result[key] !== null)) return null;
  if (result.responseStatus !== 'complete' && result.usageStatus === 'verified') return null;
  if (result.usageStatus === 'verified' && (!['promptTokens','completionTokens','totalTokens'].every(key => token(result[key])) || result.promptTokens + result.completionTokens !== result.totalTokens)) return null;
  if (result.cacheStatus !== 'verified' && (result.cacheHitTokens !== null || result.cacheMissTokens !== null)) return null;
  if ([result.cacheHitTokens,result.cacheMissTokens].some(n => n !== null && (result.usageStatus !== 'verified' || n > result.promptTokens))) return null;
  if (result.cacheHitTokens !== null && result.cacheMissTokens !== null && result.cacheHitTokens + result.cacheMissTokens !== result.promptTokens) return null;
  for (const key of ['firstModelDeltaMs','firstTextMs','requestDurationMs']) if (result[key] !== null && result[key] > result.elapsedMs) return null;
  if (result.firstTextMs !== null && (result.firstModelDeltaMs === null || result.firstTextMs < result.firstModelDeltaMs)) return null;
  if (result.transport !== 'sse' && [result.firstModelDeltaMs,result.firstTextMs,result.generationDurationMs].some(n => n !== null)) return null;
  if (result.responseStatus === 'receiving' && (result.requestDurationMs !== null || result.generationDurationMs !== null)) return null;
  if (result.responseStatus === 'complete' && result.requestDurationMs === null) return null;
  if (result.generationDurationMs !== null && (result.responseStatus !== 'complete' || result.firstModelDeltaMs === null || result.generationDurationMs !== result.requestDurationMs - result.firstModelDeltaMs)) return null;
  for (const [rateKey,durationKey,basisKey,basis] of [
    ['outputTokensPerSecond','generationDurationMs','outputTokensPerSecondBasis',GENERATION_RATE_BASIS],
    ['requestOutputTokensPerSecond','requestDurationMs','requestOutputTokensPerSecondBasis',REQUEST_RATE_BASIS],
  ]) {
    const rate = result[rateKey], duration = result[durationKey];
    if (rate === null ? result[basisKey] !== null : result.responseStatus !== 'complete' || result.usageStatus !== 'verified' || !(duration > 0) || result[basisKey] !== basis || rate !== result.completionTokens / (duration / 1000)) return null;
  }
  return Object.freeze(result);
}

/** One request, monotonic host-observed timings, at most one terminal receipt.
 * SSE generation window ends at complete body reception (includes stream tail).
 * JSON has no observable first delta/text or generation window. No token estimates.
 */
export class RequestMetrics {
  #emit; #clock; #start; #dispatched = false; #elapsed = 0; #end = null; #final = false;
  #transport = 'unknown'; #kind = 'none'; #firstDelta = null; #firstText = null;
  constructor({ emit, clock = () => performance.now() } = {}) { this.#emit = emit; this.#clock = clock; this.#start = clock(); }
  dispatch() { if (!this.#dispatched && !this.#final) { this.#start = this.#clock(); this.#elapsed = 0; this.#dispatched = true; } }
  #now() {
    const n = this.#clock() - this.#start;
    if (Number.isFinite(n) && n >= this.#elapsed && n <= Number.MAX_SAFE_INTEGER) this.#elapsed = n;
    return this.#elapsed;
  }
  #event(responseStatus, verified = {}) {
    const elapsedMs = this.#now(), ended = responseStatus !== 'receiving';
    const duration = ended ? this.#end : null;
    const completion = verified.completionTokens ?? null;
 // Reuse DSH's settled-step timing formulas only with host-projected values.
 // Here 'decode' is our observed first-delta -> body-complete receive window.
    const reading = responseStatus === 'complete' ? assistantStepReading({
      timing: { stepStartTime: 0, firstTokenTime: this.#transport === 'sse' ? this.#firstDelta : null, completedTime: duration },
      usage: { outputTokens: completion },
    }) : null;
    const generation = reading?.decodeMs ?? null;
    const rate = seconds => completion !== null && seconds > 0 && Number.isFinite(completion / seconds) && completion / seconds <= Number.MAX_SAFE_INTEGER ? completion / seconds : null;
    const outputRate = rate(generation === null ? 0 : generation / 1000), requestRate = rate(responseStatus === 'complete' ? duration / 1000 : 0);
    const event = Object.freeze({ version: 1, modelDeltaKind: this.#kind, responseStatus, transport: this.#transport, usageStatus: ended ? 'unknown' : 'pending', cacheStatus: 'unknown', elapsedMs,
      firstModelDeltaMs: reading ? reading.ttftMs : this.#firstDelta, firstTextMs: this.#firstText, requestDurationMs: duration, generationDurationMs: generation,
      promptTokens: null, completionTokens: null, totalTokens: null, cacheHitTokens: null, cacheMissTokens: null, ...verified,
      outputTokensPerSecond: outputRate, requestOutputTokensPerSecond: requestRate,
      outputTokensPerSecondBasis: outputRate === null ? null : GENERATION_RATE_BASIS,
      requestOutputTokensPerSecondBasis: requestRate === null ? null : REQUEST_RATE_BASIS });
    try { this.#emit?.(event); } catch { /* Metrics observers cannot affect accounting or release. */ }
    return event;
  }
  transport(value) { if (this.#final || !['sse','json'].includes(value)) return; this.#transport = value; this.#event('receiving'); }
  delta({ model = false, text = false, reasoning = false, tool = false } = {}) {
    if (this.#final || this.#transport !== 'sse') return;
    const now = this.#now(); let changed = false;
    if ((model || text || reasoning || tool) && this.#firstDelta === null) { this.#firstDelta = now; changed = true; }
    if (text && this.#firstText === null) { this.#firstText = now; changed = true; }
    const kind = text ? 'text' : tool ? 'tool' : reasoning ? 'reasoning' : this.#kind;
    if (kind !== this.#kind) { this.#kind = kind; changed = true; }
    if (changed) this.#event('receiving');
  }
  bodyComplete() { if (!this.#final && this.#end === null) this.#end = this.#now(); }
  complete(usage) { if (this.#final) return; this.bodyComplete(); this.#final = true; return this.#event('complete', verifyRequestUsage(usage)); }
  fail(status = 'unknown') { if (this.#final) return; this.#final = true; return this.#event(status === 'interrupted' ? status : 'unknown'); }
}

/** Stable final display. Rates are whole-completion averages, NOT text/live speed.
 * Compact legend: Delta (Δ) = first model delta (text/reasoning/tools); 完 = body complete.
 * Both rates use all provider completion tokens; neither is a public-text token rate.
 */
export function requestMetricsLines(event) {
  const m = projectRequestMetrics(event); if (!m || m.responseStatus === 'receiving') return [];
  const n = value => value === null ? '?' : String(value);
  const seconds = value => value === null ? '?' : (value / 1000).toFixed(2) + 's';
  const rate = value => value === null ? '?' : value.toFixed(1);
  const status = m.responseStatus === 'complete' ? '响应统计' : m.responseStatus === 'interrupted' ? '已中断/用量未知' : '未验证/用量未知';
  const cache = m.cacheStatus === 'conflict' ? '冲突' : m.cacheStatus === 'invalid' ? '无效' : n(m.cacheHitTokens);
  return [
    status + ' · 输入 ' + n(m.promptTokens) + ' / 输出 ' + n(m.completionTokens) + ' / 总 ' + n(m.totalTokens) + ' · 缓存读 ' + cache + ' / 未命中 ' + n(m.cacheMissTokens),
    '输出均速 ' + rate(m.outputTokensPerSecond) + '/' + rate(m.requestOutputTokensPerSecond) + ' token/s〔Δ→完/请求〕 · Δ/文 ' + seconds(m.firstModelDeltaMs) + '/' + seconds(m.firstTextMs) + ' · 请求 ' + seconds(m.requestDurationMs),
  ];
}
