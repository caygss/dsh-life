/**
 * 通用 TTS：一句话 -> 一整包 WAV，只认一个 HTTP 端点。
 *
 * 这里故意什么引擎都不认识：端点、路径、预设表、请求体模板都由 config 给。
 * 缺省 body 是 { text, preset }，够接大多数 OpenAI 风格的 /v1/tts；不一样就改模板。
 * 模板里的占位符写成 {{text}} / {{preset}}。不做流式，QQ 语音本来就是整段。
 */

export const TTS_DEFAULTS = Object.freeze({
  path: '/v1/tts',
  timeoutMs: 60000,
  maxChars: 200,
  presets: Object.freeze({ default: {} }),
  body: Object.freeze({ text: '{{text}}', preset: '{{preset}}' }),
});

export function ttsSettings(config) {
  const given = config && typeof config === "object" ? config : {};
  return {
    ...TTS_DEFAULTS,
    ...given,
    presets: given.presets && typeof given.presets === "object" ? given.presets : TTS_DEFAULTS.presets,
    body: given.body && typeof given.body === "object" ? given.body : TTS_DEFAULTS.body,
  };
}

export function presetNames(config) { return Object.keys(ttsSettings(config).presets); }

function fill(value, vars) {
  if (typeof value === "string") {
    const whole = /^\{\{([a-zA-Z0-9_]+)\}\}$/.exec(value);
    if (whole && Object.hasOwn(vars, whole[1])) return vars[whole[1]];
    return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = fill(v, vars);
    return out;
  }
  return value;
}

export function buildTtsBody(config, input) {
  const vars = { text: String(input?.text ?? ""), preset: input?.preset ?? null };
  return fill(ttsSettings(config).body, vars);
}
