# 插件接口（模板文档）

本文件说明「一个插件长什么样、宿主怎么装它」。示例代码在 `packages/dsh-life-*`，可以直接抄一份改名。

## 1. 一个插件是一个目录，两个文件

```
packages/dsh-<名字>/
├─ life-plugin.json    声明（数据，不含代码）
└─ index.mjs           工厂（唯一入口，必须导出 create）
```

插件 id 用小写加连字符（如 `life-time`），目录名可以与 id 不同（本仓用 `dsh-` 前缀）。

## 2. 声明文件 life-plugin.json

```json
{
  "id": "life-time",
  "apiVersion": 1,
  "version": "1.2.0",
  "kinds": ["time"],
  "platforms": ["any"],
  "capabilities": [
    { "name": "schedule",  "surface": "schedule" },
    { "name": "hello_world", "surface": "tool" }
  ],
  "config": { "timeZone": "UTC" }
}
```

| 字段 | 含义 |
|---|---|
| `id` | 插件标识，唯一 |
| `apiVersion` | 宿主接口版本，目前只有 1 |
| `version` | 语义化版本；**改它必须重装插件**，否则宿主按设计拒载 |
| `kinds` | 分类标签，宿主不解释 |
| `platforms` | `any` / `linux` / `win32` / `darwin` |
| `capabilities` | 这个插件会交付的东西，每项都要写 `surface` |
| `config` | 默认配置；宿主可以按插件覆盖（只加不减） |

### surface 是什么

surface 决定「这件事能做什么」，宿主只会把声明过的能力交给插件：

| surface | 用途 |
|---|---|
| `tool` | 变成一个模型可调用的工具 |
| `inbound` | 一个入站订阅（收到消息时回调） |
| `outbound` | 一个出站通道（把消息发出去） |
| `exec` | 在沙箱里起一个一次性进程 |
| `fs` | 读写宿主授予的目录 |
| `net` | 联网：宿主的 search / fetch 两个动作 |
| `secret` | 用宿主托管的凭据，只在插件内部用 |
| `memory` | 记忆服务（`context.memory`） |
| `schedule` | 定时/提醒服务（`context.reminders`） |
| `image` | 生图服务（`context.paint`） |
| `image-pool` | 把账号文件交给生图号池（`context.imagePool`） |

`device` / `display` / `vm` 是预留、尚未实现的三项，声明了也拿不到服务。

## 3. 工厂文件 index.mjs

```js
export function create(context) {
  context.tool('hello_world', {
    description: '说一句你好。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() { return '你好。'; },
  });
}
```

`context` 提供：

| 成员 | 说明 |
|---|---|
| `apiVersion` / `plugin` / `capabilities` | 只读元信息 |
| `config` | 声明里的 `config` 与宿主覆盖合并后的只读对象 |
| `env` | 宿主给的环境变量（只读） |
| `dataDir` | 这个插件的可写目录 |
| `log(line)` | 写一行加载日志（有上限） |
| `tool(name, impl)` | 注册 `surface: tool` 的能力 |
| `outbound(name, handler)` | 注册出站：宿主把要发的消息交给它 |
| `inbound(name, subscribe)` | 注册入站：插件把「怎么收」交给宿主 |
| 各服务对象 | `memory` / `reminders` / `net` / `paint` / `imagePool`，没声明就报错 |

### 宿主环境变量（`env`）

`env` 是宿主在加载插件时传进来的只读对象；**插件自己不去读 `process.env`**。
本仓两个插件用到它，键不全时插件在 `create` 里直接报错，不会带着空值跑起来：

| 插件 | 键 | 必需 | 用途 / 缺了会怎样 |
|---|---|---|---|
| `life-room` | `homeRoot` | 是 | 助手的屋（读 + 写 `mine/`）。缺了直接抛 `life-room needs env.homeRoot from the host` |
| `life-room` | `libraryRoot` | 否 | 只读资料区；缺了就只有 home |
| `life-room` | `system` | 否 | `false` 关掉"机器现状"那一层（时间/磁盘/CPU） |
| `life-qq` | `homeRoot` | 否 | 收到的文件默认落 `<homeRoot>/inbox`；缺了退回插件数据目录（助手读不到） |
| `life-qq` | `workspaceRoot` | 否 | 允许往外发的第二条根（助手干活的地方）；缺了只认 home |
| `life-qq` | `qqUserId` | 否 | 助手自己的 QQ 号；`recipients.mode=list` 且 ids 为空时必需 |
| `life-qq` | `onebotToken` | 否 | OneBot HTTP 的 `Authorization: Bearer`；也可用 `config.tokenPath` 指文件 |
| `life-qq` | `onebotWsToken` | 否 | OneBot WebSocket 的鉴权；用 WS 入站时才需要 |

其余插件（memory / time / web / hand / draw / image-pool）不读 `env`，只靠 `config` 和服务对象。

入站的样子（插件侧）：

```js
context.inbound('qq_recv', (emit) => {
  // 自己连协议端；收到消息就 emit
  emit({ channel: 'qq', from: '10001', text: '你好', at: new Date().toISOString() });
});
```

出站的样子（插件侧）：

```js
context.outbound('qq_send', async ({ text }) => { /* 发出去 */ });
```

## 4. 加载顺序与失败

宿主按这个顺序检查，任何一步失败都不半装：

1. 已安装且已启用（插件在市场里的状态）
2. 声明存在、能通过校验，且 id 与目录一致
3. 版本与已安装记录一致
4. 声明里 `requires` 的插件与服务都在（缺一项就整份不加载，不静默降级）
5. 工厂导出了 `create`
6. 注册的能力都在声明里，且 surface 对得上

## 5. 错误码

| 码 | 含义 |
|---|---|
| `invalid_manifest` | 声明不合法 |
| `declaration_missing` | 找不到 life-plugin.json |
| `id_mismatch` | 目录与声明 id 不一致 |
| `version_mismatch` | 版本与安装记录不一致（要重装） |
| `factory_missing` / `factory_missing_export` | 没有 index.mjs 或没有 create |
| `factory_failed` | create 抛错 |
| `undeclared_capability` | 注册了没声明的能力 |
| `tool_for_non_tool_surface` | surface 不对 |
| `duplicate_tool` | 同一个名字注册两次 |
| `slot_not_implemented` | 宿主没有这个服务 |
| `plugin_not_installed` / `plugin_disabled` | 宿主里没有这个插件，或它没启用 |
| `requires_unmet` | `requires` 里的插件/服务不存在；整份不加载 |
| `*_service_unavailable` | 声明了某道门，但宿主没交出那个服务 |
| `invalid_outbound_handler` / `invalid_inbound_handler` | 出站/入站注册的不是函数 |
| `load_failed` | 其它加载期异常（原样带出） |

## 6. 边界

插件的代码以宿主的身份运行，**没有沙箱**。安装 = 信任，宿主只负责记录谁装了什么。
