// Adapted from DeepSeek Harness, MIT License, Copyright (c) 2026 DeepSeek.
// Commit 22ddee3792402c3e70ec5f86a63c3e3e895a2f60:
// packages/client/ui-chat/src/client/contract/turn-metrics.ts
// TypeScript types removed; the timing formulas and null semantics are retained.
// MIT License; the full notice is in THIRD-PARTY-NOTICES.md. Call only with host-projected plain values.
function usageOutputTokens(usage) {
  if (typeof usage !== 'object' || usage === null) return null;
  const value = usage.outputTokens;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
export function assistantStepReading(node) {
  const timing = node.timing;
  const ttftMs = timing !== undefined && timing.stepStartTime !== null && timing.firstTokenTime !== null
    ? Math.max(0, timing.firstTokenTime - timing.stepStartTime)
    : null;
  const decodeMs = timing !== undefined && timing.firstTokenTime !== null
    ? Math.max(0, timing.completedTime - timing.firstTokenTime)
    : null;
  return { ttftMs, decodeMs, outputTokens: usageOutputTokens(node.usage) };
}
// Adapted from the same DeepSeek Harness commit, message-chrome.ts:54-64 (MIT).
export function formatRunDuration(ms, t) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = total % 60;
  const parts = [];
  if (hours > 0) parts.push({ text: String(hours), numeric: true }, { text: t('duration.hourUnit'), numeric: false });
  if (total >= 60) parts.push({ text: String(minutes), numeric: true }, { text: t('duration.minuteUnit'), numeric: false });
  parts.push({ text: String(seconds), numeric: true }, { text: t('duration.secondUnit'), numeric: false });
  return parts;
}
