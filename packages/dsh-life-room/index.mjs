/**
 * The first first-party plugin: its room, as two tools the agent can call (W2).
 *
 * This is host code that happens to live in a plugin directory. It is installed, granted
 * and enabled through its plugin table like any other plugin, and its tools reach its tool
 * table only through the same seam - so the path being exercised is the real one. What is
 * deliberately NOT true: a third-party plugin cannot import host modules like this. It
 * would come with its own code and would have to work through granted surfaces.
 *
 * The two tools are views, not a second implementation of the boundary: room.mjs does the
 * resolving, the escape checks and the caps, and this file only turns the result into
 * text the agent can read.
 */
import {
  LifeRoomError, deleteRoomMine, describeRoom, importRoomFile, listRoom, listRoomMine, readRoomFile, systemStatus,
  writeRoomFile,
} from '../dsh-life-core/room.mjs';

const MESSAGES = Object.freeze({
  outside_room: '那个路径不在你能看的地方里面。',
  symlink_refused: '那是个链接，不是真文件；链接我不跟。',
  not_found: '没有这个东西。',
  not_a_file: '那是个目录，不是文件。',
  is_directory: '那不是目录。',
  too_large: '这一下太大了，一次读不完。',
  invalid_root: '你没有这个地方。',
 // 搬
  already_exists: '你自己那一块已经有同名的了。换个名字，或者告诉我要覆盖。',
  sealed: '这份不是我搬得动的（宿主的纸、你的本子、私记都不搬）。',
 // 写
  outside_room: '那个路径不在你能看的地方里面。',
  not_a_file: '那是个目录，不是文件。',
  not_found: '那儿没有这个东西。',
  too_large: '这一下太大了（我这边单份最多 200 KB）。',
  invalid_path: '名字不行：就写一个名字（不带目录、不带斜杠，别用点开头）。',
});

function gb(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '？';
  return (bytes / (1024 ** 3)).toFixed(1);
}

function hours(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '？';
  return (seconds / 3600).toFixed(1);
}

/** '11月1日 18:52'：列表里的短时间，同样是本地钟点。 */
function localShort(at) {
  const ms = Date.parse(String(at ?? ''));
  if (!Number.isFinite(ms)) return String(at ?? '');
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'UTC', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return pick('month') + '月' + pick('day') + '日 ' + pick('hour') + ':' + pick('minute');
}

/** 给助手看的时间是本地钟点：库和系统状态里存的是 UTC。 */
function localStamp(at) {
  const text = String(at ?? '');
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return text;
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric',
    weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return pick('year') + '年' + pick('month') + '月' + pick('day') + '日 ' + pick('weekday') + ' ' + pick('hour') + ':' + pick('minute');
}

function describeText(config) {
  const described = describeRoom(config);
  const lines = [];
  for (const root of described.roots) {
    const label = root.name === 'home' ? '房间' : '资料库';
    const mode = root.permission === 'rw' ? '可读写' : '只读';
    if (!root.exists) { lines.push(label + ' ' + root.path + '（' + mode + '）：还不存在'); continue; }
    lines.push(label + ' ' + root.path + '（' + mode + '）：目录 ' + root.directories + '，文件 ' + root.files + '，共 ' + gb(root.bytes) + ' GB');
  }
  for (const item of described.items) {
    const label = item.key === 'card' ? '纸条' : item.key === 'notebook' ? '本子' : item.key === 'private' ? '私人笔记' : '书';
    if (!item.present) { lines.push('  ' + label + '：没有（' + item.detail + '）'); continue; }
    if (item.display === 'presence-only') { lines.push('  ' + label + '：在，' + item.bytes + ' 字节（内容我不看）'); continue; }
    lines.push('  ' + label + '：' + (item.path ?? '目录里') + (item.bytes === undefined ? '' : '，' + item.bytes + ' 字节'));
  }
  if (described.system) {
    const status = systemStatus({ diskPath: described.home });
    lines.push('机器：' + status.platform + '，' + status.cpus + ' 核，内存 ' + gb(status.memory.freeBytes) + '/' + gb(status.memory.totalBytes) + ' GB，运行 ' + hours(status.uptimeSeconds) + ' 小时');
 // 本地钟点：status.time 是 UTC ISO，助手读到的会是 10:50 而不是 18:50。
    lines.push('  时间：' + localStamp(status.time));
    if (status.disk !== null) lines.push('  磁盘：剩 ' + gb(status.disk.freeBytes) + '/' + gb(status.disk.totalBytes) + ' GB');
    for (const note of status.notes) lines.push('  （' + note + '）');
  }
  return lines.join('\n');
}

function listingText(config, args) {
  const listing = listRoom(config, {
    root: typeof args.root === 'string' ? args.root : 'home',
    path: typeof args.path === 'string' ? args.path : '',
    depth: Number.isInteger(args.depth) ? args.depth : config.__depth,
    maxEntries: config.__maxEntries,
  });
  const head = listing.root + ':' + (listing.path === '' ? '/' : listing.path) + '（' + listing.permission + '）';
  if (listing.entries.length === 0) return head + '\n（空的）';
  const lines = listing.entries.map((entry) => entry.kind === 'directory'
    ? '  ' + entry.name + '/（目录）'
    : entry.kind === 'symlink' ? '  ' + entry.name + '（链接，不跟）'
    : '  ' + entry.name + '（' + entry.bytes + ' 字节）');
  if (listing.truncated) lines.push('  …（还有，没列完）');
  return head + '\n' + lines.join('\n');
}

function translate(error) {
  if (error instanceof LifeRoomError) return new Error(MESSAGES[error.code] ?? ('看不了：' + error.code));
  return error;
}

export function create(context) {
  const env = context.env;
  if (typeof env.homeRoot !== 'string' || env.homeRoot === '') {
    throw new Error('life-room needs env.homeRoot from the host');
  }
  const config = {
    homeRoot: env.homeRoot,
    libraryRoot: typeof env.libraryRoot === 'string' ? env.libraryRoot : null,
    system: env.system !== false,
    __depth: Number.isInteger(context.config.defaultDepth) ? context.config.defaultDepth : 2,
    __maxEntries: Number.isInteger(context.config.maxEntries) ? context.config.maxEntries : 200,
    __maxReadBytes: Number.isInteger(context.config.maxReadBytes) ? context.config.maxReadBytes : 262144,
  };

  context.tool('room_look', {
    description: '看你现在住的地方：房间和资料库各多大、开局那几样在不在、这台机器现在什么状态。给一个 path 就再看一个子目录。',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', enum: ['home', 'library'], description: '看哪个根，默认 home' },
        path: { type: 'string', description: '根里面的相对路径；不给就只看概况' },
        depth: { type: 'integer', description: '列几层，默认 2' },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const settings = args === null || typeof args !== 'object' ? {} : args;
      if (typeof settings.path === 'string' && settings.path !== '') return listingText(config, settings);
      return describeText(config);
    },
  });

  context.tool('room_read', {
    description: '读你房间里或资料库里某一个文件的正文。只能读你有的那两个根里面的文件。',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', enum: ['home', 'library'], description: '从哪个根读，默认 home' },
        path: { type: 'string', description: '根里面的相对路径' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    execute: async (args) => {
      try {
        const file = readRoomFile(config, {
          root: typeof args.root === 'string' ? args.root : 'home',
          path: args.path,
          maxBytes: config.__maxReadBytes,
        });
        if (file.bytes.subarray(0, 8192).includes(0)) return '（这是二进制文件，不是文字，读不出内容）';
        return file.bytes.toString('utf8');
      } catch (error) {
        throw translate(error);
      }
    },
  });

 // ---- 写：屋里只开「mine」这一小块--------------------
 // 三个动作：写一份、看看写了什么、删掉自己写的。宿主封印的那三样（宿主留的纸 / 本子 /
 // 私记）不在这一块里，所以助手的手碰不到——沙箱那边对 /data/home 仍然是只读。
  context.tool('room_write', {
    description: '往你自己的地方写一份东西（文字）：想留下来的、想以后再看的，都放这儿。同名就是改你自己那一份。写完它就在屋里，可以直接发出去。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '文件名，例如 今天.md（只写名字，不带目录）' },
        content: { type: 'string', description: '要写进去的文字（单份最多 200 KB）' },
      },
      required: ['name', 'content'],
      additionalProperties: false,
    },
    execute: async (args) => {
      try {
        const written = writeRoomFile(config, { name: args?.name, content: args?.content });
        return (written.replaced ? '改好了：' : '写好了：') + written.path + '（' + written.bytes + ' 字节）'
          + '\n（它在你屋里 ' + written.path + '，想发出去就用这个路径）';
      } catch (error) {
        throw translate(error);
      }
    },
  });

  context.tool('room_mine', {
    description: '看你自己写过什么：那一块里有哪些文件、多大、什么时候写的。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      try {
        const listed = listRoomMine(config, {});
        if (listed.entries.length === 0) return '你那一块还空着（什么都还没写）。';
        const lines = listed.entries.map((entry) => entry.name + '　' + entry.bytes + ' 字节　' + localShort(entry.modifiedAt));
        const more = listed.truncated ? '\n（只列了前 ' + lines.length + ' 个，一共 ' + listed.total + ' 个）' : '';
        return '你自己写下的 ' + listed.total + ' 份：\n' + lines.join('\n') + more;
      } catch (error) {
        throw translate(error);
      }
    },
  });

  context.tool('room_delete', {
    description: '删掉你自己写的一份东西。删了就没了，别的（宿主留的、你的本子和私记）碰不到。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '要删的文件名' } },
      required: ['name'],
      additionalProperties: false,
    },
    execute: async (args) => {
      try {
        const removed = deleteRoomMine(config, { name: args?.name });
        return '删掉了：' + removed.path + '（原来 ' + removed.bytes + ' 字节）';
      } catch (error) {
        throw translate(error);
      }
    },
  });

context.tool('room_import', {
    description: '把别人发给你的文件搬成你自己的：from 是它在屋里的位置（收件箱里的就是 inbox/文件名，room_look 能看到）。'
      + 'mode=copy 复制一份到你自己那一块，原件留着；mode=move 搬过去，原件这就不在了（相当于删掉原件）。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '屋里那个文件的位置，例如 inbox/FF261031131431.txt' },
        mode: { type: 'string', enum: ['copy', 'move'], description: 'copy 复制（默认）/ move 搬走' },
        name: { type: 'string', description: '搬过来叫什么名字，可省略（默认用原名）' },
        replace: { type: 'boolean', description: '你那块已经有同名的时候是否覆盖，默认不覆盖' },
      },
      required: ['from'],
      additionalProperties: false,
    },
    execute: async (args) => {
      try {
        const imported = importRoomFile(config, {
          from: args?.from,
          mode: args?.mode,
          name: args?.name,
          replace: args?.replace === true,
        });
        const head = (imported.mode === 'move' ? '搬过来了：' : '复制好了：') + imported.to
          + '（' + imported.bytes + ' 字节' + (imported.replaced ? '，覆盖了你原来那份' : '') + '）';
        if (imported.mode === 'move') return head + '\n（原件 ' + imported.from + ' 已经不在了）';
        return head + '\n（原件 ' + imported.from + ' 还在，没动）';
      } catch (error) {
        throw translate(error);
      }
    },
  });

  context.log('life-room ready: ' + (config.libraryRoot === null ? 'no library' : 'library at ' + config.libraryRoot));
}
