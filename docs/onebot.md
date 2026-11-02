# 协议端（OneBot v11）接入

> 本文档对应仓库 0.1.0。**本仓库不含协议端实现**：它只提供 OneBot v11 的**客户端**（`packages/dsh-life-qq`），
> 负责登录 QQ、连协议、真正收发消息的那一层要你自己装。

## 1. 这一层是谁

```
QQ 服务器 ⇄ 协议端（你自己装）⇄ HTTP / WebSocket ⇄ life-qq 插件 ⇄ 宿主 ⇄ 模型
```

- 协议端：第三方 OneBot v11 实现。登录的是**真实 QQ 账号**，扫码/密码都在协议端那边；本仓库不保存账号密码。
- 插件：只做两件事——用 HTTP 调动作、从 WebSocket 收事件；媒体一律用 `base64://` 递字节。
- 示例里的 `examples/minimal-host/fake/onebot.mjs` 是 45 行的**测试替身**（任何动作都回 `retcode 0`），
  只用于跑通示例和 CI，不能登录、不能发真消息。

## 2. 我们验证过的版本

| 项 | 值 |
|---|---|
| 协议端 | **SnowLuma 2.2.1**（构建标识 `SnowLuma 2.2.1-node`，OneBot v11） |
| 部署形态 | 容器，一次部署时镜像 tag 为 `latest` |
| 我们做的验证 | 50 个动作名全部对得上（**没有一个返回 `1404`**）；其中 27 个本轮实测成功、11 个由主账号日常实操确认成功（共 38 个已验证），10 个只做了存在性探测，2 个未单独验证（见第 6 节） |
| 验证环境 | 27 个实测在隔离的测试账号和三人测试群上完成；执行期间两个助手的入站都处于静音，测试消息已撤回、测试文件已删除 |

**说清楚边界**，免得别人以为我们承诺过更多：

- `latest` 这类 tag 会漂移。你拿到的镜像可能已经不是 2.2.1；**建议按 digest 固定**，并记下自己用的版本。
- 第 6.3 节那 10 个是"只做存在性探测"：动作确实在，但我们**没有执行**，所以不写成已验证；第 6.4 节那 2 个连探测都没单独做。
- 换协议端（别的 OneBot v11 实现）：标准动作照 OneBot v11 规范调用；扩展动作（空间、收藏表情、改资料）各实现差异很大。

## 3. 最小接入：四个值

| 配置 | 例子 | 说明 |
|---|---|---|
| `endpoint` | `http://127.0.0.1:3000` | OneBot HTTP 基址；插件往 `{endpoint}/{action}` POST |
| `wsEndpoint` | `ws://127.0.0.1:3001` | OneBot WebSocket（正向）；入站事件从这里来 |
| token | `env.onebotToken` 或 `config.tokenPath`（文件） | HTTP 鉴权；SnowLuma 只认 `Authorization: Bearer <token>` |
| token（WS） | `env.onebotWsToken` 或 `config.wsTokenPath` | **WS 是另一份 token**；不填会回落到 HTTP 那份（通常 401） |

再加三项"发给谁 / 听谁"：

| 配置 | 作用 | 默认 |
|---|---|---|
| `env.qqUserId` | 助手自己的 QQ 号 | — |
| `recipients` | 私聊能发给谁（`mode: list/all/none` + `ids`） | `list` + 空名单（谁都发不出去） |
| `groups` | 在哪些群说话 | `list` + 空名单（不进任何群） |
| `inboundAllow` | 听谁的私聊 | 空 = 只按 `recipients` 规则 |

**默认值是收紧的**：不填名单，助手既发不出去也听不到。这是有意的。

## 4. 鉴权：两份 token，别混

- HTTP：`Authorization: Bearer <token>`。发 `Token` 前缀或裸 token 都会 401。
- WS：协议端的 WS 服务器有自己的 token，**用 HTTP 那份去打 WS 会 401**。
- 存放：优先宿主 env；否则用 `tokenPath` / `wsTokenPath` 指向**宿主上**的文件（权限自己管）。
  两条路都没有时插件直接报错，不会带着空 token 跑。
- 不要把 OneBot 的端口暴露到公网。本仓库的示例和文档都假设它只监听 `127.0.0.1`。

## 5. 媒体、语音、文件：没有共享目录

插件与协议端通常是两个容器，路径互相看不见。所以：

| 方向 | 做法 |
|---|---|
| 发图 / 发表情 / 发文件 | 插件把本地文件读成字节，用 OneBot 的 `base64://` 递过去 |
| 收图 / 收文件 | 协议端把 base64 或 URL 给你；插件落进助手屋里（`homeRoot/inbox`） |
| 发语音 | 本地 TTS 出**整包 WAV** → `record` 段 `base64://`；不支持流式 |
| 收语音 | `get_record {out_format:'wav'}` 让协议端转 WAV，再交给你的 ASR 端点 |

SnowLuma 2.2.1 自带转码（`get_record` 出 24 kHz 单声道 16-bit WAV），所以插件侧不需要装 ffmpeg。

## 6. 动作清单与验证状态

插件一共调用 **50 个 OneBot 动作名**（私聊、群、群管理、媒体、资料、空间）。
**缺其中一个只会让对应工具报错，不会拖垮其它功能。**

验证分四档：本轮实测、主账号日常实操确认、只做存在性探测、未单独验证。

### 6.1 本轮实测成功（27 个）

| 动作 | 验证到什么程度 |
|---|---|
| `send_private_msg` | 真发成功；也能发给自己（用来做无副作用自检） |
| `send_group_msg` | 在测试群真发成功，随后撤回 |
| `get_msg` | 按 message_id 读回完整消息段 |
| `delete_msg` | 撤回自己刚发的消息 |
| `get_group_list` / `get_group_info` | 读取群列表与单个群资料 |
| `get_group_member_list` / `get_group_member_info` | 读取成员列表与单个成员资料 |
| `get_group_msg_history` | 读取群历史消息段 |
| `get_group_root_files` | 读取群文件根目录 |
| `get_group_at_all_remain` | 读取 @全体 剩余次数 |
| `get_friend_list` | 读取好友列表 |
| `get_friend_msg_history` | 读取与某个好友的私聊历史 |
| `upload_group_file` / `delete_group_file` | 真上传一个小文件，再删掉 |
| `_get_group_notice` | 读取群公告（带前导下划线） |
| `set_online_status` | 状态码：10 在线 / 20 离开 / 30 忙碌 / 40 隐身 / 50 请勿打扰 / 60 听歌中 |
| `fetch_custom_face_detail` / `add_custom_face` / `modify_custom_face` / `delete_custom_face` / `send_custom_face` | 收藏表情即图库；`add_custom_face` 收 `base64://` |
| `get_record` | `out_format:'wav'`，协议端自己转码 |
| `get_qzone_feeds` / `get_qzone_msg_list` / `get_qzone_msg_detail` | 读说说/动态 |
| `set_msg_emoji_like` | 动作存在；**私聊里贴表情被协议端拒（retcode 100）**，群聊才行 |

`get_login_info` 不在插件的 50 个里，但它是确认"连到的是哪个号"最省事的一次调用。

### 6.2 主账号日常实操确认（11 个）

这些不是测试调用，是主账号在日常使用中真的做过、并且成功的。

| 动作 | 实操 |
|---|---|
| `set_qq_avatar` / `set_qq_profile` / `set_self_longnick` | 换过头像、改过资料与签名，客户端可见 |
| `send_qzone_msg` / `delete_qzone_msg` | 发过说说，也删过说说 |
| `send_like` | 给好友点过赞 |
| `set_group_ban` | 群禁言 |
| `set_group_kick` | 群踢人 |
| `set_essence_msg` / `delete_essence_msg` | 设过群精华，也取消过 |
| `upload_private_file` | 给好友发过文件 |

### 6.3 只做了存在性探测（10 个）

这些动作**存在、参数形状对得上**，但没有执行：它们会打扰真人（戳一戳、改群名片），或者会动群设置（全员禁言、管理员、群名、头衔、退群、审批、发公告）。

探测方法：拿一个**不存在的目标 ID** 调用。返回值 `100` = 动作在、参数不对；`1404` = 没有这个动作。我们只看到 `100` / `1400`，**没有 1404**。

| 分组 | 动作 |
|---|---|
| 群管理 | `set_group_whole_ban`、`set_group_admin`、`set_group_card`、`set_group_name`、`set_group_special_title`、`set_group_leave`、`set_group_add_request` |
| 群公告 | `_send_group_notice` |
| 好友互动 | `send_poke` |
| 其他 | `get_forward_msg` |

### 6.4 未单独验证（2 个）

`get_group_file_url` / `get_private_file_url`：插件有调用，但我们没在 2.2.1 上单独验证过。

### 6.5 协议端缺口（不是本仓库的待办）

| 能力 | 状态 |
|---|---|
| 语音通话 / 视频通话（`voice_call` / `av_call`） | SnowLuma 2.2.1 没有这些动作 |
| 礼物相关 | 没有可用动作 |
| 转发好友说说 | 只有"把广场动态转进自己空间"，没有普通转发；仓库没接 |

### 6.6 验证方法（可复现）

不是"读代码猜的"，做法如下：

1. **存在性**：对一个不存在的目标 ID 调用动作。`1404` = 没这个动作；`100` / `1400` = 有这个动作、只是参数不对。这一步不产生任何投递。
2. **只读**：对测试群与测试好友调用 `get_*`，只读不写。
3. **会打扰真人的**：不执行，只做第 1 步（第 6.3 节）。
4. **真发的那三条**（私聊自检、群消息、群文件）：发完立刻撤回/删除；执行期间该账号上所有助手的入站都处于静音（`inboundMutePath` 指向的标记文件），执行后删除标记。
5. **事后核对**：两个助手的 `life.sqlite` 与 `-wal` 里都搜不到测试文本和消息 ID，静音文件也已删除。
6. **身份、空间与群管理那 11 个**：不在测试里做，由主账号日常操作确认（第 6.2 节）。

所以"验证过"= 真的产生过成功响应，或有主账号的实操记录；**不是**"应该能用"。

## 7. SnowLuma 2.2.1 的已知怪癖

| 现象 | 处理 |
|---|---|
| 空间列表不传 `target_uin` 一律 `retcode 100`（文档写着默认当前账号） | 插件默认显式传助手自己的号 |
| 私聊贴表情 `retcode 100` | 插件翻成明确错误，不冒充成功 |
| `message_id` 是**有符号** 32 位整数（会出现负数） | 插件按字符串收，不带符号校验 |
| 引用目标查不到时，协议端**静默丢掉引用段**（整体仍 `retcode 0`） | 插件发引用前先 `get_msg`，引不上就明说 |
| 文本以 `#` / `!` / `.` 开头会被协议端当管理命令执行 | 插件发消息前对这类开头做处理 |
| 公告类动作带前导下划线（和其它 OneBot 动作命名不同） | 插件按实际名字调用 |
| WS 与 HTTP 是两份 token | 见第 4 节 |
| `upload_group_file` 只回 `file_id`，没有 `busid` | 删群文件时只传 `file_id` 就行 |
| 未知参数/缺参数统一回 `retcode 100`，不存在的动作回 `1404` | 可以拿它做"能力探测"，不必真执行 |

## 8. 收到 401 / 收不到消息时按顺序查

1. 协议端是否在跑、端口是否通（`curl {endpoint}` 或看它的控制台）。
2. HTTP token 是否对：必须是 `Bearer`。
3. WS 是否用了**另一份** token。
4. `wsEndpoint` 是否是正向 WS 地址（不是反向 WS）。
5. 名单是否把对方挡住了（`inboundAllow` / `groups`）——默认空名单是"都不听"。
6. 账号是否还在线（协议端掉线时插件只会看到 HTTP 失败）。

## 9. 版本声明

本文档只对 **SnowLuma 2.2.1** 做过上面的验证；其它版本、其它 OneBot v11 实现，我们**不保证**扩展动作可用。
如果你用别的版本跑通了/跑不通，那就是那份实现的差异，不是本仓库的承诺范围。
