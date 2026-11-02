# 模型协议（模板文档）

宿主只用一份中间表示（IR）描述对话，再按协议序列化。代码在 `packages/dsh-life-core/model/protocols.mjs`。

## 1. 三种协议

| | chat | anthropic | responses |
|---|---|---|---|
| 端点 | `POST {base}/chat/completions` | `POST {base}/messages` | `POST {base}/responses` |
| 鉴权 | `Authorization: Bearer` | `x-api-key` + `anthropic-version` | `Authorization: Bearer` |
| 系统提示 | `messages[0].role=system` | 顶层 `system` | 顶层 `instructions` |
| 工具声明 | `tools[].function{...}` | `tools[].{name,description,input_schema}` | `tools[].{type,name,description,parameters}` |
| 模型发起调用 | `message.tool_calls[]`（参数是 JSON 字符串） | `content[] type=tool_use`（参数是对象） | `output[] type=function_call` |
| 回传结果 | `role=tool` + `tool_call_id` | `type=tool_result` + `tool_use_id` | `function_call_output` + `call_id` |

协议由端点路径推断（`resolveProtocol(endpoint)`），配置里不用写；要强制时再写。

## 2. 怎么用

```js
import { toRequest, userNode } from '.../model/protocols.mjs';

const body = toRequest('chat', {
  model: 'my-model',
  system: '你是一个助手。',
  messages: [userNode('你好')],
  tools: [{ function: { name: 'ping', description: 'ping', parameters: { type: 'object', properties: {} } } }],
  maxTokens: 512,
  stream: false,
});
```

流式：`stream: true` 时用 `createStreamDecoder(protocol, …)` 逐块解出来；本仓示例宿主用的是非流式。

## 3. 端口与端点

三种协议都只是 **同一个 baseUrl 下的不同路径**，所以“自定义端口”就是改 baseUrl：

```json
{ "protocol": "chat", "baseUrl": "http://127.0.0.1:18088/v1", "modelId": "fake-chat" }
```

不填 `apiKeyEnv` 时，示例宿主照样发请求（假模型不需要 key）；接真实服务时把环境变量名写进去。

## 4. 边界

- 这里只负责“把 IR 变成本协议的请求体”，不重试、不切换模型、不统计费用。
- 三种协议的回复解析在示例宿主 `readReply` 里，各 5 行左右；接新协议就加一段。
