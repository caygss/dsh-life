/**
 * Plugin manifest validation.
 *
 * A plugin is one declaration plus one factory. This file owns the declaration:
 * it answers "is this a manifest the host can reason about?" and nothing else.
 * It deliberately does not decide whether a surface is grantable - that is the
 * registry's job, because it depends on what the running host implements.
 *
 * Refusals are codes, never silent repairs. A manifest that says the wrong thing
 * is rejected whole; the host does not guess what it meant.
 *
 * Note on the factory: the declaration is data, the behaviour is a function. Keeping
 * them in separate files means a manifest can be read and audited without executing
 * a single line of the plugin.
 */
import { RESERVED_SURFACES, IMPLEMENTED_SURFACES } from './surfaces.mjs';

/** Bumped when the shape of a manifest or of the create factory changes incompatibly. */
export const HOST_API_VERSION = 1;

/** Platforms a manifest may name. 'any' is the default and matches everywhere. */
export const PLATFORMS = Object.freeze(['any', 'linux', 'win32', 'darwin']);

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;

export class LifePluginError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifePluginError';
    this.code = code;
  }
}

function refuse(code, detail) {
  throw new LifePluginError(code, detail);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, field) {
  if (typeof value !== 'string' || value === '') refuse('invalid_' + field, String(value));
  return value;
}

function optionalStringArray(value, field) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) refuse('invalid_' + field, 'not an array');
  const out = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') refuse('invalid_' + field, 'non-string entry');
    out.push(entry);
  }
  return Object.freeze(out);
}

/**
 * 依赖声明。
 *
 * 两个键，都是"名字数组"：
 * plugins — 这些插件必须已安装且启用；少一个，这个插件就不加载（不是报错，是不出现）
 * services — 宿主必须真的交出这些服务（例如 imagePool）；少一个，同样不加载
 *
 * 除了这两个键一律拒：拼错的依赖名沉默地不生效，比当场被拒危险得多。
 */
function normalizeRequires(raw) {
  if (raw === undefined) return Object.freeze({});
  if (!isPlainObject(raw)) refuse('invalid_requires', 'not an object');
  const out = {};
  for (const key of Object.keys(raw)) {
    if (key !== 'plugins' && key !== 'services') refuse('invalid_requires', 'unknown key: ' + key);
    const list = raw[key];
    if (!Array.isArray(list)) refuse('invalid_requires', key + ' must be an array');
    const names = [];
    for (const entry of list) {
      if (typeof entry !== 'string' || entry.trim() === '') refuse('invalid_requires', key + ' entry');
      if (names.includes(entry) === false) names.push(entry);
    }
    out[key] = Object.freeze(names);
  }
  return Object.freeze(out);
}

/**
 * Validates and freezes a manifest. Unknown top-level keys are ignored on purpose:
 * a newer plugin may carry fields this host does not use yet, and refusing them
 * would mean shipping two files for two host versions.
 */
export function validateManifest(raw) {
  if (!isPlainObject(raw)) refuse('invalid_manifest', typeof raw);

  const id = requireString(raw.id, 'plugin_id');
  if (!ID_PATTERN.test(id)) refuse('invalid_plugin_id', id);

  const apiVersion = raw.apiVersion;
  if (!Number.isInteger(apiVersion)) refuse('invalid_api_version', String(apiVersion));
  if (apiVersion !== HOST_API_VERSION) refuse('unsupported_api_version', apiVersion + ' != ' + HOST_API_VERSION);

  const version = requireString(raw.version, 'version');
  if (!VERSION_PATTERN.test(version)) refuse('invalid_version', version);

  const kinds = optionalStringArray(raw.kinds, 'kinds');

  const platforms = raw.platforms === undefined ? Object.freeze(['any']) : optionalStringArray(raw.platforms, 'platforms');
  if (platforms.length === 0) refuse('invalid_platforms', 'empty');
  for (const platform of platforms) {
    if (!PLATFORMS.includes(platform)) refuse('invalid_platforms', platform);
  }

  if (!Array.isArray(raw.capabilities) || raw.capabilities.length === 0) {
    refuse('invalid_capabilities', 'expected a non-empty array');
  }

  const seen = new Set();
  const capabilities = [];
  for (const entry of raw.capabilities) {
    if (!isPlainObject(entry)) refuse('invalid_capabilities', 'entry is not an object');
    const name = entry.name;
    if (typeof name !== 'string' || !CAPABILITY_PATTERN.test(name)) refuse('invalid_capability_name', String(name));
    if (seen.has(name)) refuse('duplicate_capability', name);
    seen.add(name);
    const surface = entry.surface;
    if (typeof surface !== 'string' || surface === '') refuse('invalid_capability_surface', name);
 // Carried through for later stages (limits, display view, slot). Those stages still
 // validate their own fields; this is a carrier, not a promise.
    capabilities.push(Object.freeze({
      name,
      surface,
      limits: isPlainObject(entry.limits) ? Object.freeze({ ...entry.limits }) : null,
      view: isPlainObject(entry.view) ? Object.freeze({ ...entry.view }) : null,
      slot: typeof entry.slot === 'string' && entry.slot !== '' ? entry.slot : null,
    }));
  }

  if (raw.config !== undefined && !isPlainObject(raw.config)) refuse('invalid_config', 'not an object');
  const requires = normalizeRequires(raw.requires);

  return Object.freeze({
    id,
    apiVersion,
    version,
    kinds,
    platforms,
    capabilities: Object.freeze(capabilities),
    config: isPlainObject(raw.config) ? Object.freeze({ ...raw.config }) : Object.freeze({}),
    requires,
  });
}

/** Loads a manifest from JSON text. A broken file is a refusal, not a crash. */
export function parseManifest(text) {
  if (typeof text !== 'string' || text === '') refuse('invalid_manifest', 'empty text');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    refuse('invalid_manifest', 'invalid JSON: ' + error.message);
  }
  return validateManifest(parsed);
}

/** True when this manifest says it runs on the given platform. */
export function supportsPlatform(manifest, platform) {
  const list = manifest.platforms.length === 0 ? ['any'] : manifest.platforms;
  return list.includes('any') || list.includes(platform);
}

/** Every surface name this host knows about, implemented and reserved. Used by docs and tests. */
export const KNOWN_SURFACES = Object.freeze([...IMPLEMENTED_SURFACES, ...RESERVED_SURFACES]);
