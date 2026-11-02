# 配置（模板文档）

示例宿主读 `examples/minimal-host/config.json`（故意用 JSON，全仓零依赖）。

## 1. 宿主配置

| 键 | 说明 |
|---|---|
| `promptPath` | system prompt 文件；**没有就报错退出**，不会给默认人设 |
| `dataDir` | 插件可写目录的根 |
| `plugins` | 要加载的插件 id 列表（对应 `packages/dsh-<id>`） |
| `pluginsConfig` | 按插件覆盖 `config`（端点、名单等） |
| `inbound.channel` | 从哪个入站通道收消息 |
| `outbound` | 用哪个出站通道发消息 |
| `model` | `protocol / baseUrl / modelId / maxTokens / apiKeyEnv` |
| `turn.maxRounds` | 一次对话最多几轮工具调用 |

## 2. 每个插件的端点（必须自己填）

只有 `life-qq` 自己拿端点——它要直连 OneBot，可选接 TTS/ASR：

| 插件 | 键 | 说明 |
|---|---|---|
| qq | `endpoint` / `wsEndpoint` | OneBot v11 的 HTTP 与 WebSocket 地址 |
| qq | `voiceEndpoint` | TTS 端点；空 = 关闭语音 |
| qq | `asrEndpoint` | 语音转写端点；空 = 关闭 |

`memory`（embedding）、`net`（搜索/抓取）、`image`（生图）、`image-pool` 不是插件配置：
插件只声明 surface，端点和 key 由**宿主**持有并注入，插件看不见 key。宿主那边怎么接，
是宿主自己的事。

参考部署：向量用**自部署的 Qwen3-Embedding-8B**（4096 维，OpenAI 兼容 `/v1/embeddings`，走环回地址），
向量表以模型名区分 —— 换模型或换维度必须同时换表名，旧向量不会自动重算。

## 3. 语音：接你自己的 TTS

语音工具只认三件事：端点、请求体模板、预设表。

```json
{
  "voiceEndpoint": "http://127.0.0.1:18100",
  "voicePresets": { "default": {}, "soft": { "style": "soft" } },
  "voiceBody": { "text": "{{text}}", "preset": "{{preset}}" }
}
```

`{{text}}` / `{{preset}}` 是占位符；响应必须是整包 WAV（不支持流式）。预设表的内容原样塞进请求体，所以你接什么引擎就写什么参数。

## 4. 名单

`life-qq` 的 `recipients` / `groups` 决定“能发给谁 / 在哪些群说话”，`inboundAllow` 决定“听谁说”。示例里只放了一个假 QQ 号。
