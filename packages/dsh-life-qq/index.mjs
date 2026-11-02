/**
 * life-qq：把助手的话交到 QQ，也把 QQ 上"手能做的事"交给助手。
 *
 * 三个槽位，三种不同性质的权力：
 * - outbound('qq_send') 出口：助手要说的字。发给谁、发几次、超长怎么切，全在宿主。
 * - inbound('qq_recv') 入口：谁说的话能到助手那儿。白名单/上限/静音/去重也在宿主。
 * - tool('qq_*') 手：助手可以主动做的 QQ 动作（发图/发语音/发文件/撤回/贴表情/
 * 戳一戳/读历史/读单条/改在线状态/改资料/点赞）。
 *
 * 收件人不是写死一个人，而是一份可配置的名单策略，口径跟"听"对称：
 * recipients.mode = 'list' 只有 ids 里的人（单选就是这里只放一个）
 * recipients.mode = 'all' 所有好友，除黑名单（反选 = all + 把人放黑名单）
 * recipients.mode = 'none' 谁都不发
 * recipients.blacklist 黑名单：任何模式下都永远不发（优先于以上三种）
 * 嘴（出口）永远只对"主收件人"说；手可以用 to 在允许集合里选人。黑名单永远赢。
 *
 * 协议端：协议端的 OneBot v11 HTTP。token 只从宿主 env 或 600 的只读文件取，
 * 不写 token、不把 token 放进回执或日志。
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

import { createPolicyReader } from '../dsh-life-core/policy-file.mjs';
import { presetNames, buildTtsBody } from '../dsh-life-core/voice/tts.mjs';

const DEFAULT_MEDIA_MAX_BYTES = 8 * 1024 * 1024;
/** 听和发用同一套口径：list（名单内）/ all（除黑名单外所有人）/ none（谁都不）。 */
const RECIPIENT_MODES = Object.freeze(['list', 'all', 'none']);
/** 听群的口径跟听人一样：none 一个字都不进，list 只认名单，all 全听。 */
const GROUP_MODES = Object.freeze(['none', 'list', 'all']);
/** 好友列表缓存多久（all 模式要用它算"所有好友"）；可被 manifest / 热文件覆盖。 */
const FRIEND_CACHE_MS = 60000;
// QQ 群禁言的硬上限：30 天。超过这个数协议端也会拒，先在本地拒，助手才知道是自己给多了。
const GROUP_BAN_MAX_MINUTES = 43200;
// QQ 在线状态码（OneBot v11 扩展，协议端 沿用）：10 在线 / 20 离开 / 30 忙碌 / 40 隐身 / 50 请勿打扰 / 60 听歌中
const STATUS_CODES = Object.freeze({
  online: 10,
  away: 20,
  busy: 30,
  invisible: 40,
  'do-not-disturb': 50,
  dnd: 50,
  listening: 60,
});

function fail(code, detail) {
  const error = new Error(code + (detail === undefined ? '' : ': ' + detail));
  error.code = code;
  return error;
}

function base64Bytes(text) {
 // 只做长度估算，不解析内容：base64 长度 * 3/4 减掉 padding。
  const trimmed = text.endsWith('==') ? text.slice(0, -2) : text.endsWith('=') ? text.slice(0, -1) : text;
  return Math.floor((trimmed.length * 3) / 4);
}

// 头像的来源：协议端跑在自己的容器里，读不到助手的
// 屋（home），set_qq_avatar 传路径一律 retcode 100；而让助手自己把 base64 抄进工具参数，
// 长串必串字（128px 以内才保证不出错）→ 头像只能很小、很糊。所以路径先给插件自己读：
// 本机读得到就直接转 base64 递过去，读不到才按老口径透传（URL / 协议端那边的路径）。
const AVATAR_MAX_BYTES = 4 * 1024 * 1024;

function isImageHead(bytes) {
  if (bytes.length < 12) return false;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const gif = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
  const webp = bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
  return jpeg || png || gif || webp;
}

function avatarFile(raw) {
  const compact = raw.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/=]+$/.test(compact) && base64Bytes(compact) > 64) return 'base64://' + compact;
  let stat;
  try { stat = statSync(raw); } catch { return raw; }
  if (!stat.isFile()) return raw;
  if (stat.size === 0) throw fail('qq_avatar_file_empty', raw);
  if (stat.size > AVATAR_MAX_BYTES) throw fail('qq_avatar_file_too_big', raw + ' is ' + stat.size + ' bytes, limit ' + AVATAR_MAX_BYTES);
  const bytes = readFileSync(raw);
  if (!isImageHead(bytes)) throw fail('qq_avatar_not_image', raw);
  return 'base64://' + bytes.toString('base64');
}

/** 一串 QQ 号：去重、必须是正整数，错就当场拒（不猜）。 */
function idList(value, code) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw fail(code, 'must be a list of QQ numbers');
  const out = [];
  for (const entry of value) {
    const text = String(entry ?? '').trim();
    if (!/^\d+$/.test(text)) throw fail(code, text);
    const id = Number(text);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export function create(context) {
  const endpoint = String(context.config.endpoint ?? '').replace(/\/+$/, '');
  if (endpoint === '') throw new Error('life-qq needs config.endpoint (OneBot HTTP base URL)');
  const timeoutMs = Number.isInteger(context.config.timeoutMs) ? context.config.timeoutMs : 10000;
  let token = typeof context.env.onebotToken === 'string' ? context.env.onebotToken : '';
  const tokenPath = typeof context.config.tokenPath === 'string' && context.config.tokenPath.trim() !== ''
    ? context.config.tokenPath.trim() : null;
  if (token === '' && tokenPath !== null) {
    let raw;
    try { raw = readFileSync(tokenPath, 'utf8'); } catch { throw new Error('life-qq cannot read config.tokenPath'); }
    token = raw.trim();
    if (token === '') throw new Error('life-qq config.tokenPath is empty');
  }
 // 协议端的 OneBot HTTP 只认 Authorization: Bearer <token>；Token 前缀和裸 token 都会 401。
  const authScheme = context.config.authScheme === undefined ? 'Bearer' : String(context.config.authScheme);
  if (authScheme !== 'Bearer' && authScheme !== 'Token' && authScheme !== 'none') {
    throw new Error('life-qq config.authScheme must be Bearer, Token or none');
  }
  const mediaMaxBytes = Number.isInteger(context.config.mediaMaxBytes) && context.config.mediaMaxBytes > 0
    ? context.config.mediaMaxBytes : DEFAULT_MEDIA_MAX_BYTES;
  const friendCacheMs = Number.isInteger(context.config.friendCacheMs) && context.config.friendCacheMs >= 0
    ? context.config.friendCacheMs : FRIEND_CACHE_MS;

 // ---- 语音转文字------------------
 // 协议端先把语音转成 WAV（get_record out_format=wav），再交给本地 SenseVoice 服务。
 // 助手读到的那句话带 [语音] 前缀——助手得知道这是用嘴说的，语气和期待的回答都不一样。
  const asrEndpoint = typeof context.config.asrEndpoint === 'string' && context.config.asrEndpoint.trim() !== ''
    ? context.config.asrEndpoint.trim().replace(/\/+$/, '') : '';
  const asrEnabled = context.config.asrEnabled !== false && asrEndpoint !== '';
  const asrTimeoutMs = Number.isInteger(context.config.asrTimeoutMs) && context.config.asrTimeoutMs > 0
    ? context.config.asrTimeoutMs : 15000;
  const asrMaxBytes = Number.isInteger(context.config.asrMaxBytes) && context.config.asrMaxBytes > 0
    ? context.config.asrMaxBytes : DEFAULT_MEDIA_MAX_BYTES;
  const asrLangRaw = typeof context.config.asrLang === 'string' ? context.config.asrLang.trim().toLowerCase() : 'auto';
  const asrLang = ['auto', 'zh', 'en', 'yue', 'ja', 'ko'].includes(asrLangRaw) ? asrLangRaw : 'auto';
 // ---- 用自己的声音说话----------------------
 // TTS 由你自己起一个服务，端点写在 config.voiceEndpoint。
 //
 // 只有本机的 docker 网桥能连，公网碰不到。契约。
  const voiceEndpoint = (typeof context.config.voiceEndpoint === 'string' && context.config.voiceEndpoint.trim() !== ''
    ? context.config.voiceEndpoint.trim() : '').replace(/\/+$/, '');
  const voicePresets = (context.config.voicePresets && typeof context.config.voicePresets === 'object') ? context.config.voicePresets : { default: {} };
  const voiceEnabled = context.config.voiceEnabled !== false && voiceEndpoint !== '';
 // 引擎自己的硬上限是 60 s / 240 字、并发 1（queue_max=0）；这里留一点网络余量。
  const voiceTimeoutMs = Number.isInteger(context.config.voiceTimeoutMs) && context.config.voiceTimeoutMs > 0
    ? context.config.voiceTimeoutMs : 90000;
  const voiceMaxChars = Number.isInteger(context.config.voiceMaxChars) && context.config.voiceMaxChars > 0
    ? Math.min(context.config.voiceMaxChars, 240) : 240;
  const voicePresetRaw = typeof context.config.voicePreset === 'string' ? context.config.voicePreset.trim() : 'default';
  const voicePresetDefault = Object.hasOwn(voicePresets, voicePresetRaw) ? voicePresetRaw : 'default';
  const VOICE_PREFIX = '[语音] ';
  const VOICE_MAX_PER_MESSAGE = 3;
 // ---- 图片入站-----------
 // 定的数：单图 < 20 MB，一条消息最多 15 张。
  const imageMaxBytes = Number.isInteger(context.config.imageMaxBytes) && context.config.imageMaxBytes > 0
    ? context.config.imageMaxBytes : 20 * 1024 * 1024;
  const imageTimeoutMs = Number.isInteger(context.config.imageTimeoutMs) && context.config.imageTimeoutMs > 0
    ? context.config.imageTimeoutMs : 20000;
 // 目录默认值：先看配置，再用宿主给的插件数据目录；两样都没有就报清楚——
 // 不写死任何一台机器上的路径。
  const resolveDataDir = (configured, subdir, configKey) => {
    const declared = typeof configured === 'string' ? configured.trim() : '';
    if (declared !== '') return declared;
    if (typeof context.dataDir === 'string' && context.dataDir !== '') return path.join(context.dataDir, subdir);
    throw new Error('life-qq needs ' + configKey + ' or a host dataDir');
  };
  const imageDir = resolveDataDir(context.config.imageDir, 'media', 'config.imageDir');
 // 图要不要塞给模型：这条路由本来就能看图。看不见的原因是
 // provider 没把这个 id 声明成 input:['text','image']（缺 MODEL_CATALOG 条目 → harness 把
 // image 块换成"只吃文字"的占位）。元数据对了就正常。所以默认**递**：
 // 万一哪天元数据又退回 text-only，harness 只会换成占位、不会报错，代价可接受。
 // 真要关，attachImages: false。
  const attachImages = context.config.attachImages !== false;
 // ---- 文件入站--------------------------------
 // 以前 file 段只变成一句“[文件] 名字 大小”，字节一个都没拿下来——助手只能诚实地说“我没收到”。
 // 现在真去下载，落进助手屋里（room_read 读得到的地方），标记里给助手一个相对路径。
 // 落点默认 <homeRoot>/inbox：助手的工具看得到；插件数据目录是助手的禁区，落那儿等于“收到了打不开”。
  const fileDir = typeof context.config.fileDir === 'string' && context.config.fileDir.trim() !== ''
    ? context.config.fileDir.trim()
    : (typeof context.env.homeRoot === 'string' && context.env.homeRoot !== ''
      ? path.join(context.env.homeRoot, 'inbox')
      : resolveDataDir('', 'inbox', 'config.fileDir'));
 // 文件比图大得多：20 秒对几 MB 的文件不够，给 120 秒（可被 manifest / 热文件覆盖）。
  const fileTimeoutMs = Number.isInteger(context.config.fileTimeoutMs) && context.config.fileTimeoutMs > 0
    ? context.config.fileTimeoutMs : 120000;
 // 别人发来的东西不该无限堆在助手屋里：只留最新的这么多份。
  const FILE_KEEP = 50;
 // ---- 时间：插件里凡是要"人看"的时间都按助手的时区打-----
 // 起因：qq_history / qq_group_history 一直用 toISOString，那是 UTC——助手看到的是 07:50，
 // 而助手自己的钟（宿主、助手自己的时区、助手跟对方说的时间）如果不是同一个钟，助手会把旧话当新话。
 // 所以这里只留一个钟：时区取 config.timeZone（没写就 UTC），其余全部走它。
  const pluginTimeZone = typeof context.config.timeZone === 'string' && context.config.timeZone.trim() !== ''
    ? context.config.timeZone.trim() : 'UTC';
  const clockFormat = (() => {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: pluginTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      });
    } catch { return null; }
  })();
  function clockParts(seconds) {
    const n = Number(seconds);
    if (Number.isFinite(n) === false || n <= 0 || clockFormat === null) return null;
    const parts = {};
    for (const part of clockFormat.formatToParts(new Date(n * 1000))) parts[part.type] = part.value;
    return parts;
  }
 /** 'MM-DD HH:mm'：历史、合并转发每一条用这个。 */
  function clockShort(seconds) {
    const p = clockParts(seconds);
    return p === null ? '' : p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute;
  }
 /** 'HH:mm'：同一天里的流水用这个。 */
  function clockMinutes(seconds) {
    const p = clockParts(seconds);
    return p === null ? '' : p.hour + ':' + p.minute;
  }
 /** 'YYYY-MM-DD HH:mm'：公告、说说这种可能跨天的用这个。 */
  function clockFull(seconds) {
    const p = clockParts(seconds);
    return p === null ? '' : p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute;
  }
  const imageKeepMs = 60 * 60 * 1000;
  const PENDING_FILE = 'pending.json';
  const IMAGE_MAX_PER_MESSAGE = 15;
  const IMAGE_MARK = '[图片]';
 // DSH 的附件准入只认这四种；BMP 由本插件转成 PNG，TIFF/HEIC/AVIF 只报"收到了但看不了"。
  const IMAGE_PASS = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
 // ---- QQ 空间：读是安全的，发/删是对外发声，默认关着 ------------------------
 // 协议端有整套 qzone 动作：get_qzone_msg_list /
 // get_qzone_feeds / send_qzone_msg / delete_qzone_msg。没有语音通话
 // （voice_call / av_call），礼物相关动作也不在它的动作表里。
  const qzonePostEnabled = context.config.qzonePost === true;
  const QZONE_UGC_RIGHTS = Object.freeze([1, 4, 16, 64, 128]);
  const qzoneDefaultRight = Number.isInteger(context.config.qzoneUgcRight) && QZONE_UGC_RIGHTS.includes(context.config.qzoneUgcRight)
    ? context.config.qzoneUgcRight : 64;
  const qzoneMaxChars = Number.isInteger(context.config.qzoneMaxChars) && context.config.qzoneMaxChars > 0
    ? context.config.qzoneMaxChars : 1000;
  const qzoneFeedCount = Number.isInteger(context.config.qzoneFeedCount) && context.config.qzoneFeedCount > 0
    ? Math.min(context.config.qzoneFeedCount, 20) : 5;

 // ---- 表情包 ---------------------------------------------------------------
  // 图库不是本地文件夹，而是助手 QQ 账号的「收藏表情」——协议端有整套动作：
 // fetch_custom_face_detail {count} -> [{emoji_id, resId, url, md5, desc}]
 // add_custom_face {file:'base64://…'} -> {emoji_id}（吃 base64：两个容器不用共享目录）
 // modify_custom_face {emoji_id, desc} -> 改备注，就是助手给这张起的名字
 // delete_custom_face {emoji_id}
 // send_custom_face {emoji_id, user_id, reply_to} 发出去还保留"表情"样式
 // 好处：助手在 QQ 客户端里也看得见自己加的图，不用维护第二份副本、也不会两边对不上。
 // 别人发给助手的表情包先落在"收件箱"（<stickerDir>/inbox），助手收下才进图库。
  const stickerEnabled = context.config.stickerEnabled !== false;
  const stickerDir = resolveDataDir(context.config.stickerDir, 'stickers', 'config.stickerDir');
  const stickerMaxBytes = Number.isInteger(context.config.stickerMaxBytes) && context.config.stickerMaxBytes > 0
    ? Math.min(context.config.stickerMaxBytes, 8 * 1024 * 1024) : 2 * 1024 * 1024;
  const stickerInboxMax = Number.isInteger(context.config.stickerInboxMax) && context.config.stickerInboxMax > 0
    ? Math.min(context.config.stickerInboxMax, 300) : 60;
  const stickerInboxKeepMs = Number.isInteger(context.config.stickerInboxKeepMs) && context.config.stickerInboxKeepMs > 0
    ? context.config.stickerInboxKeepMs : 30 * 24 * 60 * 60 * 1000;
  const stickerListMax = Number.isInteger(context.config.stickerListMax) && context.config.stickerListMax > 0
    ? Math.min(context.config.stickerListMax, 200) : 100;
  const STICKER_MARK = '[表情包]';
 // QQ 认这个组合：image 段带 sub_type=1 + summary='[动画表情]' 就按表情显示（协议端自己发收藏表情也这么拼）。
  const STICKER_SUMMARY = '[动画表情]';
 // ---- 引用回复 -------------------------------------------------------------
 // 协议端：send_private_msg 的 message 数组里放 { type:'reply', data:{ id } } 就能挂上引用，
 // 但它会先在本地消息库里把 id 换成序号——**查不到就静默丢掉这一段**（只写一行 warn）。
 // 所以这里发之前先 get_msg 确认一遍：引不上就明说，不让助手以为引上了。
  const replyMaxChars = Number.isInteger(context.config.replyMaxChars) && context.config.replyMaxChars > 0
    ? context.config.replyMaxChars : 2000;
  const replyWindowMs = Number.isInteger(context.config.replyWindowMs) && context.config.replyWindowMs > 0
    ? context.config.replyWindowMs : 10 * 60 * 1000;

 /**
 * 发（谁能收到助手的东西）——跟"听"用同一套口径：list / all / none + 黑名单。
 * list 只有 ids 里的人
 * all 所有好友，除黑名单
 * none 谁都不发
 * 黑名单任何模式下都优先。**单选** = list 里只放一个人；**反选** = all + 把要排除的人放黑名单。
 */
  const policy = context.config.recipients !== null && typeof context.config.recipients === 'object'
    ? context.config.recipients : {};
  const mode = String(policy.mode ?? 'list').trim().toLowerCase();
  if (!RECIPIENT_MODES.includes(mode)) {
    throw new Error('life-qq config.recipients.mode must be list, all or none');
  }
  const listed = idList(policy.ids, 'qq_invalid_recipients');
  const blacklist = new Set(idList(policy.blacklist, 'qq_invalid_blacklist'));
  const envIdText = context.env.qqUserId === undefined || context.env.qqUserId === null ? '' : String(context.env.qqUserId).trim();
  const envId = /^\d+$/.test(envIdText) ? Number(envIdText) : null;
 // 名单为空 + list：退回宿主给的那个默认收件人（部署没写 recipients 时就是这个行为）。
  if (mode === 'list' && listed.length === 0) {
    if (envId === null) throw new Error('life-qq config.recipients.mode is list but ids is empty and env.qqUserId is missing');
    listed.push(envId);
  }
 // 主收件人 = 嘴对着的那个人，也是手不传 to 时的默认。list 模式下必须在名单里。
  const primaryText = policy.primary === undefined || policy.primary === null || String(policy.primary).trim() === ''
    ? '' : String(policy.primary).trim();
  if (primaryText !== '' && !/^\d+$/.test(primaryText)) throw new Error('life-qq config.recipients.primary must be a QQ number');
  const configuredPrimary = primaryText !== '' ? Number(primaryText) : (mode === 'list' ? listed[0] : envId);
  if (mode === 'list' && configuredPrimary !== null && !listed.includes(configuredPrimary)) {
    throw new Error('life-qq config.recipients.primary must be one of the ids in list mode');
  }

 /**
 * 热改：上面那套是**启动默认值**；真正每次用之前会先看一眼
 * config.policyJsonPath 指向的热文件（没有就看 config.policyYmlPath 的同类键），最多 1 s 一次。
 * 所以改名单不用重启宿主。
 * 两个路径都由宿主配，插件不猜。
 */
  const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
  const policyReader = createPolicyReader({
    jsonPath: text(context.config.policyJsonPath),
    ymlPath: text(context.config.policyYmlPath),
    defaults: {
      hear: { mode: 'list', allow: [], deny: [] },
      speak: {
        mode,
        ids: listed.map((id) => String(id)),
        blacklist: [...blacklist].map((id) => String(id)),
        primary: configuredPrimary === null ? null : String(configuredPrimary),
      },
 // 运行参数的启动默认值 = manifest / 宿主配置里写的值（热文件可以覆盖）
      runtime: { mediaMaxBytes, onebotTimeoutMs: timeoutMs, friendCacheMs },
    },
    onWarning: (warning) => context.log('policy warning: ' + warning.code + (warning.detail === null ? '' : ' ' + warning.detail)),
  });
  let lastSpeakKey = null;
  let lastRuntimeKey = null;
 /** 现在生效的运行参数（媒体上限 / 单次超时 / 好友缓存），改热文件即生效。 */
  function runtimeNow() {
    const runtime = policyReader.read().policy.runtime ?? {};
    const current = {
      mediaMaxBytes: Number.isInteger(runtime.mediaMaxBytes) ? runtime.mediaMaxBytes : mediaMaxBytes,
      onebotTimeoutMs: Number.isInteger(runtime.onebotTimeoutMs) ? runtime.onebotTimeoutMs : timeoutMs,
      friendCacheMs: Number.isInteger(runtime.friendCacheMs) ? runtime.friendCacheMs : friendCacheMs,
    };
    const key = current.mediaMaxBytes + '|' + current.onebotTimeoutMs + '|' + current.friendCacheMs;
    if (key !== lastRuntimeKey) {
      if (lastRuntimeKey !== null) {
        context.log('runtime now: mediaMaxBytes ' + current.mediaMaxBytes + ', onebotTimeoutMs ' + current.onebotTimeoutMs + ', friendCacheMs ' + current.friendCacheMs);
      }
      lastRuntimeKey = key;
    }
    return current;
  }
 /** 现在生效的"发"策略（可能跟启动时不一样）。变了就记一行。 */
  function speakNow() {
    const live = policyReader.read();
    const raw = live.policy.speak ?? {};
    const current = {
      mode: RECIPIENT_MODES.includes(String(raw.mode)) ? String(raw.mode) : mode,
      ids: Array.isArray(raw.ids) ? raw.ids.map((id) => String(id)) : listed.map((id) => String(id)),
      blacklist: new Set((Array.isArray(raw.blacklist) ? raw.blacklist : [...blacklist]).map((id) => String(id))),
      primary: raw.primary === null || raw.primary === undefined || String(raw.primary) === '' ? configuredPrimary : Number(String(raw.primary)),
    };
    const key = current.mode + '|' + current.ids.join(',') + '|' + [...current.blacklist].join(',') + '|' + String(current.primary);
    if (key !== lastSpeakKey) {
      if (lastSpeakKey !== null) {
        context.log('speak policy now: ' + current.mode + ' [' + current.ids.join(',') + '] blacklist [' + [...current.blacklist].join(',') + '] primary ' + String(current.primary) + ' (source ' + live.source + ')');
      }
      lastSpeakKey = key;
    }
    return current;
  }

  function headers() {
    const out = { 'content-type': 'application/json' };
    if (token !== '' && authScheme !== 'none') out.authorization = authScheme + ' ' + token;
    return out;
  }

 /**
 * 一条语音 → 助手读到的那句话。**永不抛**：转不出来也必须让助手知道"对方刚说了一段话"，
 * 静默丢掉等于助手假装没听见。所有结果都带 [语音] 前缀，好把"用嘴说的"和"打字的"分开。
 */
  async function transcribeRecord(data) {
    const file = data !== null && typeof data === 'object' && typeof data.file === 'string' ? data.file.trim() : '';
    if (file === '') return VOICE_PREFIX + '（这条语音拿不到文件）';
    if (!asrEnabled) return VOICE_PREFIX + '（转写没开，只听得到声音）';
    let encoded = '';
    try {
      const body = await onebot('get_record', { file, out_format: 'wav' });
      encoded = body !== null && typeof body === 'object' && body.data !== null && typeof body.data === 'object'
        && typeof body.data.base64 === 'string' ? body.data.base64 : '';
    } catch (error) {
      context.log('voice: get_record failed ' + String((error && (error.code || error.message)) || error));
      return VOICE_PREFIX + '（语音没能取到）';
    }
    if (encoded === '') return VOICE_PREFIX + '（语音没能取到）';
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length === 0) return VOICE_PREFIX + '（语音是空的）';
    if (bytes.length > asrMaxBytes) return VOICE_PREFIX + '（语音太大，没转）';
    try {
      const response = await fetch(asrEndpoint + '/transcribe?lang=' + encodeURIComponent(asrLang), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes,
        signal: AbortSignal.timeout(asrTimeoutMs),
      });
      if (response.ok === false) {
        context.log('voice: asr http ' + response.status);
        return VOICE_PREFIX + '（转写服务报错 ' + response.status + '）';
      }
      const payload = await response.json().catch(() => null);
      const text = payload !== null && typeof payload === 'object' && typeof payload.text === 'string'
        ? payload.text.trim() : '';
      if (text === '') return VOICE_PREFIX + '（没听清）';
      return VOICE_PREFIX + text;
    } catch (error) {
      const name = String((error && error.name) || '');
      context.log('voice: asr failed ' + name + ' ' + String((error && error.message) || ''));
      return VOICE_PREFIX + (name === 'TimeoutError' ? '（转写超时，没听清）' : '（转写服务连不上）');
    }
  }

 // 引擎并发只有 1（queue_max=0，第二条直接 429/503），所以这一侧必须自己排队。
 // 不排队就会在助手连着说两句的时候把第二句丢成"合成服务忙"。
  let voiceChain = Promise.resolve();
  function voiceSerialise(task) {
    const next = voiceChain.then(task, task);
    voiceChain = next.then(() => undefined, () => undefined);
    return next;
  }

 /** 拿回的是不是约定的那条 WAV（24 kHz 单声道 16-bit）。 */
  function voiceWavInfo(bytes) {
    if (bytes.length < 44) return null;
    if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null;
    const channels = bytes.readUInt16LE(22);
    const rate = bytes.readUInt32LE(24);
    const bits = bytes.readUInt16LE(34);
    const dataSize = bytes.readUInt32LE(40);
    if (channels < 1 || rate <= 0 || bits !== 16) return null;
    return { channels, rate, bits, seconds: dataSize / (rate * channels * 2) };
  }

 /**
 * 一句话 → 一段整包 WAV（走配置的 TTS 端点）。
 * **会抛**（和转写相反）：这是助手自己发起的动作，失败必须让助手看见原因，不能假装说出去了。
 */
  async function synthesiseVoice(text, presetId) {
    if (!voiceEnabled) throw fail('qq_voice_disabled', 'voice endpoint is not configured');
    const preset = voicePresets[presetId];
    if (preset === undefined) throw fail('qq_voice_bad_preset', String(presetId));
    const chars = text.length;
    if (chars > voiceMaxChars) throw fail('qq_voice_too_long', chars + ' > ' + voiceMaxChars);
    return voiceSerialise(async () => {
      let response;
      try {
        response = await fetch(voiceEndpoint + '/v1/tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildTtsBody(context.config, { preset, text })),
          signal: AbortSignal.timeout(voiceTimeoutMs),
        });
      } catch (error) {
        const name = String((error && error.name) || '');
        throw fail('qq_voice_unreachable', name === 'TimeoutError' ? 'timeout ' + voiceTimeoutMs + 'ms' : String((error && error.message) || error));
      }
      if (response.ok === false) {
        const raw = await response.text().catch(() => '');
        let message = '';
        try { message = String(JSON.parse(raw)?.error?.message ?? ''); } catch { message = raw.slice(0, 160); }
        if (response.status === 429 || response.status === 503) throw fail('qq_voice_busy', 'tts_' + response.status + ' ' + message);
        if (response.status === 504) throw fail('qq_voice_timeout', 'tts_504 ' + message);
        if (response.status === 400) throw fail('qq_voice_rejected', 'tts_400 ' + message);
        throw fail('qq_voice_failed', 'tts_' + response.status + ' ' + message);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const info = voiceWavInfo(bytes);
      if (info === null) throw fail('qq_voice_bad_audio', bytes.length + ' bytes');
      const limit = runtimeNow().mediaMaxBytes;
      if (bytes.length > limit) throw fail('qq_media_too_large', bytes.length + ' > ' + limit);
      return { bytes, seconds: info.seconds, rate: info.rate, preset: preset.id };
    });
  }

 /**
 * 一次 OneBot 调用。失败一律抛（带 code），因为宿主会把异常记成"这一手没成"，
 * 而不是把一句"失败了"当成助手的语气写进记忆。
 */
  async function onebot(action, payload) {
    const response = await fetch(endpoint + '/' + action, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(runtimeNow().onebotTimeoutMs),
    });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) throw fail('onebot_http_' + response.status, action);
    if (body === null || typeof body !== 'object') throw fail('onebot_bad_body', action);
    if (body.status === 'failed') {
      throw fail('onebot_' + String(body.retcode ?? 'failed'), action + ' ' + String(body.message ?? body.wording ?? ''));
    }
    return body;
  }

 // ---- 收件人解析 ------------------------------------------------------------
  const friendCache = { at: 0, ids: [] };
  async function friendIds() {
    const now = Date.now();
    const ttl = runtimeNow().friendCacheMs;
    if (ttl > 0 && now - friendCache.at < ttl && friendCache.ids.length > 0) return friendCache.ids;
    const body = await onebot('get_friend_list', {});
    const list = Array.isArray(body?.data) ? body.data : [];
    const ids = [];
    for (const friend of list) {
      const id = Number(friend?.user_id ?? friend?.userId);
      if (Number.isFinite(id)) ids.push(id);
    }
    friendCache.at = now;
    friendCache.ids = ids;
    return ids;
  }

 /** 现在允许发给谁（黑名单永远最后扣掉；none 就是谁都不行）。 */
  async function allowedRecipients(speak) {
    if (speak.mode === 'none') return [];
    if (speak.mode === 'list') {
      return speak.ids
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && !speak.blacklist.has(String(id)));
    }
    const friends = await friendIds();
    return friends.filter((id) => !speak.blacklist.has(String(id)));
  }

  function pickPrimary(speak, allowed) {
    if (speak.primary !== null && Number.isFinite(speak.primary) && allowed.includes(speak.primary)) return speak.primary;
 // 没配 primary（或 primary 被黑名单挡住）时：env 给的号优先，其次允许集合里的第一个
    if (envId !== null && allowed.includes(envId)) return envId;
    return allowed.length > 0 ? allowed[0] : null;
  }

 /**
 * 这一手要发给谁。args.to 只能在"允许集合"里选人；
 * 传了集合外的人就是拒（不是悄悄忽略，也不是照发）。
 */
  async function target(args) {
    const speak = speakNow();
    const allowed = await allowedRecipients(speak);
    if (allowed.length === 0) throw fail('qq_no_recipients', speak.mode);
    const raw = args?.to === undefined || args?.to === null ? '' : String(args.to).trim();
    if (raw === '') {
      const primary = pickPrimary(speak, allowed);
      if (primary === null) throw fail('qq_no_recipients', speak.mode);
      return primary;
    }
    if (!/^\d+$/.test(raw)) throw fail('qq_invalid_recipient', raw);
    const wanted = Number(raw);
    if (speak.blacklist.has(raw)) throw fail('qq_recipient_blacklisted', raw);
    if (!allowed.includes(wanted)) throw fail('qq_recipient_not_allowed', raw);
    return wanted;
  }

 // ---- 出口：助手要说的字（只对主收件人）--------------------------------------
 // 防重复：助手用 qq_reply 说过的那句，出口这边两分钟内不再发一遍同样的字
 // （否则助手"说了一遍 + 又调了一次引用"就会在对方那儿看到两条一模一样的）。
  let lastQuoted = null;
  const flat = (value) => String(value ?? '').replace(/\s+/g, '');

 /**
 * 别让助手的话变成协议端的管理命令。
 *
 * 为什么：协议端 会把以 # / !. 这类前缀开头的文本**当成管理命令**执行（#sl、/clear
 * 这种可能是退群、清记录）。助手只是想说句话，不该因为句首一个符号就把整个群改了。
 * 做法：只在最前面插一个零宽空格 U+200B——协议端的命令匹配断在第一格就失效了，
 * 而屏幕上看起来一个字都没变。其余文本原样不动（标点、空格、换行都不改），
 * 所以助手说的还是助手说的。判断位置用 trimStart：' /clear' 也要拦。
 */
  const COMMAND_PREFIXES = Object.freeze(['#', '/', '!', '.', '＃', '／', '！', '．']);
  function sanitizeInboundCommand(text) {
    const raw = String(text ?? '');
    const first = raw.trimStart().charAt(0);
    if (first === '') return raw;
    return COMMAND_PREFIXES.includes(first) ? '\u200b' + raw : raw;
  }

  context.outbound('qq_send', async ({ text }) => {
    const speak = speakNow();
    const allowed = await allowedRecipients(speak);
    const to = pickPrimary(speak, allowed);
    if (to === null) return { ok: false, error: 'qq_no_recipients' };
    if (lastQuoted !== null && lastQuoted.to === to && Date.now() - lastQuoted.at < 120000
      && flat(text) !== '' && flat(text) === flat(lastQuoted.text)) {
      context.log('outbound skipped: the same words were just sent as a quoted reply');
      return { ok: true, error: null, messageId: lastQuoted.messageId, skipped: 'duplicate_of_quoted_reply' };
    }
    const response = await fetch(endpoint + '/send_private_msg', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        user_id: to,
 // 出口是助手说的每一句话，所以这里也要中和：助手句首那个 '#' 不是命令。
        message: [{ type: 'text', data: { text: sanitizeInboundCommand(text) } }],
        auto_escape: false,
      }),
      signal: AbortSignal.timeout(runtimeNow().onebotTimeoutMs),
    });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    const failed = body !== null && body.status === 'failed';
    const ok = response.ok && !failed;
    return {
      ok,
      error: ok ? null : 'onebot_' + response.status + (failed && body?.retcode !== undefined ? '_' + body.retcode : ''),
      messageId: body?.data?.message_id ?? null,
    };
  });

 // ---- 手：媒体段（图/语音/文件）怎么拼 --------------------------------------
 // 助手的容器跟 协议端 是两个容器，路径互相看不见。所以优先 base64（OneBot 的 base64://），
 // 只有助手明确给了 协议端 那侧能读到的路径/URL 时才原样传 file。
 // 助手自己房间里的一张图（web_image 拿下来的那种）：容器里的路径 协议端 读不到，
 // 所以这里自己读成字节再 base64 发出去。只认助手房间和插件数据目录里的文件——
 // 不给助手一条"随便读宿主任何文件再发出去"的路。
  // 助手的屋（home）和工作区是两个地方——做的在工作区，能发的只认屋，
 // 于是助手做出来的东西一张都发不出去（报 qq_media_path_not_allowed）。
 // 这里把工作区也列进来：助手能读、能写的地方，就能发出去。屋仍然是只读的（记录不该被沙箱改写），
 // 变的只是"出口够得着工作区"。
  function localImageRoots() {
    const roots = [];
    const home = typeof context.env.homeRoot === 'string' ? context.env.homeRoot : '';
    if (home !== '') roots.push(path.resolve(home));
    const declared = typeof context.env.workspaceRoot === 'string' ? context.env.workspaceRoot : '';
 // 宿主没显式给工作区时，按"屋的隔壁"推（<state>/home 的隔壁就是 <state>/workspace）。
    const workspace = declared !== ''
      ? declared
      : (home === '' ? '' : path.join(path.dirname(path.resolve(home)), 'workspace'));
    if (workspace !== '') roots.push(path.resolve(workspace));
    if (typeof context.dataDir === 'string' && context.dataDir !== '') roots.push(path.resolve(context.dataDir));
    return roots;
  }

  function localFileBytes(localPath) {
    const target = path.resolve(localPath);
    const allowed = localImageRoots().some((root) => target === root || target.startsWith(root + path.sep));
    if (!allowed) throw fail('qq_media_path_not_allowed', localPath);
    const info = statSync(target);
    if (!info.isFile()) throw fail('qq_media_path_not_file', localPath);
    const limit = runtimeNow().mediaMaxBytes;
    if (info.size > limit) throw fail('qq_media_too_large', info.size + ' > ' + limit);
    return readFileSync(target);
  }

 /**
 * 发之前先看这张图是不是完整的。
 *
 * 起因：助手下了半张 PNG（缺结尾），照样递上去，QQ 那边报
 * `highway upload error_code=921`，助手误以为"图太大"，猜了两轮。
 * 只看**结构有没有收尾**，不解码、不装图片库：
 * PNG 结尾必须有 IEND；JPEG 结尾必须有 FFD9；GIF 以 3B 收尾；
 * WEBP 的 RIFF 声明长度必须正好等于文件长度。
 * 认不出的格式一律放行——这里不是格式检查，只拦"半个文件"。
 */
  function looksWholeMedia(bytes) {
    if (bytes === null || typeof bytes !== 'object' || bytes.byteLength === undefined) return true;
    if (bytes.byteLength < 16) return false;
    const head = bytes.subarray(0, 12);
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
      const tail = bytes.subarray(bytes.byteLength - 8);
      return Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]).equals(Buffer.from(tail));
    }
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
      return bytes[bytes.byteLength - 2] === 0xff && bytes[bytes.byteLength - 1] === 0xd9;
    }
    if (head.subarray(0, 4).toString('latin1') === 'GIF8') return bytes[bytes.byteLength - 1] === 0x3b;
    if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') {
      const declared = head[4] | (head[5] << 8) | (head[6] << 16) | (head[7] << 24);
      return declared + 8 === bytes.byteLength;
    }
    return true;
  }

  function mediaSegment(kind, args) {
    const data = typeof args?.data === 'string' ? args.data.trim() : '';
    const file = typeof args?.file === 'string' ? args.file.trim() : '';
    const localPath = typeof args?.path === 'string' ? args.path.trim() : '';
    const given = (data !== '' ? 1 : 0) + (file !== '' ? 1 : 0) + (localPath !== '' ? 1 : 0);
    if (given > 1) throw fail('qq_media_ambiguous', 'data / file / path 只能给一个');
    if (localPath !== '') {
      const bytes = localFileBytes(localPath);
      const limit = runtimeNow().mediaMaxBytes;
      if (bytes.byteLength > limit) throw fail('qq_media_too_large', bytes.byteLength + ' > ' + limit);
 // 只拦"半个文件"：完整与否跟大小无关（助手那张 441 KB 是坏的，350 KB 的是好的）。
 // 真被拦下来了还有出路：把原图网址用 file 递过去，那条不经过这里。
      if (kind === 'image' && looksWholeMedia(bytes) !== true) throw fail('qq_media_truncated', localPath);
      return { type: kind, data: { file: 'base64://' + bytes.toString('base64') } };
    }
    if (data !== '' && file !== '') throw fail('qq_media_ambiguous', 'give either data or file, not both');
    if (data === '') {
      if (file === '') throw fail('qq_media_missing', 'needs data (base64) or file (path/URL)');
      return { type: kind, data: { file } };
    }
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(data)) throw fail('qq_media_not_base64');
    const bytes = base64Bytes(data.replace(/\s+/g, ''));
    const limit = runtimeNow().mediaMaxBytes;
    if (bytes > limit) throw fail('qq_media_too_large', bytes + ' > ' + limit);
    return { type: kind, data: { file: 'base64://' + data.replace(/\s+/g, '') } };
  }

  function messageId(value) {
    const text = String(value ?? '').trim();
 // 协议端的 message_id 是**有符号** 32 位整数，所以负号是合法的。
    if (!/^-?\d+$/.test(text)) throw fail('qq_invalid_message_id', text);
    return Number(text);
  }

  function requireText(value, code) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text === '') throw fail(code);
    return text;
  }

 // ---- 表情包 / 引用的底料 ---------------------------------------------------
 /** 这一段是不是"表情"：商城表情（mface）会被协议端转成带 emoji_id 的 image 段。 */
  function isStickerSegment(data) {
    if (data === null || typeof data !== 'object') return false;
    if (String(data.emoji_id ?? '').trim() !== '') return true;
    if (Number(data.sub_type) === 1) return true;
    return /表情/.test(String(data.summary ?? ''));
  }

  function stickerInboxFile(md5, ext) { return path.join(stickerDir, 'inbox', md5 + ext); }
  function stickerInboxMetaPath() { return path.join(stickerDir, 'inbox.json'); }

  function readStickerInbox() {
    try {
      const parsed = JSON.parse(readFileSync(stickerInboxMetaPath(), 'utf8'));
      if (Array.isArray(parsed?.items)) {
        return parsed.items.filter((item) => item !== null && typeof item === 'object' && typeof item.md5 === 'string');
      }
    } catch { /* 没有就是空的 */ }
    return [];
  }

  function writeStickerInbox(items) {
    mkdirSync(stickerDir, { recursive: true });
    writeFileSync(stickerInboxMetaPath(), JSON.stringify({ items }));
  }

 /**
 * 收到一张表情包：留一份在收件箱，等助手自己决定收不收。
 * 只留最新的 stickerInboxMax 张、stickerInboxKeepMs 之内——这是**收件箱**的规矩，
 * 进了图库的图在 QQ 那边，跟这里清不清无关。
 */
  function harvestSticker(image, data, event) {
    if (stickerEnabled === false) return null;
    const file = typeof image?.path === 'string' ? image.path : '';
    if (file === '') return null;
    let bytes;
    try { bytes = readFileSync(file); } catch { return null; }
    if (bytes.length === 0) return null;
    const md5 = createHash('md5').update(bytes).digest('hex');
    const ext = image.mediaType === 'image/png' ? '.png' : image.mediaType === 'image/jpeg' ? '.jpg'
      : image.mediaType === 'image/webp' ? '.webp' : '.gif';
    const items = readStickerInbox();
    if (items.some((item) => item.md5 === md5) === false) {
      try {
        mkdirSync(path.join(stickerDir, 'inbox'), { recursive: true });
        writeFileSync(stickerInboxFile(md5, ext), bytes);
      } catch { return null; }
      items.push({
        md5,
        ext,
        bytes: bytes.length,
        at: Date.now(),
        from: event?.user_id === undefined ? '' : String(event.user_id),
        messageId: event?.message_id === undefined ? '' : String(event.message_id),
        summary: String(data?.summary ?? ''),
      });
    }
    const cut = Date.now() - stickerInboxKeepMs;
    const kept = items.filter((item) => (Number.isFinite(item.at) ? item.at >= cut : true)).slice(-stickerInboxMax);
    for (const item of items) {
      if (kept.includes(item)) continue;
      try { unlinkSync(stickerInboxFile(item.md5, item.ext)); } catch { /* 下一轮再清 */ }
    }
    writeStickerInbox(kept);
    return md5;
  }

 /** 收进图库之后，收件箱里那份就没用了。 */
  function dropFromStickerInbox(md5) {
    const items = readStickerInbox();
    const keep = [];
    for (const item of items) {
      if (item.md5 === md5) { try { unlinkSync(stickerInboxFile(item.md5, item.ext)); } catch { /* 已经没了 */ } continue; }
      keep.push(item);
    }
    if (keep.length !== items.length) writeStickerInbox(keep);
  }

 // ---- 表情包的分类 / 标签-------------------------
 // 协议端只给一个 desc（收藏表情的备注，原样存取，中文和 # 都不变形），
 // 没有分类字段。所以分类就写进备注： 名字 #分类 #标签 #标签
 // - 第一个 # 后面那段 = 分类，其余 = 标签
 // - 名字/标签里的 # 换成全角＃（不然读回来就分不开）
 // - 整条备注卡在 60 字以内，装不下的标签宁可丢掉也不截断半截
  const STICKER_DESC_MAX = 60;

  function stickerClean(value) {
    return String(value ?? '').replace(/#/g, '＃').replace(/\s+/g, ' ').trim();
  }

 /** "猫猫 #可爱 #橘" → { name:'猫猫', tags:['可爱','橘'], category:'可爱' } */
  function parseStickerMeta(desc) {
    const raw = String(desc ?? '').trim();
    if (raw === '') return { name: '', tags: [], category: '' };
    const pieces = raw.split('#');
    const name = pieces.shift().trim();
    const tags = [];
    for (const piece of pieces) {
      const tag = piece.trim();
      if (tag !== '' && tags.includes(tag) === false) tags.push(tag);
    }
    return { name, tags, category: tags.length > 0 ? tags[0] : '' };
  }

  function buildStickerDesc(name, tags) {
    const cleanName = stickerClean(name).slice(0, STICKER_DESC_MAX);
    const list = [];
    for (const raw of Array.isArray(tags) ? tags : []) {
      const tag = stickerClean(raw);
      if (tag === '' || list.includes(tag)) continue;
      list.push(tag);
    }
    let desc = cleanName;
    for (const tag of list) {
      const next = desc === '' ? '#' + tag : desc + ' #' + tag;
      if (next.length > STICKER_DESC_MAX) break;
      desc = next;
    }
    return desc;
  }

 /** 搜索：名字和标签都算；分类要完全对得上（分类是助手自己分的，不做模糊）。 */
  function matchFaceQuery(face, query, category) {
    if (category !== '') {
      const want = category.toLowerCase();
      if (face.tags.some((tag) => tag.toLowerCase() === want) === false) return false;
    }
    if (query !== '') {
      const q = query.toLowerCase();
      if ((face.name + ' ' + face.tags.join(' ')).toLowerCase().includes(q) === false) return false;
    }
    return true;
  }

  function categorySummary(faces) {
    const counts = new Map();
    for (const face of faces) {
      const key = face.category === '' ? '未分类' : face.category;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].map(([key, n]) => key + ' ' + n).join(' / ');
  }

 /** 图库 = QQ 收藏表情。读一次就是"助手现在有什么"。 */
  async function customFaces(count) {
    const body = await onebot('fetch_custom_face_detail', { count });
    const rows = Array.isArray(body?.data) ? body.data : [];
    const out = [];
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue;
      const id = String(row.emoji_id ?? '').trim();
      if (id === '') continue;
      const meta = parseStickerMeta(row.desc);
      out.push({
        id,
        url: String(row.url ?? '').trim(),
        md5: String(row.md5 ?? '').trim().toLowerCase(),
        name: meta.name,
        tags: meta.tags,
        category: meta.category,
      });
    }
    return out;
  }

 /** 名字 / 完整 id / md5 / id 里那串摘要（前 8 位也行）都能点到同一张。 */
  function matchFace(faces, key) {
    const raw = String(key ?? '').trim();
    if (raw === '') return null;
    const lower = raw.toLowerCase();
    return faces.find((face) => face.id === raw)
      ?? faces.find((face) => face.name !== '' && face.name === raw)
      ?? faces.find((face) => face.md5 !== '' && face.md5 === lower)
      ?? faces.find((face) => face.tags.some((tag) => tag.toLowerCase() === lower))
      ?? faces.find((face) => face.md5 !== '' && face.md5.startsWith(lower))
      ?? null;
  }

  function faceLabel(face) {
    const name = face.name === '' ? '无名' : face.name;
    return face.md5 === '' ? name : name + '（' + face.md5.slice(0, 8) + '）';
  }

 /** 这张图能不能当表情包：认图、BMP 转 PNG、超过 stickerMaxBytes 直接说清楚。 */
  function stickerBytes(bytes) {
    if (bytes.length === 0) throw fail('qq_sticker_empty', 'empty file');
    if (bytes.length > stickerMaxBytes) throw fail('qq_sticker_too_large', bytes.length + ' > ' + stickerMaxBytes);
    let mediaType = sniffImage(bytes);
    if (mediaType === null) throw fail('qq_sticker_not_image', 'not a picture');
    if (mediaType === 'image/bmp') {
      const png = bmpToPng(bytes);
      if (png === null) throw fail('qq_sticker_bmp_variant', 'bmp variant');
      return { bytes: png, mediaType: 'image/png' };
    }
    if (IMAGE_PASS.includes(mediaType) === false) throw fail('qq_sticker_format', mediaType);
    return { bytes, mediaType };
  }

  async function downloadSticker(url) {
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(imageTimeoutMs) });
    } catch (error) {
      throw fail('qq_sticker_fetch_failed', String((error && (error.name || error.message)) || error));
    }
    if (response.ok === false) throw fail('qq_sticker_fetch_http_' + response.status, url.slice(0, 120));
    return Buffer.from(await response.arrayBuffer());
  }

 /** 一条消息里的图 → 字节（别人的表情包就这么进来）。 */
  async function stickerFromMessage(id) {
    const body = await onebot('get_msg', { message_id: messageId(id) });
    const segments = Array.isArray(body?.data?.message) ? body.data.message : [];
    for (const segment of segments) {
      if (segment === null || typeof segment !== 'object' || segment.type !== 'image') continue;
      const url = String(segment.data?.url ?? '').trim();
      if (url !== '') return stickerBytes(await downloadSticker(url));
    }
    throw fail('qq_sticker_no_image', 'that message has no picture');
  }

 /** 收件箱里那张（不给号就是最近一张）。 */
  function stickerFromInbox(handle) {
    const items = readStickerInbox();
    if (items.length === 0) throw fail('qq_sticker_inbox_empty');
    const raw = String(handle ?? '').trim().toLowerCase();
    const pick = raw === ''
      ? items[items.length - 1]
      : (items.find((item) => item.md5 === raw) ?? items.find((item) => item.md5.startsWith(raw)));
    if (pick === undefined) throw fail('qq_sticker_not_in_inbox', raw);
    let bytes;
    try { bytes = readFileSync(stickerInboxFile(pick.md5, pick.ext)); } catch { throw fail('qq_sticker_inbox_gone', pick.md5); }
    return stickerBytes(bytes);
  }

 /**
 * file 那条路：助手给的位置可能是屋里的相对路径（inbox/img-x.jpg），也可能是绝对路径。
 * 以前这里直接 readFileSync —— 相对路径一律 ENOENT（qq_sticker_file_unreadable），
 * 而绝对路径又等于"宿主任何文件都能读成表情再发出去"。两个毛病一起修：
 * 先按屋/工作区拼，再统一过 localFileBytes 的白名单。
 */
  function stickerLocalBytes(file) {
    const candidates = [];
    if (path.isAbsolute(file)) {
      candidates.push(file);
    } else {
      const home = typeof context.env.homeRoot === 'string' && context.env.homeRoot !== '' ? context.env.homeRoot : '';
      if (home !== '') candidates.push(path.join(home, file));
      const workspace = typeof context.env.workspaceRoot === 'string' && context.env.workspaceRoot !== '' ? context.env.workspaceRoot : '';
      if (workspace !== '') candidates.push(path.join(workspace, file));
      candidates.push(file);
    }
    let last = null;
    for (const candidate of candidates) {
      try { return localFileBytes(candidate); } catch (error) { last = error; }
    }
    throw last ?? fail('qq_sticker_file_unreadable', file.slice(0, 160));
  }

 /** data / file / fromMessage / incoming 四选一。 */
  async function stickerSource(args) {
    const data = typeof args?.data === 'string' ? args.data.trim() : '';
    const file = typeof args?.file === 'string' ? args.file.trim() : '';
    const fromMessage = args?.fromMessage === undefined || args?.fromMessage === null ? '' : String(args.fromMessage).trim();
    const incoming = typeof args?.incoming === 'string' ? args.incoming.trim() : '';
    const given = [data, file, fromMessage, incoming].filter((value) => value !== '').length;
    if (given > 1) throw fail('qq_sticker_ambiguous', 'give one of data / file / fromMessage / incoming');
    if (incoming !== '') return stickerFromInbox(incoming);
    if (fromMessage !== '') return stickerFromMessage(fromMessage);
    if (data === '') {
      if (file === '') return stickerFromInbox('');
      if (/^https?:\/\//i.test(file)) return stickerBytes(await downloadSticker(file));
      let bytes;
      try {
        bytes = stickerLocalBytes(file);
      } catch (error) {
        const code = error !== null && typeof error === 'object' ? String(error.code ?? '') : '';
        if (code === 'qq_media_path_not_allowed' || code === 'qq_media_path_not_file' || code === 'qq_media_too_large') throw error;
        throw fail('qq_sticker_file_unreadable', file.slice(0, 160));
      }
      return stickerBytes(bytes);
    }
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(data)) throw fail('qq_sticker_not_base64');
    return stickerBytes(Buffer.from(data.replace(/\s+/g, ''), 'base64'));
  }

 /** 这条 message_id 协议端还认不认（引用发之前先问一句）。 */
  async function messageExists(id) {
    try {
      const body = await onebot('get_msg', { message_id: Number(id) });
      return body?.data !== null && body?.data !== undefined;
    } catch {
      return false;
    }
  }

 // 助手最近收到的那条（引用默认指向它）。只记一条，够用且不会替助手记住一整本聊天记录。
  let lastInbound = null;

 /**
 * 媒体上传重试：
 * QQ 的图/语音走 highway 上传，偶发返回 error_code=9xx。
 * 这类失败可能是瞬时的，所以重试一次；参数错（不是 9xx）重试没有意义。
 * 还是失败就抛一个助手自己看得懂的话，别让助手猜"是不是图太大"。
 */
  async function mediaCall(action, payload) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await onebot(action, payload);
      } catch (error) {
        lastError = error;
        const code = String(error?.code ?? '');
        const detail = String(error?.message ?? '');
        const retriable = code.startsWith('onebot_') && /highway upload|error_code=9\d\d/i.test(detail);
        if (retriable === false || attempt === 1) break;
        await new Promise((resolve) => { const timer = setTimeout(resolve, 800); if (typeof timer.unref === 'function') timer.unref(); });
      }
    }
    const detail = String(lastError?.message ?? '');
    if (/highway upload/i.test(detail)) {
      throw fail('qq_media_upload_failed', 'QQ 那边没传上去（' + detail.slice(0, 160) + '）——换成 jpg 或者压小一点再发');
    }
    throw lastError;
  }

 // ---- 手 1：发图 ------------------------------------------------------------
  context.tool('qq_send_image', {
    description: '把一张图片发到 QQ 私聊。data 是图片的 base64；path 是助手自己房间里的图片路径'
      + '（web_image 拿下来的那种，推荐）；file 是协议端能读到的路径或 URL（助手容器里的路径它读不到）。'
      + '最好带上一句话 caption。to 可选：要给名单里的谁（不填就是主收件人）。',
    parameters: {
      type: 'object',
      properties: {
        data: { type: 'string', description: '图片的 base64（不带 data: 前缀）' },
        path: { type: 'string', description: '或者：助手自己房间里的图片路径（如 <房间>/web/xxx.jpg）' },
        file: { type: 'string', description: '或者：协议端能读到的路径/URL' },
        caption: { type: 'string', description: '跟在图片后面的一句话，可省略' },
        asSticker: { type: 'boolean', description: '当成表情包发：同一张图，QQ 里显示成表情（不进图库，想留着以后用走 qq_sticker_save）' },
        group: { type: 'string', description: '发到哪个群（必须是助手会听的群），可省略' },
        to: { type: 'string', description: '收件人 QQ 号，只在多选/反选模式下有效，可省略' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const groupId = String(args?.group ?? '').trim();
      const toGroup = groupId !== '';
      if (toGroup) {
        if (!/^\d+$/.test(groupId)) throw fail('qq_invalid_group', groupId);
        if (groupAllowed(groupId) === false) throw fail('qq_group_not_allowed', groupId);
      }
      const to = toGroup ? null : await target(args);
      const segment = mediaSegment('image', args);
      if (args?.asSticker === true) {
        segment.data.sub_type = 1;
        segment.data.summary = STICKER_SUMMARY;
      }
      const message = [segment];
      const caption = typeof args?.caption === 'string' ? args.caption.trim() : '';
      if (caption !== '') message.push({ type: 'text', data: { text: caption } });
 // 带图的这条走重试版：highway 上传偶发 9xx，重试一次通常就过。
      const body = await mediaCall(toGroup ? 'send_group_msg' : 'send_private_msg', {
        ...(toGroup ? { group_id: Number(groupId) } : { user_id: to }),
        message,
        auto_escape: false,
      });
      const id = body?.data?.message_id;
      return (toGroup ? '图发到群 ' + groupId + ' 了' : '图发出去了') + (id === undefined ? '' : '（message_id ' + String(id) + '）');
    },
  });

 // ---- 手 1b：引用回复 ------------------------------------------------------
  context.tool('qq_reply', {
    description: '把一句话作为「引用回复」发到 QQ 私聊：先挂上对方（或助手）那条原消息，再跟你的话。'
      + '不给 messageId 就引用你最近收到的那条（' + Math.round(replyWindowMs / 60000) + ' 分钟内有效）。'
      + 'text 就是这句话本身——用了它，别再在回复正文里把同样的话重复一遍。to 可选。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '你要说的话' },
        messageId: { type: 'string', description: '要引用哪条消息（默认：最近收到的那条）' },
        to: { type: 'string', description: '收件人 QQ 号，只在多选/反选模式下有效，可省略' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(args) {
      const to = await target(args);
      const said = requireText(args?.text, 'qq_reply_text_missing');
      if (said.length > replyMaxChars) throw fail('qq_reply_too_long', said.length + ' > ' + replyMaxChars);
      let quotedId = '';
      let quotedPreview = '';
      if (args?.messageId !== undefined && args?.messageId !== null && String(args.messageId).trim() !== '') {
        quotedId = String(messageId(args.messageId));
      } else if (lastInbound !== null && Date.now() - lastInbound.at <= replyWindowMs) {
        quotedId = lastInbound.messageId;
        quotedPreview = lastInbound.preview;
      }
      const message = [];
      let note = '';
      if (quotedId !== '') {
        if (await messageExists(quotedId)) message.push({ type: 'reply', data: { id: quotedId } });
        else note = '（这句引用的那条协议端不认，已经当普通消息发出去了）';
      } else {
        note = '（没有可引用的消息，已经当普通消息发出去了）';
      }
 // 引用段之后才是助手的话；这里中和的只是"这段话不能以命令前缀开头"。
      message.push({ type: 'text', data: { text: sanitizeInboundCommand(said) } });
      const body = await onebot('send_private_msg', { user_id: to, message, auto_escape: false });
      const id = body?.data?.message_id;
      const head = message.length > 1
        ? '引用回复发出去了' + (quotedPreview === '' ? '' : '（引的是「' + quotedPreview + '」）')
        : '发出去了一句';
      lastQuoted = { text: said, at: Date.now(), to, messageId: id === undefined ? null : id };
      return head + note + (id === undefined ? '' : '（message_id ' + String(id) + '）');
    },
  });

 // ---- 手 1c：表情包图库 ----------------------------------------------------
  context.tool('qq_sticker_save', {
    description: '把一张图收进你自己的表情包图库（QQ 的「收藏表情」）。普通图片走这条就能变成表情包，收进去以后能反复发。'
      + '四个来源选一个：data 给 base64；file 给图片的路径或 URL；fromMessage 给一条消息的 message_id（那里面那张图）；'
      + 'incoming 给收件箱里的号（别人发给你的表情包，见 qq_sticker_list source=inbox）——四个都不给就是收件箱里最近那张。'
      + 'name 是名字，category 是分类（以后 qq_sticker_list category=… 就按它筛），tags 是自由标签（搜索也能搜到）。'
      + '这些文字写在收藏表情的备注里（60 字以内，装不下的标签会丢），同一张图重复收会被认出来，不会存两份。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '给它起的名字（之后发的时候就靠这个名）' },
        category: { type: 'string', description: '分类，例如 可爱 / 日常 / 猫' },
        tags: { type: 'array', items: { type: 'string' }, description: '附加标签，可省略' },
        data: { type: 'string', description: '图片 base64（不带 data: 前缀）' },
        file: { type: 'string', description: '图片位置：屋里的相对路径（例如 inbox/a.jpg）或 http(s) URL' },
        fromMessage: { type: 'string', description: '从这条消息里取图' },
        incoming: { type: 'string', description: '收件箱里的号（md5 前几位就够）' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      if (stickerEnabled === false) throw fail('qq_sticker_disabled');
      const name = typeof args?.name === 'string' ? args.name.trim() : '';
      if (name.length > 40) throw fail('qq_sticker_name_too_long', name.length + ' > 40');
      const category = String(args?.category ?? '').trim();
      const tags = [category, ...(Array.isArray(args?.tags) ? args.tags : [])];
      const picture = await stickerSource(args);
      const md5 = createHash('md5').update(picture.bytes).digest('hex');
      const faces = await customFaces(stickerListMax);
      const same = faces.find((face) => face.md5 === md5);
      if (same !== undefined) {
        let relabelled = false;
        if (name !== '' || category !== '' || tags.length > 1) {
          const desc = buildStickerDesc(name === '' ? same.name : name, tags.length > 1 ? tags : same.tags);
          if (desc !== '' && desc !== (same.name + (same.tags.length > 0 ? ' #' + same.tags.join(' #') : ''))) {
            await onebot('modify_custom_face', { emoji_id: same.id, desc });
            relabelled = true;
          }
        }
        dropFromStickerInbox(md5);
        return '库里已经有这张了：' + faceLabel(same) + (relabelled ? '（名字/分类改成了「' + buildStickerDesc(name === '' ? same.name : name, tags.length > 1 ? tags : same.tags) + '」）' : '');
      }
      const added = await onebot('add_custom_face', { file: 'base64://' + picture.bytes.toString('base64') });
      const emojiId = String(added?.data?.emoji_id ?? '').trim();
      if (emojiId === '') throw fail('qq_sticker_add_failed', '协议端没给 emoji_id');
      const desc = buildStickerDesc(name, tags);
      let note = '';
      if (desc !== '') {
        try { await onebot('modify_custom_face', { emoji_id: emojiId, desc }); }
        catch (error) { note = '（名字/分类没写进去：' + String((error && (error.code || error.message)) || error) + '）'; }
      }
      dropFromStickerInbox(md5);
      const shown = name === '' ? '（还没起名字）' : name + (category === '' ? '' : '【' + category + '】');
      return '收进图库了：' + shown + '，' + picture.bytes.length + ' 字节' + note;
    },
  });

  context.tool('qq_sticker_send', {
    description: '从你的表情包图库发一张出去（按 QQ 表情的样子显示，不是普通图片）。sticker 给名字、md5 或 id 都行。'
      + 'text 可以跟一句话（贴图 + 一句话是同一条消息），replyTo 给 message_id 就同时挂上引用。'
      + '发给谁：group 给群号就发群里（只能发助手会听的群），否则发给名单里的人（to 可选，默认主收件人）。',
    parameters: {
      type: 'object',
      properties: {
        sticker: { type: 'string', description: '图库里的名字 / md5 / id / 标签' },
        text: { type: 'string', description: '跟在这张贴图后面的那句话，可省略' },
        replyTo: { type: 'string', description: '要引用哪条消息，可省略' },
        group: { type: 'string', description: '发到哪个群（必须是助手会听的群）' },
        to: { type: 'string', description: '收件人 QQ 号，只在多选/反选模式下有效，可省略' },
      },
      required: ['sticker'],
      additionalProperties: false,
    },
    async execute(args) {
      if (stickerEnabled === false) throw fail('qq_sticker_disabled');
      const groupId = String(args?.group ?? '').trim();
      const toGroup = groupId !== '';
      if (toGroup) {
        if (!/^\d+$/.test(groupId)) throw fail('qq_invalid_group', groupId);
        if (groupAllowed(groupId) === false) throw fail('qq_group_not_allowed', groupId);
      }
 // 发群里就不问私聊收件人；发私聊才走名单。两套都是同一个白名单口径。
      const to = toGroup ? null : await target(args);
      const where = toGroup ? { group_id: Number(groupId) } : {};
      const headText = toGroup ? '贴图发到群 ' + groupId + ' 了：' : '贴图发出去了：';
      const key = requireText(args?.sticker, 'qq_sticker_key_missing');
      const text = typeof args?.text === 'string' ? args.text.trim() : '';
      if (text.length > replyMaxChars) throw fail('qq_sticker_text_too_long', text.length + ' > ' + replyMaxChars);
      const faces = await customFaces(stickerListMax);
      const face = matchFace(faces, key);
      if (face === null) throw fail('qq_sticker_not_found', key + '（先用 qq_sticker_list 看看图库里有什么）');
      let replyId = '';
      if (args?.replyTo !== undefined && args?.replyTo !== null && String(args.replyTo).trim() !== '') {
        replyId = String(messageId(args.replyTo));
      }
      const message = [];
      if (replyId !== '' && (await messageExists(replyId))) message.push({ type: 'reply', data: { id: replyId } });
      if (text !== '') message.push({ type: 'text', data: { text } });
      if (face.url === '') {
        if (text !== '') throw fail('qq_sticker_no_url', '协议端没给这张的地址，带话发不了');
        const body = await onebot('send_custom_face', {
          ...where,
          ...(toGroup ? {} : { user_id: to }),
          emoji_id: face.id,
          ...(replyId === '' ? {} : { reply_to: Number(replyId) }),
        });
        const id = body?.data?.message_id;
        return headText + faceLabel(face) + (id === undefined ? '' : '（message_id ' + String(id) + '）');
      }
      message.push({ type: 'image', data: { file: face.url, sub_type: 1, summary: STICKER_SUMMARY } });
      let body;
      try {
        body = await onebot(toGroup ? 'send_group_msg' : 'send_private_msg', {
          ...where,
          ...(toGroup ? {} : { user_id: to }),
          message,
          auto_escape: false,
        });
      } catch (error) {
 // 图 + 话拼在一条消息里失败（比如协议端不肯按 URL 取图）时，退回原生"发收藏表情"：
 // 贴图发得出去，那句话得助手自己另说——回执里就这么写，不假装成功。
        const code = String((error && error.code) || '');
        if (text === '' || code.startsWith('onebot_') === false) throw error;
        body = await onebot('send_custom_face', {
          ...where,
          ...(toGroup ? {} : { user_id: to }),
          emoji_id: face.id,
          ...(replyId === '' ? {} : { reply_to: Number(replyId) }),
        });
        const fallbackId = body?.data?.message_id;
        return headText + faceLabel(face) + '，但那句话没跟上去（协议端收不下"图+字"那条）'
          + (fallbackId === undefined ? '' : '（message_id ' + String(fallbackId) + '）');
      }
      const id = body?.data?.message_id;
      return headText + faceLabel(face) + (id === undefined ? '' : '（message_id ' + String(id) + '）');
    },
  });

  context.tool('qq_sticker_list', {
    description: '看看你的表情包：source=library（默认）列图库里有什么——名字、【分类】、md5 前 8 位，以及分类统计；'
      + 'query 按名字/标签搜，category 只看某一类。'
      + 'source=inbox 列别人发给你、你还没收下的那几张（带号、来自谁、什么时候）。',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['library', 'inbox'], description: '看哪边，默认 library' },
        query: { type: 'string', description: '搜索词：名字或标签里有这几个字就算' },
        category: { type: 'string', description: '只看这一类（分类就是第一个标签）' },
        count: { type: 'integer', description: '最多列几张，默认 20' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      if (stickerEnabled === false) throw fail('qq_sticker_disabled');
      const source = String(args?.source ?? 'library').trim().toLowerCase();
      const want = Number.isInteger(args?.count) && args.count > 0 ? Math.min(args.count, stickerListMax) : 20;
      const inbox = readStickerInbox();
      if (source === 'inbox') {
        if (inbox.length === 0) return '收件箱是空的（还没有人发过表情包给你）。';
        const lines = inbox.slice(-want).map((item) => '#'
          + item.md5.slice(0, 8) + '  ' + (item.from === '' ? '某人' : item.from)
          + '  ' + clockFull(Math.floor((Number.isFinite(item.at) ? item.at : Date.now()) / 1000))
          + '  ' + sizeLabel(item.bytes));
        return '收件箱里有 ' + inbox.length + ' 张（还没收进图库）：\n' + lines.join('\n')
          + '\n想留下哪张就说名字用 qq_sticker_save（incoming 填 # 后面那串）。';
      }
      const faces = await customFaces(stickerListMax);
      if (faces.length === 0) {
        return '图库还是空的。收一张：qq_sticker_save（图 + 名字 + category）。'
          + (inbox.length === 0 ? '' : '收件箱里还有 ' + inbox.length + ' 张等你决定。');
      }
      const query = String(args?.query ?? '').trim();
      const category = String(args?.category ?? '').trim();
      const shown = faces.filter((face) => matchFaceQuery(face, query, category));
      const head = query === '' && category === ''
        ? '图库里有 ' + faces.length + ' 张（' + categorySummary(faces) + '）：'
        : '按「' + (query !== '' ? query : '') + (category !== '' ? (query !== '' ? ' + ' : '') + '分类 ' + category : '')
          + '」在图库 ' + faces.length + ' 张里找到 ' + shown.length + ' 张：';
      if (shown.length === 0) return head + '\n（一张都没找到）';
      const lines = shown.slice(0, want).map((face, index) => (index + 1) + '. ' + faceLabel(face)
        + (face.category === '' ? '' : '【' + face.category + '】'));
      const more = shown.length > want ? '\n…还有 ' + (shown.length - want) + ' 张没列（count 可以调大）' : '';
      return head + '\n' + lines.join('\n') + more
        + (inbox.length === 0 ? '' : '\n收件箱里另有 ' + inbox.length + ' 张没入库（source=inbox 看）。');
    },
  });

  context.tool('qq_sticker_rename', {
    description: '改图库里一张表情包的名字 / 分类 / 标签（QQ 收藏表情的备注）。sticker 给现在的名字 / md5 / id；'
      + 'name、category、tags 至少给一个，没给的那几项保持原样。',
    parameters: {
      type: 'object',
      properties: {
        sticker: { type: 'string', description: '现在怎么找到它（名字 / md5 / id / 标签）' },
        name: { type: 'string', description: '新名字，可省略' },
        category: { type: 'string', description: '新分类（就是第一个标签），可省略' },
        tags: { type: 'array', items: { type: 'string' }, description: '换掉全部标签（category 会放在第一个），可省略' },
      },
      required: ['sticker'],
      additionalProperties: false,
    },
    async execute(args) {
      if (stickerEnabled === false) throw fail('qq_sticker_disabled');
      const key = requireText(args?.sticker, 'qq_sticker_key_missing');
      const name = typeof args?.name === 'string' ? args.name.trim() : '';
      const category = typeof args?.category === 'string' ? args.category.trim() : '';
      const hasTags = Array.isArray(args?.tags);
      if (name === '' && category === '' && hasTags === false) throw fail('qq_sticker_nothing_to_change');
      if (name.length > 40) throw fail('qq_sticker_name_too_long', name.length + ' > 40');
      const faces = await customFaces(stickerListMax);
      const face = matchFace(faces, key);
      if (face === null) throw fail('qq_sticker_not_found', key);
      const nextName = name === '' ? face.name : name;
      const nextTags = hasTags
        ? [category, ...args.tags]
        : (category === '' ? face.tags : [category, ...face.tags.slice(1)]);
      const desc = buildStickerDesc(nextName, nextTags);
      await onebot('modify_custom_face', { emoji_id: face.id, desc });
      return '改好了：' + faceLabel(face) + ' → ' + (desc === '' ? '（空）' : desc);
    },
  });

  context.tool('qq_sticker_remove', {
    description: '把一张表情包从图库里删掉（QQ 收藏表情里的那张也一起没了，删了就找不回来）。sticker 给名字 / md5 / id。',
    parameters: {
      type: 'object',
      properties: { sticker: { type: 'string', description: '要删哪张（名字 / md5 / id）' } },
      required: ['sticker'],
      additionalProperties: false,
    },
    async execute(args) {
      if (stickerEnabled === false) throw fail('qq_sticker_disabled');
      const key = requireText(args?.sticker, 'qq_sticker_key_missing');
      const faces = await customFaces(stickerListMax);
      const face = matchFace(faces, key);
      if (face === null) throw fail('qq_sticker_not_found', key);
      await onebot('delete_custom_face', { emoji_id: face.id });
      return '从图库里删了：' + faceLabel(face);
    },
  });

 // ---- 手 2：发语音 ----------------------------------------------------------
  context.tool('qq_send_voice', {
    description: '发一条语音到 QQ。data 是语音文件的 base64（QQ 认 silk/amr，wav/mp3 要看协议端能不能转）；'
      + 'file 是协议端能读到的路径/URL。group 给了就发到那个群，不给就发私聊；to 只在私聊时有效。',
    parameters: {
      type: 'object',
      properties: {
        data: { type: 'string', description: '语音文件 base64（不带 data: 前缀）' },
        file: { type: 'string', description: '或者：协议端能读到的路径/URL' },
        group: { type: 'string', description: '发到哪个群（群号），可省略' },
        to: { type: 'string', description: '收件人 QQ 号，只在多选/反选模式下有效，可省略' },
      },
      additionalProperties: false,
    },
    async execute(args) {
 // 助手不止一次把"想说一句话"塞进来（text/preset），然后卡在 qq_media_missing 上反复重试
 // 。缺内容时直接把正确的那个手点名。
      const hasMedia = (typeof args?.data === 'string' && args.data.trim() !== '')
        || (typeof args?.file === 'string' && args.file.trim() !== '')
        || (typeof args?.path === 'string' && args.path.trim() !== '');
      if (!hasMedia) {
        throw fail('qq_media_missing', 'qq_send_voice 只发手里已有的音频文件（data 或 file）；'
          + '想让助手用自己的声音说一句话，用 qq_voice（text → 引擎 → 语音）');
      }
      const groupId = optionalGroup(args);
      if (groupId !== '') {
        const body = await groupCall('send_group_msg', {
          group_id: Number(groupId), message: [mediaSegment('record', args)], auto_escape: false,
        });
        const id = body?.data?.message_id;
        return '语音发到群 ' + groupId + ' 了' + (id === undefined ? '' : '（message_id ' + String(id) + '）');
      }
      const to = await target(args);
      const body = await onebot('send_private_msg', {
        user_id: to, message: [mediaSegment('record', args)], auto_escape: false,
      });
      const id = body?.data?.message_id;
      return '语音发出去了' + (id === undefined ? '' : '（message_id ' + String(id) + '）');
    },
  });

 // ---- 手 2b：用自己的声音说话（文字 → TTS 引擎 → QQ 语音）--------------------
 // 和 qq_send_voice 的区别：那个是助手手上已经有一个音频文件；这个是助手只给一句话。
  context.tool('qq_voice', {
    description: '用助手自己的声音说一句话：把文字交给配置的 TTS 端点合成整包 WAV，再当成 QQ 语音发出去。'
      + 'text 是你要说的话（口语、短句，240 字以内，越长越慢）。preset 可选情绪：'
      + Object.keys(voicePresets).join(' / ')
      + '（默认 ' + voicePresetDefault + '）。group 给了就说到那个群，不给就发私聊；'
      + '想让语气被听见就用这个；用了它就别再把同样的话用文字发一遍。to 可选。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要说的话（口语、短句，240 字以内）' },
        preset: {
          type: 'string',
          enum: Object.keys(voicePresets),
          description: '情绪/语气，默认 ' + voicePresetDefault,
        },
        group: { type: 'string', description: '发到哪个群（群号），可省略；不给就发私聊' },
        to: { type: 'string', description: '收件人 QQ 号，只在多选/反选模式下有效，可省略' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(args) {
 // 群：以前这条只会发私聊，助手想在群里开口时只能去调 qq_send_voice，
 // 而那个吃的是"手里已有的音频文件"→ 一路 qq_media_missing。现在群里也走这条路。
      const groupId = optionalGroup(args);
      const text = requireText(args?.text, 'qq_voice_text_missing').replace(/\s+/g, ' ');
      const preset = typeof args?.preset === 'string' && args.preset.trim() !== '' ? args.preset.trim() : voicePresetDefault;
      const audio = await synthesiseVoice(text, preset);
      const segment = { type: 'record', data: { file: 'base64://' + audio.bytes.toString('base64') } };
      const body = groupId !== ''
        ? await groupCall('send_group_msg', { group_id: Number(groupId), message: [segment], auto_escape: false })
        : await onebot('send_private_msg', { user_id: await target(args), message: [segment], auto_escape: false });
      const id = body?.data?.message_id;
      const seconds = audio.seconds > 0 ? '，' + audio.seconds.toFixed(1) + ' 秒' : '';
      const where = groupId !== '' ? '语音发到群 ' + groupId + ' 了' : '语音发出去了';
      return where + '（' + audio.bytes.length + ' 字节' + seconds
        + (id === undefined ? '' : '，message_id ' + String(id)) + '）';
    },
  });

 // ---- 手 3：发文件 ----------------------------------------------------------
  context.tool('qq_send_file', {
    description: '把一个文件发到 QQ。name 是对方看到的文件名；data 是文件 base64（推荐），'
      + 'file 是协议端能读到的路径/URL，path 是我自己这边（屋或工作区）的一个文件路径。'
      + 'group 给了就传群文件，不给就发私聊；to 只在私聊时有效。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '文件名，例如 note.txt' },
        data: { type: 'string', description: '文件内容的 base64（不带 data: 前缀）' },
        file: { type: 'string', description: '或者：协议端能读到的路径/URL' },
        path: { type: 'string', description: '或者：我自己这边（屋或工作区）的一个文件路径，我读了发出去' },
        group: { type: 'string', description: '传到哪个群（群号），可省略' },
        to: { type: 'string', description: '收件人 QQ 号，只在多选/反选模式下有效，可省略' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async execute(args) {
      const groupId = optionalGroup(args);
      const name = requireText(args?.name, 'qq_file_name_missing');
      const data = typeof args?.data === 'string' ? args.data.trim() : '';
      const file = typeof args?.file === 'string' ? args.file.trim() : '';
      const localPath = typeof args?.path === 'string' ? args.path.trim() : '';
      const given = (data !== '' ? 1 : 0) + (file !== '' ? 1 : 0) + (localPath !== '' ? 1 : 0);
      if (given > 1) throw fail('qq_media_ambiguous', 'data / file / path 只能给一个');
 // 群文件走另一条 OneBot 动作（upload_group_file），参数名也不同，所以先在这里分叉。
 // 助手和协议端是两个容器，路径互相看不见——递绝对路径过去它只会读到 ENOENT，
 // 所以本地文件一律读成字节、用 base64:// 递（和媒体段同一条理由）。
      if (groupId !== '') {
        let groupSource = file;
        if (localPath !== '') {
 // 同上：两个容器看不到彼此的路径，助手自己盘上的文件必须读成字节再递。
          groupSource = 'base64://' + localFileBytes(localPath).toString('base64');
        }
        if (data !== '') {
          if (!/^[A-Za-z0-9+/=\r\n]+$/.test(data)) throw fail('qq_media_not_base64');
          const bytes = base64Bytes(data.replace(/\s+/g, ''));
          const limit = runtimeNow().mediaMaxBytes;
          if (bytes > limit) throw fail('qq_media_too_large', bytes + ' > ' + limit);
          groupSource = 'base64://' + data.replace(/\s+/g, '');
        }
        if (groupSource === '') throw fail('qq_media_missing');
        await groupCall('upload_group_file', { group_id: Number(groupId), file: groupSource, name });
        return '文件「' + name + '」发到群 ' + groupId + ' 了';
      }
      const to = await target(args);
      let source = file;
      if (localPath !== '') {
 // 助手自己盘上的文件：读成字节再按 base64 递过去（和 data 那条路同一个出口）。
        source = 'base64://' + localFileBytes(localPath).toString('base64');
      }
      if (data !== '') {
        if (!/^[A-Za-z0-9+/=\r\n]+$/.test(data)) throw fail('qq_media_not_base64');
        const bytes = base64Bytes(data.replace(/\s+/g, ''));
        const limit = runtimeNow().mediaMaxBytes;
        if (bytes > limit) throw fail('qq_media_too_large', bytes + ' > ' + limit);
        source = 'base64://' + data.replace(/\s+/g, '');
      }
      if (source === '') throw fail('qq_media_missing');
      await onebot('upload_private_file', { user_id: to, file: source, name });
      return '文件「' + name + '」发出去了';
    },
  });

 // ---- 手 4：撤回 ------------------------------------------------------------
  context.tool('qq_recall', {
    description: '撤回助手自己发过的一条消息（QQ 只允许一定时间内撤回）。messageId 是那条消息的 message_id。',
    parameters: {
      type: 'object',
      properties: { messageId: { type: 'string', description: '要撤回的消息 message_id' } },
      required: ['messageId'],
      additionalProperties: false,
    },
    async execute(args) {
      const id = messageId(args?.messageId);
      await onebot('delete_msg', { message_id: id });
      return '撤回了（message_id ' + id + '）';
    },
  });

 // ---- 手 5：贴表情 ----------------------------------------------------------
  context.tool('qq_react', {
    description: '给一条消息贴表情回应（QQ 的"表情表态"）。emojiId 是 QQ 表情 ID，默认 128077（点赞👍）。'
      + '注意：QQ 好友私聊不支持表情表态（协议端 retcode 100），群里才行。',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: '要贴表情的消息 message_id' },
        emojiId: { type: 'string', description: 'QQ 表情 ID，默认 128077' },
      },
      required: ['messageId'],
      additionalProperties: false,
    },
    async execute(args) {
      const id = messageId(args?.messageId);
      const emoji = String(args?.emojiId ?? '128077').trim() || '128077';
      if (!/^\d+$/.test(emoji)) throw fail('qq_invalid_emoji_id', emoji);
 // 协议端的签名是 { message_id, emoji_id: string, set: bool }，set=true 表示贴上而不是取消。
      try {
        await onebot('set_msg_emoji_like', { message_id: id, emoji_id: emoji, set: true });
      } catch (error) {
 // QQ 好友私聊不支持表情表态（协议端 retcode 100 "emoji reactions are not supported
 // on private messages"），群里才行。这里翻成一条明确的错误，不让原始报错冒上去。
        if (/emoji reactions are not supported/i.test(String(error?.message))) {
          throw fail('qq_react_private_unsupported', 'QQ private chats do not support emoji reactions');
        }
        throw error;
      }
      return '给对方那条消息贴了表情（emoji_id ' + emoji + '）';
    },
  });

 // ---- 手 6：戳一戳 ----------------------------------------------------------
  context.tool('qq_poke', {
    description: '戳一下某人（QQ 的"戳一戳"）。私聊时 to 可选，不填就是主收件人（只能是名单里的人）；'
      + 'group 给了就在群里戳 to 那个人，此时 to 必填、是那个人的 QQ 号。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '收件人 QQ 号，只在多选/反选模式下有效，可省略' },
        group: { type: 'string', description: '在哪个群里戳（群号），可省略' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const groupId = optionalGroup(args);
      if (groupId !== '') {
        const who = String(args?.to ?? '').trim();
        if (!/^\d+$/.test(who)) throw fail('qq_poke_group_needs_user', who);
        await groupCall('send_poke', { group_id: Number(groupId), user_id: Number(who) });
        return '在群 ' + groupId + ' 里戳了 ' + who + ' 一下';
      }
      const to = await target(args);
      await onebot('send_poke', { user_id: to });
      return '戳了 ' + to + ' 一下';
    },
  });

 // ---- 手 7：读历史 ----------------------------------------------------------
  context.tool('qq_history', {
    description: '读助手和某个人的 QQ 私聊记录（默认主收件人）。count 最多 50 条，默认 20。',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: '要几条，最多 50，默认 20' },
        to: { type: 'string', description: '看和谁的记录，只在多选/反选模式下有效，可省略' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const to = await target(args);
      const raw = Number(args?.count ?? 20);
      const count = Number.isInteger(raw) ? Math.min(50, Math.max(1, raw)) : 20;
      const body = await onebot('get_friend_msg_history', { user_id: to, count });
      const list = Array.isArray(body?.data?.messages) ? body.data.messages : [];
      if (list.length === 0) return '（最近没有消息）';
      const lines = [];
      for (const entry of list.slice(-count)) {
        const sender = entry?.sender?.user_id !== undefined ? String(entry.sender.user_id) : '';
        const who = sender === String(to) ? '对方' : (entry?.sender?.card || entry?.sender?.nickname || '助手');
        const described = describeMessage(entry?.message);
        const text = described !== '' ? described : String(entry?.raw_message ?? '').trim();
        const at = clockMinutes(entry?.time);
        lines.push((at === '' ? '' : at + ' ') + who + '：' + (text === '' ? '（非文字）' : text));
      }
      return lines.join('\n').slice(0, 2000);
    },
  });

  function segmentText(message) {
    if (typeof message === 'string') return message.trim();
    if (!Array.isArray(message)) return '';
    const parts = [];
    for (const segment of message) {
      if (segment && segment.type === 'text' && segment.data && typeof segment.data.text === 'string') parts.push(segment.data.text);
    }
    return parts.join('').trim();
  }

 /**
 * 给助手看的"这条消息是什么"：文字照抄，别的段给一个人话标签。
 * 以前直接把 raw_message 交出去，助手读到的是 [CQ:record,file=…url=…] 这种协议噪声。
 */
  function describeMessage(message, imageTexts) {
    if (typeof message === 'string') return message.trim();
    if (!Array.isArray(message)) return '';
    const parts = [];
 // imageTexts（可选）：按出现顺序替换 [图片] 的文案。合并转发那条路用它把"图存哪了"写进去，
 // 别的调用方不传，行为和以前一模一样。
    let imageCursor = 0;
    for (const segment of message) {
      if (segment === null || typeof segment !== 'object') continue;
      const data = segment.data !== null && typeof segment.data === 'object' ? segment.data : {};
      if (segment.type === 'text' && typeof data.text === 'string' && data.text.trim() !== '') { parts.push(data.text.trim()); continue; }
      if (segment.type === 'record') { parts.push('[语音]'); continue; }
      if (segment.type === 'image') {
        if (Array.isArray(imageTexts)) {
          const replaced = imageTexts[imageCursor];
          imageCursor += 1;
          parts.push(typeof replaced === 'string' && replaced !== '' ? replaced : (isStickerSegment(data) ? STICKER_MARK : '[图片]'));
          continue;
        }
        parts.push(isStickerSegment(data) ? STICKER_MARK : '[图片]');
        continue;
      }
      if (segment.type === 'face') { parts.push('[表情]'); continue; }
      if (segment.type === 'mface' || segment.type === 'marketface') { parts.push('[贴图]'); continue; }
      if (segment.type === 'file') { const name = String(data.name ?? '').trim(); parts.push(name === '' ? '[文件]' : '[文件 ' + name + ']'); continue; }
      if (segment.type === 'video') { parts.push('[视频]'); continue; }
      if (segment.type === 'reply') { parts.push('（回复）'); continue; }
      if (segment.type === 'forward') { parts.push('[转发]'); continue; }
      if (segment.type === 'at') { const qq = data.qq === undefined ? '' : String(data.qq); parts.push('@' + (qq === '' ? '某人' : qq)); continue; }
    }
    return parts.join('').trim();
  }

 // ---- 手 8：读单条 ----------------------------------------------------------
  context.tool('qq_message', {
    description: '按 message_id 读回一条消息的内容（引用、核对撤回时用）。',
    parameters: {
      type: 'object',
      properties: { messageId: { type: 'string', description: '消息的 message_id' } },
      required: ['messageId'],
      additionalProperties: false,
    },
    async execute(args) {
      const id = messageId(args?.messageId);
      const body = await onebot('get_msg', { message_id: id });
      const text = describeMessage(body?.data?.message) || String(body?.data?.raw_message ?? '').trim();
      return text === '' ? '（那条读不出内容）' : text.slice(0, 2000);
    },
  });

 // ---- 手 9：在线状态 --------------------------------------------------------
  context.tool('qq_status', {
    description: '改助手自己显示的在线状态。status 可用：online / away / busy / invisible / do-not-disturb / listening，'
      + '也可以直接给 QQ 的状态码（10/20/30/40/50/60）。',
    parameters: {
      type: 'object',
      properties: { status: { type: 'string', description: 'online/away/busy/invisible/do-not-disturb/listening 或 10/20/30/40/50/60' } },
      required: ['status'],
      additionalProperties: false,
    },
    async execute(args) {
      const raw = String(args?.status ?? '').trim().toLowerCase();
      let code;
      if (/^\d+$/.test(raw)) {
        code = Number(raw);
        if (!Object.values(STATUS_CODES).includes(code)) throw fail('qq_invalid_status', raw);
      } else {
        code = STATUS_CODES[raw];
        if (code === undefined) throw fail('qq_invalid_status', raw + ' (use ' + Object.keys(STATUS_CODES).join('/') + ')');
      }
      await onebot('set_online_status', { status: code });
      return '在线状态改成 ' + raw + '（' + code + '）';
    },
  });

 // ---- 手 10：改资料 ---------------------------------------------------------
  context.tool('qq_profile', {
    description: '改助手自己的 QQ 资料：nickname 改昵称，signature 改个性签名，avatar 换头像。'
      + '头像直接给助手这台机器上的图片路径最好（插件自己读文件、自己转 base64，不用助手抄长串 base64；'
      + '支持 png/jpg/gif/webp，四兆以内）；也接受 base64 串或协议端能读到的 URL。只改传了的那几项。',
    parameters: {
      type: 'object',
      properties: {
        nickname: { type: 'string', description: '新昵称' },
        signature: { type: 'string', description: '新个性签名' },
        avatar: { type: 'string', description: '新头像：优先给助手这台机器上的图片路径（插件自己读、自己转 base64），也接受 base64 或 URL' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const applied = [];
      const nickname = typeof args?.nickname === 'string' ? args.nickname.trim() : '';
      const signature = typeof args?.signature === 'string' ? args.signature.trim() : '';
      const avatarRaw = typeof args?.avatar === 'string' ? args.avatar.trim() : '';
      if (nickname === '' && signature === '' && avatarRaw === '') {
        throw fail('qq_profile_empty', 'give nickname, signature or avatar');
      }
      if (nickname !== '') {
        await onebot('set_qq_profile', { nickname });
        applied.push('昵称');
      }
      if (signature !== '') {
        await onebot('set_self_longnick', { longNick: signature });
        applied.push('签名');
      }
      if (avatarRaw !== '') {
        await onebot('set_qq_avatar', { file: avatarFile(avatarRaw) });
        applied.push('头像');
      }
      return '改了' + applied.join('、');
    },
  });

 // ---- 手 11：点赞 ----------------------------------------------------------
  context.tool('qq_like', {
    description: '给某人点赞（"名片赞"）。times 是次数，默认 1；助手自己不设上限，QQ 每天的额度由协议端决定。to 可选。',
    parameters: {
      type: 'object',
      properties: {
        times: { type: 'integer', description: '点几次，默认 1' },
        to: { type: 'string', description: '给谁点，只在多选/反选模式下有效，可省略' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const to = await target(args);
      const raw = Number(args?.times ?? 1);
      if (!Number.isInteger(raw) || raw < 1) throw fail('qq_invalid_like_times', String(args?.times));
      await onebot('send_like', { user_id: to, times: raw });
      return '给 ' + to + ' 点了 ' + raw + ' 个赞';
    },
  });

 // ---- 手 12-14：群（听群名单之外的一律拒） -----------------------------------
  context.tool('qq_group_list', {
    description: '看助手在哪些群里，以及哪些群是助手会听的。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const body = await onebot('get_group_list', {});
      const list = Array.isArray(body?.data) ? body.data : [];
      if (list.length === 0) return '（助手不在任何群里）';
      return list.slice(0, 50).map((group) => {
        const id = String(group?.group_id ?? '');
        const name = String(group?.group_name ?? '').trim();
        return (name === '' ? id : name + '（' + id + '）') + (groupAllowed(id) ? ' [会听]' : ' [不听]');
      }).join('\n').slice(0, 2000);
    },
  });

  context.tool('qq_group_history', {
    description: '读某个群最近的消息（只在会听的群里可用）。',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: '群号' },
        count: { type: 'integer', description: '条数 1-50，默认 20' },
      },
      required: ['groupId'],
      additionalProperties: false,
    },
    async execute(args) {
      const groupId = String(args?.groupId ?? '').trim();
      if (!/^\d+$/.test(groupId)) throw fail('qq_invalid_group', groupId);
      if (groupAllowed(groupId) === false) throw fail('qq_group_not_allowed', groupId);
      const raw = Number(args?.count ?? 20);
      const count = Number.isInteger(raw) ? Math.min(50, Math.max(1, raw)) : 20;
      const body = await onebot('get_group_msg_history', { group_id: groupId, count });
      const list = Array.isArray(body?.data?.messages) ? body.data.messages : [];
      if (list.length === 0) return '（这个群最近没有消息）';
      const lines = [];
      for (const entry of list.slice(-count)) {
        const who = entry?.sender?.card || entry?.sender?.nickname || String(entry?.sender?.user_id ?? entry?.user_id ?? '');
        const text = segmentText(entry?.message) || String(entry?.raw_message ?? '').trim() || '（非文字）';
        const at = clockMinutes(entry?.time);
        lines.push((at === '' ? '' : at + ' ') + who + '：' + text);
      }
      return lines.join('\n').slice(0, 2000);
    },
  });

  context.tool('qq_send_group', {
    description: '往一个群里发一句话（只在会听的群里可用；群里没有"主收件人"这回事）。',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: '群号' },
        text: { type: 'string', description: '要说的话' },
      },
      required: ['groupId', 'text'],
      additionalProperties: false,
    },
    async execute(args) {
      const groupId = String(args?.groupId ?? '').trim();
      if (!/^\d+$/.test(groupId)) throw fail('qq_invalid_group', groupId);
      if (groupAllowed(groupId) === false) throw fail('qq_group_not_allowed', groupId);
      const text = String(args?.text ?? '');
      if (text.trim() === '') throw fail('qq_empty_text');
      await onebot('send_group_msg', {
        group_id: groupId,
        message: [{ type: 'text', data: { text: sanitizeInboundCommand(text) } }],
        auto_escape: false,
      });
      return '发到群 ' + groupId + ' 了';
    },
  });

 // ---- 手 20+：群里的动作（群号必须在助手会听的名单里）-------------------------
 // 为什么这些动作都先过 groupAllowed：它们全作用在"别人的群"上——改群名、踢人、发公告、
 // @ 全体。助手连听都不听的群，更不该由助手来动设置。听群名单就是唯一的闸，不另开第二张表，
 // 免得两处名单慢慢对不上。

 /** 群号：必须是数字，而且必须在助手会听的群里。和旧的三只群工具同一句话、同一道闸。 */
  function requireGroup(args) {
    const raw = args?.groupId === undefined || args?.groupId === null ? '' : String(args.groupId).trim();
    if (!/^\d+$/.test(raw)) throw fail('qq_invalid_group', raw);
    if (groupAllowed(raw) === false) throw fail('qq_group_not_allowed', raw);
    return raw;
  }

 /** 可选群号：没给返回 ''（qq_send_voice / qq_send_file / qq_poke 用）。 */
  function optionalGroup(args) {
    const raw = args?.group === undefined || args?.group === null ? '' : String(args.group).trim();
    if (raw === '') return '';
    if (!/^\d+$/.test(raw)) throw fail('qq_invalid_group', raw);
    if (groupAllowed(raw) === false) throw fail('qq_group_not_allowed', raw);
    return raw;
  }

 /** 一个 QQ 号（群里的人、被 @ 的人）。 */
  function qqNumber(value, code) {
    const raw = value === undefined || value === null ? '' : String(value).trim();
    if (!/^\d+$/.test(raw)) throw fail(code, raw);
    return Number(raw);
  }

 /**
 * 一组 @ 目标：QQ 号，或者字符串 'all'（@ 全体）。可以混着给。
 * 重复的只留一个，顺序照助手给的（助手要先说 @谁 再说话，顺序就是语气的一部分）。
 */
  function atList(value, code) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw fail(code, 'must be a list of QQ numbers or "all"');
    const out = [];
    for (const entry of value) {
      const raw = entry === undefined || entry === null ? '' : String(entry).trim();
      let who = null;
      if (raw.toLowerCase() === 'all') who = 'all';
      else if (/^\d+$/.test(raw)) who = raw;
      if (who === null) throw fail(code, raw);
      if (!out.includes(who)) out.push(who);
    }
    return out;
  }

 /** 开关参数：只认真布尔；"true" 这种字符串不当成 true（不猜助手的意思）。 */
  function requireFlag(value, code) {
    if (typeof value !== 'boolean') throw fail(code, String(value));
    return value;
  }

 /**
 * 群动作的统一出口：协议端拒绝时翻译成人话再抛。
 *
 * 为什么：最常见的拒绝是"助手不是管理员"，协议端只回一个 retcode 100 + 一句英文，
 * 助手看到 onebot_100 只会以为没生效、再试一遍。翻译一次，助手就能换个做法
 * （先请群主给权限，或者干脆不做），而不是撞同一堵墙。
 */
  async function groupCall(action, payload) {
    try {
      return await onebot(action, payload);
    } catch (error) {
      const code = String(error?.code ?? '');
      const detail = String(error?.message ?? '');
      const blob = (code + ' ' + detail).toLowerCase();
      const seen = (code + ' ' + detail).slice(0, 160);
      if (/permission|权限|not admin|no admin|管理员/.test(blob)) throw fail('qq_group_not_admin', seen);
      if (/not found|不存在|不在群|not in group|member not found|no such member/.test(blob)) throw fail('qq_group_member_missing', seen);
      throw error;
    }
  }

 /** 群成员角色说人话；认不出就不写（不编一个"成员"出来）。 */
  function roleLabel(role) {
    const raw = String(role ?? '').trim().toLowerCase();
    if (raw === 'owner') return '群主';
    if (raw === 'admin') return '管理员';
    if (raw === 'member') return '成员';
    return '';
  }

 /** 一个群成员一行：名片（昵称）QQ号 角色。缺哪样就少写哪样。 */
  function describeMember(member) {
    const id = String(member?.user_id ?? '').trim();
    const card = String(member?.card ?? '').trim();
    const nick = String(member?.nickname ?? '').trim();
    const role = roleLabel(member?.role);
    const name = card !== '' ? card : (nick !== '' ? nick : '');
    const alias = card !== '' && nick !== '' && card !== nick ? '（' + nick + '）' : '';
    const head = name === '' ? '（没有名字）' : name + alias;
    return '- ' + head + (id === '' ? ' （没有 QQ 号）' : ' ' + id) + (role === '' ? '' : ' ' + role);
  }

 /** 公告的时间戳（秒）→ 本地可读；给不出就返回空串，调用方少写一段。 */
  function noticeWhen(seconds) {
    return clockFull(seconds);
  }

  context.tool('qq_group_say', {
    description: '往群里发一句话。at 是要 @ 的 QQ 号数组，也可以放字符串 all 来 @ 全体（@全体有次数限制，群主/管理员才用得了）；'
      + 'replyTo 是要引用的那条消息的 message_id。',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: '群号' },
        text: { type: 'string', description: '要说的话' },
        at: {
          type: 'array',
          items: { type: 'string' },
          description: '要 @ 的 QQ 号，可以混一个 all 表示 @ 全体；可省略',
        },
        replyTo: { type: 'string', description: '要引用的消息 message_id，可省略' },
      },
      required: ['groupId', 'text'],
      additionalProperties: false,
    },
    async execute(args) {
      const groupId = requireGroup(args);
      const said = requireText(args?.text, 'qq_empty_text');
      const message = [];
      let note = '';
      const replyRaw = args?.replyTo === undefined || args?.replyTo === null ? '' : String(args.replyTo).trim();
      if (replyRaw !== '') {
        const replyId = messageId(replyRaw);
 // 和 qq_reply 同一个道理：协议端 查不到这条 id 会静默丢掉引用段，
 // 所以先问一句，引不上就明说，不让助手以为引上了。
        if (await messageExists(replyId)) message.push({ type: 'reply', data: { id: String(replyId) } });
        else note = '（引用那条协议端不认，已经按普通消息发出去）';
      }
      for (const qq of atList(args?.at, 'qq_invalid_at')) message.push({ type: 'at', data: { qq } });
      message.push({ type: 'text', data: { text: sanitizeInboundCommand(said) } });
      const body = await groupCall('send_group_msg', { group_id: Number(groupId), message, auto_escape: false });
      const sentId = body?.data?.message_id;
      return '发到群 ' + groupId + ' 了' + note + (sentId === undefined ? '' : '（message_id ' + String(sentId) + '）');
    },
  });

  context.tool('qq_group_ban', {
    description: '禁言群里的某个人（禁言期间该成员不能在群里发言）。minutes 是分钟数，0 表示解除禁言，最多 43200 分钟（30 天）。',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: '群号' },
        userId: { type: 'string', description: '要禁言的人的 QQ 号' },
        minutes: { type: 'integer', description: '禁言多少分钟；0 = 解除禁言；最多 43200' },
      },
      required: ['groupId', 'userId', 'minutes'],
      additionalProperties: false,
    },
    async execute(args) {
      const groupId = requireGroup(args);
      const userId = qqNumber(args?.userId, 'qq_invalid_user');
      const minutes = args?.minutes;
      if (Number.isInteger(minutes) === false || minutes < 0) throw fail('qq_invalid_minutes', String(minutes));
      if (minutes > GROUP_BAN_MAX_MINUTES) throw fail('qq_group_ban_too_long', minutes + ' > ' + GROUP_BAN_MAX_MINUTES);
      await groupCall('set_group_ban', { group_id: Number(groupId), user_id: userId, duration: minutes * 60 });
      return minutes === 0 ? '给 ' + userId + ' 解除禁言了' : '把 ' + userId + ' 禁言 ' + minutes + ' 分钟';
    },
  });

  context.tool('qq_group_ban_all', {
    description: '把整个群设成全群禁言，或者解除。on 是 true/false。',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: '群号' },
        on: { type: 'boolean', description: 'true = 全群禁言，false = 解除' },
      },
      required: ['groupId', 'on'],
      additionalProperties: false,
    },
    async execute(args) {
      const groupId = requireGroup(args);
      const on = requireFlag(args?.on, 'qq_group_bad_flag');
      await groupCall('set_group_whole_ban', { group_id: Number(groupId), enable: on });
      return on ? '把群 ' + groupId + ' 设成全群禁言了' : '把群 ' + groupId + ' 的全群禁言解除了';
    },
  });

  context.tool('qq_group_kick', {
    description: '把一个人移出群（其就不在群里了）。block 为 true 时同时拒绝其再申请进群。',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: '群号' },
        userId: { type: 'string', description: '要移出的人的 QQ 号' },
        block: { type: 'boolean', description: '是否同时拒绝其再申请进群，默认 false' },
      },
      required: ['groupId', 'userId'],
      additionalProperties: false,
    },
    async execute(args) {
      const groupId = requireGroup(args);
      const userId = qqNumber(args?.userId, 'qq_invalid_user');
      const block = args?.block === undefined || args?.block === null ? false : requireFlag(args.block, 'qq_group_bad_flag');
      await groupCall('set_group_kick', { group_id: Number(groupId), user_id: userId, reject_add_request: block });
      return '把 ' + userId + ' 移出群 ' + groupId + ' 了' + (block ? '，同时拒绝了再申请' : '');
    },
  });

  context.tool('qq_group_admin', {
    description: '设置或取消群里某个人的管理员。on 是 true/false。',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: '群号' },
        userId: { type: 'string', description: '那个人 QQ 号' },
        on: { type: 'boolean', description: 'true = 设为管理员，false = 取消' },
      },
      required: ['groupId', 'userId', 'on'],
      additionalProperties: false,
    },
    async execute(args) {
      const groupId = requireGroup(args);
      const userId = qqNumber(args?.userId, 'qq_invalid_user');
      const on = requireFlag(args?.on, 'qq_group_bad_flag');
      await groupCall('set_group_admin', { group_id: Number(groupId), user_id: userId, enable: on });
      return (on ? '把 ' + userId + ' 设成群 ' + groupId + ' 的管理员了' : '取消了 ' + userId + ' 在群 ' + groupId + ' 的管理员');
    },
  });

  context.tool('qq_group_card', {
    description: '改群里某个人的群名片。card 给空串就是清空名片。',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: '群号' },
        userId: { type: 'string', description: '那个人 QQ 号' },
        card: { type: 'string', description: '新名片；空串 = 清空' },
      },
      required: ['groupId', 'userId', 'card'],
      additionalProperties: false,
    },
    async execute(args) {
      const groupId = requireGroup(args);
      const userId = qqNumber(args?.userId, 'qq_invalid_user');
      if (typeof args?.card !== 'string') throw fail('qq_group_card_missing', String(args?.card));
      const card = args.card.trim();
      await groupCall('set_group_card', { group_id: Number(groupId), user_id: userId, card });
      return card === '' ? '清空了 ' + userId + ' 在群 ' + groupId + ' 的名片' : '把 ' + userId + ' 在群 ' + groupId + ' 的名片改成「' + card + '」';
    },
  });

  context.tool('qq_group_name', {
    description: '改群名。name 是新群名。',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: '群号' },
        name: { type: 'string', description: '新群名' },
      },
      required: ['groupId', 'name'],
      additionalProperties: false,
    },
    async execute(args) {
      const groupId = requireGroup(args);
      const name = requireText(args?.name, 'qq_group_name_missing');
      await groupCall('set_group_name', { group_id: Number(groupId), group_name: name });
      return '把群 ' + groupId + ' 的名字改成「' + name + '」了';
    },
  });

  context.tool('qq_group_title', {
    description: '改群里某个人的专属头衔。title 给空串就是清空头衔。',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: '群号' },
        userId: { type: 'string', description: '那个人 QQ 号' },
        title: { type: 'string', description: '新头衔；空串 = 清空' },
      },
      required: ['groupId', 'userId', 'title'],
      additionalProperties: false,
    },
    async execute(args) {
      const groupId = requireGroup(args);
      const userId = qqNumber(args?.userId, 'qq_invalid_user');
      if (typeof args?.title !== 'string') throw fail('qq_group_title_missing', String(args?.title));
      const title = args.title.trim();
      await groupCall('set_group_special_title', { group_id: Number(groupId), user_id: userId, special_title: title });
      return title === '' ? '清空了 ' + userId + ' 在群 ' + groupId + ' 的头衔' : '把 ' + userId + ' 在群 ' + groupId + ' 的头衔改成「' + title + '」';
    },
  });

  context.tool('qq_group_notice_post', {
    description: '往群里发一条公告（全群的人都看得到）。text 是公告正文。',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: '群号' },
        text: { type: 'string', description: '公告正文' },
      },
      required: ['groupId', 'text'],
      additionalProperties: false,
    },
    async execute(args) {
      const groupId = requireGroup(args);
      const said = requireText(args?.text, 'qq_empty_text');
 // 协议端的公告动作带前导下划线，和别的 OneBot 动作不一样。
      await groupCall('_send_group_notice', { group_id: Number(groupId), content: said });
      return '群 ' + groupId + ' 的公告发出去了';
    },
  });

  context.tool('qq_group_notice_read', {
    description: '读群里最近的公告，返回时间和正文。',
    parameters: {
      type: 'object',
      properties: { groupId: { type: 'string', description: '群号' } },
      required: ['groupId'],
      additionalProperties: false,
    },
    async execute(args) {
      const groupId = requireGroup(args);
      const body = await groupCall('_get_group_notice', { group_id: Number(groupId) });
      const raw = body?.data;
      const rows = Array.isArray(raw) ? raw : (Array.isArray(raw?.notices) ? raw.notices : []);
      if (rows.length === 0) return '（群 ' + groupId + ' 没有公告）';
      const lines = [];
      for (const row of rows.slice(-5)) {
        if (row === null || typeof row !== 'object') continue;
 // 时间/正文取不到就少写一段，不替协议端编一个出来。
        const when = noticeWhen(row.publish_time ?? row.time);
        const content = segmentText(row.message) || String(row.content ?? row.text ?? '').trim();
        lines.push((when === '' ? '' : when + ' ') + (content === '' ? '（这条公告没有文字内容）' : content));
      }
      if (lines.length === 0) return '（群 ' + groupId + ' 的公告读不出内容）';
      return '群 ' + groupId + ' 的公告（最近 ' + lines.length + ' 条）：\n' + lines.join('\n').slice(0, 2000);
    },
  });

  context.tool('qq_group_members', {
    description: '看群成员。不给 userId 就是名单（共几人 + 名片/昵称 QQ号 角色），给了就是那一个人的资料。',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: '群号' },
        userId: { type: 'string', description: '只看这一个人，可省略' },
      },
      required: ['groupId'],
      additionalProperties: false,
    },
    async execute(args) {
      const groupId = requireGroup(args);
      const whoRaw = args?.userId === undefined || args?.userId === null ? '' : String(args.userId).trim();
      if (whoRaw !== '') {
        const userId = qqNumber(whoRaw, 'qq_invalid_user');
        const body = await groupCall('get_group_member_info', { group_id: Number(groupId), user_id: userId });
        const data = body?.data;
        if (data === null || typeof data !== 'object') throw fail('qq_group_member_missing', String(userId));
        return '群 ' + groupId + ' 里的 ' + userId + '：\n' + describeMember(data);
      }
      const body = await groupCall('get_group_member_list', { group_id: Number(groupId) });
      const list = Array.isArray(body?.data) ? body.data : [];
      if (list.length === 0) return '（群 ' + groupId + ' 里没拿到成员名单）';
      const lines = ['群 ' + groupId + ' 共 ' + list.length + ' 人：'];
      for (const member of list.slice(0, 50)) lines.push(describeMember(member));
      if (list.length > 50) lines.push('（只列了前 50 个）');
      return lines.join('\n').slice(0, 2000);
    },
  });

  context.tool('qq_group_info', {
    description: '看一个群的情况：群名、人数、群主，以及现在还能 @ 全体几次。',
    parameters: {
      type: 'object',
      properties: { groupId: { type: 'string', description: '群号' } },
      required: ['groupId'],
      additionalProperties: false,
    },
    async execute(args) {
      const groupId = requireGroup(args);
      const lines = [];
      const problems = [];
 // 两个动作各写各的：坏一个不该把另一个能拿到的也一起丢掉。
      try {
        const body = await groupCall('get_group_info', { group_id: Number(groupId) });
        const info = body?.data;
        if (info !== null && typeof info === 'object') {
          const name = String(info.group_name ?? '').trim();
          lines.push('群 ' + groupId + (name === '' ? '' : '「' + name + '」'));
          const members = Number(info.member_count);
          const max = Number(info.max_member_count);
          if (Number.isFinite(members)) lines.push('人数：' + members + (Number.isFinite(max) && max > 0 ? ' / ' + max : ''));
          const owner = String(info.owner_id ?? '').trim();
          if (owner !== '') lines.push('群主：' + owner);
        } else {
          problems.push('群资料没拿到');
        }
      } catch (error) {
        problems.push('群资料：' + String(error?.code ?? error?.message ?? error));
      }
      try {
        const body = await groupCall('get_group_at_all_remain', { group_id: Number(groupId) });
        const remain = body?.data;
        if (remain !== null && typeof remain === 'object') {
          if (remain.can_at_all === false) {
            lines.push('现在不能 @ 全体成员');
          } else {
            const left = [];
            const forGroup = Number(remain.remain_at_all_count_for_group);
            const forMe = Number(remain.remain_at_all_count_for_uin);
            if (Number.isFinite(forGroup)) left.push('本群还能 ' + forGroup + ' 次');
            if (Number.isFinite(forMe)) left.push('我还能 ' + forMe + ' 次');
            lines.push('@ 全体：' + (left.length === 0 ? '可以' : left.join('，')));
          }
        } else {
          problems.push('@ 全体次数没拿到');
        }
      } catch (error) {
        problems.push('@ 全体次数：' + String(error?.code ?? error?.message ?? error));
      }
      if (lines.length === 0) return '群 ' + groupId + ' 的情况没读出来（' + problems.join('；') + '）';
      return lines.join('\n') + (problems.length === 0 ? '' : '\n（' + problems.join('；') + '）');
    },
  });

  context.tool('qq_group_files', {
    description: '看群文件根目录里有哪些文件，给出文件名、大小和 file_id。',
    parameters: {
      type: 'object',
      properties: { groupId: { type: 'string', description: '群号' } },
      required: ['groupId'],
      additionalProperties: false,
    },
    async execute(args) {
      const groupId = requireGroup(args);
      const body = await groupCall('get_group_root_files', { group_id: Number(groupId) });
      const files = Array.isArray(body?.data?.files) ? body.data.files : [];
      if (files.length === 0) return '（群 ' + groupId + ' 的文件里没有文件）';
      const lines = ['群 ' + groupId + ' 的文件共 ' + files.length + ' 个：'];
      for (const file of files.slice(0, 50)) {
        const name = String(file?.file_name ?? '').trim() || '（没有名字）';
        const size = sizeLabel(file?.file_size);
        const fileId = String(file?.file_id ?? '').trim();
        lines.push('- ' + name + (size === '' ? '' : '（' + size + '）') + (fileId === '' ? '' : ' ' + fileId));
      }
      if (files.length > 50) lines.push('（只列了前 50 个）');
      return lines.join('\n').slice(0, 2000);
    },
  });

  context.tool('qq_group_file_upload', {
    description: '把我这边（屋或工作区）的一个文件传到群文件。path 是文件路径，name 是对方看到的文件名，可省略。',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: '群号' },
        path: { type: 'string', description: '我自己这边的一个文件路径' },
        name: { type: 'string', description: '传上去以后的文件名，可省略（默认用原文件名）' },
      },
      required: ['groupId', 'path'],
      additionalProperties: false,
    },
    async execute(args) {
      const groupId = requireGroup(args);
      const localPath = requireText(args?.path, 'qq_media_missing');
 // 先过本地这道闸：只认助手屋/工作区/插件数据目录里的文件，超上限也在这里拦。
      const bytes = localFileBytes(localPath);
      const absolute = path.resolve(localPath);
      const given = typeof args?.name === 'string' ? args.name.trim() : '';
      const name = given === '' ? path.basename(absolute) : given;
 // 助手和协议端是两个容器，路径互相看不见（媒体段那里同一条理由）。所以绝对路径递过去
 // 协议端只会读到 ENOENT——交给它的必须是内容本身，读成字节再用 base64:// 走。
      await groupCall('upload_group_file', { group_id: Number(groupId), file: 'base64://' + bytes.toString('base64'), name });
      return '文件「' + name + '」传到群 ' + groupId + ' 了';
    },
  });

  context.tool('qq_group_file_delete', {
    description: '删掉群文件里的一个文件。fileId 是 qq_group_files 里给出的那个 id。',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: '群号' },
        fileId: { type: 'string', description: '要删的文件的 file_id' },
      },
      required: ['groupId', 'fileId'],
      additionalProperties: false,
    },
    async execute(args) {
      const groupId = requireGroup(args);
      const fileId = requireText(args?.fileId, 'qq_group_file_id_missing');
      await groupCall('delete_group_file', { group_id: Number(groupId), file_id: fileId });
      return '群 ' + groupId + ' 的文件 ' + fileId + ' 删掉了';
    },
  });

  context.tool('qq_group_essence', {
    description: '把一条消息设成群精华，on 为 false 时取消。',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: '那条消息的 message_id' },
        on: { type: 'boolean', description: 'true = 设成精华（默认），false = 取消' },
      },
      required: ['messageId'],
      additionalProperties: false,
    },
    async execute(args) {
      const id = messageId(args?.messageId);
      const on = args?.on === undefined || args?.on === null ? true : requireFlag(args.on, 'qq_group_bad_flag');
      await groupCall(on ? 'set_essence_msg' : 'delete_essence_msg', { message_id: id });
      return (on ? '设成群精华了' : '取消群精华了') + '（message_id ' + id + '）';
    },
  });

  context.tool('qq_group_handle_request', {
    description: '处理一条入群申请或进群邀请。flag 是那条请求的 flag，approve 是同意/拒绝，'
      + 'subType 是 add（入群申请，默认）或 invite（进群邀请）。',
    parameters: {
      type: 'object',
      properties: {
        flag: { type: 'string', description: '请求的 flag' },
        approve: { type: 'boolean', description: 'true = 同意，false = 拒绝' },
        subType: { type: 'string', enum: ['add', 'invite'], description: 'add = 入群申请（默认），invite = 进群邀请' },
        reason: { type: 'string', description: '拒绝理由，可省略' },
      },
      required: ['flag', 'approve'],
      additionalProperties: false,
    },
    async execute(args) {
      const flagValue = requireText(args?.flag, 'qq_group_flag_missing');
      const approve = requireFlag(args?.approve, 'qq_group_bad_flag');
      const subRaw = args?.subType === undefined || args?.subType === null ? 'add' : String(args.subType).trim().toLowerCase();
      const subType = subRaw === '' ? 'add' : subRaw;
      if (subType !== 'add' && subType !== 'invite') throw fail('qq_group_bad_sub_type', subType);
      const reason = typeof args?.reason === 'string' ? args.reason.trim() : '';
      const payload = { flag: flagValue, sub_type: subType, approve };
      if (reason !== '') payload.reason = reason;
      await groupCall('set_group_add_request', payload);
      const what = subType === 'invite' ? '进群邀请' : '入群申请';
      return (approve ? '同意了这条' : '拒绝了这条') + what + (reason === '' ? '' : '（理由：' + reason + '）');
    },
  });

  context.tool('qq_group_leave', {
    description: '退出一个群（退出后这个群的消息我就收不到了）。confirm 必须是 true 才会执行。',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: '群号' },
        confirm: { type: 'boolean', description: '必须是 true 才会退群' },
      },
      required: ['groupId', 'confirm'],
      additionalProperties: false,
    },
    async execute(args) {
      const groupId = requireGroup(args);
 // 退群不能重来：没有 confirm 就一步都不走（连协议端都不碰）。
      if (args?.confirm !== true) throw fail('qq_group_leave_needs_confirm');
      await groupCall('set_group_leave', { group_id: Number(groupId), is_dismiss: false });
      return '退出群 ' + groupId + ' 了';
    },
  });

 // ---- 手 16-19：QQ 空间 ----------------------------------------------------
 // 读（自己的说说、好友动态）随时可用；发和删是"对外公开发言"，要先由宿主打开
 // config.qzonePost —— 默认 false，调了直接被拒，不会悄悄发出去。

 /** 可见性：名字或数字都认，未知当场拒（不猜）；16/128 必须给 targets。 */
  function qzoneRight(args) {
    const named = { all: 1, friends: 4, some: 16, self: 64, exclude: 128 };
    const raw = args?.visibility;
    let right = qzoneDefaultRight;
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
      const key = String(raw).trim().toLowerCase();
      if (Object.hasOwn(named, key)) right = named[key];
      else if (/^\d+$/.test(key) && QZONE_UGC_RIGHTS.includes(Number(key))) right = Number(key);
      else throw fail('qq_qzone_bad_visibility', key);
    }
    const targets = (Array.isArray(args?.targets) ? args.targets : [])
      .map((id) => String(id ?? '').trim()).filter((id) => /^\d+$/.test(id)).map(Number);
    if ((right === 16 || right === 128) && targets.length === 0) throw fail('qq_qzone_targets_required', String(right));
    return { right, targets };
  }

  function qzoneWriteGuard() {
    if (qzonePostEnabled === false) throw fail('qq_qzone_post_disabled', 'config.qzonePost is false');
  }

  function qzoneExcerpt(text, max) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (flat === '') return '（没有正文）';
    return flat.length > max ? flat.slice(0, max) + '…' : flat;
  }

  function qzoneBody(text, max) {
    const raw = String(text ?? '').trim();
    if (raw === '') return '（没有正文）';
    return raw.length > max ? raw.slice(0, max) + '…' : raw;
  }

  function qzoneWhen(seconds) {
    return clockFull(seconds);
  }

  context.tool('qq_qzone_mine', {
    description: '读助手自己 QQ 空间的说说列表（默认就是助手的空间）。num 最多 20，默认 5；返回每条的时间、正文摘要和 tid。',
    parameters: {
      type: 'object',
      properties: {
        num: { type: 'integer', description: '要几条，最多 20，默认 5' },
        pos: { type: 'integer', description: '从第几条开始，默认 0' },
        uin: { type: 'string', description: '看谁的说说，默认助手自己' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const rawNum = Number(args?.num ?? qzoneFeedCount);
      const num = Number.isInteger(rawNum) ? Math.min(20, Math.max(1, rawNum)) : qzoneFeedCount;
      const rawPos = Number(args?.pos ?? 0);
      const pos = Number.isInteger(rawPos) && rawPos > 0 ? rawPos : 0;
 // 这个动作不传 target_uin 一律 retcode 100，
 // 哪怕文档写着"默认当前账号"。所以默认显式传助手自己的号。
      const uinRaw = args?.uin === undefined || args?.uin === null ? '' : String(args.uin).trim();
      const uin = uinRaw === '' ? envId : (/^\d+$/.test(uinRaw) ? Number(uinRaw) : null);
      if (uin === null) throw fail('qq_qzone_no_target', uinRaw);
      const body = await onebot('get_qzone_msg_list', { pos, num, target_uin: uin });
      const list = Array.isArray(body?.data?.msglist) ? body.data.msglist : [];
      const total = Number(body?.data?.total ?? 0);
      if (list.length === 0) return '（空间里还没有说说）';
      const lines = list.map((entry) => {
        const when = qzoneWhen(entry?.time);
        const priv = Number(entry?.is_private) === 1 ? ' [仅自己可见]' : '';
        const comments = Number(entry?.comment_num) > 0 ? ' [评论 ' + Number(entry.comment_num) + ']' : '';
        return (when === '' ? '' : when + ' ') + qzoneExcerpt(entry?.content, 120) + priv + comments
          + ' 【tid ' + String(entry?.tid ?? '') + '】';
      });
      return ('一共 ' + total + ' 条，这里是 ' + list.length + ' 条：\n' + lines.join('\n')).slice(0, 2000);
    },
  });

  context.tool('qq_qzone_feeds', {
    description: '读 QQ 空间的好友动态首页（别人发的说说）。count 最多 20，默认 5；has_more 为真时可用返回的 cursor 接着读。',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: '要几条，最多 20，默认 5' },
        page: { type: 'integer', description: '第几页，默认 1' },
        cursor: { type: 'string', description: '上一页返回的 next_cursor，原样传回来' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const rawCount = Number(args?.count ?? qzoneFeedCount);
      const count = Number.isInteger(rawCount) ? Math.min(20, Math.max(1, rawCount)) : qzoneFeedCount;
      const rawPage = Number(args?.page ?? 1);
      const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
      const cursor = typeof args?.cursor === 'string' ? args.cursor.trim() : '';
      const payload = { page_num: page, count };
      if (cursor !== '') payload.cursor = cursor;
      const body = await onebot('get_qzone_feeds', payload);
      const feeds = Array.isArray(body?.data?.feeds) ? body.data.feeds : [];
      if (feeds.length === 0) return '（这一页没有好友动态）';
      const lines = feeds.map((feed) => {
        const who = String(feed?.nickname ?? feed?.uin ?? '某人');
        const when = qzoneWhen(feed?.time);
        const text = qzoneExcerpt(feed?.content, 100);
        const bits = [];
        const images = Array.isArray(feed?.images) ? feed.images.length : 0;
        if (images > 0) bits.push('图 ' + images);
 // 协议端这两个计数可能是 null（表示"不知道"）。不知道就不写，不能编成 0。
        if (Number.isInteger(feed?.like_count) && feed.like_count > 0) bits.push('赞 ' + feed.like_count);
        if (Number.isInteger(feed?.comment_count) && feed.comment_count > 0) bits.push('评论 ' + feed.comment_count);
        const meta = bits.length === 0 ? '' : '（' + bits.join('，') + '）';
        return (when === '' ? '' : when + ' ') + who + '：' + text + meta
          + ' 【tid ' + String(feed?.tid ?? '') + ' / uin ' + String(feed?.uin ?? '') + '】';
      });
      const more = body?.data?.has_more === true && typeof body?.data?.next_cursor === 'string'
        ? '\n（还有下一页，cursor：' + body.data.next_cursor + '）' : '';
      return (lines.join('\n') + more + '\n（要看哪条的评论，把它的 tid 和 uin 传给 qq_qzone_detail）').slice(0, 2000);
    },
  });

  context.tool('qq_qzone_detail', {
    description: '看一条说说的详情：完整正文、评论数，以及下面的一级评论和楼中楼回复。tid 和 uin 来自 qq_qzone_feeds / qq_qzone_mine。'
      + '协议端不在这条里给点赞数——点赞数在动态列表那一行的"赞 N"里。',
    parameters: {
      type: 'object',
      properties: {
        tid: { type: 'string', description: '说说 tid' },
        uin: { type: 'string', description: '这条说说作者的 QQ 号（列表里带的 uin），不填就当是助手自己的空间' },
        comments: { type: 'integer', description: '要几条一级评论，最多 20，默认 10' },
      },
      required: ['tid'],
      additionalProperties: false,
    },
    async execute(args) {
      const tid = requireText(args?.tid, 'qq_qzone_tid_missing');
      const uinRaw = args?.uin === undefined || args?.uin === null ? '' : String(args.uin).trim();
      const uin = uinRaw === '' ? envId : (/^\d+$/.test(uinRaw) ? Number(uinRaw) : null);
      if (uin === null) throw fail('qq_qzone_no_target', uinRaw);
      const rawNum = Number(args?.comments ?? 10);
      const num = Number.isInteger(rawNum) ? Math.min(20, Math.max(0, rawNum)) : 10;
      const body = await onebot('get_qzone_msg_detail', { tid, target_uin: uin, pos: 0, num });
      const data = body?.data ?? {};
      const comments = Array.isArray(data?.comments) ? data.comments : [];
      const commentNum = Number.isInteger(data?.comment_num) ? data.comment_num : null;
      const out = [qzoneBody(data?.content, 800)];
      out.push(commentNum === null
        ? '评论数：不知道'
        : '评论数：' + commentNum + (commentNum > comments.length ? '（这里列了 ' + comments.length + ' 条）' : ''));
      for (const comment of comments.slice(0, num)) {
        const when = qzoneWhen(comment?.time);
        out.push('· ' + (when === '' ? '' : when + ' ') + String(comment?.name ?? comment?.uin ?? '某人')
          + '：' + qzoneExcerpt(comment?.content, 200));
        for (const reply of Array.isArray(comment?.replies) ? comment.replies.slice(0, 5) : []) {
          out.push('   ↳ ' + String(reply?.name ?? reply?.uin ?? '某人') + '：' + qzoneExcerpt(reply?.content, 160));
        }
      }
      if (comments.length === 0) out.push('（还没有评论）');
      return out.join('\n').slice(0, 2000);
    },
  });

  context.tool('qq_qzone_post', {
    description: '发一条说说到助手自己的 QQ 空间。text 是正文；visibility 是可见范围：all（所有人，默认）/ friends（好友）/ self（仅自己）/'
      + ' some（部分好友可见）/ exclude（部分好友不可见），后两种要用 targets 给出 QQ 号。范围助手可以自己挑，不写就用宿主定的默认范围。'
      + '宿主没打开 qzonePost 开关时这条会被直接拒。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '说说正文' },
        visibility: { type: 'string', description: 'self / friends / all / some / exclude，默认按宿主配置（通常 self）' },
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: '只有 some / exclude 需要：可见或被排除的 QQ 号',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：图片 base64（不带 data: 前缀）或 http(s)/file 地址，最多 9 张',
        },
        stickers: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：表情包图库里的名字 / md5 / id，一起发到说说里（和 images 合计最多 9 张）',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(args) {
      qzoneWriteGuard();
      const text = requireText(args?.text, 'qq_qzone_text_missing');
      if (text.length > qzoneMaxChars) throw fail('qq_qzone_too_long', text.length + ' > ' + qzoneMaxChars);
      const { right, targets } = qzoneRight(args);
      const rawImages = Array.isArray(args?.images) ? args.images : [];
      const rawStickers = Array.isArray(args?.stickers) ? args.stickers.filter((item) => String(item ?? '').trim() !== '') : [];
      if (rawStickers.length > 0) {
        if (stickerEnabled === false) throw fail('qq_sticker_disabled');
        const faces = await customFaces(stickerListMax);
        for (const raw of rawStickers) {
          const key = String(raw).trim();
          const face = matchFace(faces, key);
          if (face === null) throw fail('qq_sticker_not_found', key + '（先用 qq_sticker_list 看看图库里有什么）');
          if (face.url === '') throw fail('qq_sticker_no_url', key);
          rawImages.push(face.url);
        }
      }
      if (rawImages.length > 9) throw fail('qq_qzone_too_many_images', String(rawImages.length));
      const images = [];
      for (const raw of rawImages) {
        const item = String(raw ?? '').trim();
        if (item === '') continue;
        if (/^https?:\/\//i.test(item) || item.startsWith('file://')) { images.push(item); continue; }
        if (/^base64:\/\//.test(item)) { images.push(item); continue; }
        if (/^[A-Za-z0-9+/=\r\n]+$/.test(item) === false) throw fail('qq_media_not_base64');
        const bytes = base64Bytes(item.replace(/\s+/g, ''));
        const limit = runtimeNow().mediaMaxBytes;
        if (bytes > limit) throw fail('qq_media_too_large', bytes + ' > ' + limit);
        images.push('base64://' + item.replace(/\s+/g, ''));
      }
      const payload = { content: text, ugc_right: right };
      if (targets.length > 0) payload.target_uins = targets;
      if (images.length > 0) payload.images = images;
      const body = await onebot('send_qzone_msg', payload);
      const tid = body?.data?.tid === undefined ? '' : String(body.data.tid);
      const scope = Object.entries({ 1: 'all', 4: 'friends', 16: 'some', 64: 'self', 128: 'exclude' })
        .find(([code]) => Number(code) === right);
      return '说说发出去了' + (scope === undefined ? '' : '（可见：' + scope[1] + '）')
        + (tid === '' ? '' : '，tid ' + tid);
    },
  });

  context.tool('qq_qzone_delete', {
    description: '删掉助手自己的一条说说。tid 来自 qq_qzone_mine 或 qq_qzone_post。宿主没打开 qzonePost 开关时会被拒。',
    parameters: {
      type: 'object',
      properties: { tid: { type: 'string', description: '要删的说说 tid' } },
      required: ['tid'],
      additionalProperties: false,
    },
    async execute(args) {
      qzoneWriteGuard();
      const tid = String(args?.tid ?? '').trim();
      if (tid === '') throw fail('qq_qzone_tid_missing');
      await onebot('delete_qzone_msg', { tid });
      return '说说 ' + tid + ' 删掉了';
    },
  });

 // ---- 入站的边角料：群名单、通知开关、富文本拼接 --------------------------------
  const groupsConfig = context.config.groups !== null && typeof context.config.groups === 'object' ? context.config.groups : {};
  const groupModeRaw = String(groupsConfig.mode ?? 'none').trim().toLowerCase();
  if (GROUP_MODES.includes(groupModeRaw) === false) throw new Error('life-qq config.groups.mode must be none, list or all');
  const groupMode = groupModeRaw;
  const groupIds = new Set(Array.isArray(groupsConfig.ids)
    ? groupsConfig.ids.map((id) => String(id ?? '').trim()).filter((id) => /^\d+$/.test(id)) : []);
  const noticesEnabled = context.config.notices !== false;
  const quoteMaxChars = Number.isInteger(context.config.quoteMaxChars) && context.config.quoteMaxChars > 0
    ? context.config.quoteMaxChars : 200;

 /** 这个群助手要不要听（默认 none：不在名单里的群一个字都不进来）。 */
  function groupAllowed(groupId) {
    const id = String(groupId ?? '').trim();
    if (id === '') return false;
    if (groupMode === 'all') return true;
    if (groupMode === 'list') return groupIds.has(id);
    return false;
  }

  function senderLabel(event) {
    const sender = event !== null && typeof event === 'object' && event.sender !== null && typeof event.sender === 'object' ? event.sender : {};
    const card = typeof sender.card === 'string' ? sender.card.trim() : '';
    if (card !== '') return card;
    const nick = typeof sender.nickname === 'string' ? sender.nickname.trim() : '';
    if (nick !== '') return nick;
    return event !== null && typeof event === 'object' && event.user_id !== undefined ? String(event.user_id) : '某人';
  }

  function sizeLabel(bytes) {
    const n = Number(bytes);
    if (Number.isFinite(n) === false || n <= 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

 /** 引用/撤回要的原文：拿不到就返回空串，让调用方少写一段而不是编造。 */
  async function quotedText(messageId) {
    const id = String(messageId ?? '').trim();
    if (id === '') return '';
    try {
      const body = await onebot('get_msg', { message_id: id });
      const text = segmentText(body?.data?.message) || String(body?.data?.raw_message ?? '').trim();
      if (text === '') return '';
      return text.length > quoteMaxChars ? text.slice(0, quoteMaxChars) + '…' : text;
    } catch {
      return '';
    }
  }

 // ---- 合并转发：整包落盘 + 一行摘要 + 可拆---------------------
 // 为什么不再压成一行：压成一行只能塞前 N 条，而助手要看的往往就在后面，等于替助手决定了
 // 什么重要。现在整包存成文件、入站只给一行摘要和那个 id，要看就自己用
 // qq_forward_unpack 拆——上下文不涨，内容一条都不丢。

 /** 只留最新这么多个包；再多就是无底洞（助手的盘不该被转发撑满）。 */
  const FORWARD_KEEP = 50;
  const FORWARD_UNPACK_DEFAULT = 30;
  const FORWARD_UNPACK_MAX = 100;

 /**
 * 包放哪儿：config.forwardDir 显式指定，否则放宿主的插件数据目录下面；
 * 宿主没给数据目录就报清楚，不猜一个路径。
 */
  function forwardsDir() {
    const declared = typeof context.config.forwardDir === 'string' ? context.config.forwardDir.trim() : '';
    if (declared !== '') return path.resolve(declared);
    if (typeof context.dataDir !== 'string' || context.dataDir === '') throw new Error('life-qq needs config.forwardDir or a host dataDir');
    return path.join(path.resolve(context.dataDir), 'forwards');
  }

 /**
 * 转发 id → 文件名：只留 [A-Za-z0-9_-]，别的字一个都不留、长度也封顶。
 * 这样 id 无论是什么都不可能变成 './' 或绝对路径——路径穿越在拼之前就没有了落脚的地方。
 */
  function forwardSafeId(raw) {
    const id = String(raw ?? '').trim();
    const safe = id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
    return safe === '' ? '_' : safe;
  }

 /** 一个转发包的文件名（绝对路径）。 */
  function forwardFile(raw) {
    return path.join(forwardsDir(), forwardSafeId(raw) + '.json');
  }

 /** 清掉最旧的，只留 FORWARD_KEEP 个。按修改时间排，同一毫秒的按名字排（结果可复现）。 */
  function pruneForwardPackages(dir) {
    let names;
    try { names = readdirSync(dir); } catch { return 0; }
    const files = [];
    for (const name of names) {
      if (name.endsWith('.json') === false) continue;
      try {
        const info = statSync(path.join(dir, name));
        if (info.isFile()) files.push({ name, at: info.mtimeMs });
      } catch { /* 下一轮再清 */ }
    }
    if (files.length <= FORWARD_KEEP) return 0;
    files.sort((left, right) => (left.at - right.at) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    let removed = 0;
    for (const file of files.slice(0, files.length - FORWARD_KEEP)) {
      try { unlinkSync(path.join(dir, file.name)); removed += 1; } catch { /* 下一轮再清 */ }
    }
    return removed;
  }

 /**
 * 整包落盘。存不下来不算失败：摘要照样给助手，只是不告诉助手一个拆不开的 id——
 * 反过来（给了 id 却打不开）助手只会以为东西丢了。
 */
  function storeForwardPackage(pkg) {
    const dir = forwardsDir();
    const file = path.join(dir, forwardSafeId(pkg.id) + '.json');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify({
        id: pkg.id,
        at: new Date().toISOString(),
        count: pkg.messages.length,
        sender: pkg.sender,
        messages: pkg.messages,
      }, null, 2) + '\n', 'utf8');
      pruneForwardPackages(dir);
      return true;
    } catch (error) {
      context.log('forward package not stored: ' + String((error && (error.code || error.message)) || error));
      return false;
    }
  }

 /** 压成一行、截到 max 个字：摘要里不能有换行，否则一行就变成一片。 */
  function clipOneLine(text, max) {
    const flatText = String(text ?? '').replace(/\s+/g, ' ').trim();
    return flatText.length > max ? flatText.slice(0, max) : flatText;
  }

 // 合并转发里的图：以前包里每张图只留一句 [图片]，字节一个都没拿下来，
 // 助手拆开看到的就是一对方括号。现在拆包时先把图取下来、放一份进助手的收件箱，标记里直接给路径。
  const FORWARD_IMAGE_MAX = 8;
  const FORWARD_IMAGE_BUDGET_MS = 15000;

 /**
 * 一条转发里的图片：取下来、落进助手屋里、返回按顺序的替换文案。
 * 取不到/太多/超时都翻成一句人话，绝不静默丢（助手至少知道"这里本来有张图"）。
 */
  async function forwardRowImages(message, budget, deadline) {
    const segments = Array.isArray(message) ? message : [];
    const replacements = [];
    const images = [];
    for (const segment of segments) {
      if (segment === null || typeof segment !== 'object' || segment.type !== 'image') continue;
      const data = segment.data !== null && typeof segment.data === 'object' ? segment.data : {};
      const mark = isStickerSegment(data) ? STICKER_MARK : IMAGE_MARK;
      if (budget.left <= 0) { replacements.push(mark + '（这条转发里图太多，这张没展开）'); continue; }
      if (Date.now() > deadline) { replacements.push(mark + '（取图超时，这张没展开）'); continue; }
      budget.left -= 1;
      const got = await fetchImage(data);
      if (got.image === undefined || got.image === null) { replacements.push(got.text); continue; }
      const shown = keepImageInInbox(got.image);
      const where = shown !== '' ? shown : got.image.path;
      images.push({ path: got.image.path, shown: where, bytes: got.image.bytes, mediaType: got.image.mediaType });
      replacements.push(mark + ' → ' + where);
    }
    return { replacements, images };
  }

 /** 入站看到的合并转发：数字（几条）、来自谁、前两条各截 40 字，外加那个可拆的 id。 */
  async function forwardLine(forwardId, event) {
    const id = String(forwardId ?? '').trim();
    if (id === '') return '[合并转发] （拿不到内容）';
    let rows;
    try {
      const body = await onebot('get_forward_msg', { id });
      rows = Array.isArray(body?.data?.messages) ? body.data.messages : [];
    } catch {
      return '[合并转发] （拿不到内容）';
    }
    const sender = senderLabel(event);
    if (rows.length === 0) return '[合并转发 0 条] 来自 ' + sender + '，里面没有能读的内容';
    const messages = [];
    const budget = { left: FORWARD_IMAGE_MAX };
    const deadline = Date.now() + FORWARD_IMAGE_BUDGET_MS;
    for (const row of rows) {
      const who = row !== null && typeof row === 'object' && row.sender !== null && typeof row.sender === 'object'
        ? String(row.sender.card || row.sender.nickname || row.sender.user_id || '')
        : '';
 // describeMessage：文字照抄，非文字段给 [图片]/[语音]/[文件 x] 这类标记——一段都不丢。
 // 图片先把字节取下来，标记换成"图在哪"；取不到才退回那句 [图片]。
      const picked = await forwardRowImages(row?.message, budget, deadline);
      const said = describeMessage(row?.message, picked.replacements) || String(row?.raw_message ?? '').trim() || '（非文字）';
      const when = Number(row?.time) > 0 ? new Date(Number(row.time) * 1000).toISOString() : null;
      messages.push(picked.images.length === 0 ? { who, text: said, at: when } : { who, text: said, at: when, images: picked.images });
    }
    const stored = storeForwardPackage({ id, sender, messages });
    const preview = messages.slice(0, 2).map((message) => clipOneLine(message.text, 40)).join(' ／ ');
    const imagesTotal = messages.reduce((sum, message) => sum + (Array.isArray(message.images) ? message.images.length : 0), 0);
    const tail = stored
      ? '（要拆开看就用 qq_forward_unpack，id=' + id + '）'
      : '（这份没存下来，拆不了）';
    return '[合并转发 ' + messages.length + ' 条' + (imagesTotal > 0 ? '，其中 ' + imagesTotal + ' 张图已存进你收件箱' : '')
      + '] 来自 ' + sender + '，大致是在说：' + preview + '…' + tail;
  }

  context.tool('qq_forward_unpack', {
    description: '拆开一条合并转发，逐条读：给 id（入站摘要里那个），from 是第几条起（默认 1），count 是看几条（默认 30，最多 100）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '转发 id（入站摘要是 [合并转发 N 条] … id=xxx 里那个）' },
        from: { type: 'integer', description: '从第几条开始，默认 1' },
        count: { type: 'integer', description: '看几条，默认 30，最多 100' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(args) {
      const rawId = requireText(args?.id, 'qq_forward_id_missing');
      const dir = forwardsDir();
      const file = forwardFile(rawId);
 // 安全化之后落点只可能是这个目录里的一个文件；这一句是双保险，不是主防线。
      if (path.dirname(file) !== dir) throw fail('qq_forward_missing', rawId);
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        throw fail('qq_forward_missing', rawId);
      }
      const all = Array.isArray(pkg?.messages) ? pkg.messages : [];
      const rawFrom = args?.from === undefined || args?.from === null ? 1 : args.from;
      if (Number.isInteger(rawFrom) === false || rawFrom < 1) throw fail('qq_forward_bad_range', 'from ' + String(rawFrom));
      const rawCount = args?.count === undefined || args?.count === null ? FORWARD_UNPACK_DEFAULT : args.count;
      if (Number.isInteger(rawCount) === false || rawCount < 1) throw fail('qq_forward_bad_range', 'count ' + String(rawCount));
      const count = Math.min(rawCount, FORWARD_UNPACK_MAX);
      const start = rawFrom - 1;
      const slice = all.slice(start, start + count);
      const sender = String(pkg?.sender ?? '').trim();
      const head = '合并转发 ' + all.length + ' 条' + (sender === '' ? '' : '（来自 ' + sender + '）')
        + '，这次给第 ' + rawFrom + '–' + (start + slice.length) + ' 条：';
      if (slice.length === 0) return head + '\n（这一段没有内容）';
      const lines = [];
      for (const message of slice) {
        const when = typeof message?.at === 'string' ? clockShort(Date.parse(message.at) / 1000) : '';
        const who = String(message?.who ?? '').trim();
        const said = String(message?.text ?? '').trim() || '（非文字）';
        lines.push((when === '' ? '' : when + ' ') + (who === '' ? '' : who + '：') + said);
      }
      const withImages = slice.reduce((sum, message) => sum + (Array.isArray(message?.images) ? message.images.length : 0), 0);
      const note = withImages > 0
        ? '\n（这条转发里有 ' + withImages + ' 张图，已经存进你收件箱：标记后面就是路径，要看就用 view_image，要改就用 edit_image。）'
        : '';
      return (head + '\n' + lines.join('\n') + note).slice(0, 4000);
    },
  });

 /**
 * 按字节认图（不信扩展名）：能直接交给模型的四种 + BMP（插件转 PNG）+ 三种认得但看不了的。
 */
  function sniffImage(bytes) {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (bytes.length >= 6 && bytes.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
    if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
    if (bytes.length >= 4 && ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00)
      || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))) return 'image/tiff';
    if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
      const brand = bytes.toString('ascii', 8, 12).toLowerCase();
      if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif';
      if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1') || brand.startsWith('msf1')) return 'image/heic';
    }
    return null;
  }

  const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
    return table;
  })();

  function crc32(buffer) {
    let crc = -1;
    for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
  }

  function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  }

 /** BMP（24/32 位、不压缩）→ PNG。别的 BMP 变体返回 null，交回调用方报"看不了"。 */
  function bmpToPng(bytes) {
    try {
      const dataOffset = bytes.readUInt32LE(10);
      const headerSize = bytes.readUInt32LE(14);
      if (headerSize < 40) return null;
      const width = bytes.readInt32LE(18);
      const rawHeight = bytes.readInt32LE(22);
      const topDown = rawHeight < 0;
      const height = Math.abs(rawHeight);
      const bpp = bytes.readUInt16LE(28);
      const compression = bytes.readUInt32LE(30);
      if (compression !== 0 || (bpp !== 24 && bpp !== 32) || width <= 0 || height <= 0) return null;
      const stride = Math.floor((bpp * width + 31) / 32) * 4;
      const channels = bpp / 8;
      const rowBytes = width * channels + 1;
      const raw = Buffer.alloc(rowBytes * height);
      for (let y = 0; y < height; y += 1) {
        const srcY = topDown ? y : height - 1 - y;
        const src = dataOffset + srcY * stride;
        const dst = y * rowBytes;
        raw[dst] = 0;
        for (let x = 0; x < width; x += 1) {
          const s = src + x * channels;
          const d = dst + 1 + x * channels;
          raw[d] = bytes[s + 2];
          raw[d + 1] = bytes[s + 1];
          raw[d + 2] = bytes[s];
          if (channels === 4) raw[d + 3] = bytes[s + 3];
        }
      }
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(width, 0);
      ihdr.writeUInt32BE(height, 4);
      ihdr[8] = 8;
      ihdr[9] = channels === 4 ? 6 : 2;
      return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
      ]);
    } catch {
      return null;
    }
  }

 /** 图落盘、不进内存：宿主那边读一张、准入一张、删一张（15×20 MB 也不会把内存撑爆）。 */
  function saveImageBytes(bytes, mediaType) {
    const ext = mediaType === 'image/png' ? '.png' : mediaType === 'image/jpeg' ? '.jpg'
      : mediaType === 'image/webp' ? '.webp' : '.gif';
    const name = createHash('sha1').update(bytes).digest('hex') + ext;
    mkdirSync(imageDir, { recursive: true });
    const target = path.join(imageDir, name);
    writeFileSync(target, bytes);
    return target;
  }

 /**
 * 清扫：只清"谁也不要"的孤儿图。
 * 还在宿主队列里（pending.json）= 助手还没看过 → 无论放多久都不动；
 * 助手处理过一次的图由宿主当场删掉，轮不到这里。
 */
  function sweepImages() {
    try {
      let queued = new Set();
      try {
        const raw = readFileSync(path.join(imageDir, PENDING_FILE), 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.items)) {
          queued = new Set(parsed.items.map((item) => (item !== null && typeof item === 'object' ? item.path : null)).filter(Boolean));
        }
      } catch { /* 没有队列文件 = 没有要保护的 */ }
      const nowMs = Date.now();
      for (const name of readdirSync(imageDir)) {
        if (name === PENDING_FILE || name === PENDING_FILE + '.tmp') continue;
        const full = path.join(imageDir, name);
        if (queued.has(full)) continue;
        try { if (nowMs - statSync(full).mtimeMs > imageKeepMs) unlinkSync(full); } catch { /* 下一轮再清 */ }
      }
    } catch { /* 目录还不存在 */ }
  }

 /**
 * 一张图 → { text, image? }：text 是助手读到的标记，image 是宿主能读的落盘路径。
 * 取不到/看不了一律给一句人话标记，绝不静默丢。
 */
  async function fetchImage(data) {
    const url = typeof data?.url === 'string' ? data.url.trim() : '';
    if (url === '') return { text: IMAGE_MARK + '（没取到）' };
    let bytes;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(imageTimeoutMs) });
      if (response.ok === false) return { text: IMAGE_MARK + '（没取到，HTTP ' + response.status + '）' };
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      const name = String((error && error.name) || '');
      return { text: IMAGE_MARK + (name === 'TimeoutError' ? '（取图超时）' : '（没取到）') };
    }
    if (bytes.length === 0) return { text: IMAGE_MARK + '（空文件）' };
    if (bytes.length > imageMaxBytes) return { text: IMAGE_MARK + '（太大，' + (bytes.length / 1048576).toFixed(1) + ' MB）' };
    let mediaType = sniffImage(bytes);
    if (mediaType === null) return { text: IMAGE_MARK + '（格式不认识）' };
    if (mediaType === 'image/bmp') {
      const png = bmpToPng(bytes);
      if (png === null) return { text: IMAGE_MARK + '（BMP 变体看不了）' };
      bytes = png;
      mediaType = 'image/png';
    }
    if (IMAGE_PASS.includes(mediaType) === false) {
      return { text: IMAGE_MARK + '（' + mediaType.replace('image/', '') + ' 格式看不了）' };
    }
    try {
      sweepImages();
      const target = saveImageBytes(bytes, mediaType);
      if (attachImages === false) return { text: IMAGE_MARK + '（存下来了，但现在的模型看不了图）' };
      return { text: IMAGE_MARK, image: { path: target, mediaType, bytes: bytes.length } };
    } catch {
      return { text: IMAGE_MARK + '（存不下来）' };
    }
  }

 /** 文件名去毒：只留一个名字（不带目录、不带控制字符、不以点开头），长度封顶。 */
  function safeFileName(raw) {
    const base = String(raw ?? '')
      .replace(/[\\/]+/g, '_')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/^[.\s]+/, '')
      .trim();
    const name = base === '' ? 'file' : base;
    return name.length > 80 ? name.slice(0, 80) : name;
  }

 /** 落点：同名就加 -2、-3……，不覆盖助手手上已有的那一份。 */
  function fileTarget(name) {
    mkdirSync(fileDir, { recursive: true });
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let target = path.join(fileDir, name);
    for (let n = 2; existsSync(target); n += 1) {
      if (n > 50) throw new Error('too many same names');
      target = path.join(fileDir, stem + '-' + n + ext);
    }
    return target;
  }

 /** 标记里给助手看的路：在助手屋里就给相对路径（room_read 用这个），不在才给绝对路径。 */
  function fileShown(target) {
    const base = typeof context.env.homeRoot === 'string' && context.env.homeRoot !== '' ? context.env.homeRoot : fileDir;
    const relative = path.relative(base, target);
    return relative !== '' && relative.startsWith('..') === false ? relative.split(path.sep).join('/') : target;
  }

 /**
 * 图片也落一份进助手的收件箱。
 *
 * 图片以前只存在插件数据目录里（助手的禁区），宿主管道虽然能看，但 edit_image
 * 只认"屋里的文件"——所以"你发助手的图助手无法二创"。同一份字节再放个名字到 inbox，
 * 名字用内容哈希：同一张图发十次也只有一份，不会把收件箱刷满。
 */
  function keepImageInInbox(image) {
    try {
      const ext = path.extname(image.path).toLowerCase() || '.png';
      const hash = path.basename(image.path, path.extname(image.path)).slice(0, 12);
      const target = path.join(fileDir, 'img-' + hash + ext);
      if (existsSync(target) === false) {
        mkdirSync(fileDir, { recursive: true });
        copyFileSync(image.path, target);
        sweepFiles();
      }
      return fileShown(target);
    } catch {
      return '';
    }
  }

 /** 只留最新的 FILE_KEEP 份：磁盘是有限的，别人发的东西不该无限堆在助手屋里。 */
  function sweepFiles() {
    try {
      const entries = [];
      for (const name of readdirSync(fileDir)) {
        const full = path.join(fileDir, name);
        try {
          const stat = statSync(full);
          if (stat.isFile()) entries.push({ full, at: stat.mtimeMs });
        } catch { /* 正在被删 */ }
      }
      if (entries.length <= FILE_KEEP) return;
      entries.sort((left, right) => left.at - right.at);
      for (const entry of entries.slice(0, entries.length - FILE_KEEP)) {
        try { unlinkSync(entry.full); } catch { /* 下一轮再清 */ }
      }
    } catch { /* 目录还不存在 */ }
  }

 /** 下载地址：事件里带了就用；没带就问协议端要（私聊/群各一个动作）。 */
  async function fileUrl(data, event) {
    const inline = typeof data?.url === 'string' ? data.url.trim() : '';
    if (/^https?:\/\//i.test(inline)) return inline;
    const fileId = String(data?.file_id ?? data?.id ?? '').trim();
    if (fileId === '') return '';
    const groupId = event !== null && typeof event === 'object' && event.group_id !== undefined ? String(event.group_id) : '';
    let params;
    if (groupId === '') {
      params = { user_id: Number(event?.user_id), file_id: fileId };
    } else {
      params = { group_id: Number(groupId), file_id: fileId };
      if (data?.busid !== undefined && Number.isFinite(Number(data.busid))) params.busid = Number(data.busid);
    }
    try {
      const body = await onebot(groupId === '' ? 'get_private_file_url' : 'get_group_file_url', params);
      const url = typeof body?.data?.url === 'string' ? body.data.url.trim() : '';
      return /^https?:\/\//i.test(url) ? url : '';
    } catch { return ''; }
  }

 /**
 * 一条文件消息 → 一句话标记。能下载就落进助手屋里、标记里给路径；不能就明说为什么。
 * 绝不静默丢：助手至少要知道"有人发过一个叫 X 的文件"。
 */
  async function receiveFile(data, event) {
    const name = safeFileName(String(data?.name ?? data?.file ?? ''));
    const declared = Number(data?.size ?? data?.file_size ?? 0);
    const size = sizeLabel(declared);
    const head = '[文件 ' + name + (size === '' ? '' : ' ' + size);
    const limit = runtimeNow().mediaMaxBytes;
    if (Number.isFinite(declared) && declared > limit) {
      return head + '，太大（门槛 ' + sizeLabel(limit) + '）]';
    }
    const url = await fileUrl(data, event);
    if (url === '') return head + '，没拿到下载地址]';
    let bytes;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(fileTimeoutMs) });
      if (response.ok === false) return head + '，没拿到（HTTP ' + response.status + '）]';
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      const kind = String((error && error.name) || '');
      return head + (kind === 'TimeoutError' ? '，下载超时]' : '，没拿到]');
    }
    if (bytes.length === 0) return head + '，下载下来是空的]';
    if (bytes.length > limit) return head + '，太大（门槛 ' + sizeLabel(limit) + '）]';
    try {
      const target = fileTarget(name);
      writeFileSync(target, bytes);
      sweepFiles();
      return head + ' → ' + fileShown(target) + ']';
    } catch {
      return head + '，存不下来]';
    }
  }

 /** 按原顺序把消息段拼成一句话；认不出的段直接跳过（不编造）。 */
  async function composeSegments(event, selfId) {
    const segments = event !== null && typeof event === 'object' && Array.isArray(event.message) ? event.message : [];
    const parts = [];
    const images = [];
    let voices = 0;
    for (const segment of segments) {
      if (segment === null || typeof segment !== 'object') continue;
      const data = segment.data !== null && typeof segment.data === 'object' ? segment.data : {};
      if (segment.type === 'text' && typeof data.text === 'string' && data.text.trim() !== '') {
        parts.push(data.text.trim());
        continue;
      }
      if (segment.type === 'image') {
        if (images.length >= IMAGE_MAX_PER_MESSAGE) { parts.push(IMAGE_MARK + '（这条消息图太多，没看全）'); continue; }
        const sticker = isStickerSegment(data);
        const picture = await fetchImage(data);
        let landed = '';
        if (picture.image !== undefined) {
          images.push(picture.image);
          if (sticker) {
 // 别人发的表情包留一份到收件箱——助手要不要收进图库由助手决定，但得先存得下来。
            try { harvestSticker(picture.image, data, event); } catch { /* 收件箱写不进去不影响助手看图 */ }
          } else {
 // 普通图片：再放一份带名字的到助手屋里，助手才能拿它当二创的底图。
            landed = keepImageInInbox(picture.image);
          }
        }
        const shown = sticker ? picture.text.replace(/^\[图片\]/, STICKER_MARK) : picture.text;
        parts.push(landed === '' ? shown : shown.replace(/^\[图片\]/, '[图片 → ' + landed + ']'));
        continue;
      }
      if (segment.type === 'record' && voices < VOICE_MAX_PER_MESSAGE) {
        voices += 1;
        parts.push(await transcribeRecord(data));
        continue;
      }
      if (segment.type === 'reply') {
        const quote = await quotedText(data.id === undefined ? '' : String(data.id));
        if (quote !== '') parts.push('（引用「' + quote + '」）');
        continue;
      }
      if (segment.type === 'file') {
        parts.push(await receiveFile(data, event));
        continue;
      }
      if (segment.type === 'forward') {
        parts.push(await forwardLine(data.id === undefined ? '' : String(data.id), event));
        continue;
      }
      if (segment.type === 'at') {
        const qq = data.qq === undefined ? '' : String(data.qq);
        parts.push('@' + (selfId !== null && qq === selfId ? '你' : (qq === '' ? '某人' : qq)));
        continue;
      }
    }
    return { parts, voices, images };
  }

 // ---- 入口：谁在 QQ 上说话，能不能到助手那儿 ----------------------------------
  context.inbound('qq_recv', (emit) => {
    const wsEndpoint = String(context.config.wsEndpoint ?? '').trim();
    if (wsEndpoint === '') throw new Error('life-qq needs config.wsEndpoint for inbound');
    if (typeof WebSocket !== 'function') throw new Error('life-qq needs a WebSocket implementation');
 // 协议端的 WS 服务器有自己的一份 token（用 HTTP 那份打 WS 是 401），所以这里单独取。
    let wsToken = typeof context.env.onebotWsToken === 'string' ? context.env.onebotWsToken : '';
    const wsTokenPath = typeof context.config.wsTokenPath === 'string' ? context.config.wsTokenPath.trim() : '';
    if (wsToken === '' && wsTokenPath !== '') {
      try { wsToken = readFileSync(wsTokenPath, 'utf8').trim(); } catch { throw new Error('life-qq cannot read config.wsTokenPath'); }
      if (wsToken === '') throw new Error('life-qq config.wsTokenPath is empty');
    }
    if (wsToken === '') wsToken = token;
    const reconnectMs = Number.isInteger(context.config.reconnectMs) && context.config.reconnectMs > 0 ? context.config.reconnectMs : 3000;
    const maxReconnectMs = Number.isInteger(context.config.maxReconnectMs) && context.config.maxReconnectMs > 0 ? context.config.maxReconnectMs : 60000;

    const handle = (raw) => {
      let event;
      try { event = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch { return; }
      if (event === null || typeof event !== 'object') return;
      const selfId = event.self_id === undefined ? null : String(event.self_id);
      if (event.post_type === 'message') { void handleMessage(event, selfId); return; }
      if (event.post_type === 'notice' && noticesEnabled) { void handleNotice(event, selfId); return; }
      if (event.post_type === 'request' && noticesEnabled) { void handleRequest(event, selfId); return; }
    };

 /** 消息：私聊照原样；群聊加「[群 名字] 谁：」前缀，且必须在听群名单里。 */
    async function handleMessage(event, selfId) {
      const isGroup = event.message_type === 'group';
      if (isGroup === false && event.message_type !== 'private') return;
      const from = event.user_id === undefined ? '' : String(event.user_id);
      if (selfId !== null && from === selfId) return;
      const groupId = isGroup && event.group_id !== undefined ? String(event.group_id) : '';
      if (isGroup && groupAllowed(groupId) === false) {
        context.log('inbound ignored: group ' + (groupId === '' ? '?' : groupId) + ' is not in the group allow list');
        return;
      }
      const { parts, voices, images } = await composeSegments(event, selfId);
      const composed = parts.join(' ').trim();
      if (composed === '') {
        context.log('inbound ignored: nothing readable in message from ' + from);
        return;
      }
      const messageId = event.message_id === undefined ? '' : String(event.message_id);
      const groupName = typeof event.group_name === 'string' && event.group_name.trim() !== '' ? event.group_name.trim() : groupId;
 // 群号必须带进来：助手只有群名时没法往对的群说话（两个群同名、或者名字改了都认不出来）。
      const text = isGroup ? '[群 ' + groupName + ' ' + groupId + '] ' + senderLabel(event) + '：' + composed : composed;
 // 引用默认指向"助手最近收到的这条"：只记一条，不替助手攒一整本聊天记录。
      lastInbound = { messageId, at: Date.now(), from, preview: composed.slice(0, 40) };
      await emit({
        channel: 'qq',
        from,
        text,
        messageId,
        at: new Date().toISOString(),
        voice: voices > 0,
        group: isGroup ? groupId : null,
        ...(images.length > 0 ? { images } : {}),
      });
    }

 /** 通知：戳一戳 / 撤回 / 成为好友。助手没有"手"去处理，只负责知道。 */
    async function handleNotice(event, selfId) {
      const type = String(event.notice_type ?? '');
      const sub = String(event.sub_type ?? '');
      const actor = event.user_id === undefined ? '' : String(event.user_id);
      if (actor === '') return;
      if (selfId !== null && actor === selfId) return;
      const groupId = event.group_id === undefined ? '' : String(event.group_id);
      if (groupId !== '' && groupAllowed(groupId) === false) return;
      const messageId = event.message_id === undefined ? '' : String(event.message_id);
      let text = '';
      if (type === 'notify' && sub === 'poke') {
        text = '[戳一戳] ' + (groupId === '' ? '对方' : '群里有人') + '戳了你一下';
      } else if (type === 'friend_recall') {
        const quote = await quotedText(messageId);
        text = '[撤回] 对方撤回了一条消息' + (quote === '' ? '' : '：「' + quote + '」');
      } else if (type === 'group_recall') {
        const quote = await quotedText(messageId);
        text = '[撤回·群 ' + groupId + '] 有人撤回了一条消息' + (quote === '' ? '' : '：「' + quote + '」');
      } else if (type === 'friend_add') {
        text = '[好友] 对方成了你的好友';
      } else {
        return;
      }
      await emit({
        channel: 'qq', from: actor, text, messageId,
        at: new Date().toISOString(), voice: false, group: groupId === '' ? null : groupId, notice: type,
      });
    }

 /** 请求：好友申请 / 进群邀请。现在只让助手知道，接不接受还没有手。 */
    async function handleRequest(event, selfId) {
      const kind = String(event.request_type ?? '');
      const sub = String(event.sub_type ?? '');
      const actor = event.user_id === undefined ? '' : String(event.user_id);
      const groupId = event.group_id === undefined ? '' : String(event.group_id);
 // 邀请/申请不算聊天流量，不看听群名单；但发起来的人仍要过"听谁"那道闸。
      if (actor === '' && groupId === '') return;
      if (selfId !== null && actor === selfId) return;
      const comment = typeof event.comment === 'string' ? event.comment.trim() : '';
      const tail = comment === '' ? '' : '，附言：「' + (comment.length > quoteMaxChars ? comment.slice(0, quoteMaxChars) + '…' : comment) + '」';
      let text = '';
      if (kind === 'friend') text = '[好友申请] ' + actor + ' 请求加你为好友' + tail;
      else if (kind === 'group' && sub === 'invite') text = '[进群邀请] 群 ' + groupId + ' 邀请你进群' + tail;
      else if (kind === 'group') text = '[入群申请] ' + actor + ' 申请进群 ' + groupId + tail;
      else return;
      await emit({
        channel: 'qq', from: actor === '' ? String(groupId) : actor, text,
        messageId: '', at: new Date().toISOString(), voice: false,
        group: groupId === '' ? null : groupId, request: kind,
      });
    }

    let attempt = 0;
    const connect = () => {
      const url = wsEndpoint + (wsEndpoint.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(wsToken);
      let socket;
      try { socket = new WebSocket(url); } catch (error) {
        context.log('inbound ws could not start: ' + String(error?.message || error));
        return;
      }
      socket.addEventListener('open', () => {
        attempt = 0;
        context.log('inbound ws open');
      });
      socket.addEventListener('message', (event) => handle(event?.data));
      socket.addEventListener('error', () => { /* close 会跟着来 */ });
      socket.addEventListener('close', (event) => {
        attempt += 1;
        if (attempt === 1) context.log('inbound ws closed code=' + String(event?.code) + ' reason=' + String(event?.reason || ''));
        const wait = Math.min(maxReconnectMs, reconnectMs * Math.pow(2, Math.min(attempt - 1, 5)));
        if (attempt <= 5) context.log('inbound ws closed, retry in ' + wait + 'ms (attempt ' + attempt + ')');
        setTimeout(connect, wait);
      });
    };
    connect();
  });

  const shape = mode + (mode === 'list' ? '(' + listed.length + ' listed)' : '');
  context.log('life-qq ready: ' + endpoint + ' -> recipients ' + shape + (blacklist.size > 0 ? ' blacklist ' + blacklist.size : ''));
}
