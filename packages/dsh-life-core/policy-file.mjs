/**
 * 热改策略文件：听和发两张名单，改完不用重启容器。
 *
 * 两个来源，优先级从高到低：
 * 1. 热文件（JSON）：/data/state/policy.json —— 每秒最多读一次，改了立刻生效
 * 2. 启动配置（YAML）：/config/life.live.yml 里的同名键 —— 文件被删/写坏时兜底
 * 3. 内存里的默认值：插件/宿主启动时拿到的配置
 *
 * 为什么还要读 YAML：改配置文件后几秒内生效比重启省事。所以这里带了一个
 * **只认每个键**的极简扫描器（不引 YAML 依赖）：它只找 inboundMode/inboundAllow/
 * inboundDeny 和 life-qq 下的 recipients.mode/ids/blacklist/primary，别的行一概不看。
 * 扫不到就退回默认值，并在 warning 里说清楚——不猜、不静默。
 *
 * 读坏了怎么办：保留**上一次认过的**策略（last good），而不是把人全锁在外面；warning 只报一次。
 */
import { readFileSync, statSync } from 'node:fs';

export const POLICY_MODES = Object.freeze(['list', 'all', 'none']);
/** 两次 stat 之间最多多久（毫秒）；1 s 是"改完几秒生效"的实现。 */
export const POLICY_INTERVAL_MS = 1000;

/**
 * 运行参数。每个键都有上下界：
 * 热改是为了方便，不是为了让人能写成 1e9 次重试把宿主卡死。
 */
export const RUNTIME_LIMITS = Object.freeze({
  mediaMaxBytes: Object.freeze({ min: 1024, max: 200 * 1024 * 1024, fallback: 8 * 1024 * 1024 }),
  onebotTimeoutMs: Object.freeze({ min: 1000, max: 120000, fallback: 10000 }),
  friendCacheMs: Object.freeze({ min: 0, max: 3600000, fallback: 60000 }),
  inboundMaxChars: Object.freeze({ min: 1, max: 65536, fallback: 8196 }),
  inboundDailyCap: Object.freeze({ min: 0, max: 100000, fallback: 0 }),
  outboundMaxChars: Object.freeze({ min: 1, max: 65536, fallback: 8196 }),
  outboundRetries: Object.freeze({ min: 0, max: 10, fallback: 5 }),
  outboundAttemptTimeoutMs: Object.freeze({ min: 1000, max: 120000, fallback: 10000 }),
  outboundDailyCap: Object.freeze({ min: 0, max: 100000, fallback: 0 }),
});

export const RUNTIME_DEFAULTS = Object.freeze(Object.fromEntries(
  Object.entries(RUNTIME_LIMITS).map(([key, spec]) => [key, spec.fallback]),
));

const ID = /^\d+$/;

function warn(code, detail) {
  return { code, detail: detail === undefined ? null : String(detail) };
}

// 三个校验器都回答同一个形状：{ present: false } = 没写；{ present: true, ok: false } = 写坏；
// { present: true, ok: true, value } = 认下。区分"没写"和"写坏"是逐键容错的前提：
// 没写 = 回落到下面的层；写坏 = 这一格保持上一次生效值。
function idArray(value, field, problems) {
  if (value === undefined || value === null) return { present: false };
  if (!Array.isArray(value)) { problems.push(field + ' must be a list'); return { present: true, ok: false }; }
  const out = [];
  for (const entry of value) {
    const text = String(entry ?? '').trim();
    if (!ID.test(text)) { problems.push(field + ' has a non-number: ' + text); return { present: true, ok: false }; }
    if (!out.includes(text)) out.push(text);
  }
  return { present: true, ok: true, value: out };
}

function runtimeValue(key, value, problems) {
  const spec = RUNTIME_LIMITS[key];
  if (spec === undefined) return { present: false };
  if (value === undefined || value === null) return { present: false };
  const number = Number(value);
  if (!Number.isInteger(number)) { problems.push('runtime.' + key + ' must be an integer'); return { present: true, ok: false }; }
  if (number < spec.min || number > spec.max) {
    problems.push('runtime.' + key + ' must be ' + spec.min + '-' + spec.max + ', got ' + number);
    return { present: true, ok: false };
  }
  return { present: true, ok: true, value: number };
}

function mode(value, field, problems) {
  if (value === undefined || value === null) return { present: false };
  const text = String(value).trim().toLowerCase();
  if (!POLICY_MODES.includes(text)) { problems.push(field + ' must be list/all/none, got ' + text); return { present: true, ok: false }; }
  return { present: true, ok: true, value: text };
}

/**
 * 把"文件里写的"合到默认值上。
 *
 * 改的口径（逐键容错，取代原来的"整份拒绝"）：
 * - 一个字段写坏了，只丢那一个字段，其余写对的照用；
 * - 写坏的字段保持**上一次生效值**（当作这次没改这一格）；
 * - 字段被**删掉**才算回落（YAML / 默认值）——"删=撤"和"错=不动"是两条不同的规则。
 * 返回值永远带一份完整 policy（不再是 null）；哪些格被丢了在 ignored 里点名。
 */
export function mergePolicy(raw, defaults, options) {
  const settings = options === null || typeof options !== 'object' ? {} : options;
  const previous = settings.previous !== null && typeof settings.previous === 'object' ? settings.previous : null;
  const problems = [];
  const ignored = [];
  const hear = { ...defaults.hear };
  const speak = { ...defaults.speak };
  const runtime = { ...RUNTIME_DEFAULTS, ...(defaults.runtime ?? {}) };

  const section = (value) => (value !== null && typeof value === 'object' ? value : null);
  const prevHear = previous === null ? null : section(previous.hear);
  const prevSpeak = previous === null ? null : section(previous.speak);
  const prevRuntime = previous === null ? null : section(previous.runtime);

 /** 认下 → 写入；写坏 → 点名 + 保持上一次生效值；没写 → 什么都不做（由下层兜底）。 */
  const keep = (result, field, target, key, last) => {
    if (result.present !== true) return;
    if (result.ok === true) { target[key] = result.value; return; }
    ignored.push(field);
    if (last !== null && last !== undefined && last[key] !== undefined) target[key] = last[key];
  };

  if (raw === null || typeof raw !== 'object') return { policy: { hear, speak, runtime }, problems, ignored };

  const hearRaw = section(raw.hear) ?? {};
  const speakRaw = section(raw.speak) ?? {};
  const runtimeRaw = section(raw.runtime) ?? {};
  for (const key of Object.keys(RUNTIME_LIMITS)) {
    keep(runtimeValue(key, runtimeRaw[key], problems), 'runtime.' + key, runtime, key, prevRuntime);
  }
  keep(mode(hearRaw.mode, 'hear.mode', problems), 'hear.mode', hear, 'mode', prevHear);
  keep(idArray(hearRaw.allow, 'hear.allow', problems), 'hear.allow', hear, 'allow', prevHear);
  keep(idArray(hearRaw.deny, 'hear.deny', problems), 'hear.deny', hear, 'deny', prevHear);
 // 听得见的群：按群号放行，整群都能进来。跟人名单互不影响——
 // 删掉这一格 = 退回默认（一个群都不听），写坏了 = 保持上一次生效的群名单。
  keep(idArray(hearRaw.groups, 'hear.groups', problems), 'hear.groups', hear, 'groups', prevHear);
  keep(mode(speakRaw.mode, 'speak.mode', problems), 'speak.mode', speak, 'mode', prevSpeak);
  keep(idArray(speakRaw.ids, 'speak.ids', problems), 'speak.ids', speak, 'ids', prevSpeak);
  keep(idArray(speakRaw.blacklist, 'speak.blacklist', problems), 'speak.blacklist', speak, 'blacklist', prevSpeak);
 // primary：空串=没写（不覆盖）；非数字 QQ 号=写坏（保持上一次）
  if (speakRaw.primary !== undefined && speakRaw.primary !== null && String(speakRaw.primary).trim() !== '') {
    const text = String(speakRaw.primary).trim();
    if (ID.test(text)) speak.primary = text;
    else {
      problems.push('speak.primary must be a QQ number');
      ignored.push('speak.primary');
      if (prevSpeak !== null && prevSpeak.primary !== undefined && prevSpeak.primary !== null) speak.primary = prevSpeak.primary;
    }
  }
  return { policy: { hear, speak, runtime }, problems, ignored };
}

// ---- 极简 YAML 扫描（只认下面这几个键）-------------------------------------
function unquote(text) {
  const t = String(text ?? '').trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1);
  return t;
}

/** 一个值：要么 [a, b] 流式列表，要么单个标量（后面的 # 注释丢掉）。 */
function scalarOrFlow(rest) {
  const text = String(rest ?? '').trim();
  if (text === '') return { kind: 'empty' };
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    const body = end === -1 ? text.slice(1) : text.slice(1, end);
    const items = body.split(',').map((part) => unquote(part)).filter((part) => part !== '');
    return { kind: 'list', items };
  }
  const beforeComment = text.startsWith("'") || text.startsWith('"')
    ? unquote(text.slice(0, text.lastIndexOf(text[0]) + 1))
    : text.split(' #')[0].trim();
  return { kind: 'scalar', value: beforeComment };
}

function blockList(lines, startIndex, baseIndent) {
  const items = [];
  let index = startIndex;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent) break;
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) break;
    const value = unquote(trimmed.slice(2).split(' #')[0]);
    if (value !== '') items.push(value);
  }
  return { items, nextIndex: index };
}

/**
 * 从配置 YAML 里读关心的六个键。返回 { hear: {..}, speak: {..} }（只含找到的键）。
 * 找不到就不写那一个键——交给 defaults 兜底。
 */
export function parseLifePolicyYml(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const hear = {};
  const speak = {};
  const runtime = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^(\s*)([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (match === null) continue;
    const indent = match[1].length;
    const key = match[2];
    const rest = match[3];

    if (key === 'runtime') {
 // 运行参数块：runtime: 下面直接写那九个键
      const baseIndent = indent;
      for (let inner = index + 1; inner < lines.length; inner += 1) {
        const child = lines[inner];
        if (child.trim() === '' || child.trim().startsWith('#')) continue;
        const childIndent = child.length - child.trimStart().length;
        if (childIndent <= baseIndent) break;
        const parsed = /^(\s*)([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(child);
        if (parsed === null) continue;
        if (RUNTIME_LIMITS[parsed[2]] !== undefined) {
          const value = scalarOrFlow(parsed[3]);
          if (value.kind === 'scalar') runtime[parsed[2]] = value.value;
        }
      }
      continue;
    }
    if (key === 'inboundMaxChars' || key === 'inboundDailyCap') {
      const value = scalarOrFlow(rest);
      if (value.kind === 'scalar') runtime[key] = value.value;
      continue;
    }

    if (key === 'inboundMode') {
      const value = scalarOrFlow(rest);
      if (value.kind === 'scalar' && value.value !== '') hear.mode = value.value;
      continue;
    }
    if (key === 'inboundAllow' || key === 'inboundDeny' || key === 'inboundGroups') {
      const value = scalarOrFlow(rest);
      const field = key === 'inboundAllow' ? 'allow' : (key === 'inboundDeny' ? 'deny' : 'groups');
      if (value.kind === 'list') hear[field] = value.items;
      else if (value.kind === 'empty') {
        const block = blockList(lines, index + 1, indent);
        hear[field] = block.items;
        index = block.nextIndex - 1;
      }
      continue;
    }
    if (key === 'recipients') {
 // life-qq 的 recipients 块：mode / ids / blacklist / primary 都在它下面
      const baseIndent = indent;
      for (let inner = index + 1; inner < lines.length; inner += 1) {
        const child = lines[inner];
        if (child.trim() === '' || child.trim().startsWith('#')) continue;
        const childIndent = child.length - child.trimStart().length;
        if (childIndent <= baseIndent) break;
        const childMatch = /^(\s*)([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(child);
        if (childMatch === null) continue;
        const childKey = childMatch[2];
        const childRest = childMatch[3];
        const value = scalarOrFlow(childRest);
        if (childKey === 'mode' && value.kind === 'scalar') speak.mode = value.value;
        else if (childKey === 'primary' && value.kind === 'scalar') speak.primary = value.value;
        else if (childKey === 'ids' || childKey === 'blacklist') {
          const field = childKey === 'ids' ? 'ids' : 'blacklist';
          if (value.kind === 'list') speak[field] = value.items;
          else if (value.kind === 'empty') {
            const block = blockList(lines, inner + 1, childIndent);
            speak[field] = block.items;
          }
        }
      }
    }
  }
  return { hear, speak, runtime };
}

/**
 * 造一个读取器。read 最多每 intervalMs 看一次文件，返回 { policy, source, warning, ignored }。
 * - 写坏的字段：只丢那一格，其余照用，warning.code = 'policy_partial'，ignored 里点名；
 * - 整份读不出来（JSON 语法坏）：保留最后一次生效的整份，warning.code = 'policy_json_invalid'。
 * 注意：是**惰性**读——只有入站判定、出口发送、或启动时写报告才会触发，空闲时改文件没有副作用。
 */
export function createPolicyReader(input) {
  const options = input === null || typeof input !== 'object' ? {} : input;
  const defaults = mergePolicy(null, {
    hear: { mode: 'list', allow: [], deny: [], groups: [] },
    speak: { mode: 'list', ids: [], blacklist: [], primary: null },
    ...(options.defaults ?? {}),
  }).policy;
  const jsonPath = typeof options.jsonPath === 'string' && options.jsonPath !== '' ? options.jsonPath : null;
  const ymlPath = typeof options.ymlPath === 'string' && options.ymlPath !== '' ? options.ymlPath : null;
  const intervalMs = Number.isInteger(options.intervalMs) && options.intervalMs > 0 ? options.intervalMs : POLICY_INTERVAL_MS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const onWarning = typeof options.onWarning === 'function' ? options.onWarning : null;

  let lastCheck = -Infinity;
  let current = { policy: defaults, source: 'defaults', warning: null, ignored: [] };
  let lastWarningKey = null;
  let lastStateKey = null;
  const stamps = new Map();

  function readText(path) {
    if (path === null) return null;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) return null;
      return { text: readFileSync(path, 'utf8'), mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return null;
    }
  }

  function emit(warning) {
    const key = warning.code + ':' + warning.detail;
    if (onWarning !== null && key !== lastWarningKey) onWarning(warning);
    lastWarningKey = key;
  }

  function fail(warning) {
    emit(warning);
 // 整份读不出来（JSON 语法坏）：把最后一份认过的整份策略原样交出去，绝不半路换成默认值。
 // warning 留在 current 上，这样间隔内被缓存命中的读也能看见"文件是坏的"。
    current = { ...current, warning, ignored: [] };
    return current;
  }

 /** 每个来源最近一次解析成功的原文对象（解析只在文件变的时侯做）。 */
  let ymlParsed = null;
  let jsonParsed = null;
  let jsonBroken = null;

  function read() {
    const stamp = now();
    if (stamp - lastCheck < intervalMs) return current;
    lastCheck = stamp;

 // 1) YAML 是底：它缺的键由默认值补
    const yml = readText(ymlPath);
    if (yml !== null) {
 // 用**原文**当签名：文件名相同但同长度改一个字，mtime 在 Windows 上可能一样。
      const signature = 'yml:' + yml.text;
      if (signature !== stamps.get('yml')) {
        stamps.set('yml', signature);
        ymlParsed = parseLifePolicyYml(yml.text);
      }
    } else {
      ymlParsed = null;
    }
    const fromYml = mergePolicy(ymlParsed, defaults, { previous: current.policy });
    let policy = fromYml.policy;
    let source = ymlParsed === null ? 'defaults' : 'yml';
    const problems = fromYml.problems.slice();
    const ignored = fromYml.ignored.slice();

 // 2) JSON 压在上面：它写了的键优先，没写的键用 YAML/默认值
    const json = readText(jsonPath);
    if (json !== null) {
      const signature = 'json:' + json.text;
      if (jsonBroken !== null && jsonBroken.signature !== signature) jsonBroken = null;
      if (jsonBroken !== null) return fail(jsonBroken.warning);
      if (signature !== stamps.get('json')) {
        stamps.set('json', signature);
        try {
          jsonParsed = JSON.parse(json.text);
        } catch (error) {
          jsonParsed = null;
          jsonBroken = { signature, warning: warn('policy_json_invalid', error.message) };
          return fail(jsonBroken.warning);
        }
      }
      if (jsonParsed !== null) {
        const merged = mergePolicy(jsonParsed, policy, { previous: current.policy });
        policy = merged.policy;
        problems.push(...merged.problems);
        ignored.push(...merged.ignored);
        source = 'json';
      }
    } else {
      jsonParsed = null;
      jsonBroken = null;
    }

 // 写坏的格：其余照用，这一格保持上一次生效值，并用一条 warning 点名
    const warning = problems.length > 0 ? warn('policy_partial', problems.join('; ')) : null;
    const next = { policy, source, warning, ignored };
    const stateKey = JSON.stringify(next);
    if (stateKey !== lastStateKey) {
      lastStateKey = stateKey;
      if (warning === null) lastWarningKey = null;
      current = next;
    }
    if (warning !== null) emit(warning);
    return current;
  }

  return { read, defaults };
}
