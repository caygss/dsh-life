# dsh-life

A plugin collection plus a small core for a persistent companion agent on DeepSeek Harness.
模板化文档，不含任何个人设定、prompt 原文、部署信息或密钥。

## 目录

- `packages/dsh-life-core` — 插件契约（manifest / loader / registry / surfaces / tools）、
  `node:sqlite` 存储、记忆与向量层、睡眠与醒来节奏、三种模型协议（含流式解码）。
- `packages/dsh-life-*` — 插件：qq（45 个工具）、room、memory、time、web、hand、draw、image-pool。
- `examples/minimal-host` — 最小宿主 + 假 OneBot + 假模型，零 key、零外网跑通一轮闭环。
- `docs/` — 模板文档：插件接口、模型协议、配置、安全。

## 跑起来

```bash
node examples/minimal-host/start.mjs
```

会看到：假 OneBot 推一条私聊 → 宿主调假模型 → 模型发起一个工具调用 → 工具执行 → 最终回复发出去。
示例回复里带 `|||` 和 `<…>`：宿主按 `|||` 分条发送，`<…>`（以及整条 `(( ))` / `（…）`）作为心声不发出去——判定在 `packages/dsh-life-core/marks.mjs`，**不写进 prompt**。
真实环境：把 `examples/minimal-host/config.json` 里的端点指向你自己的服务，删掉两行 fake 启动即可。

## 你必须自己准备

1. 你自己的 system prompt（`examples/minimal-host/prompts/system.md` 只是玩具模板）。
2. 所有端点：OneBot HTTP/WS、模型 baseUrl、TTS、ASR、生图、embeddings。
3. 你自己的人设、记忆策略和边界 —— 仓库里没有这些。

Node >= 24.22.1（内置 sqlite / fetch / WebSocket），零 npm 依赖。

## 许可

[PolyForm Noncommercial License 1.0.0](LICENSE)（SPDX: `PolyForm-Noncommercial-1.0.0`）：
允许个人、学习、研究、评估、非营利等**非商业**用途；**禁止任何商业用途**，商业授权需另行取得书面许可。

## 本地检查（可选）

服务端分支保护需要 GitHub Pro；没有的话可以先装本地钩子，push 前跑和 CI 一样的两步：

```bash
git config core.hooksPath .githooks
```
