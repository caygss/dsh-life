# 记忆与向量（模板文档）
> 本文档对应仓库 0.1.0。它讲一条输入怎么变成记忆、怎么被召回和装配，以及向量层怎么接自己的服务。
> 许可：PolyForm Noncommercial 1.0.0，**禁止商用**。本文档是模板，不是产品；仓库里也没有生产向量服务。

## 1. 这层解决什么
原话只进追加日志；压缩把一段经历写成一条 `package`；同步编码时 `indexPackage` 把包、向量、词表放在同一个事务里，远程编码分两步写（见 §3）；召回按语义/词面/时间取候选，打分后抽样，最后变成上下文里的 `parts`。纠正和撤回都只改状态、追加日志，不删行。

## 2. 分层与文件职责

全部在 `packages/dsh-life-core/memory/` 下；下表按文件说它管什么、不管什么。

| 文件 | 主要导出 | 负责 | 备注 |
|---|---|---|---|
| `facade.mjs` | `createMemoryFacade` | 助手手上的记忆动作：`note` / `recall` / `unpack` / `revise` / `withdraw`，另带 `prefer` / `preferences` / `describe` | 动作方法把失败转成 `{ok:false, code}`；`prefer` 也兜住异常 |
| `pipeline.mjs` | `compressAndStore` | 压缩 + 尝试记录 + 写包 + 索引的唯一入口 | 拿锁；失败也写 `recordAttempt` |
| `segments.mjs` | `splitSegments`、`DEFAULT_SEGMENT_RULES` | 按空闲/日界/状态/时长把事件切成 stretch | 只做时间规则；话题一致性需要向量，明确不在这一层 |
| `segment.mjs` | `buildMemoryParts` | 召回 → 打分 → 变成 `{id, text}` 的 `parts` | 不决定 token 预算 |
| `packages.mjs` | `insertPackage`、`writePackage`、`getPackage` | `life_packages` 的读写与字段校验 | 区间重叠检查在这里 |
| `index.mjs` | `indexPackage`、`indexTerms`、`writeVector` | 写 `life_package_vectors` 与 `life_package_terms` | 同步 encoder 走 `indexPackage`，异步走 `writeVector` |
| `encoder.mjs` | `createHashEncoder`、`extractTerms`、`cosine` | 本地确定性编码：中文 bi-gram + ASCII 词哈希到定长桶 | `HASH_ENCODER_NAME` 是 `hash-bigram-v1`，`HASH_ENCODER_DIM` 是 64 |
| `encoder-remote.mjs` | `createRemoteEncoder`、`DEFAULT_EMBEDDING_ENDPOINT` | OpenAI 兼容 `/v1/embeddings` 客户端 | 默认端点是环回地址 |
| `recall.mjs` | `recallPackages`、`ROUTE_WEIGHTS`、`DEFAULT_RECALL` | 语义 / 关键词 / 时间三路取候选并融合 | 只返回候选，不决定谁进上下文 |
| `score.mjs` | `fiveFactorScore`、`selectMemories`、`sampleCandidates` | 五因子打分 + softmax 抽样 | 默认权重与温度是常量 |
| `time-cue.mjs` / `address.mjs` | `resolveCueTime` / `addressFactors` | 解析“三天前”这类显式说法；按 `occurredAt`、`subjects`、`ordinal` 匹配 | `resolveCueTime` 与 `addressFactors` 在仓库里都没有调用点（见 §11） |
| `compress.mjs` | `compressSegment`、`compressSegmentAddressed`、`parseAddressOutput` | 组提示词、调注入的 `summarise`、校验草稿 | 从不写库 |
| `consolidate.mjs` | `pendingSegments`、`consolidateRange` | 睡时把没有包覆盖的段补压 | 不做日记，也不更新权重 |
| `attempts.mjs` | `recordAttempt`、`listPendingStretches`、`acquireCompressionLock` | 每次尝试一行；压缩锁按 TTL 接管 | 失败段因此可重试 |
| `corrected.mjs` | `correctPackage`、`latestCorrection` | 旧包撤回 + 同区间新包 + 指针 + 日志，一个事务 | 复制旧向量，不重新编码 |
| `withdraw.mjs` | `withdrawPackage`、`listWithdrawals` | 标 `withdrawn` 并追加理由 | 不删任何行 |
| `activation.mjs` | `recordActivation`、`activationValue` | 记录“真正被想起”的时刻，算 ACT-R 激活 | `ACTIVATION_FLOOR` 是 -4 |
| `tool-calls.mjs` | `recordToolCall`、`describeToolCall` | 一次工具调用写成 `role='tool'`、`kind='action'` 的事件 | 结果超长留头 800 + 尾 200 |
| `unpack.mjs` | `unpackPackage`、`renderEvent` | 按 `package` 的 seq 区间回读原话 | 默认 `maxTokens` 20000，不重写不排序 |
| `roll.mjs` | `planRoll`、`rollToFit`、`commitRoll` | 把最老的一段滚出实时窗口 | 只滚有活动包覆盖的内容；`DEFAULT_ROLL_KEEP_TOKENS` 是 120000 |

## 3. 写入路径：一条输入怎么变成可装配的记忆
1. 事件先落 `life_events`：`store/events.mjs` 的 `appendEvent` 校验 `EVENT_ROLES` 与 `EVENT_KINDS` 后追加一行。
2. `segments.mjs` 的 `splitSegments` 把事件切成 `segment`；切分原因记在 `stats.reasons` 的 `idle` / `day` / `state` / `duration` 里。
3. `pipeline.mjs` 的 `compressAndStore` 是唯一入口：`acquireCompressionLock` → `summarise` → `recordAttempt` → `writePackage` → 索引。
4. `compress.mjs` 只把草稿返给管线，自己不碰事务；`pipeline` 在锁释放后才写包。
5. `index.mjs` 的 `indexPackage` 在同一事务里写向量和词表；远程路径先 `writeVector` 再 `indexTerms`，是两次小事务。索引失败不会回滚包，只把错误放进返回值的 `indexed.error`。

| `compressAndStore` 的返回 | 什么时候 |
|---|---|
| `{ok:true, attemptId, package, indexed}` | 压缩与写包成功；`indexed` 可能是 `terms+vector`、只有词表，或带 `error` |
| `{ok:false, attemptId:null, errorCode:compression_locked, lock}` | 同区间已有未过期锁，`lock` 是占锁方 |
| `{ok:false, attemptId, errorCode}` | 模型草稿失败；尝试已记录，段留在待压列表 |

带地址的压缩（`addressed:true`）要求模型交 JSON；只有错误码以 `address_` 开头时才回退到纯文本提示词，网络失败、超短、截断都不回退。

`facade.note` 是另一条入口：一条 `role='system'`、`kind='note'` 的事件 + 一个同区间的 `note` 包 + 词表 + 可选向量，全在一个 `store.atomic` 里；返回值 `indexed` 是 `terms+vector` 或 `terms`，不假装有语义。

## 4. `segment` 与 `package` 的区别

| 维度 | `segment` | `package` |
|---|---|---|
| 存在形式 | `splitSegments` 返回的内存对象，不落库 | `life_packages` 的一行 |
| 从哪来 | 事件按空闲/日界/状态/时长切开，小段还会被合并 | 压缩草稿（或 `facade.note` 的原话）+ 地址字段（`occurred_at` / `subjects_json` / `ordinal`） |
| 区间 | `startSeq` / `endSeq`，外加 `startAt` / `endAt` / `durationMs` | `start_seq` / `end_seq`，必须 `end_seq >= start_seq` |
| 状态 | 无 | `active` / `withdrawn`，只有这两种 |
| 能不能搜 | 不能 | 词表 + 向量两条索引 |

| `DEFAULT_SEGMENT_RULES` 常量 | 值 | 作用 |
|---|---|---|
| `idleGapMs` | 4 小时 | 超过这个间隔才断 |
| `maxSegmentMs` | 3 小时 | 一段最长时长 |
| `timeZone` | `UTC` | 日界按这个时区算 |
| `boundaryOnlyKinds` | `['state']` | 状态变化是边界，不是内容 |
| `minEvents` / `minChars` | 2 / 20 | 小于它的小段尝试并入相邻段 |
| `mergeGapMs` / `absorbGapMs` | 4 小时 / 12 小时 | 向前并 / 向后并的最大距离 |

`splitSegments` 返回 `{segments, stats}`；空内容的边界段会被丢弃并记进 `stats.dropped`，合并次数记进 `stats.merged`。

## 5. 召回 → 打分 → 装配
`segment.mjs` 的 `buildMemoryParts` 串起三步：`recallPackages` 取候选 → 读 `life_activation` 与包的 `links_json` → `selectMemories` 打分抽样。返回 `{parts, selected, recall, scored}`，`parts` 每项只有 `{id, text}`。

| 阶段 | 函数 | 产出 |
|---|---|---|
| 召回 | `recallPackages` | `candidates`（带 `total` / `rank` / `score` / `routes`）、`routes`、`stats` |
| 打分 | `selectMemories` | `scored`（含 `factors` 与 `scoreParts`）、`selected`、`probabilities` |
| 装配 | `buildMemoryParts` | `parts`；预算和丢弃数量由调用方负责 |

`recall.mjs` 有三条路，融合时按 `ROUTE_WEIGHTS` 加权：语义 0.7、关键词 0.15、时间 0.15。每条路先做 min-max 归一化；文件头注释还写着“reciprocal rank fusion”，实际实现是加权求和，以函数为准。`DEFAULT_RECALL.mode` 是 `semantic`，此时只走语义路；`facade.recall` 显式传 `{mode:'fused', perRoute:20, limit}`。

| 路 | 查什么 | 怎么算 | 权重 |
|---|---|---|---|
| 语义 | `life_package_vectors WHERE encoder=?` | 逐元素点积除以两个模长 | 0.7 |
| 关键词 | `life_package_terms` | 按 IDF 加权命中词，再除以查询总权重 | 0.15 |
| 时间 | `life_packages.created_at` | `exp(-距离 / halfLife)`，`timeHalfLifeDays` 默认 30 | 0.15 |

`facade.recall` 没有查询词时走 `recent`（按 `created_at` 倒序）；有词但没有向量时走 `keyword_only`；返回前对每条 `remembered` 写一次 `recordActivation`。`time-cue.mjs` 只认“昨天”“三天前”“一个多月前”这类闭式说法，`resolveCueTime` 返回 `at` 与 `windowDays`，但仓库里没有调用点，`recall.mjs` 的时间路只读 `cue.at`。

打分公式是 `w1*log(1+I) + w2*A + w3*R + w4*S + w5*Z - w6*X + noise`，默认权重在 `DEFAULT_WEIGHTS`：`importance` 0.771、`activation` 0.05、`relevance` 2.023、`association` 0.27、`openLoop` 1.079、`inhibition` 0.27。

| 因子 | 来源 | 备注 |
|---|---|---|
| `importance` | `candidate.importance`，缺省 3 | 只接受 1–5，越界抛 `importance_out_of_range` |
| `activation` | `activationValue` 按 ACT-R：`ln(Σ gap^-0.5)` | 没有想起记录时取 `ACTIVATION_FLOOR` = -4 |
| `relevance` | `candidate.total` | 召回融合后的分数 |
| `association` / `openLoop` / `inhibition` | 链接数 / `openLoops` / `recentPackageIds` | `min(1, linked/3)` / 命中 1 否则 0 / 刚看过取 1 |

抽样不是取 top-1：`sampleCandidates` 用 `softmax(score / temperature)` 无放回抽，`DEFAULT_SAMPLING` 是 `temperature` 0.7、`count` 6、`maxCount` 8、`noise` 0；随机数默认种子 1，可复现。

## 6. 向量：本地编码与远程 embedding

| 编码器 | `name` | 维度 | 是不是语义 |
|---|---|---|---|
| `createHashEncoder` | `hash-bigram-v1` | 64（可用 `dim` 改） | 不是；只反映字面重合，匹配不了“搬家”和“换房子” |
| `createRemoteEncoder` | 默认 `emb-<model>` | 由第一次响应的向量长度决定 | 接口按语义设计；质量取决于接的服务 |

远程编码器的真实接口是 `createRemoteEncoder({ model, apiKey, endpoint, name })`，另可传 `fetchImpl` 与 `timeoutMs`（默认 60000）；用法是先建 encoder，再 `await encoder.encode(text)`。端点默认 `DEFAULT_EMBEDDING_ENDPOINT = http://127.0.0.1:8080/v1/embeddings`，是环回地址；请求是 `POST`，body 是 `{model, input: texts, encoding_format: 'float'}`，头是 `Authorization: Bearer <apiKey>`，并设 `redirect: 'error'`。

文档口径叫“表名”，代码里就是 `life_package_vectors.encoder` 的值。不传 `name` 时按 `emb-` + 模型名（非字母数字换成 `-`、转小写）生成，代码注释的原话是“换名字等于换一套向量”。代码不写死 4096：`dim` 从第一次响应的长度量出来，同批不一致抛 `encoder_dim_mismatch`；参考部署是自部署的 Qwen3-Embedding-8B、4096 维（模型支持 MRL，宽度是部署选择）。

| 变化 | 代码里发生什么 | 后果 |
|---|---|---|
| 换模型但沿用 `name` | 新旧向量写进同一个 `encoder` 键 | 两套坐标混在一张表里，相似度没有意义；必须先换 `name` |
| 换维度但沿用 `name` | 每行自带 `dim`，召回时 `recall.mjs` 不校验 cue 与库中维度 | 不报错：库里的维度比 cue 长时乘出 `NaN`，候选被 `score > 0` 过滤；比 cue 短时只比了前几维，得到不完整的余弦 |
| 换 `name` | 查询固定 `WHERE encoder=?` | 旧向量留在旧键下，新召回看不到它们；仓库没有重算或回填工具 |

## 7. 压缩：提示词在哪一层
提示词是 `compress.mjs` 里的常量，不是 `prompts/` 文件、也不是配置：纯文本用 `COMPRESS_SYSTEM`，带地址用 `COMPRESS_ADDRESS_SYSTEM`；`buildCompressMessages` / `buildAddressMessages` 组出 `system` + 一条 `user`（时间区间、条数、逐行事件）。核心不知道谁回答，只调用注入的 `summarise`。

| 常量 | 值 | 用途 |
|---|---|---|
| `COMPRESS_PROMPT_VERSION` | `life-compress-v2` | 纯文本版本号 |
| `COMPRESS_ADDRESS_PROMPT_VERSION` | `life-compress-address-v10` | 带地址 + `importance` 的版本号 |
| `minChars` / `maxChars` | 12 / 2000 | 草稿太短或太长都拒绝 |
| `targetChars` | 160 | 提示词里的目标长度 |
| `maxOutputTokens` / `maxInputChars` | 32768 / 60000 | 输出预算与单段输入上限 |

硬护栏：`finishReason === 'length'` 直接抛 `compressed_output_truncated`；输出为空、短于 `minChars`、长于 `maxChars` 各有错误码；命中 `META_NARRATION`（例如“记录里”“就这一行”）抛 `meta_narration`，宁可这一段继续待压，也不存一条描述记录本身的记忆。`thought` 事件渲染成 `UNSPOKEN_MARK`（`助手心里（没说出口）`），`tool` 事件渲染成“动作”，不写成助手说过的话。

## 8. 纠正与撤回：不参与后续装配，不等于物理删除

| 操作 | 旧 `package` | 新行 | 日志 | 不做什么 |
|---|---|---|---|---|
| `correctPackage` | `status='withdrawn'`，并追加 `{type:'corrected_by', to}` | 同区间、`kind='correction'` 的新包，id 默认 `<旧id>-fix`；`life_corrections` 一行 | 一条 `role='system'`、`kind='note'` 的更正记录 | 不重新调模型、不删旧行；向量和词表直接复制旧包的（注释自己承认这是同 `encoder` 名下的近似） |
| `withdrawPackage` | `status='withdrawn'` | 无 | 一条带 `meta.withdrawal` 的 note 事件 | 不删包、不删向量、不删日志 |

`latestCorrection` 顺着 `life_corrections` 一路走到最后一版；指针成环抛 `correction_cycle`。`facade.unpack` 遇到已撤回的包会跟随指针读改后的版本，读不到就返回 `withdrawn`，不会退回旧文。撤回理由必填（`reason_required`），缺失就不动。

## 9. 存储
`store/db.mjs` 用运行时自带的 `node:sqlite`（`DatabaseSync`），没有新增依赖；表由 `migrate` 的 `SCHEMA` 用 `CREATE TABLE IF NOT EXISTS` 建，当前 `SCHEMA_VERSION` 是 17。打开时设 `journal_mode=WAL`、`foreign_keys=ON`、`synchronous=FULL`、`trusted_schema=OFF`、`busy_timeout=5000`；`atomic` 在 `BEGIN IMMEDIATE … COMMIT` 里跑同步回调，回调返回 Promise 抛 `async_transaction_body`。

| 表 | 存什么 | 记忆层怎么用 |
|---|---|---|
| `life_events` | 原话与状态流水 | 唯一法源；触发器 `life_events_no_update` / `life_events_no_delete` 禁止改删 |
| `life_packages` | 压缩包 | `status` 只有 `active` / `withdrawn`；`importance` 限 1–5 |
| `life_package_vectors` | 向量 | 主键 `(package_id, encoder)`；`vector` 是 float32 小端 BLOB |
| `life_package_terms` | 词表 | 主键 `(package_id, term)`，关键词路读它 |
| `life_activation` | 每次真正想起 | `activation.mjs` 写，打分读 |
| `life_compression_attempts` | 每次压缩尝试 | 状态 `completed` / `truncated` / `empty` / `too_short` / `too_long` / `failed` |
| `life_compression_locks` | 压缩锁 | `UNIQUE(start_seq, end_seq)`；`DEFAULT_LOCK_TTL_MS` 是 10 分钟 |
| `life_corrections` | 旧 → 新指针 | `UNIQUE(from_package_id)` |
| `life_rolls` | 滚动截止点 | `to_seq` 只增不减 |

`store/events.mjs` 定义 `EVENT_ROLES`（`user` / `assistant` / `system` / `tool`）和 `EVENT_KINDS`（`spoken` / `thought` / `action` / `observation` / `state` / `note` / `reply` / `opening`）。工具调用因此能进记忆：`recordToolCall` 写的是 `role='tool'`、`kind='action'`，既会被分段压缩，也不会出现在助手的对话历史里；结果超过 `maxChars`（默认 1000）时留头 800 + 尾 200，中间写“中间 N 字没记”。

## 10. 错误码 / 边界码（照抄代码）

| 来源 | 码 | 触发 |
|---|---|---|
| `store/db.mjs` | `identity_mismatch` / `schema_from_future` | 库绑定了别的 identity / 库版本比代码新 |
| `store/db.mjs` | `nested_transaction` / `async_transaction_body` | `atomic` 里再开事务 / 回调返回 Promise |
| `store/db.mjs` | `life_events_is_append_only` | 触发器拒绝 `UPDATE` / `DELETE` 事件 |
| `index.mjs` | `invalid_vector` / `async_encoder_requires_write_vector` | 向量不是非空 `Float32Array` / 同步索引路径拿到 Promise |
| `encoder-remote.mjs` | `encoder_timeout` / `encoder_transport_failed` / `encoder_http_error` | 超时 / `fetch` 抛错 / 非 2xx |
| `encoder-remote.mjs` | `encoder_incomplete_output` / `encoder_invalid_vector` / `encoder_dim_mismatch` | `data` 数量不符 / embedding 不是非空数组 / 同批维度不一致 |
| `compress.mjs` | `compressed_output_truncated` / `compressed_output_empty` / `compressed_output_too_short` / `compressed_output_too_long` | `finishReason` 是 `length` / 空 / 太短 / 太长 |
| `compress.mjs` | `meta_narration` / `address_output_not_json` / `address_missing_subjects` / `address_invalid_importance` | 命中 `META_NARRATION` / JSON 解析失败 / 缺 `subjects` / `importance` 不是 1–5 整数 |
| `pipeline.mjs` | `compression_locked` | 同区间已有未过期锁 |
| `packages.mjs` | `package_range_overlap` | 活动包的区间与新区间重叠 |
| `recall.mjs` | `missing_cue_vector` / `invalid_recall_mode` | 无同步 encoder 且没传 `cueVector` / `mode` 不在 `RECALL_MODES` |
| `corrected.mjs` | `reason_required` / `package_not_found` / `already_withdrawn` / `correction_cycle` | 缺理由 / 找不到 / 旧包已撤 / 指针成环 |
| `withdraw.mjs` | `reason_required` / `package_not_found` / `already_withdrawn` | 缺理由 / 找不到 / 已撤回 |
| `segments.mjs` | `events_not_ascending` / `invalid_time_zone` | `seq` 不递增 / 时区非法 |
| `unpack.mjs` | `package_withdrawn` / `package_range_empty` / `unpack_budget_too_small` | 未允许撤回包 / 区间无事件 / 预算放不下第一条 |
| `tool-calls.mjs` | `invalid_tool_name` / `invalid_limit` | 名字为空 / 上限不是正整数或 `tailChars >= maxChars` |
| `facade.mjs` | `text_too_long` / `id_or_seq_required` / `withdrawn` | `note`/`revise` 超上限 / `unpack` 两个参数都没给 / 撤回包没有可跟随的更正 |

## 11. 边界 / 没有做的事

| 没有做 | 说明 |
|---|---|
| 生产向量服务 | 只有 `createRemoteEncoder` 这个客户端；没有服务端、批量索引队列、ANN 索引或向量缓存；语义路把该 `encoder` 的所有向量取回来逐条算余弦 |
| 自动重算 / 迁移 | 换 `name` 后旧向量不重算；没有回填或迁移脚本，只有“换模型就换名字”的约定 |
| 多模型混用 | 一次召回只查一个 `encoder` 键；没有按包挑模型的逻辑 |
| 真实语义质量验证 | 本地 `hash-bigram-v1` 只反映字面重合；远程 4096 维 Qwen3-Embedding-8B 是参考部署，不是仓库自带的保证 |
| 加密 | SQLite 是明文；`apiKey` 由调用方传入，只在进程内存里，不落库、不写日志 |
| `assembleFrame` 与宿主接线 | `segment.mjs` 注释提到 `assembleFrame`，但仓库里没有这个模块；`createMemoryFacade` 和 `buildMemoryParts` 没有调用点，示例宿主 `examples/minimal-host/host.mjs` 里 `stubs.memory = {}` |
| 时间线索与地址字段 | `resolveCueTime`、`addressFactors` 都没有调用点；`facade.recall` 不解析“三天前”，只把 `subjects` 附在结果上，按序号或时间窗命中没有接进召回 |
| 日记与权重更新 | `consolidate.mjs` 明确说这两件事没做 |
| 物理删除 / 清理 | 撤回只改状态；没有删除记忆的工具，`life_events` 的触发器也禁止删除 |
| 多实例 / 分布式协调 | 压缩锁只在同一个库内生效，TTL 10 分钟后可被接管；没有跨进程或跨主机锁 |

相关文档：[整体结构](architecture.md) · [配置](config.md) · [模型协议](model-protocols.md) · [插件接口](plugin-api.md) · [安全边界](security.md) · [常见问题](faq.md)