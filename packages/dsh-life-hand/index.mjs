/**
 * 助手的手：一个真正能跑命令、读写文件的工作间。
 *
 * 插件自己**不碰进程、不碰文件系统**——那是宿主的事：这条门（surface:exec）交给
 * 插件的是 context.hands，里面每条路径都已经过宿主的沙箱（landlock 白名单 + ulimit +
 * 超时）。所以助手"能跑命令"这件事的边界不在这份代码里，在宿主那一侧；插件只负责把
 * 结果说给助手听。
 *
 * 五种动作，各自只做一件事：
 * run 跑一条命令（工作区里）
 * read_file 读一个文本文件（按行）
 * write_file 写一个文本文件
 * list_files 看一个目录
 * view_image 看一张图（字节交给附件服务，助手这一轮真的看得见）
 *
 * 失败一律翻译成一句人话，不抛异常：助手需要知道"没跑成"和"为什么"，而不是一段堆栈。
 *
 * 除了 view_image，四只工具**只回一句话（字符串）**，不回对象。原因不是审美：宿主校验工具输出的
 * 规则是"要么是字符串，要么按你声明的 output.schema 验"；这四只当时回了对象却没声明 schema，
 * 于是助手每次调 run 都吃到一句 Error: tool "run" returned invalid output: "value" must be a string
 * ——实际踩过：助手为此报了两轮"跑命令就报错"。要回对象就得连带维护一份和返回体一一对应
 * 的 schema；回字符串没有这个问题。
 */

const REFUSALS = {
  not_absolute: '得是绝对路径（从工作区根写起）。',
  outside_allowed: '这个地方不在我的工作区里，我不碰。',
  not_found: '那儿没有这个东西。',
  not_a_file: '那是个目录，不是文件。',
  not_a_directory: '那是个文件，不是目录。',
  too_large: '太大了，我这边有上限。',
  bad_argument: '参数不对。',
  no_launcher: '沙箱没装好，我现在跑不了命令。',
  spawn_failed: '命令没能起来。',
  sandbox_args_refused: '沙箱参数不对，这条我不跑。',
  io_error: '读写的时候出错了。',
  not_image: '那不是一个能看的图片。',
  timeout: '跑太久了，我把它停了。',
};

function refusal(code) {
  return REFUSALS[String(code)] ?? '没成（' + String(code) + '）。';
}

function codeOf(result) {
  return String(result.error ?? result.code ?? 'unknown');
}

function clip(text, max) {
  const value = String(text ?? '');
  return value.length > max ? value.slice(0, max) + '\n…（后面还有，我给截了）' : value;
}

function section(title, body) {
  const text = String(body ?? '').trimEnd();
  return text === '' ? '' : '\n' + title + '：\n' + text;
}

export function create(context) {
  const hands = context.hands;
  const config = context.config ?? {};
 // 显示截断按"不超过助手一轮窗口的 3%"定：
 // 窗口 1,048,576 tokens → 3% ≈ 31,457 tokens；中文最坏情况 1 字 ≈ 1 token，所以取 32,000 字符。
 // 英文/代码按 4 字符 ≈ 1 token 算，同样 32,000 字符只占 0.8%——这是按最坏情况卡的天花板。
  const outputChars = Number.isInteger(config.outputCharsMax) && config.outputCharsMax > 0 ? config.outputCharsMax : 32000;
  const readChars = Number.isInteger(config.readCharsMax) && config.readCharsMax > 0 ? config.readCharsMax : 32000;
  const listEntries = Number.isInteger(config.listEntriesMax) && config.listEntriesMax > 0 ? config.listEntriesMax : 300;

  context.tool('run', {
    description: '在工作间里跑一条命令（sh 里的那些都行：node、git、python3、curl我都装好了）。跑在工作区里，有超时和输出上限；碰不到这台机器的别处。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要跑的命令' },
        cwd: { type: 'string', description: '在哪个目录跑（绝对路径；不给就在工作区根）' },
        timeoutMs: { type: 'integer', description: '最多跑多久（毫秒；不给就用默认的）' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const settings = args ?? {};
      const result = await hands.run({
        command: settings.command,
        ...(typeof settings.cwd === 'string' && settings.cwd !== '' ? { cwd: settings.cwd } : {}),
        ...(Number.isInteger(settings.timeoutMs) ? { timeoutMs: settings.timeoutMs } : {}),
      });
      if (result === null || typeof result !== 'object') return '什么都没回来。';
      if (result.ok !== true) {
        if (result.timedOut === true) {
          return refusal('timeout') + section('错误输出', clip(result.stderr, outputChars));
        }
        return '没跑成（退出码 ' + String(result.code ?? '?') + '）。'
          + section('标准输出', clip(result.stdout, outputChars))
          + section('错误输出', clip(result.stderr, outputChars));
      }
      const tail = result.truncated === true ? '\n（输出太长，后面的我截了）' : '';
      return '跑完了。'
        + section('标准输出', clip(result.stdout, outputChars))
        + section('错误输出', clip(result.stderr, outputChars))
        + tail;
    },
  });

  context.tool('read_file', {
    description: '读一个文本文件，按行给（工作区里，或者我自己存图的那个目录）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件的绝对路径' },
        offset: { type: 'integer', description: '从第几行开始（默认 1）' },
        limit: { type: 'integer', description: '最多几行（默认 2000）' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const settings = args ?? {};
      const result = hands.read({
        path: settings.path,
        ...(Number.isInteger(settings.offset) ? { offset: settings.offset } : {}),
        ...(Number.isInteger(settings.limit) ? { limit: settings.limit } : {}),
      });
      if (result === null || typeof result !== 'object') return '什么都没回来。';
      if (result.ok !== true) return refusal(codeOf(result));
      const from = result.totalLines === 0 ? 0 : (settings.offset ?? 1);
      const to = from + Math.max(result.lines.length - 1, 0);
      const header = result.path + '（共 ' + result.totalLines + ' 行' + (result.truncated === true ? '，这里是第 ' + from + '–' + to + ' 行' : '') + '）';
      return header + '\n\n' + clip(result.content, readChars);
    },
  });

  context.tool('write_file', {
    description: '在工作区里写一个文本文件（父目录会自己建）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件的绝对路径' },
        content: { type: 'string', description: '要写进去的内容' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const settings = args ?? {};
      const result = hands.write({ path: settings.path, content: settings.content });
      if (result === null || typeof result !== 'object') return '什么都没回来。';
      if (result.ok !== true) return refusal(codeOf(result));
      return '写好了：' + result.path + '（' + result.bytes + ' 字节）';
    },
  });

  context.tool('list_files', {
    description: '看一个目录里有什么（工作区里，或者我自己存图的那个目录）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录的绝对路径' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const settings = args ?? {};
      const result = hands.list({ path: settings.path });
      if (result === null || typeof result !== 'object') return '什么都没回来。';
      if (result.ok !== true) return refusal(codeOf(result));
      if (result.entries.length === 0) return result.path + '：空的。';
      const kept = result.entries.slice(0, listEntries);
      const rows = kept.map((entry) => {
        const kind = entry.type === 'dir' ? '目录' : (entry.type === 'link' ? '链接' : '文件');
        const size = entry.type === 'file' && Number.isInteger(entry.size) ? '（' + entry.size + ' 字节）' : '';
        return entry.name + '  ' + kind + size;
      });
      const more = result.entries.length > kept.length ? '\n…还有 ' + (result.entries.length - kept.length) + ' 个没列。' : '';
      return result.path + '（' + result.entries.length + ' 项）：\n' + rows.join('\n') + more;
    },
  });

  context.tool('view_image', {
    description: '看一张图（工作区里，或者我自己存图的那个目录）。看清楚了才说得清它长什么样。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '图片文件的绝对路径' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          mediaType: { type: 'string' },
          byteLength: { type: 'integer' },
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
        },
      },
      render: (_args, value) => {
        if (value === null || typeof value !== 'object' || value.ok !== true) {
          return [{ type: 'text', text: String(value !== null && typeof value === 'object' && typeof value.text === 'string' ? value.text : '没看成。') }];
        }
        const dimensions = value.image === undefined || value.image === null ? '' : '，' + value.image.width + '×' + value.image.height;
        const blind = value.image === undefined || value.image === null ? '（拿到了，但我没看着）' : '';
        const blocks = [{
          type: 'text',
          text: '看见了：' + value.mediaType + dimensions + '，' + value.byteLength + ' 字节，在 ' + value.path + '。' + blind,
        }];
        if (value.image !== undefined && value.image !== null) blocks.push({ type: 'image', attachment: value.image });
        return blocks;
      },
    },
    execute: async (args) => {
      const settings = args ?? {};
      const result = await hands.view({ path: settings.path });
      if (result === null || typeof result !== 'object') return { ok: false, text: '什么都没回来。' };
 // 这一只保留结构：它要把图交给附件服务（type:'image' 那一块），所以有 output.schema + render。
      if (result.ok !== true) return { ok: false, code: codeOf(result), text: refusal(codeOf(result)) };
      return {
        ok: true,
        path: result.path,
        mediaType: result.mediaType,
        byteLength: result.byteLength,
        ...(result.image === null || result.image === undefined ? {} : { image: result.image }),
        text: '看见了：' + result.mediaType + '，' + result.byteLength + ' 字节',
      };
    },
  });
}
