/**
 * The agent's plugin table.
 *
 * Capabilities belong to it, not to the house the agent happens to live in, so the table
 * lives in its own store: change the runtime, keep the abilities. Three facts are
 * kept apart on purpose, because collapsing them is how a plugin silently gains power:
 *
 * declared - what the manifest asks for (validated, frozen, stored verbatim-ish)
 * granted - what the owner's allowlist actually hands over at enable time
 * active - what an enabled plugin may use right now (declared AND granted)
 *
 * Install never grants anything. Enable is all-or-nothing: if one capability is not
 * on the allowlist the whole plugin stays disabled, because half a plugin running is
 * a plugin whose failure modes nobody described. Every accepted and every refused
 * operation appends one receipt, and the receipt table refuses UPDATE and DELETE
 * (see the triggers in store/db.mjs) - so "what did I allow, and when" is answerable
 * after the fact, including for the attempts that were turned down.
 */
import { LifePluginError, supportsPlatform, validateManifest } from './manifest.mjs';
import { resolveCapabilities, SURFACE_STATE } from './surfaces.mjs';

export const PLUGIN_STATUSES = Object.freeze(['disabled', 'enabled']);
export const RECEIPT_ACTIONS = Object.freeze(['install', 'enable', 'disable', 'uninstall']);
export const RECEIPT_OUTCOMES = Object.freeze(['ok', 'refused']);

function requireStore(store) {
  if (store === null || typeof store !== 'object' || typeof store.db !== 'object' || typeof store.atomic !== 'function') {
    throw new LifePluginError('missing_store');
  }
}

function isoAt(value) {
  if (value === undefined) return new Date().toISOString();
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new LifePluginError('invalid_time', String(value));
  return new Date(ms).toISOString();
}

function requireId(value) {
  if (typeof value !== 'string' || value === '') throw new LifePluginError('invalid_plugin_id', String(value));
  return value;
}

function jsonColumn(text, fallback) {
  try {
    const parsed = JSON.parse(text);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function toRow(row) {
  if (row === undefined) return null;
  return {
    id: row.id,
    version: row.version,
    apiVersion: Number(row.api_version),
    status: row.status,
    capabilities: jsonColumn(row.capabilities_json, []),
    granted: jsonColumn(row.granted_json, []),
    manifest: jsonColumn(row.manifest_json, {}),
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
}

/** Inserts one receipt. Caller supplies the db so this can join an existing transaction. */
function writeReceipt(db, receipt) {
  const info = db.prepare(
    'INSERT INTO life_plugin_receipts(at, plugin_id, action, outcome, code, detail_json) VALUES(?,?,?,?,?,?)',
  ).run(
    receipt.at,
    receipt.pluginId ?? null,
    receipt.action,
    receipt.outcome,
    receipt.code ?? null,
    JSON.stringify(receipt.detail ?? {}),
  );
  return Number(info.lastInsertRowid);
}

function appendReceipt(store, receipt) {
  return store.atomic((db) => writeReceipt(db, receipt));
}

/**
 * 一条回执，给宿主自己的出口用：助手说了话、宿主替助手发出去，这件事也必须有账。
 * 只做插入，不碰插件的 installed/granted/active 三行。
 */
export function recordPluginReceipt(store, receipt) {
  requireStore(store);
  const at = typeof receipt?.at === 'string' && receipt.at !== '' ? receipt.at : new Date().toISOString();
  return appendReceipt(store, { ...receipt, at });
}

/**
 * Records a refusal and then throws it. The order matters: a caller that only sees
 * the exception must still be able to find the refusal in its receipts afterwards.
 */
function refuse(store, receipt) {
  appendReceipt(store, { ...receipt, outcome: 'refused' });
  throw new LifePluginError(receipt.code, typeof receipt.detail === 'string' ? receipt.detail : JSON.stringify(receipt.detail ?? {}));
}

export function readPlugin(store, id) {
  requireStore(store);
  return toRow(store.db.prepare('SELECT * FROM life_plugins WHERE id=?').get(requireId(id)));
}

/** Newest install first. Capabilities are reported with their surface state. */
export function listPlugins(store) {
  requireStore(store);
  return store.db.prepare('SELECT * FROM life_plugins ORDER BY installed_at DESC, id').all().map((row) => {
    const plugin = toRow(row);
    return {
      ...plugin,
      capabilityStates: plugin.capabilities.map((capability) => ({
        name: capability.name,
        surface: capability.surface,
        state: resolveCapabilities({ capabilities: [capability] })[0].state,
      })),
    };
  });
}

/**
 * Installs a plugin in the disabled state. Nothing is granted here.
 *
 * Refusals, in the order they can happen: a manifest the host cannot read, a platform
 * this build does not run on, a surface the host cannot fence (reserved or unknown),
 * a version conflict.
 */
export function installPlugin(store, input) {
  requireStore(store);
  const options = input === null || typeof input !== 'object' ? {} : input;
  const at = isoAt(options.at);
  const platform = typeof options.platform === 'string' ? options.platform : process.platform;
  const manifest = validateManifest(options.manifest);

  if (!supportsPlatform(manifest, platform)) {
    refuse(store, {
      at, pluginId: manifest.id, action: 'install', code: 'platform_unsupported',
      detail: { platform, platforms: manifest.platforms },
    });
  }

 // Surface check. Reserved and unknown are both refusals, with different codes so a
 // roadmap item is not mistaken for a typo.
  const resolved = resolveCapabilities(manifest);
  const blocked = resolved.filter((capability) => capability.state !== SURFACE_STATE.IMPLEMENTED);
  if (blocked.length > 0) {
    const reserved = blocked.filter((capability) => capability.state === SURFACE_STATE.RESERVED);
    refuse(store, {
      at,
      pluginId: manifest.id,
      action: 'install',
      code: reserved.length > 0 ? 'surface_reserved' : 'surface_unknown',
      detail: {
        capabilities: blocked.map((capability) => ({
          name: capability.name,
          surface: capability.surface,
          state: capability.state,
          door: capability.door,
        })),
      },
    });
  }

  const existing = readPlugin(store, manifest.id);
  if (existing !== null) {
    if (existing.version === manifest.version) {
      return { status: 'unchanged', plugin: existing };
    }
    refuse(store, {
      at, pluginId: manifest.id, action: 'install', code: 'version_change_requires_uninstall',
      detail: { installed: existing.version, requested: manifest.version },
    });
  }

  const capabilities = manifest.capabilities.map((capability) => ({
    name: capability.name,
    surface: capability.surface,
  }));

  const receiptSeq = store.atomic((db) => {
    db.prepare(
      'INSERT INTO life_plugins(id, version, api_version, status, manifest_json, capabilities_json, granted_json, installed_at, updated_at) ' +
      'VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(manifest.id, manifest.version, manifest.apiVersion, 'disabled', JSON.stringify(manifest), JSON.stringify(capabilities), '[]', at, at);
    return writeReceipt(db, {
      at, pluginId: manifest.id, action: 'install', outcome: 'ok',
      detail: { version: manifest.version, capabilities },
    });
  });

  return { status: 'installed', receiptSeq, plugin: readPlugin(store, manifest.id) };
}

function normalizeAllow(allow) {
  if (allow === undefined) return Object.freeze([]);
  if (!Array.isArray(allow)) throw new LifePluginError('invalid_allow', String(allow));
  const out = [];
  for (const name of allow) {
    if (typeof name !== 'string' || name === '') throw new LifePluginError('invalid_allow', String(name));
    if (!out.includes(name)) out.push(name);
  }
  return Object.freeze(out);
}

/**
 * Enables a plugin, but only for the capabilities the allowlist names.
 *
 * All-or-nothing: a partial allowlist refuses the whole plugin and reports what was
 * missing. The stored manifest is re-checked against the current registry, so a plugin
 * installed while a surface was implemented cannot stay enabled after that surface is
 * withdrawn.
 */
export function enablePlugin(store, input) {
  requireStore(store);
  const options = input === null || typeof input !== 'object' ? {} : input;
  const id = requireId(options.id);
  const at = isoAt(options.at);
  const allow = normalizeAllow(options.allow);

  const plugin = readPlugin(store, id);
  if (plugin === null) {
    refuse(store, { at, pluginId: id, action: 'enable', code: 'plugin_not_found', detail: {} });
  }
  if (plugin.status === 'enabled') return { status: 'unchanged', plugin };

  const declared = plugin.capabilities.map((capability) => capability.name);
  const unknownGrants = allow.filter((name) => !declared.includes(name));
  if (unknownGrants.length > 0) {
    refuse(store, {
      at, pluginId: id, action: 'enable', code: 'grant_unknown_capability',
      detail: { unknown: unknownGrants, declared },
    });
  }

  const missing = declared.filter((name) => !allow.includes(name));
  if (missing.length > 0) {
    refuse(store, {
      at, pluginId: id, action: 'enable', code: 'capability_not_granted',
      detail: { missing, declared },
    });
  }

  const states = resolveCapabilities(plugin).filter((capability) => capability.state !== SURFACE_STATE.IMPLEMENTED);
  if (states.length > 0) {
    const reserved = states.filter((capability) => capability.state === SURFACE_STATE.RESERVED);
    refuse(store, {
      at, pluginId: id, action: 'enable',
      code: reserved.length > 0 ? 'surface_reserved' : 'surface_unknown',
      detail: { capabilities: states.map((capability) => ({ name: capability.name, surface: capability.surface, state: capability.state })) },
    });
  }

  const receiptSeq = store.atomic((db) => {
    db.prepare('UPDATE life_plugins SET status=?, granted_json=?, updated_at=? WHERE id=?')
      .run('enabled', JSON.stringify(allow), at, id);
    return writeReceipt(db, { at, pluginId: id, action: 'enable', outcome: 'ok', detail: { granted: allow } });
  });

  return { status: 'enabled', receiptSeq, plugin: readPlugin(store, id) };
}

/** Turns a plugin off. Capabilities stay declared, the grant is cleared. */
export function disablePlugin(store, input) {
  requireStore(store);
  const options = input === null || typeof input !== 'object' ? {} : input;
  const id = requireId(options.id);
  const at = isoAt(options.at);

  const plugin = readPlugin(store, id);
  if (plugin === null) {
    refuse(store, { at, pluginId: id, action: 'disable', code: 'plugin_not_found', detail: {} });
  }
  if (plugin.status === 'disabled') return { status: 'unchanged', plugin };

  const receiptSeq = store.atomic((db) => {
    db.prepare('UPDATE life_plugins SET status=?, granted_json=?, updated_at=? WHERE id=?')
      .run('disabled', '[]', at, id);
    return writeReceipt(db, { at, pluginId: id, action: 'disable', outcome: 'ok', detail: { wasGranted: plugin.granted } });
  });

  return { status: 'disabled', receiptSeq, plugin: readPlugin(store, id) };
}

/**
 * Removes the plugin row. Two explicit steps on purpose: the plugin has to be disabled
 * first, so nothing is ever uninstalled while its tools are live.
 *
 * The agent's data is NOT touched. At this stage a plugin has no data directory yet (gives
 * it one under life/plugins-data/<id>), and when it does, uninstall will still leave it
 * alone - the receipt says so explicitly, so "I removed the plugin" can never be
 * misread as "I deleted what was in it".
 *
 * The row goes away, the receipt keeps what the row said: version and capabilities are
 * copied into the receipt detail, so the audit trail outlives the row.
 */
export function uninstallPlugin(store, input) {
  requireStore(store);
  const options = input === null || typeof input !== 'object' ? {} : input;
  const id = requireId(options.id);
  const at = isoAt(options.at);

  const plugin = readPlugin(store, id);
  if (plugin === null) {
    refuse(store, { at, pluginId: id, action: 'uninstall', code: 'plugin_not_found', detail: {} });
  }
  if (plugin.status === 'enabled') {
    refuse(store, {
      at, pluginId: id, action: 'uninstall', code: 'plugin_enabled',
      detail: { hint: 'disable the plugin before uninstalling it', granted: plugin.granted },
    });
  }

  const receiptSeq = store.atomic((db) => {
    db.prepare('DELETE FROM life_plugins WHERE id=?').run(id);
    return writeReceipt(db, {
      at, pluginId: id, action: 'uninstall', outcome: 'ok',
      detail: {
        version: plugin.version,
        capabilities: plugin.capabilities.map((capability) => capability.name),
        dataPreserved: true,
      },
    });
  });

  return { status: 'uninstalled', receiptSeq, plugin };
}

/**
 * What the agent can actually use right now: enabled plugins, granted capabilities only.
 * feeds this into the tool table and into restrict, so the two can no longer
 * disagree the way they did in the first wake test.
 */
export function activeCapabilities(store) {
  requireStore(store);
  const rows = store.db.prepare("SELECT id, version, capabilities_json, granted_json FROM life_plugins WHERE status='enabled' ORDER BY id").all();
  const out = [];
  for (const row of rows) {
    const granted = new Set(jsonColumn(row.granted_json, []));
    for (const capability of jsonColumn(row.capabilities_json, [])) {
      if (!granted.has(capability.name)) continue;
      out.push({ pluginId: row.id, name: capability.name, surface: capability.surface });
    }
  }
  return out;
}

/** Newest first, refused ones included. */
export function listReceipts(store, limit = 100) {
  requireStore(store);
  const cap = Number(limit);
  if (!Number.isInteger(cap) || cap <= 0) throw new LifePluginError('invalid_limit', String(limit));
  return store.db.prepare('SELECT * FROM life_plugin_receipts ORDER BY seq DESC LIMIT ?').all(cap).map((row) => ({
    seq: Number(row.seq),
    at: row.at,
    pluginId: row.plugin_id,
    action: row.action,
    outcome: row.outcome,
    code: row.code,
    detail: jsonColumn(row.detail_json, {}),
  }));
}
