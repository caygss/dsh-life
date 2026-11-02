# 报错对照

> 先跑 `node .githooks/check.mjs` 排除语法/示例问题，再按下面的码查。
> 码来自代码本身，找不到的直接 `grep -r "invalid_why" packages/` 这种搜法最准。

## 1. 插件加载失败（宿主启动时）

| 码 | 原因 | 处理 |
|---|---|---|
| `declaration_missing` | 目录里没有 `life-plugin.json` | 插件目录名要与配置的 id 对应：`packages/dsh-<id>` |
| `invalid_manifest` | 声明不合法（缺字段、类型错） | 对照 [plugin-api.md](plugin-api.md) 的字段表 |
| `id_mismatch` | 声明的 `id` 与目录/id 参数不一致 | 改声明或改配置 |
| `version_mismatch` | 磁盘上的版本与安装记录不一致 | **改了 manifest 的 version 必须重装插件**；不要直接改文件 |
| `plugin_not_installed` / `plugin_disabled` | 宿主里没有这个插件，或它没启用 | 先装/先启用，再加载 |
| `factory_missing` / `factory_missing_export` | 没有 `index.mjs`，或没导出 `create` | 导出 `export function create(context)` |
| `factory_failed` | `create` 抛了异常 | 看它抛的那条信息；常见是缺 config/env |
| `undeclared_capability` | 注册了没在 `capabilities` 里声明的东西 | 声明的 name/surface 要和注册的一致 |
| `tool_for_non_tool_surface` | 用 `surface: tool` 以外的东西注册了工具 | 改声明或改注册方式 |
| `duplicate_tool` | 同一个工具名注册两次 | 改名 |
| `requires_unmet` | `requires` 里的插件/服务不在 | 先装依赖，或去掉这个插件（它会被记进 skipped，不是崩溃） |
| `*_service_unavailable` | 声明了某道门，但宿主没交出对应服务 | 宿主必须注入 `memory` / `reminders` / `net` / `hands` / `paint` / `imagePool` |
| `slot_not_implemented` | 宿主没有这个服务 | 同上 |
| `invalid_outbound_handler` / `invalid_inbound_handler` | 注册的出站/入站不是函数 | 传函数 |

## 2. 起不来 / 没反应

| 现象 | 原因 | 处理 |
|---|---|---|
| `prompt_missing` / `prompt_empty` | `promptPath` 不存在或空文件 | 写一份自己的 prompt；仓库不提供默认人设 |
| `life-room needs env.homeRoot from the host` | 宿主没给 `env.homeRoot` | 给 room 一个可读写的目录 |
| `life-qq needs config.imageDir or a host dataDir` | 既没配目录、宿主也没给 `dataDir` | 配 `imageDir`，或给宿主 `dataDir` |
| `life-qq needs config.wsEndpoint for inbound` | 没配 WS 地址 | 见 [onebot.md](onebot.md) 第 3 节 |
| 助手完全不理人 | 名单是空的（默认收紧） | 填 `inboundAllow` / `recipients` / `groups` |
| 助手发不出去 | 同上，或协议端掉线 | 先看协议端控制台，再看 `recipients.ids` |

## 3. 协议端（OneBot）相关

| 现象 | 原因 | 处理 |
|---|---|---|
| HTTP 401 | token 不对，或用了 `Token` 前缀/裸 token | 必须是 `Authorization: Bearer <token>` |
| WS 一直 401，HTTP 正常 | WS 是**另一份** token | 配 `onebotWsToken` 或 `wsTokenPath` |
| 发图/语音失败 | 递的是本地路径，协议端读不到 | 用 `base64://`（插件已默认这么做）；自定义实现要支持它 |
| 引用回复没引上 | 协议端查不到目标消息会**静默丢掉**引用段 | 先 `get_msg` 确认；引不上时插件会明说 |
| 私聊贴表情失败 | 协议端不支持（retcode 100） | 只在群里用 |
| 空间列表 retcode 100 | 没传 `target_uin` | 插件已默认显式传助手自己的号 |

更细的版本差异、动作清单见 [onebot.md](onebot.md)。

## 4. 模型侧

| 码 | 原因 | 处理 |
|---|---|---|
| `model_protocol_unsupported` | `protocol` 写了不认识的协议 | 只能是 `chat` / `anthropic` / `responses` |
| `model_http_<状态码>` | 端点返回非 2xx | 看状态码：401=key，404=路径，429=限流 |
| `model_response_not_json` | 流式/非流式拿到的不是 JSON | 检查端点是否是 OpenAI 兼容形状 |
| `model_response_model_missing` | 响应里没有 `model` 字段 | 端点不是标准形状，或 body 被包了信封 |
| `model_id_mismatch_no_fallback` | 返回的模型名与请求的不一致 | 网关偷偷换模型了；这个仓库**拒绝自动回退** |
| `model_response_envelope_not_enabled` | body 被 `{success,data}` 包了，但没开开关 | 传 `envelope: 'data'` |
| `model_response_envelope_invalid` | 开了开关，但收到的不是信封形状 | 关掉开关，或确认网关真的包了 |
| `model_provider_error:<code>` | 上游在流里返回了错误对象 | 按 code 查供应商文档 |
| `model_incomplete_or_unsupported_output` | 流不完整、多个 choice、工具参数坏掉 | 重试；持续出现就换端点/模型 |
| 回复正常但没有工具调用 | 端点的 `tools` 支持有问题 | 换模型或换成支持 function calling 的端点 |

## 5. 状态机

| 码 | 原因 | 处理 |
|---|---|---|
| `invalid_state` | 状态名不在五个里 | 只能是 `free` / `absorbed` / `listening` / `asleep` / `away` |
| `invalid_transition` | 这个状态不允许直接跳到那个状态 | 看 `TRANSITIONS`；例如睡着只能醒到 `free` 或 `listening` |
| `dwell_not_elapsed` | 当前状态没待够最短时间 | 这是防抖动；确实要跳就传 `force: true` |
| `invalid_why` | 原因不在词表里 | 见 `state.mjs` 的 `WHY`；早期宿主用过的退役名会被接受并自动升级成现名（`WHY_ALIASES`） |
| `why_mismatch` | 这个原因不能产生那个目标状态 | 例如 `sleepy` 只能进 `asleep` |
| `not_sleepy_enough` | 用 `sleepy` 但没给 `guards.mustSleep` | 传 guard，或改用 `decided_sleep` |
| `not_rested_enough` | 用 `natural_wake` 但没给 `guards.canWake` | 同上 |
| `focus_required` | 进 `absorbed` 却没给 `itemId` | 传正在做的事的 id |

## 6. 记忆 / 向量

| 现象 | 原因 | 处理 |
|---|---|---|
| `missing_api_key` / `missing_model` | 编码器没拿到 key 或模型名 | 由宿主传，不从磁盘猜 |
| `encoder_http_error` | embedding 端点报错 | 看状态码；key/额度/路径 |
| `encoder_dim_mismatch` | 同一次响应里向量长度不一致 | 端点有问题，或批次混了不同模型 |
| 换模型后召回空/乱 | 向量表按**模型名**区分 | 换模型必须换表名并重建向量，旧向量不会自动重算 |
| 召回质量差 | 没有语义模型，退化成 hash 编码 | 接一个真的 embedding 端点（参考：自部署 Qwen3-Embedding-8B，4096 维） |

## 7. 两条通用建议

1. **先缩小范围**：单聊 → 纯文本 → 一次工具 → 再扩到图片/语音/群/空间。
2. **先看日志再改代码**：插件加载日志会写明哪个码、哪个插件；错误码基本都能在本文对上。
