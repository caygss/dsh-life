# 宿主（Host）实现指南（模板文档）

> 本文档对应仓库 0.1.0。它讲“想自己写一个宿主、把 `packages/dsh-life-*` 这些插件跑起来”需要做什么；示例在 `examples/minimal-host/host.mjs`，是接线样例，不是产品。
> 许可：PolyForm Noncommercial 1.0.0（禁止商用）。本文是模板文档，不是产品说明。

## 1. 职责边界

插件只做三件事：在 `life-plugin.json` 里声明能力，在 `index.mjs` 里导出 `create(context)` 注册实现，被调用时执行。装配、注入、执行、持久化都在宿主：

| 归宿主 | 代码位置 |
|---|---|
| 读并校验 manifest，按 surface 决定给不给服务 | `plugins/manifest.mjs`、`plugins/surfaces.mjs` |
| 维护 installed / enabled / granted 三张事实 | `plugins/registry.mjs`、`life_plugins` 表 |
| 导入工厂、构造 context、收集工具 | `plugins/loader.mjs` |
| 把“已启用且已授权”的能力变成工具表 | `plugins/tools.mjs` |
| 拼请求、发请求、解析回复、执行工具、发出站 | 宿主自己；示例见 `examples/minimal-host/host.mjs` |
| 建库、迁移、事务 | `store/db.mjs`；状态机 `state.mjs` |

边界一句话：**插件没有沙箱**。`loader.mjs` 文件头写明加载插件就是执行它的 JavaScript，权限等于宿主进程；安装 = 信任。

## 2. 加载流程

真实入口是 `loadEnabledPlugins(store, options)`：从 `life_plugins` 取 `status='enabled'` 的行，逐行调 `loadPlugin`。单插件顺序如下，任何一步失败都**不半装**（该插件零个工具）：

1. `pluginDir(pluginsRoot, pluginId)`：用 `PLUGIN_ID` 校验 id，非法是 `invalid_plugin_id`；`pluginsRoot` 不合法是 `invalid_plugins_root`。
2. `readPlugin(store, pluginId)`：没有行 → `plugin_not_installed`；`status !== 'enabled'` → `plugin_disabled`。
3. `life-plugin.json` 不存在 → `declaration_missing`；`parseManifest` 抛出的 `LifePluginError` 会带上声明文件路径原样重抛。
4. 声明 id 不等于参数里的 id → `id_mismatch`；`manifest.version` 不等于安装行的 `version` → `version_mismatch`。
5. `unmetRequirements(manifest, store, services)`：`requires.plugins` 必须已装且 `enabled`，`requires.services` 必须由宿主真的交出；缺任一 → `requires_unmet`（`loadEnabledPlugins` 把它记进 `skipped`，不算 `failed`）。
6. `index.mjs` 不存在 → `factory_missing`；`import` 抛错 → `factory_failed`；模块没有 `create` 函数 → `factory_missing_export`。
7. 传了 `dataRoot` 才建插件目录（`<dataRoot>/<pluginId>`，`mkdirSync` 递归）；路径不合法是 `invalid_data_root`。
8. `buildContext(...)` 之后 `await module.create(context)`；它抛 `LifePluginError` 原样上抛，其它异常转成 `factory_failed`。

`loadEnabledPlugins` 返回 `{ implementations, channels, intake, loaded, failed, skipped }`，单插件异常被收集而不是抛给调用方（store 本身不合法仍抛 `missing_store`）。注意：**loader 只检查 `status='enabled'`，不检查 `granted_json`**；授权过滤在 `buildToolTable` 里用 `activeCapabilities` 完成。

## 3. manifest 校验

`parseManifest(text)` 等于 `JSON.parse` 加 `validateManifest`；坏 JSON 也是 `invalid_manifest`。`validateManifest` 实际检查：

| 检查 | 规则 / 码 |
|---|---|
| 顶层 | 必须是普通对象，否则 `invalid_manifest` |
| `id` | 字符串且匹配 `ID_PATTERN`；否则 `invalid_plugin_id` |
| `apiVersion` | 必须是整数且等于 `HOST_API_VERSION`（=1）；否则 `invalid_api_version` / `unsupported_api_version` |
| `version` | 必须是 `x.y.z`；否则 `invalid_version` |
| `kinds` | 可省；给了就必须是字符串数组，否则 `invalid_kinds` |
| `platforms` | 默认 `['any']`，只认 `PLATFORMS`；空或未知是 `invalid_platforms` |
| `capabilities` | 非空数组；每项要有 `name`（匹配 `CAPABILITY_PATTERN`）与 `surface`；重名 `duplicate_capability` |
| `config` / `requires` | `config` 必须是对象（`invalid_config`）；`requires` 只允许 `plugins` / `services` 两个数组键（`invalid_requires`） |

未列出的顶层键**故意忽略**（向后兼容）。capability 的 `limits` / `view` / `slot` 只是原样带过，不在这一步解释。`supportsPlatform(manifest, platform)` 决定装不装；`installPlugin` 还会用 `resolveCapabilities` 拒掉 reserved / unknown surface（`surface_reserved` / `surface_unknown`），装进来一律是 `disabled`。

## 4. surface 与按门注入

surface 是闭集（`surfaces.mjs`）：`IMPLEMENTED_SURFACES` 是 `tool`、`inbound`、`outbound`、`exec`、`fs`、`net`、`secret`、`memory`、`schedule`、`image`、`image-pool`；`RESERVED_SURFACES` 是 `device`、`display`、`vm`，声明了也拿不到服务；`SURFACE_DOORS` 给每个 surface 一句“宿主到底给出去什么”，用于回执与报错文案。

服务门在 `loader.mjs` 的 `SERVICE_DOORS` 里，一个 surface 对应 context 上一个成员：

| 声明 surface | context 成员 | 宿主没交服务时的码 |
|---|---|---|
| `memory` | `memory` | `memory_service_unavailable` |
| `schedule` | `reminders` | `schedule_service_unavailable` |
| `net` | `net` | `net_service_unavailable` |
| `exec` | `hands` | `hands_service_unavailable` |
| `image` | `paint` | `image_service_unavailable` |
| `image-pool` | `imagePool` | `image_pool_service_unavailable` |

规则是“**声明了就必须给**”：插件声明了某 surface，而 `options.services[成员名]` 不是对象 → 直接拒载；没声明 → context 上根本没有这个成员，也不报错。服务必须是**对象**，函数不算。`lifecycle` 槽位未实现：`context.lifecycle` 存在，但一调用就抛 `slot_not_implemented`。

宿主得有东西可交：`createMemoryFacade({ store, embed, encoderName })` 返回带 `note` / `recall` / `unpack` / `revise` / `withdraw` / `prefer` / `preferences` / `describe` 的冻结对象；`createReminderService({ store, now })` 返回 `schedule` / `list` / `cancel` / `snooze` / `describe`。`net` / `paint` / `hands` / `imagePool` 仓库里只有插件侧调用（`net.search`、`net.fetchPage`、`paint.draw`、`hands.run`、`pool.importFile`），**没有宿主侧实现**。

## 5. context 成员与“没声明就报错”

`buildContext(plugin, manifest, deps)` 构造 context，`Object.freeze` 后交给工厂：

| 成员 | 真实内容 |
|---|---|
| `apiVersion` | `CONTEXT_VERSION`（=1） |
| `plugin` | 冻结的 `{ id, version }` |
| `capabilities` | 冻结的能力数组副本 |
| `config` | `{ ...manifest.config, ...configOverlay }` 的冻结合并（`configOverlay` 取自 `options.pluginConfig[pluginId]`）；覆盖只加不减 |
| `env` | `{ ...options.env }` 的冻结副本 |
| `dataDir` | `<dataRoot>/<pluginId>`；没给 `dataRoot` 时是 `null` |
| `log(message)` | 只进加载报告，最多 `LOADER_LIMITS.logEntries`（=200）条 |
| `tool(name, impl)` | 只为 `surface:'tool'` 的能力登记实现 |
| `outbound(name, handler)` | 只为 `surface:'outbound'` 登记发送函数 |
| `inbound(name, subscribe)` | 只为 `surface:'inbound'` 登记订阅函数 |

三个注册函数共用同一个 `used` 集合，按顺序检查：名字空或非字符串 → `invalid_tool_name`；名字不在 manifest 的 capability 里 → `undeclared_capability`；surface 不匹配 → `tool_for_non_tool_surface`；同名重复（跨三个面也算）→ `duplicate_tool`；`outbound` / `inbound` 的 handler 不是函数 → `invalid_outbound_handler` / `invalid_inbound_handler`。注册时 loader 不校验工具形状；形状由 `buildToolTable` 检查（`description`、`parameters`、`execute`，可选 `output.schema` + `output.render`）。

## 6. env 与 config 的边界

宿主决定传什么：`env` 来自 `options.env`，`config` 来自声明默认值加宿主覆盖。插件**不读 `process.env`**（`packages/` 下 `process.env` 出现 0 次），缺键时插件在 `create` 里自己抛：`life-room` 缺 `env.homeRoot` 抛 `life-room needs env.homeRoot from the host`，`life-qq` 缺 `config.endpoint` 抛 `life-qq needs config.endpoint (OneBot HTTP base URL)`。要读的密钥在宿主侧：示例宿主的模型 key 用 `process.env[config.model.apiKeyEnv]` 读，再放进请求头；插件只拿到 `env` 里宿主愿意给的那几个键。

## 7. 模型调用

`model/protocols.mjs` 只有一份 IR 和三种序列化：

| | `chat` | `anthropic` | `responses` |
|---|---|---|---|
| 协议判定（`resolveProtocol`） | 默认 | URL 以 `/messages` 结尾 | 以 `/responses` 结尾 |
| 系统提示 | `messages[0].role='system'` | 顶层 `system` | 顶层 `instructions` |
| 工具声明 | `tools[].function` | `tools[].input_schema` | `tools[].parameters` |
| 流式 | `stream` + `stream_options.include_usage` | `stream` | `stream` |

`toRequest(protocol, options)` 先过 `assertConversation`（否则 `ir_conversation_invalid`），支持 `chat` / `anthropic` / `responses`，其它值抛 `model_protocol_unsupported`。`anthropic` 的 `max_tokens` 缺省 4096；`thinking:'enabled'` 时预算在 1024–8192 之间取 `max_tokens` 的一半。

流式用 `createStreamDecoder(protocol, { modelId, envelope, captureReasoning, onText, ... })`，逐块 `push(bytes)`，最后必须 `finish()`。常见错误：

| 码 | 触发 |
|---|---|
| `model_response_not_json` | SSE 的 `data` 不是 JSON |
| `model_provider_error:<code>` | 上游在流里回 `{ error: { code } }` |
| `model_response_model_missing` / `model_id_mismatch_no_fallback` | 响应没有 `model`，或与请求的模型名不一致（**不自动回退**） |
| `model_response_envelope_invalid` / `model_response_envelope_not_enabled` | `{ success, data }` 信封与实际形状不一致（`unwrapEnvelope`） |
| `model_incomplete_or_unsupported_output` | 流不完整、多个 `choices`、工具参数坏掉 |

`finish()` 返回 `{ content, thinking, toolCalls, finishReason, usage, done }`；`thinking` 默认是 `null`，只有 `captureReasoning: true` 才保留。非流式由宿主自己解析：示例的 `readReply(protocol, body)` 按三种协议分别取 `choices[0].message` / `content[]` / `output[]`，不认识协议抛 `model_protocol_unsupported`。HTTP 非 2xx 由宿主转成 `model_http_<status>`；这一层不重试、不切模型、不算费用。

## 8. 一轮对话

以 `examples/minimal-host/host.mjs` 为例（它绕过了 registry，见第 10 节）：

1. 入站：加载完成后调用 `loaded.inbound[channel]` 拿到的 subscribe，宿主传入**自己的闸门**回调；`life-qq` 会 emit 形如 `{ channel, from, text, messageId, at, voice, group }` 的事件（另可带 `images` / `notice` / `request`）。示例把事件放进 `queue`，由 `waitForMessage(timeoutMs)` 轮询取出。
2. 工具表：示例直接用 `loadPlugins` 收集的 `tools`；正式宿主应走 `buildToolTable(store, { tools: implementations })`，它按 `activeCapabilities`（enabled **且** granted）过滤，并返回同一份数组作为 `allow`。
3. 模型：`toRequest(protocol, {...})` → `fetch` → `readReply`；示例用 `stream:false`。
4. 工具调用：把回复文本和 `toolCallBlock` 组成 `assistantNode` 推回消息；逐个执行 `implementation.execute(JSON.parse(args))`，用 `toolResultNode(callId, output, failed)` 回填；没有实现的工具抛 `unknown_tool`，执行异常转成失败结果而不是中断。
5. 终止：模型不再发起工具调用就返回文本；轮次上限 `config.turn.maxRounds`（缺省 3）用完返回 `（工具调用轮次用尽）`。
6. 出站：`splitParts(text)`（`marks.mjs`）把回复分成 `{ kind: 'public' | 'thought', text }`；示例只把 `public` 交给 `send({ text })`，`thought` 只打日志。

记号判定不在 prompt 里，在 `marks.mjs`：`MESSAGE_MARK='|||'` 分条（空段丢掉）；整条被 `(( ))` 包住是心声（两边数量相同即可，单个括号时要求一边是全角）；`< >`（含全角 `＜＞`）只取半句心声，剩下的拼回同一条；`<div>`、`<file.txt>`、heredoc 这类“像机器语法”的内容不当记号。`splitParts` 只负责分类，**发不发由宿主决定**。

## 9. 持久化、dataDir 与 state.mjs

- `dataDir`：只有传了 `options.dataRoot` 才存在，路径 `<dataRoot>/<pluginId>`，loader 用 `mkdirSync(..., { recursive: true })` 建好再交给插件；没传就是 `null`，插件需要自己拒绝（如 `life-qq needs config.forwardDir or a host dataDir`）。卸载插件不删数据（回执里写 `dataPreserved: true`）。
- 库：`openStore(path, { identityId })`（`store/db.mjs`）用 `node:sqlite`，`SCHEMA_VERSION` 为 17；文件库开 WAL、`synchronous=FULL`、`foreign_keys=ON`、`trusted_schema=OFF`、`busy_timeout=5000`。`migrate` 拒 `identity_mismatch` / `schema_from_future`；升级只建表、加列、整表重建（复制行），不删数据。写事务用 `store.atomic(fn)`：`BEGIN IMMEDIATE`，不允许嵌套（`nested_transaction`），回调返回 thenable 会被拒（`async_transaction_body`）——**不要在事务里 await 模型或网络**。
- 状态：`state.mjs` 是 `life_state` 的唯一写者。五个状态 `free` / `absorbed` / `listening` / `asleep` / `away`，合法迁移在 `TRANSITIONS`，最短停留 `MIN_DWELL_MS`，原因词表 `WHY` 与 `WHY_TARGETS`。`transition` 写 `life_state` 并追加一条 `kind='state'` 的 `life_events`；`ensureState` 首次建行是 `free` 但不写事件。错误码：`invalid_state`、`invalid_transition`、`dwell_not_elapsed`、`invalid_why`、`why_mismatch`、`not_sleepy_enough`、`not_rested_enough`、`focus_required`。`life_events` 有 append-only 触发器，UPDATE / DELETE 会 `RAISE(ABORT, ...)`。

## 10. 最小可用宿主的骨架清单

| 件 | 为什么必须有 |
|---|---|
| Node >= 24.22.1 | `package.json` 的 `engines`（同时要求 `<25`）；用到 `node:sqlite`、`fetch`、`WebSocket` |
| prompt 文件 | `promptPath` 不存在 / 为空分别抛 `prompt_missing` / `prompt_empty`，不给默认人设 |
| 插件目录 | 每个 id 一个目录，含 `life-plugin.json` + `index.mjs`（导出 `create`） |
| 插件行 | `installPlugin` + `enablePlugin` 之后 `life_plugins` 才有 `status='enabled'`；loader 从这里取行 |
| store | 至少给 loader 一个带 `db` 的 store；要记忆 / 状态就 `openStore` |
| 服务对象 | 声明了 `memory` / `schedule` 等 surface 的插件，宿主必须交对象，否则拒载 |
| 模型配置 | `protocol` / `baseUrl` / `modelId` / `maxTokens` / `apiKeyEnv` |
| 工具表与循环 | `buildToolTable`（或示例的等价物）、`toRequest`、`readReply`、执行与回填 |
| 出站通道 | `outbound` 注册的发送函数；示例缺了抛 `outbound_missing` |
| 入站通道 | `inbound` 的 subscribe；没有就只做单轮 |
| 分条 / 心声 | `splitParts`，否则 `|||` 和 `<…>` 会被原样发出去 |

`examples/minimal-host/host.mjs` **不是**这份清单的完整实现：它的 `loadPlugins` 自己拼 context、跳过 registry 与 `buildToolTable`、服务全是空对象 stub、没有 store。它能跑通演示，但只适合当接线样例。

## 11. 常见错误：码 → 现象

| 码 | 什么现象 / 什么时候出现 |
|---|---|
| `invalid_manifest` | 声明不是 JSON，或顶层不是对象、字段类型错 |
| `declaration_missing` | 插件目录里没有 `life-plugin.json` |
| `id_mismatch` / `version_mismatch` | 参数或目录的 id 与声明不一致；磁盘版本与 `life_plugins` 的版本不一致（改版本要重装） |
| `plugin_not_installed` / `plugin_disabled` | `life_plugins` 里没有这一行，或 `status` 不是 `enabled` |
| `factory_missing` / `factory_missing_export` / `factory_failed` | 没有 `index.mjs` / 没导出 `create` / 导入或 `create` 抛错 |
| `requires_unmet` | `requires.plugins` 或 `requires.services` 不满足；会被记进 `skipped` |
| `undeclared_capability` / `tool_for_non_tool_surface` / `duplicate_tool` | 注册了没声明的能力、surface 不对、同名注册两次 |
| `*_service_unavailable` | 声明了 `memory` / `schedule` / `net` / `exec` / `image` / `image-pool`，宿主没交对应对象 |
| `slot_not_implemented` | 调了 `context.lifecycle` |
| `surface_reserved` / `surface_unknown` | 安装或启用时声明了未实现或拼错的 surface |
| `capability_not_granted` / `grant_unknown_capability` | 启用时允许列表与声明不一致（启用是全有或全无） |
| `model_http_<status>` / `model_protocol_unsupported` | 端点非 2xx；协议名不在 `PROTOCOLS` 里 |
| `model_incomplete_or_unsupported_output` | 流不完整、多 choice、工具参数坏掉 |
| `prompt_missing` / `prompt_empty` | 宿主读不到 / 读空 prompt |
| `missing_store` / `invalid_callback` / `nested_transaction` | store 不合法、`atomic` 用法错 |

## 12. 边界 / 没有做的事

- 仓库**不提供生产宿主**：`examples/minimal-host` 文件头写得很直白——没有持久化、没有重试、没有并发、没有权限层。核心层只提供零件（store、loader、registry、surface、memory facade、reminders、state），没有把它们长期跑起来的循环。
- 没有插件沙箱：`loader.mjs` 明确说加载就是执行插件的 JS，权限等于宿主；`capabilities` 是功能白名单，不是安全边界。
- 模型层不重试、不自动换模型、不统计费用；`model_id_mismatch_no_fallback` 是有意拒绝回退。
- `net` / `paint` / `hands` / `imagePool` 的宿主实现不在仓库里；示例宿主根本不走 loader，它自己拼 context 并塞空对象 stub，因此 loader 的“声明了就必须给对象”检查没有被执行，真正调用服务时会失败。
- `fs` / `secret` surface 没有对应的 `SERVICE_DOORS`；`device` / `display` / `vm` 是 reserved；`lifecycle` 槽位未实现。
- 工具输出的 `output.render` 在仓库里没有调用点；`buildToolTable` 只校验并携带它。
- 示例宿主不校验工具表、不查 granted、不落库，也没有接 `createStreamDecoder`（走非流式 `readReply`）。

相关文档：[插件接口](plugin-api.md) · [模型协议](model-protocols.md) · [配置](config.md) · [报错对照](faq.md) · [安全边界](security.md) · [开始](getting-started.md)
