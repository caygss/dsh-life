/**
 * 画画：助手开口要一张图，这张图就真的被画出来。
 *
 * 助手**不碰网络、不碰 key**：这条门（surface:image）交给插件的是 context.paint，
 * 里面只有「画一张」这一个动作。请求发给外部生图服务，凭证留在宿主那一侧。
 * 插件只做两件事：把助手说的话整理成一句提示词，把画好的图摆到助手面前。
 *
 * 默认尺寸 1024x1024。
 * 失败一律翻成一句人话——"被内容策略挡了"和"没配好"不能混成同一个"画不出来"。
 */

const REFUSALS = {
  missing_key: '我这边还没接上画图的服务（没有能用的凭证），画不了。',
  image_disabled: '画图没开，画不了。',
  day_cap: '今天画得太多了，明天再画。',
  prompt_invalid: '要画什么？给我一句话。',
  prompt_too_long: '这句太长了，短一点我才画得准。',
  size_invalid: '尺寸不对：写成 宽x高，每边 64 到 4096（比如 1024x1024）。',
  model_invalid: '这个模型我这儿没有。',
  count_invalid: '一次最多画 4 张。',
  timeout: '画太久了，我把它停了。',
  network: '连不上画画那台机器，没画成。',
  bad_json: '对面回的东西看不懂，没画成。',
  http_error: '对面拒绝了这次请求，没画成。',
  content_policy_violation: '这张被挡了（内容策略），换个说法我再试。',
  no_image: '对面说画好了，但没给我图。',
  image_too_large: '那张图太大了，我拿不动。',
  io_error: '存图的时候出错了。',
 // 图生图：底图相关的错误码（宿主侧一半、插件侧一半）
  image_invalid: '要改哪张图？告诉我在屋里的哪个位置（比如 inbox/xxx.png）。',
  image_too_big: '那张图太大了（单张上限 10 MB），我传不上去。',
  image_count_invalid: '一次最多拿 4 张底图。',
  not_found: '屋里没有这个文件。',
  not_a_file: '那不是个文件。',
  is_directory: '那是个目录，不是图。',
  outside_room: '那个路径不在你能看的地方里面。',
  symlink_refused: '那是个链接，不是真文件；链接我不跟。',
  sealed: '那份不是我搬得动的。',
  invalid_path: '这个位置不对（要写成屋里相对路径，例如 inbox/xxx.png）。',
};

function refusal(code) {
  return REFUSALS[String(code)] ?? '没画成（' + String(code) + '）。';
}

export function create(context) {
  const paint = context.paint;
  if (paint === null || typeof paint !== 'object') {
    throw new Error('life-draw needs the host image service (surface:image)');
  }
  const config = context.config ?? {};
  const size = typeof config.size === 'string' && config.size !== '' ? config.size : '1024x1024';
  const promptCharsMax = Number.isInteger(config.promptCharsMax) && config.promptCharsMax > 0 ? config.promptCharsMax : 1200;
  const imagesMax = Number.isInteger(config.imagesMax) && config.imagesMax > 0 ? config.imagesMax : 2;
  const editImagesMax = Number.isInteger(config.editImagesMax) && config.editImagesMax > 0 ? config.editImagesMax : 4;

 /** 画和改回来的都是同一种形状，摆图那段共用一份。 */
  function pack(result, okWord, withSources) {
    const images = [];
    const paths = [];
    for (const entry of Array.isArray(result.images) ? result.images : []) {
      if (entry === null || typeof entry !== 'object') continue;
      if (typeof entry.path === 'string' && entry.path !== '') paths.push(entry.path);
      if (entry.image !== null && entry.image !== undefined) images.push(entry.image);
    }
    const retried = Number.isInteger(result.retries) && result.retries > 0 ? '（被挡过一次，重试成功了）' : '';
    return {
      ok: true,
      count: Number.isInteger(result.count) ? result.count : images.length,
      size: String(result.size ?? size),
      model: String(result.model ?? ''),
      ...(Number.isInteger(result.ms) ? { elapsedMs: result.ms } : {}),
      ...(withSources === true && Number.isInteger(result.sources) ? { sources: result.sources } : {}),
      paths,
      images,
      text: okWord + retried,
    };
  }

  context.tool('draw_image', {
    description: '画一张图：给一句话说清要画什么，等二十几秒，图就出来了（我能看见它，也能把它发出去）。默认 ' + size + '，想要别的尺寸就写 宽x高。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '要画什么（一句话，' + promptCharsMax + ' 字以内；越具体越像）' },
        size: { type: 'string', description: '尺寸，宽x高，每边 64–4096；不给就是 ' + size },
        n: { type: 'integer', description: '画几张，1 到 ' + imagesMax + '；不给就是 1（每多一张要多等二十几秒）' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'integer' },
          size: { type: 'string' },
          model: { type: 'string' },
          elapsedMs: { type: 'integer' },
          paths: { type: 'array', items: { type: 'string' } },
          images: {
            type: 'array',
            items: {
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
          },
          code: { type: 'string' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value === null || typeof value !== 'object' || value.ok !== true) {
          return [{ type: 'text', text: String(value !== null && typeof value === 'object' && typeof value.text === 'string' ? value.text : '没画成。') }];
        }
        const where = Array.isArray(value.paths) && value.paths.length > 0 ? '，放在 ' + value.paths.join(' ') : '';
        const seconds = Number.isInteger(value.elapsedMs) ? '，画了 ' + Math.round(value.elapsedMs / 1000) + ' 秒' : '';
        const blocks = [{ type: 'text', text: '画好了：' + value.count + ' 张，' + value.size + seconds + where + '。' }];
        const list = Array.isArray(value.images) ? value.images : [];
        for (const image of list) {
          if (image !== null && typeof image === 'object' && typeof image.attachmentId === 'string') {
            blocks.push({ type: 'image', attachment: image });
          }
        }
        return blocks;
      },
    },
    execute: async (args) => {
      const settings = args ?? {};
      const prompt = typeof settings.prompt === 'string' ? settings.prompt.trim() : '';
      if (prompt === '') return { ok: false, code: 'prompt_invalid', text: refusal('prompt_invalid') };
      if ([...prompt].length > promptCharsMax) {
        return { ok: false, code: 'prompt_too_long', text: refusal('prompt_too_long') + '（上限 ' + promptCharsMax + ' 字，现在 ' + [...prompt].length + ' 字）' };
      }
      const wanted = Number.isInteger(settings.n) ? Math.min(settings.n, imagesMax) : 1;
      const result = await paint.draw({
        prompt,
        ...(typeof settings.size === 'string' && settings.size !== '' ? { size: settings.size } : {}),
        n: wanted,
      });
      if (result === null || typeof result !== 'object') return { ok: false, text: '什么都没回来。' };
      if (result.ok !== true) {
        const code = String(result.code ?? 'unknown');
        const retried = Number.isInteger(result.retries) && result.retries > 0 ? '\n（试了 ' + (result.retries + 1) + ' 次）' : '';
        return { ok: false, code, text: refusal(code) + retried };
      }
      const images = [];
      const paths = [];
      for (const entry of Array.isArray(result.images) ? result.images : []) {
        if (entry === null || typeof entry !== 'object') continue;
        if (typeof entry.path === 'string' && entry.path !== '') paths.push(entry.path);
        if (entry.image !== null && entry.image !== undefined) images.push(entry.image);
      }
      const retried = Number.isInteger(result.retries) && result.retries > 0 ? '（被挡过一次，重试成功了）' : '';
      return {
        ok: true,
        count: Number.isInteger(result.count) ? result.count : images.length,
        size: String(result.size ?? size),
        model: String(result.model ?? ''),
        ...(Number.isInteger(result.ms) ? { elapsedMs: result.ms } : {}),
        paths,
        images,
        text: '画好了。' + retried,
      };
    },
  });

  context.tool('edit_image', {
    description: '改一张已经有的图：说清要改成什么样，再告诉我那张图在屋里的哪个位置（最多 ' + editImagesMax
      + ' 张，可以几张一起合成一张新的）。要等二十几秒。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '改成什么样（一句话，' + promptCharsMax + ' 字以内；越具体越像）' },
        from: {
          type: 'array',
          items: { type: 'string' },
          description: '底图在屋里的位置，1 到 ' + editImagesMax + ' 个，例如 inbox/xxx.png、mine/yyy.jpg',
        },
        size: { type: 'string', description: '尺寸，宽x高，每边 64–4096；不给就是 ' + size },
        n: { type: 'integer', description: '出几张，1 到 ' + imagesMax + '；不给就是 1' },
      },
      required: ['prompt', 'from'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'integer' },
          sources: { type: 'integer' },
          size: { type: 'string' },
          model: { type: 'string' },
          elapsedMs: { type: 'integer' },
          paths: { type: 'array', items: { type: 'string' } },
          images: {
            type: 'array',
            items: {
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
          },
          code: { type: 'string' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value === null || typeof value !== 'object' || value.ok !== true) {
          return [{ type: 'text', text: String(value !== null && typeof value === 'object' && typeof value.text === 'string' ? value.text : '没改成。') }];
        }
        const where = Array.isArray(value.paths) && value.paths.length > 0 ? '，放在 ' + value.paths.join(' ') : '';
        const seconds = Number.isInteger(value.elapsedMs) ? '，改用了 ' + Math.round(value.elapsedMs / 1000) + ' 秒' : '';
        const blocks = [{ type: 'text', text: '改好了：' + value.count + ' 张，' + value.size + seconds + where + '。' }];
        const list = Array.isArray(value.images) ? value.images : [];
        for (const image of list) {
          if (image !== null && typeof image === 'object' && typeof image.attachmentId === 'string') {
            blocks.push({ type: 'image', attachment: image });
          }
        }
        return blocks;
      },
    },
    execute: async (args) => {
      const settings = args ?? {};
      const prompt = typeof settings.prompt === 'string' ? settings.prompt.trim() : '';
      if (prompt === '') return { ok: false, code: 'prompt_invalid', text: refusal('prompt_invalid') };
      if ([...prompt].length > promptCharsMax) {
        return { ok: false, code: 'prompt_too_long', text: refusal('prompt_too_long') + '（上限 ' + promptCharsMax + ' 字，现在 ' + [...prompt].length + ' 字）' };
      }
      const list = Array.isArray(settings.from)
        ? settings.from.filter((value) => typeof value === 'string' && value !== '')
        : (typeof settings.from === 'string' && settings.from !== '' ? [settings.from] : []);
      if (list.length === 0) return { ok: false, code: 'image_invalid', text: refusal('image_invalid') };
      if (list.length > editImagesMax) return { ok: false, code: 'image_count_invalid', text: refusal('image_count_invalid') };
      const wanted = Number.isInteger(settings.n) ? Math.min(settings.n, imagesMax) : 1;
      const result = await paint.edit({
        prompt,
        from: list,
        ...(typeof settings.size === 'string' && settings.size !== '' ? { size: settings.size } : {}),
        n: wanted,
      });
      if (result === null || typeof result !== 'object') return { ok: false, text: '什么都没回来。' };
      if (result.ok !== true) {
        const code = String(result.code ?? 'unknown');
        const retried = Number.isInteger(result.retries) && result.retries > 0 ? '\n（试了 ' + (result.retries + 1) + ' 次）' : '';
        return { ok: false, code, text: refusal(code) + retried };
      }
      return pack(result, '改好了。', true);
    },
  });
}
