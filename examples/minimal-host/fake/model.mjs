/**
 * 假模型（OpenAI 兼容 /v1/chat/completions）：第一轮回一个工具调用，第二轮回一句话。
 * 换成真的把 baseUrl 指过去就行，这个文件不用改。
 */
import http from 'node:http';

export function startFakeModel({ port = 18088, toolName = 'qq_status', toolArgs = { status: 'online' }, reply = '好的，已经上线。||| 你那边看得见吗？<其实有点紧张>' } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch { payload = {}; }
      requests.push(payload);
      const hasTool = (payload.messages || []).some((m) => m.role === 'tool');
      console.log('[fake-model] ' + (req.url || '') + ' messages=' + (payload.messages || []).length + ' hasToolResult=' + hasTool);
      const answer = hasTool
        ? { choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] }
        : {
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: toolName, arguments: JSON.stringify(toolArgs) } }],
              },
              finish_reason: 'tool_calls',
            }],
          };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', model: payload.model || 'fake', ...answer, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    console.log('[fake-model] http :' + port);
    resolve({ requests, close() { server.close(); } });
  }));
}
