/**
 * 假 OneBot v11：HTTP 收动作 + WebSocket 推一条假私聊。
 * 只实现示例用得上的几个动作，收到什么就打印什么。
 */
import http from 'node:http';
import { createHash } from 'node:crypto';

export function startFakeOneBot({ httpPort = 18020, wsPort = 18021, message = null } = {}) {
  const actions = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const action = (req.url || '/').replace(/^\//, '');
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch { payload = {}; }
      actions.push({ action, payload });
      console.log('[fake-onebot] ' + action + ' ' + JSON.stringify(payload).slice(0, 120));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1, ...payload } }));
    });
  });

  const ws = http.createServer();
  ws.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'] || '';
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const push = (obj) => {
      const data = Buffer.from(JSON.stringify(obj));
      const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 0xff]);
      socket.write(Buffer.concat([head, data]));
    };
    if (message) setTimeout(() => { console.log('[fake-onebot] ws push message'); push(message); }, 300);
    socket.on('data', () => {});
    socket.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(httpPort, '127.0.0.1', () => {
      ws.listen(wsPort, '127.0.0.1', () => {
        console.log('[fake-onebot] http :' + httpPort + '  ws :' + wsPort);
        resolve({ actions, close() { server.close(); ws.close(); } });
      });
    });
  });
}
