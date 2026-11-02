/** Provider-neutral IR plus three wire protocols: chat/completions, anthropic messages, responses.
 * One conversation is assembled once as IR; a protocol only serializes it. Nothing here
 * rewrites history into provider-specific prose, and unsupported replay metadata is dropped
 * per request copy instead of changing stored content. */
import { projectProviderUsage } from './request-metrics.mjs';

const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalid = code => () => { throw Error(code); };

export const PROTOCOLS = Object.freeze(['chat', 'anthropic', 'responses']);

/** Endpoint shape decides the protocol; it never rewrites the configured route. */
export function resolveProtocol(endpoint) {
  let url; try { url = new URL(endpoint); } catch { throw TypeError('model_endpoint_invalid'); }
  const p = url.pathname.replace(/\/+$/, '');
  if (/\/messages$/.test(p)) return 'anthropic';
  if (/\/responses$/.test(p)) return 'responses';
  return 'chat';
}

export function textBlock(text) {
  if (typeof text !== 'string') throw TypeError('ir_text_invalid');
  return Object.freeze({ type: 'text', text });
}
export function thinkingBlock(text, signature = null) {
  if (typeof text !== 'string' || !text) throw TypeError('ir_thinking_invalid');
  return Object.freeze({ type: 'thinking', text, signature: typeof signature === 'string' && signature ? signature : null });
}
export function toolCallBlock(id, name, args, rawArguments = null) {
  const json = typeof rawArguments === 'string' ? rawArguments : JSON.stringify(args ?? {});
  return Object.freeze({ type: 'tool_call', id, name, arguments: args ?? {}, rawArguments: json });
}
export function toolResultBlock(callId, output, isError = false) {
  return Object.freeze({ type: 'tool_result', callId, output: String(output ?? ''), isError: isError === true });
}
export function systemNode(text) {
  if (typeof text !== 'string') throw TypeError('ir_system_invalid');
  return Object.freeze({ role: 'system', text });
}
export function messageNode(role, blocks) {
  if (!['user', 'assistant', 'tool'].includes(role)) throw TypeError('ir_role_invalid');
  if (!Array.isArray(blocks) || !blocks.length) throw TypeError('ir_blocks_invalid');
  return Object.freeze({ role, blocks: Object.freeze([...blocks]) });
}
export function userNode(text) { return messageNode('user', [textBlock(text)]); }
export function toolResultNode(callId, output, isError = false) { return messageNode('tool', [toolResultBlock(callId, output, isError)]); }
export function assistantNode(blocks) { return messageNode('assistant', blocks); }

export function assertConversation(ir) {
  if (!record(ir) || typeof ir.system !== 'string' || !Array.isArray(ir.messages)) throw Error('ir_conversation_invalid');
  for (const m of ir.messages) {
    if (!record(m) || !['user', 'assistant', 'tool'].includes(m.role) || !Array.isArray(m.blocks) || !m.blocks.length) throw Error('ir_conversation_invalid');
    for (const b of m.blocks) if (!record(b) || !['text', 'thinking', 'tool_call', 'tool_result'].includes(b.type)) throw Error('ir_conversation_invalid');
  }
  return ir;
}

const textOf = blocks => blocks.filter(b => b.type === 'text').map(b => b.text).join('');
const callsOf = blocks => blocks.filter(b => b.type === 'tool_call');
const thinkingOf = blocks => blocks.find(b => b.type === 'thinking') ?? null;

function chatMessages(ir, { thinking }) {
  const out = [];
  if (ir.system) out.push({ role: 'system', content: ir.system });
  for (const m of ir.messages) {
    if (m.role === 'user') {
      const toolResults = m.blocks.filter(b => b.type === 'tool_result');
      if (toolResults.length) { for (const r of toolResults) out.push({ role: 'tool', tool_call_id: r.callId, content: r.output }); continue; }
      out.push({ role: 'user', content: textOf(m.blocks) });
      continue;
    }
    if (m.role === 'tool') { for (const r of m.blocks) out.push({ role: 'tool', tool_call_id: r.callId, content: r.output }); continue; }
    const calls = callsOf(m.blocks), think = thinkingOf(m.blocks);
    const msg = { role: 'assistant', content: textOf(m.blocks) };
    if (think && thinking !== 'disabled') msg.reasoning_content = think.text;
    if (calls.length) msg.tool_calls = calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArguments } }));
    out.push(msg);
  }
  return out;
}

function anthropicMessages(ir) {
  const out = [];
  for (const m of ir.messages) {
    if (m.role === 'tool') {
      out.push({ role: 'user', content: m.blocks.map(r => ({ type: 'tool_result', tool_use_id: r.callId, content: r.output, ...(r.isError ? { is_error: true } : {}) })) });
      continue;
    }
    if (m.role === 'user') {
      const results = m.blocks.filter(b => b.type === 'tool_result');
      if (results.length) { out.push({ role: 'user', content: results.map(r => ({ type: 'tool_result', tool_use_id: r.callId, content: r.output, ...(r.isError ? { is_error: true } : {}) })) }); continue; }
      out.push({ role: 'user', content: [{ type: 'text', text: textOf(m.blocks) }] });
      continue;
    }
    out.push({ role: 'assistant', content: m.blocks.map(b => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'thinking') return { type: 'thinking', thinking: b.text, ...(b.signature ? { signature: b.signature } : {}) };
      return { type: 'tool_use', id: b.id, name: b.name, input: b.arguments };
    }) });
  }
  return out;
}

function responsesInput(ir) {
  const input = [];
  for (const m of ir.messages) {
    for (const b of m.blocks) {
      if (b.type === 'text') input.push({ type: 'message', role: m.role === 'assistant' ? 'assistant' : 'user', content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: b.text }] });
      else if (b.type === 'thinking') input.push({ type: 'reasoning', ...(b.signature ? { encrypted_content: b.signature } : {}), summary: [] });
      else if (b.type === 'tool_call') input.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: b.rawArguments });
      else if (b.type === 'tool_result') input.push({ type: 'function_call_output', call_id: b.callId, output: b.output });
    }
  }
  return input;
}

function chatTools(tools) { return tools.map(t => ({ type: 'function', function: t.function })); }
function anthropicTools(tools) { return tools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })); }
function responsesTools(tools) { return tools.map(t => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters })); }

/** Serialize one IR conversation for a protocol. Only the request copy is protocol-specific. */
export function toRequest(protocol, options) {
  assertConversation(options);
  const { model, system, messages, tools = null, toolChoice = null, maxTokens = null, stream = true, thinking = undefined } = options;
  if (protocol === 'chat') {
    const body = { model, messages: chatMessages(options, { thinking }), stream };
    if (stream) body.stream_options = { include_usage: true };
    if (Number.isSafeInteger(maxTokens)) body.max_tokens = maxTokens;
    if (tools && tools.length) { body.tools = chatTools(tools); if (toolChoice) body.tool_choice = toolChoice; }
    if (thinking === 'disabled') body.thinking = { type: 'disabled' };
    return body;
  }
  if (protocol === 'anthropic') {
    const body = { model, max_tokens: Number.isSafeInteger(maxTokens) ? maxTokens : 4096, messages: anthropicMessages(options), stream };
    if (system) body.system = system;
    if (tools && tools.length) { body.tools = anthropicTools(tools); if (toolChoice) body.tool_choice = { type: 'auto' }; }
    if (thinking === 'enabled') body.thinking = { type: 'enabled', budget_tokens: Math.max(1024, Math.min(8192, Math.floor((body.max_tokens || 8192) / 2))) };
    return body;
  }
  if (protocol === 'responses') {
    const body = { model, input: responsesInput(options), stream };
    if (system) body.instructions = system;
    if (Number.isSafeInteger(maxTokens)) body.max_output_tokens = maxTokens;
    if (tools && tools.length) body.tools = responsesTools(tools);
    return body;
  }
  throw TypeError('model_protocol_unsupported');
}

const clineEndpoint = endpoint => {
  try { const u = new URL(endpoint); return u.origin === 'https://api.cline.bot' && u.pathname === '/api/v1/chat/completions'; } catch { return false; }
};
export function unwrapEnvelope(value, endpoint) {
  if (!record(value)) throw Error('model_response_envelope_invalid');
  if (!clineEndpoint(endpoint) || (!Object.hasOwn(value, 'success') && !Object.hasOwn(value, 'data'))) return value;
  if (value.success !== true || !record(value.data) || Object.hasOwn(value, 'choices') || Object.hasOwn(value.data, 'data')) throw Error('model_response_envelope_invalid');
  return value.data;
}
export function assertResponseModel(value, expected) {
  if (typeof value?.model !== 'string' || !value.model.trim()) throw Error('model_response_model_missing');
  if (value.model !== expected) throw Error('model_id_mismatch_no_fallback');
}

const toUsage = (usage, protocol) => {
  if (!record(usage)) return null;
  if (protocol === 'chat') return projectProviderUsage(usage);
  const p = Number.isSafeInteger(usage.input_tokens) ? usage.input_tokens : null;
  const c = Number.isSafeInteger(usage.output_tokens) ? usage.output_tokens : null;
  if (p === null || c === null) return null;
  const mapped = { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
  if (Number.isSafeInteger(usage.cache_read_input_tokens)) mapped.prompt_cache_hit_tokens = usage.cache_read_input_tokens;
  return mapped;
};

/** One SSE decoder per protocol. Emits neutral deltas and one final assistant message. */
export function createStreamDecoder(protocol, { modelId, endpoint, onText = null, onThinking = null, onToolCall = null, captureReasoning = false } = {}) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '', data = [], content = '', thinking = '', usage = null, finishReason = null, done = false, terminated = false;
  const toolCalls = new Map();
  const emit = (fn, arg) => { try { fn?.(arg); } catch { /* observers never control the request */ } };
  const recordUsage = raw => { if (usage !== null) throw Error('model_incomplete_or_unsupported_output'); usage = toUsage(raw, protocol); };
  const pushText = t => { content += t; emit(onText, t); };
  const tool = index => { if (!toolCalls.has(index)) toolCalls.set(index, { id: '', name: '', arguments: '' }); return toolCalls.get(index); };
  const handle = payload => {
    if (payload === '[DONE]') { done = true; return; }
    let chunk; try { chunk = JSON.parse(payload); } catch { throw Error('model_response_not_json'); }
    chunk = unwrapEnvelope(chunk, endpoint);
 // A provider that fails mid-stream is reported as an error envelope. Name it
 // as such: the alternative was "model missing", which pointed at the
 // response shape instead of at the provider that refused the request.
    if (record(chunk) && record(chunk.error)) {
      const code = typeof chunk.error.code === 'string' && chunk.error.code ? chunk.error.code : 'unknown';
      throw Error('model_provider_error:' + code);
    }
    if (protocol === 'chat') {
      assertResponseModel(chunk, modelId);
      if (!Array.isArray(chunk.choices) || chunk.choices.length > 1) throw Error('model_incomplete_or_unsupported_output');

      for (const choice of chunk.choices) {
        const delta = choice?.delta ?? {};
        if (typeof delta.content === 'string' && delta.content) pushText(delta.content);
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) { if (captureReasoning) thinking += delta.reasoning_content; emit(onThinking); }
        if (Array.isArray(delta.tool_calls)) for (const call of delta.tool_calls) {
          const slot = tool(Number.isSafeInteger(call.index) ? call.index : 0);
          if (typeof call.id === 'string' && call.id) slot.id = call.id;
          if (typeof call.function?.name === 'string') slot.name += call.function.name;
          if (typeof call.function?.arguments === 'string') slot.arguments += call.function.arguments;
          emit(onToolCall, { id: slot.id, name: slot.name });
        }
        if (choice?.finish_reason) { finishReason = choice.finish_reason; terminated = true; }
      }
      if (chunk.usage) { if (terminated) recordUsage(chunk.usage); }
      return;
    }
    if (protocol === 'anthropic') {
      const type = chunk.type;
      if (type === 'message_start') { assertResponseModel({ model: chunk.message?.model }, modelId); usage = toUsage(chunk.message?.usage, protocol) ?? usage; return; }
      if (type === 'content_block_start') { const b = chunk.content_block ?? {}; if (b.type === 'tool_use') { const slot = tool(chunk.index ?? 0); slot.id = b.id ?? ''; slot.name = b.name ?? ''; } return; }
      if (type === 'content_block_delta') {
        const d = chunk.delta ?? {};
        if (d.type === 'text_delta' && typeof d.text === 'string') pushText(d.text);
        else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') { if (captureReasoning) thinking += d.thinking; emit(onThinking); }
        else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') { const slot = tool(chunk.index ?? 0); slot.arguments += d.partial_json; }
        return;
      }
      if (type === 'message_delta') { if (chunk.delta?.stop_reason) finishReason = chunk.delta.stop_reason; if (chunk.usage) usage = toUsage(chunk.usage, protocol) ?? usage; return; }
      if (type === 'message_stop') { done = true; return; }
      if (type === 'error') throw Error('model_incomplete_or_unsupported_output');
      return;
    }
    const t = chunk.type;
    if (t === 'response.output_text.delta' && typeof chunk.delta === 'string') pushText(chunk.delta);
    else if (t === 'response.reasoning_summary_text.delta' && typeof chunk.delta === 'string') { if (captureReasoning) thinking += chunk.delta; emit(onThinking); }
    else if (t === 'response.output_item.added' && chunk.item?.type === 'function_call') { const slot = tool(toolCalls.size); slot.id = chunk.item.call_id ?? ''; slot.name = chunk.item.name ?? ''; }
    else if (t === 'response.function_call_arguments.delta' && typeof chunk.delta === 'string') { const slot = tool(toolCalls.size ? toolCalls.size - 1 : 0); slot.arguments += chunk.delta; }
    else if (t === 'response.completed') { if (chunk.response?.usage) recordUsage(chunk.response.usage); finishReason = 'stop'; done = true; }
    else if (t === 'response.failed' || t === 'error') throw Error('model_incomplete_or_unsupported_output');
  };
  const consumeLine = () => {
    const current = line; line = '';
    if (!current) { if (data.length) { const payload = data.join('\n'); data = []; handle(payload); } return; }
    if (current.startsWith(':')) return;
    const colon = current.indexOf(':');
    if ((colon < 0 ? current : current.slice(0, colon)) !== 'data') return;
    let value = colon < 0 ? '' : current.slice(colon + 1); if (value.startsWith(' ')) value = value.slice(1);
    data.push(value);
  };
  return {
    push(bytes) {
      let text; try { text = decoder.decode(bytes, { stream: true }); } catch { throw Error('model_incomplete_or_unsupported_output'); }
      let start = 0;
      for (let i = 0; i < text.length; i++) {
        if (text[i] !== '\n' && text[i] !== '\r') continue;
        line += text.slice(start, i); consumeLine();
        if (text[i] === '\r' && text[i + 1] === '\n') i++;
        start = i + 1;
      }
      line += text.slice(start);
    },
    get done() { return done; },
    finish() {
      try { if (decoder.decode()) throw Error('model_incomplete_or_unsupported_output'); } catch { throw Error('model_incomplete_or_unsupported_output'); }
      if (line.trim() || data.length) throw Error('model_incomplete_or_unsupported_output');
      if (!done) throw Error('model_incomplete_or_unsupported_output');
      const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => {
        let args = {}; if (c.arguments.trim()) { try { args = JSON.parse(c.arguments); } catch { args = null; } }
        return { id: c.id, name: c.name, arguments: args, rawArguments: c.arguments };
      });
      if (calls.some(c => !c.id || !c.name || c.arguments === null)) throw Error('model_incomplete_or_unsupported_output');
      if (calls.length && finishReason !== 'tool_use' && finishReason !== 'tool_calls' && protocol !== 'responses') finishReason = 'tool_calls';
 // Reasoning text is never retained unless the caller explicitly opted in for replay.
      return { content, thinking: captureReasoning ? thinking : null, toolCalls: calls, finishReason, usage, done };
    }
  };
}