/**
 * 示例入口：起假 OneBot + 假模型 + 最小宿主，跑一轮完整闭环，然后退出。
 * 真实环境：把 config.json 的端点指向你自己的服务，删掉两行 startFake* 即可。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeOneBot } from './fake/onebot.mjs';
import { startFakeModel } from './fake/model.mjs';
import { startHost } from './host.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const message = {
  post_type: 'message', message_type: 'private', self_id: 10000, user_id: 10001,
  message_id: 42, time: Math.floor(Date.now() / 1000),
  message: [{ type: 'text', data: { text: '在吗？把自己设成在线。' } }],
};

process.on('uncaughtException', (error) => { console.error('[example] uncaught: ' + ((error && error.stack) || error)); process.exit(1); });
process.on('unhandledRejection', (error) => { console.error('[example] unhandled: ' + ((error && error.stack) || error)); process.exit(1); });

const onebot = await startFakeOneBot({ httpPort: 18020, wsPort: 18021, message });
const model = await startFakeModel({ port: 18088 });
const host = await startHost({ root: here, configPath: 'config.json' });

const inbound = await host.waitForMessage(5000);
if (!inbound) { console.log('没有得到入站消息'); process.exit(1); }
console.log('[example] 收到：' + inbound.text);

const result = await host.runTurn(inbound.text);
console.log('[example] 模型最终回复：' + result.text);
for (const call of result.used) console.log('[example] 工具 ' + call.name + ' ok=' + call.ok + ' -> ' + call.output);

// 分条与心声由宿主处理，不写进 prompt：||| 分条，<...> 与整条括号是心声、不发送
const parts = host.splitParts(result.text);
const bubbles = [];
for (const part of parts) {
  if (part.kind === 'public') { bubbles.push(part.text); await host.send({ text: part.text }); }
  else console.log('[example] 心声（不发送）：' + part.text);
}
console.log('[example] 发出 ' + bubbles.length + ' 条；假 OneBot 收到的动作：' + onebot.actions.map((a) => a.action).join(', '));

onebot.close(); model.close();
await new Promise((resolve) => process.stdout.write('', resolve));
setTimeout(() => process.exit(0), 300);
