/**
 * The tool seam.
 *
 * Three things used to be built from three different sources: the tool table its core
 * asked for, the schemas the runtime actually registered, and the allowlist restrict
 * was given. In the first wake test they disagreed - the receipt counted one thing and
 * the runtime held another - so the receipt could not answer "what could the agent do".
 *
 * This module makes that class of bug structural rather than a thing to remember:
 * one function reads its plugin table, one array of tools comes out, and BOTH the
 * registry list and the allowlist are that same array. describeToolTable then feeds
 * the receipt from the same object, so the three views cannot drift apart.
 *
 * Only the 'tool' surface becomes a tool. inbound/outbound/exec/fs/net/secret are not
 * its actions: a plugin having one of those must not silently appear in its tool table.
 *
 * Refusals are loud, because every one of them means a declaration and a behaviour
 * disagree: a declared tool with no implementation, an implementation with no shape, a
 * tool offered for a non-tool surface, or two plugins claiming the same name (its tool
 * names are what the agent sees, so a collision is a design error, not a merge decision).
 */
import { LifePluginError } from './manifest.mjs';
import { activeCapabilities } from './registry.mjs';

/** The one surface that turns a capability into something the agent can call. */
export const TOOL_SURFACE = 'tool';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function refuse(code, detail) {
  throw new LifePluginError(code, detail);
}

function requireImplementation(pluginId, name, implementation) {
  const where = pluginId + '/' + name;
  if (implementation === undefined || implementation === null) refuse('tool_not_provided', where);
  if (!isPlainObject(implementation)) refuse('invalid_tool_implementation', where + ': not an object');
  if (typeof implementation.description !== 'string' || implementation.description.trim() === '') {
    refuse('invalid_tool_implementation', where + ': description');
  }
  const parameters = implementation.parameters;
  if (!isPlainObject(parameters)) refuse('invalid_tool_implementation', where + ': parameters');
  if (parameters.type !== undefined && parameters.type !== 'object') {
    refuse('invalid_tool_implementation', where + ': parameters.type must be object');
  }
  if (typeof implementation.execute !== 'function') refuse('invalid_tool_implementation', where + ': execute');

  let output = null;
  if (implementation.output !== undefined && implementation.output !== null) {
    if (!isPlainObject(implementation.output)) refuse('invalid_tool_implementation', where + ': output');
    if (!isPlainObject(implementation.output.schema)) refuse('invalid_tool_implementation', where + ': output.schema');
    if (typeof implementation.output.render !== 'function') refuse('invalid_tool_implementation', where + ': output.render');
    output = implementation.output;
  }

  return Object.freeze({
    name,
    description: implementation.description,
    parameters,
    output,
    execute: implementation.execute,
    pluginId,
    surface: TOOL_SURFACE,
  });
}

/**
 * Builds the tool table for one wake from it plugin table.
 *
 * @param {object} store its store (openStore)
 * @param {object} [input] { tools: { <pluginId>: { <capabilityName>: implementation } } }
 * Implementations are supplied by the host that actually loaded the plugin, so this
 * module never touches the filesystem and stays testable without a runtime.
 */
export function buildToolTable(store, input) {
  if (store === null || typeof store !== 'object' || typeof store.db !== 'object') {
    refuse('missing_store', typeof store);
  }
  const options = isPlainObject(input) ? input : {};
  const provided = isPlainObject(options.tools) ? options.tools : {};

  const active = activeCapabilities(store);
  const declared = [];
  const ignored = [];
  const tools = [];
  const owner = new Map();

  for (const capability of active) {
    if (capability.surface !== TOOL_SURFACE) {
 // Enabled, but not one of it actions. Recorded so the receipt can say so.
      ignored.push({ pluginId: capability.pluginId, name: capability.name, surface: capability.surface });
      continue;
    }
    declared.push(capability);
    const bucket = provided[capability.pluginId];
    const implementation = isPlainObject(bucket) ? bucket[capability.name] : undefined;
    const tool = requireImplementation(capability.pluginId, capability.name, implementation);
    if (owner.has(tool.name)) {
      refuse('tool_name_collision', tool.name + ': ' + owner.get(tool.name) + ' and ' + capability.pluginId);
    }
    owner.set(tool.name, capability.pluginId);
    tools.push(tool);
  }

 // The reverse check: an implementation offered for a capability that is NOT a tool
 // means the plugin's behaviour and its declaration disagree. Refuse it instead of
 // quietly ignoring a function nobody will ever call.
  for (const [pluginId, bucket] of Object.entries(provided)) {
    if (!isPlainObject(bucket)) continue;
    for (const name of Object.keys(bucket)) {
      const capability = active.find((entry) => entry.pluginId === pluginId && entry.name === name);
      if (capability === undefined) continue; // loaded but not enabled: nothing to check
      if (capability.surface !== TOOL_SURFACE) {
        refuse('implementation_for_non_tool_surface', pluginId + '/' + name + ' (' + capability.surface + ')');
      }
    }
  }

  return Object.freeze({
    tools: Object.freeze(tools),
 // The allowlist is not computed separately. It IS this array, so restrict and
 // register can never see different sets.
    allow: Object.freeze(tools.map((tool) => tool.name)),
    declared: Object.freeze(declared),
    ignored: Object.freeze(ignored),
  });
}

/**
 * The receipt payload for a wake. Every field is derived from the one table, and the
 * two lists that used to disagree are literally the same values in the same order.
 */
export function describeToolTable(table) {
  const names = table.tools.map((tool) => tool.name);
  return {
    registered: names.slice(),
    restricted: table.allow.slice(),
    declared: table.declared.map((capability) => capability.pluginId + '/' + capability.name),
    enabledNotTools: table.ignored.map((capability) => capability.pluginId + '/' + capability.name + ':' + capability.surface),
  };
}

/** True when registered, restricted and declared all describe the same tools. */
export function isToolTableClosed(table) {
  const description = describeToolTable(table);
  if (description.registered.length !== description.restricted.length) return false;
  if (description.registered.join('|') !== description.restricted.join('|')) return false;
  return description.declared.length === description.registered.length;
}
