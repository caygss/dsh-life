/**
 * 最小宿主：加载插件 → 收一条消息 → 调模型 → 执行工具 → 把回复发出去。
 *
 * 只做四件事：
 * 1. 读 prompt 文件（没有就报错，不给默认人设）
 * 2. 把配置点名的插件建起来（manifest 校验 + create）
 * 3. 用 core/model 的 toRequest 拼请求，把回复拆成「文本 + 工具调用」
 * 4. 工具调用交给插件实现，最后把一句话交给插件的出站通道
 *
 * 它不是生产宿主：没有持久化、没有重试、没有并发、没有权限层。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseManifest } from '../../packages/dsh-life-core/plugins/manifest.mjs';
import {
  toRequest, userNode, assistantNode, toolResultNode, textBlock, toolCallBlock,
} from '../../packages/dsh-life-core/model/protocols.mjs';
import { splitParts } from '../../packages/dsh-life-core/marks.mjs';

const PROTOCOL_PATHS = Object.freeze({ chat: '/chat/completions', anthropic: '/messages', responses: '/responses' });

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function readPrompt(file) {
  if (!fs.existsSync(file)) throw new Error('prompt_missing: write ' + file);
  const text = fs.readFileSync(file, 'utf8').trim();
  if (text === '') throw new Error('prompt_empty: ' + file);
  return text;
}

/** 一次回复 → { text, calls[] }，三种协议的差别只在这里。 */
export function readReply(protocol, body) {
  if (protocol === 'chat') {
    const message = (body && body.choices && body.choices[0] && body.choices[0].message) || {};
    const text = typeof message.content === 'string' ? message.content : '';
    const calls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((c) => ({
      id: String((c && c.id) || ''),
      name: String((c && c.function && c.function.name) || ''),
      args: typeof (c && c.function && c.function.arguments) === 'string' ? c.function.arguments : JSON.stringify((c && c.function && c.function.arguments) || {}),
    }));
    return { text, calls };
  }
  if (protocol === 'anthropic') {
    const blocks = Array.isArray(body && body.content) ? body.content : [];
    const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
    const calls = blocks.filter((b) => b && b.type === 'tool_use').map((b) => ({ id: String(b.id || ''), name: String(b.name || ''), args: JSON.stringify(b.input || {}) }));
    return { text, calls };
  }
  if (protocol === 'responses') {
    const output = Array.isArray(body && body.output) ? body.output : [];
    const text = output.filter((o) => o && o.type === 'message').flatMap((o) => o.content || []).filter((c) => c && c.type === 'output_text').map((c) => c.text).join('');
    const calls = output.filter((o) => o && o.type === 'function_call').map((o) => ({ id: String(o.call_id || ''), name: String(o.name || ''), args: typeof o.arguments === 'string' ? o.arguments : JSON.stringify(o.arguments || {}) }));
    return { text, calls };
  }
  throw new Error('model_protocol_unsupported: ' + protocol);
}

async function callModel({ config, system, messages, tools }) {
  const protocol = (config.model && config.model.protocol) || 'chat';
  const base = String(config.model.baseUrl).replace(/\/+$/, '');
  const url = base + (PROTOCOL_PATHS[protocol] || PROTOCOL_PATHS.chat);
  const body = toRequest(protocol, {
    model: config.model.modelId,
    system,
    messages,
    tools: tools.length > 0 ? tools.map((t) => ({ function: { name: t.name, description: t.description, parameters: t.parameters } })) : null,
    maxTokens: Number.isSafeInteger(config.model.maxTokens) ? config.model.maxTokens : null,
    stream: false,
  });
  const headers = { 'content-type': 'application/json' };
  const key = config.model.apiKeyEnv ? process.env[config.model.apiKeyEnv] : undefined;
  if (key) {
    if (protocol === 'anthropic') { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
    else headers.authorization = 'Bearer ' + key;
  }
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!response.ok) throw new Error('model_http_' + response.status);
  return readReply(protocol, await response.json());
}

/** 把配置点名的插件建起来，返回工具表与出入站通道。 */
export async function loadPlugins(config, root) {
  const tools = [];
  const outbound = {};
  const inbound = {};
  const stubs = { memory: {}, reminders: {}, net: {}, paint: {}, imagePool: {} };
  for (const id of config.plugins || []) {
    const dir = path.join(root, 'packages', 'dsh-' + id);
    const manifest = parseManifest(fs.readFileSync(path.join(dir, 'life-plugin.json'), 'utf8'));
    const pluginConfig = Object.assign({}, manifest.config, ((config.pluginsConfig || {})[id] || {}));
    const ctx = {
      apiVersion: 1,
      plugin: { id: manifest.id, version: manifest.version },
      capabilities: manifest.capabilities,
      config: pluginConfig,
      env: Object.assign({ qqUserId: '10000' }, config.env || {}),
      dataDir: path.join(root, config.dataDir || 'data', manifest.id),
      log() {},
      tool(name, implementation) { tools.push(Object.assign({ name }, implementation)); return implementation; },
      outbound(name, handler) { outbound[name] = handler; return handler; },
      inbound(name, subscribe) { inbound[name] = subscribe; return subscribe; },
      ...stubs,
    };
    const mod = await import(pathToFileURL(path.join(dir, 'index.mjs')).href);
    const create = mod.default || mod.create;
    if (typeof create !== 'function') throw new Error('plugin_missing_create: ' + id);
    create(ctx);
  }
  return { tools, outbound, inbound };
}

export async function startHost({ root = process.cwd(), configPath = 'config.json', onInbound } = {}) {
  const config = readJson(path.join(root, configPath));
  const system = readPrompt(path.join(root, config.promptPath));
  const loaded = await loadPlugins(config, path.resolve(root, '..', '..'));
  const byName = new Map(loaded.tools.map((t) => [t.name, t]));
  const channel = config.outbound;
  const send = loaded.outbound[channel];
  if (typeof send !== 'function') throw new Error('outbound_missing: ' + channel);

  async function runTurn(text) {
    const messages = [userNode(text)];
    const used = [];
    for (let round = 0; round < ((config.turn && config.turn.maxRounds) || 3); round++) {
      const reply = await callModel({ config, system, messages, tools: loaded.tools });
      if (reply.calls.length === 0) return { text: reply.text, used };
      const blocks = [];
      if (reply.text) blocks.push(textBlock(reply.text));
      for (const call of reply.calls) blocks.push(toolCallBlock(call.id, call.name, JSON.parse(call.args || '{}'), call.args));
      messages.push(assistantNode(blocks));
      for (const call of reply.calls) {
        const implementation = byName.get(call.name);
        let output; let failed = false;
        try {
          if (!implementation) throw new Error('unknown_tool: ' + call.name);
          output = String(await implementation.execute(JSON.parse(call.args || '{}')));
        } catch (error) { failed = true; output = String((error && error.message) || error); }
        used.push({ name: call.name, ok: !failed, output: output.slice(0, 200) });
        messages.push(toolResultNode(call.id, output, failed));
      }
    }
    return { text: '（工具调用轮次用尽）', used };
  }

  const queue = [];
  const channelName = (config.inbound && config.inbound.channel) || 'qq_recv';
  const subscribeInbound = loaded.inbound[channelName];
  if (typeof subscribeInbound === 'function') subscribeInbound((event) => { queue.push(event); if (onInbound) onInbound(event); });

  return {
    config, tools: loaded.tools, runTurn, queue, send, splitParts,
    async waitForMessage(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (queue.length === 0) {
        if (Date.now() > deadline) return null;
        await new Promise((r) => setTimeout(r, 25));
      }
      return queue.shift();
    },
  };
}
