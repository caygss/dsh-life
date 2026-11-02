/**
 * The plugin loader.
 *
 * Until now a plugin was a manifest plus three rows in the agent's table: installed, granted,
 * active. Nothing ever imported it, so "installing a plugin" proved the bookkeeping and
 * not the ability. This module closes that gap: it reads the declaration, imports the
 * factory, hands it a context built from that table, and collects the tool implementations
 * the factory registers - which is what buildToolTable then turns into the agent's tool table.
 *
 * The order is deliberately the same one the registry enforces, because the loader must
 * not become a second, weaker door:
 *
 * installed? (its table) -> else plugin_not_installed
 * enabled? (its table) -> the loader only loads ACTIVE plugins, so a
 * disabled plugin's code is never imported at all
 * declaration (life-plugin.json) -> parsed and validated whole, id must match
 * version -> must equal the installed row, otherwise "what is
 * installed" has two answers
 * factory (index.mjs) -> must export create
 * context.tool(name) -> only for a capability the agent actually declared,
 * only for the 'tool' surface
 *
 * What a load failure does NOT do: half-load the plugin. One failure means zero tools from
 * that plugin, and the host reports it (the caller turns a non-empty failure list into a
 * loud, empty tool table - the agent still wakes, but the agent is not handed a broken hand).
 *
 * Honest limit: loading a plugin executes its JavaScript with host privileges. That is not
 * sandboxed here and is not for this - sandboxes programs the agent writes. Plugin code is
 * owner-installed code; install is the gate, and the receipts say who opened it.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { LifePluginError, parseManifest } from './manifest.mjs';
import { readPlugin } from './registry.mjs';

export const DECLARATION_FILE = 'life-plugin.json';
export const FACTORY_FILE = 'index.mjs';
export const CONTEXT_VERSION = 1;
export const LOADER_LIMITS = Object.freeze({ logEntries: 200 });

export const LOADER_ERRORS = Object.freeze({
  invalidRoot: 'invalid_plugins_root',
  invalidDataRoot: 'invalid_data_root',
  pluginNotInstalled: 'plugin_not_installed',
  pluginDisabled: 'plugin_disabled',
  declarationMissing: 'declaration_missing',
  idMismatch: 'id_mismatch',
  versionMismatch: 'version_mismatch',
  factoryMissing: 'factory_missing',
  factoryMissingExport: 'factory_missing_export',
  factoryFailed: 'factory_failed',
  invalidToolName: 'invalid_tool_name',
  undeclaredCapability: 'undeclared_capability',
  toolForNonToolSurface: 'tool_for_non_tool_surface',
  duplicateTool: 'duplicate_tool',
  slotNotImplemented: 'slot_not_implemented',
  memoryServiceUnavailable: 'memory_service_unavailable',
  scheduleServiceUnavailable: 'schedule_service_unavailable',
  netServiceUnavailable: 'net_service_unavailable',
  handsServiceUnavailable: 'hands_service_unavailable',
  imageServiceUnavailable: 'image_service_unavailable',
  imagePoolServiceUnavailable: 'image_pool_service_unavailable',
 // 依赖没满足：这个插件不是坏了，是它的前提不在（例如号池这只手要先装原生生图插件）。
 // 所以 loadEnabledPlugins 把它记进 skipped，而不是 failed。
  requiresUnmet: 'requires_unmet',
  invalidOutbound: 'invalid_outbound_handler',
  invalidInbound: 'invalid_inbound_handler',
});

const PLUGIN_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function refuse(code, detail) {
  throw new LifePluginError(code, detail);
}

function requirePath(value, code, field) {
  if (typeof value !== 'string' || value.trim() === '') refuse(code, field);
  return path.resolve(value);
}

/** 助手已启用的插件 id。依赖检查问的是"装没装、开没开"，不是"加载成功没"。 */
function enabledPluginIds(store) {
  const rows = store.db.prepare("SELECT id FROM life_plugins WHERE status='enabled'").all();
  return new Set(rows.map((row) => String(row.id)));
}

/** manifest.requires 没满足的部分；两个空数组 = 满足。 */
function unmetRequirements(manifest, store, services) {
  const requires = manifest.requires === undefined || manifest.requires === null ? {} : manifest.requires;
  const wantPlugins = Array.isArray(requires.plugins) ? requires.plugins : [];
  const wantServices = Array.isArray(requires.services) ? requires.services : [];
  const enabled = wantPlugins.length === 0 ? null : enabledPluginIds(store);
  const missingPlugins = wantPlugins.filter((id) => enabled.has(id) === false);
  const missingServices = wantServices.filter((name) => {
    const service = services[name];
    return service === null || service === undefined || typeof service !== 'object';
  });
  return { missingPlugins, missingServices };
}

/** The directory a plugin lives in. The id is validated first, so the join cannot escape. */
export function pluginDir(pluginsRoot, pluginId) {
  const root = requirePath(pluginsRoot, LOADER_ERRORS.invalidRoot, 'pluginsRoot');
  if (typeof pluginId !== 'string' || !PLUGIN_ID.test(pluginId)) refuse('invalid_plugin_id', String(pluginId));
  return path.join(root, pluginId);
}

function buildContext(plugin, manifest, deps) {
  const declared = new Map(plugin.capabilities.map((capability) => [capability.name, capability.surface]));
  const used = new Set();
  const logs = [];
  const implementations = {};

  const context = {
    apiVersion: CONTEXT_VERSION,
    plugin: Object.freeze({ id: plugin.id, version: plugin.version }),
    capabilities: Object.freeze(plugin.capabilities.map((capability) => Object.freeze({ ...capability }))),
 // 宿主可以按插件覆盖声明里的 config（部署位置、token 文件路径这类只属于这台机器的值）。
 // 覆盖只加不减：声明里的默认值仍然是默认值，宿主没说的键还在。
    config: Object.freeze({ ...manifest.config, ...deps.configOverlay }),
    env: Object.freeze({ ...deps.env }),
    dataDir: deps.dataDir,
 /** A short line for the load report. Bounded: a chatty plugin cannot flood the log. */
    log(message) {
      if (logs.length >= LOADER_LIMITS.logEntries) return;
      logs.push(String(message));
    },
 /** Where a tool surface is handed over. Everything else is refused, loudly. */
    tool(name, implementation) {
      if (typeof name !== 'string' || name === '') refuse(LOADER_ERRORS.invalidToolName, String(name));
      const surface = declared.get(name);
      if (surface === undefined) refuse(LOADER_ERRORS.undeclaredCapability, plugin.id + '/' + name);
      if (surface !== 'tool') refuse(LOADER_ERRORS.toolForNonToolSurface, plugin.id + '/' + name + ' (' + surface + ')');
      if (used.has(name)) refuse(LOADER_ERRORS.duplicateTool, plugin.id + '/' + name);
      used.add(name);
      implementations[name] = implementation;
      return implementation;
    },
  };

 // ---- 出口槽位：插件把助手要说的话交出去 -------------------------
 // 和 tool 一样：只认助手声明过的能力、只认 outbound 面、同名只能注册一次。
 // 插件拿到的只是"交出去"这一个动作；发给谁、发几次、超长怎么切、失败记什么，都在宿主。
  const outbound = {};
  context.outbound = function registerOutbound(name, handler) {
    if (typeof name !== 'string' || name === '') refuse(LOADER_ERRORS.invalidToolName, String(name));
    const surface = declared.get(name);
    if (surface === undefined) refuse(LOADER_ERRORS.undeclaredCapability, plugin.id + '/' + name);
    if (surface !== 'outbound') refuse(LOADER_ERRORS.toolForNonToolSurface, plugin.id + '/' + name + ' (' + surface + ')');
    if (used.has(name)) refuse(LOADER_ERRORS.duplicateTool, plugin.id + '/' + name);
    if (typeof handler !== 'function') refuse(LOADER_ERRORS.invalidOutbound, plugin.id + '/' + name);
    used.add(name);
    outbound[name] = handler;
    return handler;
  };

 // ---- 入口槽位-----------------------------------------------
 // 和出口相反：插件交上来的不是一个「怎么发」的函数，而是一个「订阅」函数——
 // 宿主在加载完之后调用它，把**宿主自己的闸门**（白名单/上限/静音/去重）交给插件。
 // 这样插件永远拿不到「直接写进助手的记忆」那条路：它只能把消息推给闸门，进不进由宿主说了算。
  const inbound = {};
  context.inbound = function registerInbound(name, subscribe) {
    if (typeof name !== 'string' || name === '') refuse(LOADER_ERRORS.invalidToolName, String(name));
    const surface = declared.get(name);
    if (surface === undefined) refuse(LOADER_ERRORS.undeclaredCapability, plugin.id + '/' + name);
    if (surface !== 'inbound') refuse(LOADER_ERRORS.toolForNonToolSurface, plugin.id + '/' + name + ' (' + surface + ')');
    if (used.has(name)) refuse(LOADER_ERRORS.duplicateTool, plugin.id + '/' + name);
    if (typeof subscribe !== 'function') refuse(LOADER_ERRORS.invalidInbound, plugin.id + '/' + name);
    used.add(name);
    inbound[name] = subscribe;
    return subscribe;
  };

 // ---- 宿主服务（记忆、助手自己的时刻）----------------------------------------
 // 门槛永远是**声明**：只有 manifest 里声明了对应 surface 的能力，宿主才把那一层服务
 // 交出去。声明了却没给 = 拒绝加载（不能静默少一个门）；没声明 = 就是没有，不报错。
 // 一门一行，加门的时候不加分支——这样"谁能碰到助手的库"永远是一张能读完的表。
  const SERVICE_DOORS = [
    { surface: 'memory', name: 'memory', missing: LOADER_ERRORS.memoryServiceUnavailable },
 // 名字叫 reminders 而不是 schedule：插件里 context.reminders.schedule 读起来是
 // "把助手的时刻定下来"，而 surface 名字（schedule）只是那道门的编号。
    { surface: 'schedule', name: 'reminders', missing: LOADER_ERRORS.scheduleServiceUnavailable },
 // 联网：门的名字就是 net，插件拿到的是 context.net——
 // 不是通用 fetch，是「查一次」「打开一个」两个动作；出口与名单由宿主决定，插件只能照它做。
    { surface: 'net', name: 'net', missing: LOADER_ERRORS.netServiceUnavailable },
 // 助手的工作间：门的编号是 surface:exec，交到插件手里时叫 hands——
 // 插件里写 context.hands.run({command}) 读起来就是「用手跑一条命令」。拿到的不是
 // 裸 spawn，是宿主自己包好的沙箱（landlock 白名单 + ulimit + 超时）。
    { surface: 'exec', name: 'hands', missing: LOADER_ERRORS.handsServiceUnavailable },
 // 画一张：门的编号是 surface:image，交到插件手里时叫 paint——
 // 插件里写 context.paint.draw({prompt}) 就是「画一张」。图不在本机画，key 也不给插件。
    { surface: 'image', name: 'paint', missing: LOADER_ERRORS.imageServiceUnavailable },
 // 号池：门的编号是 surface:image-pool，交到插件手里时叫 imagePool——
 // 插件里写 context.imagePool.importFile({path}) 就是「把这份文件交给号池」。
 // 文件字节从不进助手的上下文；import key 只在宿主这一侧读。
    { surface: 'image-pool', name: 'imagePool', missing: LOADER_ERRORS.imagePoolServiceUnavailable },
  ];
  const services = [];
  for (const door of SERVICE_DOORS) {
    const wants = plugin.capabilities.some((capability) => capability.surface === door.surface);
    if (!wants) continue;
    const service = deps.services !== null && typeof deps.services === 'object' ? deps.services[door.name] : undefined;
    if (service === null || service === undefined || typeof service !== 'object') {
      refuse(door.missing, plugin.id + ': manifest declares surface:' + door.surface + ' but the host provided none');
    }
    context[door.name] = service;
    services.push(door.name);
  }

 // 还没实现的槽位仍然按名字拒绝：写错了要当场知道，不能靠沉默当成成功。
  for (const slot of ['lifecycle']) {
    Object.defineProperty(context, slot, {
      enumerable: true,
      value: () => refuse(LOADER_ERRORS.slotNotImplemented, slot + ': the ' + slot + ' slot is not implemented yet'),
    });
  }

  return { context: Object.freeze(context), implementations, outbound, inbound, logs, used, services };
}

/**
 * Loads one plugin the agent has enabled. Returns its tool implementations and what it logged.
 * Async because a factory may be async; the loader waits rather than racing it.
 */
export async function loadPlugin(store, input) {
  if (store === null || typeof store !== 'object' || typeof store.db !== 'object') refuse('missing_store', typeof store);
  const options = input === null || typeof input !== 'object' ? {} : input;
  const pluginId = options.pluginId;
  const dir = pluginDir(options.pluginsRoot, pluginId);

  const row = readPlugin(store, pluginId);
  if (row === null) refuse(LOADER_ERRORS.pluginNotInstalled, String(pluginId));
  if (row.status !== 'enabled') refuse(LOADER_ERRORS.pluginDisabled, String(pluginId));

  const declarationPath = path.join(dir, DECLARATION_FILE);
  if (!existsSync(declarationPath)) refuse(LOADER_ERRORS.declarationMissing, declarationPath);
  let manifest;
  try {
    manifest = parseManifest(readFileSync(declarationPath, 'utf8'));
  } catch (error) {
    if (error instanceof LifePluginError) refuse(error.code, declarationPath + ': ' + error.message);
    throw error;
  }
  if (manifest.id !== pluginId) refuse(LOADER_ERRORS.idMismatch, manifest.id + ' != ' + String(pluginId));
  if (manifest.version !== row.version) {
    refuse(LOADER_ERRORS.versionMismatch, 'installed ' + row.version + ', on disk ' + manifest.version);
  }

 // 宿主服务先算出来：依赖检查要问的是"宿主到底交没交这个服务"，
 // 不能等 buildContext 里才发现少了一把钥。
  const services = options.services === null || typeof options.services !== 'object' || Array.isArray(options.services)
    ? {}
    : options.services;
 // 依赖：装了原生生图插件、且宿主交出号池服务，才配号池那两只手。不满足就不加载——
 // 不是报错、不是静默降级，是"这一份能力压根不出现"：没有那条链路的宿主里，
 // 也就不该出现"传号池""查号池"这样的动作。
  const unmet = unmetRequirements(manifest, store, services);
  if (unmet.missingPlugins.length > 0 || unmet.missingServices.length > 0) {
    throw new LifePluginError(LOADER_ERRORS.requiresUnmet, JSON.stringify(unmet));
  }

  const factoryPath = path.join(dir, FACTORY_FILE);
  if (!existsSync(factoryPath)) refuse(LOADER_ERRORS.factoryMissing, factoryPath);
  let module;
  try {
    module = await import(pathToFileURL(factoryPath).href);
  } catch (error) {
    refuse(LOADER_ERRORS.factoryFailed, 'import failed: ' + String(error && error.message || error));
  }
  if (typeof module.create !== 'function') refuse(LOADER_ERRORS.factoryMissingExport, factoryPath);

  let dataDir = null;
  if (options.dataRoot !== undefined && options.dataRoot !== null) {
    const root = requirePath(options.dataRoot, LOADER_ERRORS.invalidDataRoot, 'dataRoot');
    dataDir = path.join(root, pluginId);
    mkdirSync(dataDir, { recursive: true });
  }

  const env = options.env === null || typeof options.env !== 'object' ? {} : options.env;
  const overlays = options.pluginConfig !== null && typeof options.pluginConfig === 'object' && !Array.isArray(options.pluginConfig)
    ? options.pluginConfig : {};
  const own = overlays[pluginId];
  const configOverlay = own !== null && typeof own === 'object' && !Array.isArray(own) ? own : {};
 // 宿主造的服务（记忆 / 画画 / 号池）：由宿主交进来，不从磁盘也不从环境里读，
 // 所以"哪个插件拿到了库"永远只是宿主里的一行。
  const built = buildContext(row, manifest, { env, dataDir, configOverlay, services });
  try {
    await module.create(built.context);
  } catch (error) {
    if (error instanceof LifePluginError) throw error;
    refuse(LOADER_ERRORS.factoryFailed, String(error && error.message || error));
  }

  return {
    pluginId,
    version: row.version,
    tools: built.implementations,
    outbound: built.outbound,
    inbound: built.inbound,
    registered: Object.keys(built.implementations),
    channels: Object.keys(built.outbound),
    intake: Object.keys(built.inbound),
 // Which host services this plugin was actually handed (surface:memory today). In the
 // receipt, because "what could the agent reach" must not be answerable only by reading code.
    services: built.services.slice(),
    logs: built.logs,
    dataDir,
  };
}

/**
 * Loads every plugin the agent has enabled. Failures are collected, never thrown past the
 * caller: the host needs to report all of them at once ("which of my abilities failed to
 * load" is one question, not a stack trace per plugin).
 */
export async function loadEnabledPlugins(store, input) {
  if (store === null || typeof store !== 'object' || typeof store.db !== 'object') refuse('missing_store', typeof store);
  const options = input === null || typeof input !== 'object' ? {} : input;
  const rows = store.db.prepare("SELECT id FROM life_plugins WHERE status='enabled' ORDER BY id").all();
  const implementations = {};
  const channels = {};
  const intake = {};
  const loaded = [];
  const failed = [];
 // 依赖没满足的插件单独一栏：那不是"坏了"，是"前提不在"。分发出去的 life 里，
 // 号池那只手会一直安静地待在 skipped 里，而不是每次启动都报一条错。
  const skipped = [];
  for (const row of rows) {
    try {
      const result = await loadPlugin(store, { ...options, pluginId: row.id });
      implementations[row.id] = result.tools;
      channels[row.id] = result.outbound;
      intake[row.id] = result.inbound;
      loaded.push({ pluginId: result.pluginId, version: result.version, registered: result.registered, channels: result.channels, intake: result.intake, services: result.services, logs: result.logs });
    } catch (error) {
      const code = error instanceof LifePluginError ? error.code : 'load_failed';
      if (code === LOADER_ERRORS.requiresUnmet) {
        skipped.push({ pluginId: row.id, reason: 'requires_unmet', message: String(error && error.message || error) });
        continue;
      }
      failed.push({ pluginId: row.id, code, message: String(error && error.message || error) });
    }
  }
  return { implementations, channels, intake, loaded, failed, skipped };
}
