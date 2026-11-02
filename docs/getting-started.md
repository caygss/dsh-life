# 开始（从 clone 到"自己的助手回话"）

> 目标：先看到闭环（2 分钟），再换成你自己的模型（10 分钟），再接自己的 QQ（30 分钟）。
> 每一步都写清"你应该看到什么"。卡住了先看 [faq.md](faq.md)。

## 0. 你需要什么

| 项 | 必需 | 说明 |
|---|---|---|
| Node.js ≥ 24.22.1 | 是 | 用到内置 `node:sqlite` / fetch / WebSocket；零 npm 依赖 |
| 终端 | 是 | Windows PowerShell 也行 |
| 一个模型端点 + key | 第二步开始 | 三种协议任选：chat / anthropic / responses |
| 一个 OneBot v11 协议端 | 第三步开始 | 见 [onebot.md](onebot.md)，本仓库不含 |
| 一个 prompt 文件 | 第二步开始 | 仓库不带人设；缺少时宿主**报错退出**，不会给默认值 |

## 1. 先看闭环（零 key、零外网）

```bash
node examples/minimal-host/start.mjs
```

这是**一次性**脚本：起假的 OneBot（`127.0.0.1:18020/18021`）和假的模型（`127.0.0.1:18088`），
推一条假私聊，跑完一轮就退出。你应该看到（节选）：

```text
[fake-onebot] ws push message
[example] 收到：在吗？把自己设成在线。
[fake-onebot] set_online_status {"status":10}
[example] 模型最终回复：好的，已经上线。||| 你那边看得见吗？<其实有点紧张>
[example] 心声（不发送）：其实有点紧张
[example] 发出 2 条；假 OneBot 收到的动作：set_online_status, send_private_msg, send_private_msg
```

它同时演示了三件事：

| 你看到的 | 含义 |
|---|---|
| 发出 **2 条** | `|||` 把一条回复分成两个气泡 |
| `<其实有点紧张>` **没发出去** | `<…>` 是半截心声；整条 `(( ))` 或 `（…）` 也不发 |
| 一次工具调用 | 模型调 `qq_status`，宿主执行后把结果回填给模型 |

分条与心声的判定在 `packages/dsh-life-core/marks.mjs`，**不在 prompt 里** —— 换 prompt 不会破坏它。

顺手跑一下和 CI 相同的检查：

```bash
node .githooks/check.mjs
```

## 2. 换成你自己的模型

编辑 `examples/minimal-host/config.json` 的 `model` 段：

```json
"model": {
  "protocol": "chat",
  "baseUrl": "https://你的端点/v1",
  "modelId": "你的模型名",
  "maxTokens": 512,
  "apiKeyEnv": "MODEL_API_KEY"
}
```

- `protocol` 决定请求形状：`chat` / `anthropic` / `responses`（对照见 [model-protocols.md](model-protocols.md)）。
- key 不写进文件，写**环境变量名**，然后 `export MODEL_API_KEY=...`（PowerShell：`$env:MODEL_API_KEY="..."`）。
- 先跑**非流式**：示例宿主的 `readReply` 是非流式的，三种协议各 5 行左右。

两个常见坑：

| 现象 | 原因 |
|---|---|
| 回复里一个工具都没调 | 端点不支持 `tools`，或模型没按工具格式输出 |
| 明明有内容却读不到文本 | 网关把 body 包成 `{success, data}`；用 `unwrapEnvelope(body, 'data')` 显式拆，详见 model-protocols.md |

prompt 文件也别忘了：`promptPath` 指向的 `prompts/system.md` 必须存在且非空，否则 `prompt_missing` / `prompt_empty`。

## 3. 接自己的 QQ

按 [onebot.md](onebot.md) 装协议端、登录账号，然后填四个值：

```json
"pluginsConfig": {
  "life-qq": {
    "endpoint": "http://127.0.0.1:3000",
    "wsEndpoint": "ws://127.0.0.1:3001",
    "recipients": { "mode": "list", "ids": ["10001"], "primary": "10001" },
    "inboundAllow": ["10001"]
  }
}
```

token 走宿主 env（`onebotToken` / `onebotWsToken`）或 `tokenPath` 文件，**不写进配置文件**。
还要让宿主把助手自己的号传进来（`env.qqUserId`；示例宿主里默认是占位的 `10000`）。

验证顺序（别一次全开）：

1. 先只开私聊：自己给助手发一句话，看宿主有没有收到（`inbound` 日志）。
2. 再看回复：助手发回一条纯文本。
3. 再试图片/语音/文件；最后才考虑群聊、空间、表情包。

名单默认是**空的**（谁都发不出去、谁都不听），这是有意的安全默认 —— 不填就不会有动静。

## 4. 让它常驻

示例宿主是**一次性脚本**，不是生产宿主：没有持久化、没有重试、没有并发、没有权限层。
要长期跑，你自己需要一个循环：

```text
收件队列 ← 插件的 inbound
   ↓
runTurn(消息)  ← 模型 ↔ 工具，直到不再调用工具
   ↓
splitParts() → 逐条 send() → 插件的 outbound
```

再加上：进程守护（systemd/容器）、崩溃重启、状态落盘（`packages/dsh-life-core/store/db.mjs`）、
调度与醒来（`scheduler.mjs` / `wake.mjs`）、以及"哪类错该重试"的判断。
这部分目前没有文档，只有代码与示例。

## 5. 接下来读什么

| 你想做的事 | 看 |
|---|---|
| 接协议端、查版本兼容、动作清单 | [onebot.md](onebot.md) |
| 报错对照表 | [faq.md](faq.md) |
| 写自己的插件 | [plugin-api.md](plugin-api.md) |
| 三种模型协议的字段对照 | [model-protocols.md](model-protocols.md) |
| 配置项与名单 | [config.md](config.md) |
| 安全边界（端口、token、账号） | [security.md](security.md) |
