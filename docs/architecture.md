# 整体结构（模板文档）

> 本文档对应仓库 0.1.0。它讲这套代码**怎么分层、一轮对话怎么走、想加东西该动哪里**。
> 它不讲怎么部署，也不含任何个人设定：仓库里没有 prompt 原文、没有人设、没有生产配置。

## 1. 一句话概括

这套代码是**一块契约 + 一组能力门 + 一层生命机制 + 一个存储**，跑起来需要你写（或挑一个）宿主。
仓库提供零件，不提供成品；示例宿主只够跑通闭环，不够上线。

## 2. 目录

| 路径 | 是什么 | 体量 |
|---|---|---|
| `packages/dsh-life-core` | 契约（manifest / loader / registry / surfaces / tools）、模型协议、记忆与向量、生命机制、`node:sqlite` 存储 | 45 个 `.mjs` |
| `packages/dsh-life-*` | 8 个插件（每个一个 `index.mjs`），共 73 个工具 | 8 个 `.mjs` |
| `examples/minimal-host` | 最小宿主 + 假 OneBot + 假模型，零 key 跑通一轮 | 4 个 `.mjs` |
| `docs/` | 模板文档（本文件所在） | 8 篇 markdown |
| `.githooks` + `.github/workflows` | 本地钩子与最小 CI：语法检查 + 示例冒烟 | 3 个文件 |
| `LICENSE` / `THIRD-PARTY-NOTICES.md` | PolyForm Noncommercial 1.0.0；第三方 MIT 声明 | — |

## 3. 三层职责

| 层 | 负责 | 不负责 |
|---|---|---|
| **插件** | 声明（`life-plugin.json`）+ 工厂（`index.mjs` 的 `create`）；把宿主给的服务翻成助手能读的一句话 | 不做判断、不碰密钥、不自己开进程/定时器 |
| **core** | 契约校验、surface 注册表、工具缝、三种模型协议、记忆与向量、状态机与节奏、SQLite 存储 | 不决定「现在该说什么」 |
| **宿主** | 装配：读声明、校验、注入服务、收集工具表、跑循环、调模型、落库、出口 | 不定义插件能力（那是声明的事） |

这里有个容易搞混的点：**几个第一方插件是「住在插件目录里的宿主代码」**（`life-room`、`life-memory`、`life-time`、`life-qq`、`life-hand`、`life-draw`、`life-web`、`life-image-pool` 都属此类）。
它们照样要走装、授权、启用那套表，能力照样只走同一条缝；区别只是它们 `import` 了 core 的模块。第三方插件不能这么干，它自带代码，只能靠声明拿到的 surface 干活。

## 4. 一轮对话怎么走

| 步 | 发生什么 | 代码 |
|---|---|---|
| 1 | 入站插件 `emit` 一条消息 | 插件的 `inbound(...)` 订阅 |
| 2 | 宿主闸门判定「这条听不听」：名单、上限、静音、去重 | 宿主侧；名单口径见 `policy-file.mjs` |
| 3 | 记成一条**到达**：按当时状态标 `immediate` / `notify` / `defer`，标记跟着行走，醒来后仍然有效 | `attention.mjs` |
| 4 | 装配上下文：帧尾三段（`scene` / `plan` / `pending`）+ 常驻偏好 + 按需召回的记忆 | `tail.mjs`、`preferences.mjs`、`memory/recall.mjs` |
| 5 | 算预算（按码点估 token；这是**估算不是账单**） | `tokens.mjs` |
| 6 | 组装请求并调用模型：先拼一份 IR，再按协议序列化 | `model/protocols.mjs` 的 `toRequest` |
| 7 | 模型要调工具：工具表来自插件，只收 `surface: tool` 的那批 | `plugins/tools.mjs` |
| 8 | 落库：事件日志只有追加，原话只存在这里 | `store/events.mjs` |
| 9 | 出口：插件的 `outbound(...)` 把话发出去；分条与「心声不发送」按记号切 | `marks.mjs` |
| 10 | 状态与节奏推进：谁在什么状态、多久能再被打断 | `state.mjs`、`rhythm.mjs`、`scheduler.mjs` |

## 5. 生命机制（core 顶层模块）

| 模块 | 管什么 | 值得知道的一点 |
|---|---|---|
| `state.mjs` | 五态：自在 / 沉浸 / 倾听 / 睡着 / 暂离 | 只有 `TRANSITIONS` 里列的迁移合法，其余拒绝；每态有最小停留时间，是**防抖**不是限流 |
| `rhythm.mjs` | 睡意与昼夜相位（双过程模型） | 睡意 = 睡眠压力 +（0.8 − 警觉度）：把警觉度**减**掉才对，加反了会得到「下午最困、凌晨最清醒」 |
| `scheduler.mjs` | 下次什么时候露面 | 计时器间隔是「基础抽样 + 重尾」，因为均匀抽样把一天切得太平均；事件触发的调度立刻排，不跟计时器抢 |
| `wake.mjs` | 醒来怎么算 | 一次醒来 ≠ 一次模型调用；间隔小于合并窗的多次醒来算同一次，取最深的那次 |
| `attention.mjs` | 什么能到达助手 | 三种处理（`immediate` / `notify` / `defer`）由到达时的状态决定并写进行里，醒来后仍带着；**不合并、不限条数**（三条消息三行），也不写追加日志（消息本身已经是事件） |
| `continuation.mjs` | 手上没做完的事 | 一件事一行，不是「我现在在干嘛」一个格子；续做材料存**指针**不存副本，夹带正文会被 `material_has_extra_fields` 拒掉 |
| `tail.mjs` | 帧尾三段 | `scene`（现在几点/什么状态/手上有什么）、`plan`（搁着没做完的标题，只有标题）、`pending`（等着的到达，**一条一段，不合并**） |
| `preferences.mjs` | 助手自己的立场 | 和记忆不同：偏好**一直在场**，不靠召回；只增不删，改 = 同 id 多一个版本 |
| `reminders.mjs` | 助手自己定的时刻 | 只有行，没有 prompt 文本；不删除，`pending → fired/cancelled` 原地改 |
| `marks.mjs` | 三个记号 | `|||` 分条、`(( ))` 整条只说给自己、`< >` 半句只说给自己；判定在代码里，**不写进 prompt** |
| `room.mjs` | 助手的屋 | `home/` 可读写、`library/` 只读、`system` 只读（时间/内存/磁盘/CPU）；四条边界在模块里强制 |
| `policy-file.mjs` | 听谁/发给谁 的热改名单 | JSON > YAML > 默认值；逐键容错，写坏保持上一次生效值，整份坏则保留 last good |

## 6. 插件清单

| 插件 | surface | 工具数 | 干什么 |
|---|---|---|---|
| `life-qq` | `inbound` / `outbound` / `tool` | 45 | 连 OneBot：发消息、发图/语音/文件、撤回、读历史、群管理、空间、改资料 |
| `life-room` | `tool` + 屋 | 6 | 看/读/写/删自己的屋，从收件箱导入 |
| `life-memory` | `memory` | 6 | 记、想、展开、修订、撤回、偏好 |
| `life-time` | `schedule` | 4 | 定时刻、列出、取消、顺延 |
| `life-hand` | `exec` / `fs` | 5 | 跑命令、读写文件、列目录、看图（全部经宿主沙箱） |
| `life-web` | `net` | 3 | 查、打开、取图（走宿主的 search/fetch，不是通用 fetch） |
| `life-draw` | `image` | 2 | 画一张、改一张（key 在宿主侧） |
| `life-image-pool` | `image-pool` | 2 | 把账号文件交给生图号池、查池状态（`requires` 两个前置，缺一不加载） |

## 7. 存储

- 用运行时自带的 `node:sqlite`（`DatabaseSync`），没有新增依赖。
- 库开 `journal_mode=WAL`、`synchronous=FULL`、`foreign_keys=ON`、`trusted_schema=OFF`：提交后能扛崩溃、孤儿向量被拒、被改过的 schema 跑不了函数。
- 事件日志**只有追加**：数据库触发器禁掉 `UPDATE` / `DELETE`，因为原话只存在这里。压缩、展开、滚动都从这张表读；滚出去的一段是归档，不是删除。
- `atomic` 里跑的是**同步**回调（`BEGIN IMMEDIATE … COMMIT`），不能在里头 `await`：要调模型就先调完，再把准备好的那批一次提交。
- 每个插件只拿到自己的 `dataDir`；跨插件的共享状态由宿主持有。

## 8. 模型层

- 一次对话只装配一次 IR，三个协议只负责序列化；不把历史改写成各家方言。
- `resolveProtocol(endpoint)` 按端点路径推断协议（`/chat/completions`、`/messages`、`/responses`），配置里不用写；要强制时再写。
- 有些网关把整个 body 包成 `{ success, data }`。这是某个部署的形状，不是协议，所以**不自动猜**：`createStreamDecoder(protocol, { …, envelope: 'data' })` 显式打开。开关和线上形状不一致会立刻报错（`model_response_envelope_invalid` / `model_response_envelope_not_enabled`），不会晚一点变成「模型缺失」。
- 用量只投影白名单里的计数（`projectProviderUsage`），不把厂商的任意扩展字段或内容带进来。
- `model/step-timing.mjs` 改编自 DeepSeek Harness（MIT），来源与全文见 `THIRD-PARTY-NOTICES.md`。

## 9. 想加东西该动哪

| 想做的事 | 改哪里 |
|---|---|
| 加一个工具 | 在插件的 `index.mjs` 里 `context.tool(...)`，并在 `life-plugin.json` 的 `capabilities` 里声明 `surface: tool` |
| 加一道新门 | `plugins/surfaces.mjs` 的 `IMPLEMENTED_SURFACES` 与 `SURFACE_DOORS`，再在 `loader.mjs` 装配 `context` 时注入对应服务 |
| 接一种新协议 | `model/protocols.mjs`：加进 `PROTOCOLS`、写 `toRequest` 分支与解码器；示例宿主的 `readReply` 同样加一段 |
| 加一种生命机制 | 在 core 顶层加模块，再接到 `state.mjs` / `scheduler.mjs` 的推进点上；别写进 prompt 文本 |
| 换向量服务 | 只换宿主侧端点与模型名；**表名跟着模型名变**（见 [记忆与向量](memory-embedding.md)） |

## 10. 边界 / 没有做的事

| 没有 | 说明 |
|---|---|
| 生产宿主 | `examples/minimal-host` 是闭环演示：没有重试、没有权限层、没有生产级持久化。仓库不提供生产宿主 |
| 人设与 prompt | 仓库里没有助手该说什么；示例 prompt 是玩具模板 |
| 插件沙箱 | 插件以宿主权限运行，`capabilities` 是**功能性**白名单，不是安全边界（见 [安全边界](security.md)） |
| 多实例协调 | 没有分布式锁、没有多进程共享状态；一个库就是一个实例 |
| 迁移工具 | 换模型、换维度、改表结构都没有自动迁移，只有约定和报错 |
| 加密 | SQLite 是明文，key 在进程内存里，没有 KMS / 内存清零 |
| 内建限流 | 有上限参数，默认偏宽，要自己收紧 |

---

相关文档：[配置](config.md) · [插件接口](plugin-api.md) · [宿主实现指南](host.md) · [模型协议](model-protocols.md) · [记忆与向量](memory-embedding.md) · [协议端接入](onebot.md) · [安全边界](security.md) · [常见问题](faq.md)
