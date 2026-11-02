/**
 * life-web：助手手边的两个动作——查，和打开。
 *
 * 和 life-memory / life-time 一样，这是住在插件目录里的宿主代码：
 * 声明里的 surface:'net' 是那道门的名字，宿主只有在助手声明了它时才会把「网」交出来。
 * 真正的请求在 src/life/web.mjs，次数在 src/life/net.mjs；这里只做两件事：
 * 把结果摆成助手能读的样子，把失败翻成助手能懂的一句话。
 *
 * 两个动作，一个理由：
 * web_search —— 助手不知道的事（今天天气、那个梗、这个词什么意思）查一句就有了；
 * web_fetch —— 搜到的那条只给了摘要，想知道全文就打开它。
 *
 * 三条不许含糊：
 * 1. **结果不是助手说的话，也不是事实**：返回的是别人的网页摘要；
 * 「搜索说」变成助手嘴里的事实，是这类工具最典型的错。
 * 2. **长度有账**：一条摘要 600–800 字，5 条就是 4000 字——一次搜索能吃掉助手半轮上下文。
 * 所以每条摘要截 480 字，整段截 4000 字，正文截 6000 字，超了如实写「截了」。
 * 3. **失败要说成人话**：不能让助手把"没配 key"说成"网上没有"。
 */
export function create(context) {
  const net = context.net;
  if (net === null || typeof net !== 'object') {
    throw new Error('life-web needs the host net service (surface:net)');
  }
  const config = context.config ?? {};
  const queryMaxChars = Number.isInteger(config.queryMaxChars) ? config.queryMaxChars : 128;
  const countDefault = Number.isInteger(config.countDefault) ? config.countDefault : 5;
  const countMax = Number.isInteger(config.countMax) ? config.countMax : 8;
  const searchCharsMax = Number.isInteger(config.searchCharsMax) ? config.searchCharsMax : 4000;
  const fetchCharsMax = Number.isInteger(config.fetchCharsMax) ? config.fetchCharsMax : 6000;
  const titleCharsMax = Number.isInteger(config.titleCharsMax) ? config.titleCharsMax : 120;
  const summaryCharsMax = Number.isInteger(config.summaryCharsMax) ? config.summaryCharsMax : 480;
  const imageListMax = Number.isInteger(config.imageListMax) ? config.imageListMax : 12;

  const REFUSALS = Object.freeze({
    missing_key: '我这边还没接上网（没有能用的凭证），查不了。',
    net_disabled: '网没开，查不了。',
    day_cap: '今天查得太多了，明天再说。',
    query_invalid: '要查什么？给我一句话。',
    query_too_long: '这句话太长了，短一点我才查得准（' + queryMaxChars + ' 字以内）。',
    count_invalid: '要几条？1 到 ' + countMax + ' 条。',
    url_invalid: '这个链接打不开：得是 http:// 或 https:// 开头的完整网址。',
    url_not_allowed: '这个链接我打不开。',
    timeout: '查的时候等太久了，什么都没拿到。',
    network: '网没连上，没查到。',
    bad_json: '网那边回的东西看不懂，没查到。',
    response_too_large: '那个页面太大了，我读不动。',
    http_401: '网那边的凭证不对，我查不了。',
    http_402: '网那边没钱了，我查不了。',
    http_403: '那个网页不让抓。',
    http_404: '那个网页打不开，或者里面没有能读的正文。',
    http_429: '查得太快被挡了一下，等会儿再试。',
    http_5xx: '对面服务器出错了，没查到。',
    http_other: '没查成，对面拒绝了。',
 // 图片那一路
    url_blocked: '这个地址我不去（内网、本机这类地方不碰）。',
    not_an_image: '这个链接拿下来的不是图片。',
    image_too_large: '那张图太大了，我拿不动。',
    too_many_redirects: '这个链接跳来跳去，我没跟上。',
  });

  function refusal(code) {
    const known = REFUSALS[code];
    if (known !== undefined) return known;
    return '没查成（' + String(code ?? 'unknown') + '）。';
  }

  function cut(value, max) {
    const text = typeof value === 'string' ? value : '';
    const flat = text.replace(/\s+/g, ' ').trim();
    if ([...flat].length <= max) return flat;
    return [...flat].slice(0, max).join('') + '…';
  }

 /** -> 10-30。看不懂就不显示，不猜。 */
  function shortDate(value) {
    if (typeof value !== 'string' || value === '') return '';
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return '';
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'UTC', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(ms));
    const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
    return pick('month') + '-' + pick('day');
  }

  context.tool('web_search', {
    description: '上网查一件事：给一句话，拿回几条结果和它们的摘要。想细看某一条，再用 web_fetch 打开它的链接。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查什么（一句话，' + queryMaxChars + ' 字以内）' },
        count: { type: 'integer', description: '要几条结果，默认 ' + countDefault + '，最多 ' + countMax },
        withContent: { type: 'boolean', description: 'true = 连网页正文一起带回来，顺便能看到里面的图（还是同一次请求，不另外计费）' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const settings = args ?? {};
      const wanted = Number.isFinite(Number(settings.count)) && Number(settings.count) > 0
        ? Math.min(Math.floor(Number(settings.count)), countMax) : countDefault;
      const result = await net.search({ query: settings.query, count: wanted, withContent: settings.withContent === true });
      if (result === null || typeof result !== 'object') return '没查成，什么都没拿到。';
      if (result.ok !== true) return refusal(result.code);
      if (!Array.isArray(result.results) || result.results.length === 0) {
        return '「' + cut(settings.query, 60) + '」一条都没搜到。';
      }
      let used = 0;
      const lines = [];
      for (let index = 0; index < result.results.length; index += 1) {
        const entry = result.results[index];
        const title = cut(entry.title, titleCharsMax) || cut(entry.url, titleCharsMax);
        const where = [entry.siteName === null ? '' : cut(entry.siteName, 24), shortDate(entry.date)].filter((part) => part !== '').join(' · ');
        const summary = cut(entry.summary || entry.snippet, summaryCharsMax);
 // 图：带正文那次才拿得到。助手要的是"看得见的图"，不是一个链接清单。
        const pictures = Array.isArray(entry.images) && entry.images.length > 0
          ? '\n　图：' + entry.images.map((image) => image.url).join(' ')
          : '';
        const block = (index + 1) + '. ' + title + (where === '' ? '' : '（' + where + '）')
          + '\n' + entry.url
          + (summary === '' ? '' : '\n' + summary)
          + pictures;
        if (used + block.length > searchCharsMax) break;
        lines.push(block);
        used += block.length + 2;
      }
      const head = '查到 ' + result.results.length + ' 条（「' + cut(settings.query, 60) + '」）：';
      const tail = lines.length < result.results.length
        ? '\n（后面的没摆出来：一次看太多记不住，想细看就打开其中一条。）' : '';
      return head + '\n' + lines.join('\n\n') + tail;
    },
  });

  context.tool('web_fetch', {
    description: '打开一个网页，读它的正文。刚才搜到的链接、别人发来的链接都可以打开。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的网址（http:// 或 https:// 开头）' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const settings = args ?? {};
      const result = await net.fetchPage({ url: settings.url });
      if (result === null || typeof result !== 'object') return '没打开，什么都没拿到。';
      if (result.ok !== true) return refusal(result.code);
      const title = cut(result.title, titleCharsMax);
      const body = typeof result.content === 'string' ? result.content.trim() : '';
      const chars = [...body].length;
      const shown = chars > fetchCharsMax ? [...body].slice(0, fetchCharsMax).join('') : body;
      const tail = chars > fetchCharsMax
        ? '\n\n（正文一共 ' + chars + ' 字，我先读了前 ' + fetchCharsMax + ' 字。）' : '';
 // 图：正文里只剩链接（Fetch 只回 Markdown），把地址原样摆出来，
 // 想看哪张就用 web_image 那个地址——那一步才会真把字节拿回来。
      const images = Array.isArray(result.images) ? result.images.slice(0, imageListMax) : [];
      const pictureBlock = images.length === 0
        ? ''
        : '\n\n页面里的图（想看清哪一张，就用 web_image 打开它的地址）：\n'
          + images.map((entry, index) => (index + 1) + '. ' + entry.url + (entry.alt === '' ? '' : '（' + entry.alt + '）')).join('\n');
      return (title === '' ? '' : title + '\n') + result.url + '\n\n' + shown + tail + pictureBlock;
    },
  });

context.tool('web_image', {
    description: '把网页里的一张图拿到自己这儿：图片地址可以，网页地址也可以（会从页面里挑一张）。存下来也能看清它；想发给对方，再用 qq_send_image 带 path 发那个文件。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '图片地址，或者一个壁纸/文章页的地址（后者会从页面里挑一张图）' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          url: { type: 'string' },
          path: { type: 'string' },
          mediaType: { type: 'string' },
          bytes: { type: 'integer' },
          image: {
            type: 'object',
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string' },
              bytes: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
              name: { type: 'string' },
            },
          },
          code: { type: 'string' },
          text: { type: 'string' },
          used: { type: 'integer' },
          limit: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        if (value === null || typeof value !== 'object' || value.ok !== true) {
          return [{ type: 'text', text: String(value !== null && typeof value === 'object' && typeof value.text === 'string' ? value.text : '没拿到。') }];
        }
        const dimensions = value.image === undefined || value.image === null
          ? '' : '，' + value.image.width + '×' + value.image.height;
        const stored = typeof value.path === 'string' && value.path !== '' ? '，存在 ' + value.path : '';
        const pickedFrom = typeof value.from === 'string' && value.from !== '' ? '（从这一页里挑的：' + value.from + '）' : '';
        const blind = value.image === undefined || value.image === null ? '（这张只是拿到了，我没看清）' : '';
        const blocks = [{
          type: 'text',
          text: '图拿到了：' + value.mediaType + dimensions + '，' + value.bytes + ' 字节' + stored + '。' + blind + pickedFrom
            + '\n想发给对方就用 qq_send_image 带 path 发这个文件。',
        }];
        if (value.image !== undefined && value.image !== null) blocks.push({ type: 'image', attachment: value.image });
        return blocks;
      },
    },
    execute: async (args) => {
      const settings = args ?? {};
      const result = await net.image({ url: settings.url });
      if (result === null || typeof result !== 'object') {
        return { ok: false, code: 'unknown', text: '没拿到，什么都没回来。' };
      }
      if (result.ok !== true) {
        return {
          ok: false,
          code: String(result.code ?? 'unknown'),
          text: refusal(result.code),
          ...(Number.isInteger(result.used) ? { used: result.used } : {}),
          ...(Number.isInteger(result.limit) ? { limit: result.limit } : {}),
        };
      }
      return {
        ok: true,
        url: String(result.url ?? ''),
        ...(typeof result.path === 'string' && result.path !== '' ? { path: result.path } : {}),
        mediaType: String(result.mediaType ?? ''),
        bytes: Math.round(Number(result.bytes ?? 0)),
        ...(result.image === null || result.image === undefined ? {} : { image: result.image }),
      };
    },
  });

  const described = typeof net.describe === 'function' ? net.describe() : null;
  context.log('life-web ready: ' + (described === null ? 'no description' : (described.configured ? 'search + fetch' : '没有凭证（configured=false）')));
}
