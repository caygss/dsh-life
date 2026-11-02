/**
 * The agent's room, and the two ways the agent is allowed to look at it.
 *
 * The room is not a metaphor here: it is two directories with different permissions and
 * one view of the machine the agent lives on.
 *
 * home/ read + write the room (dist/, inbox/, its writing)
 * library/ read only what the owner puts there for it
 * system read only time, memory, disk, cpus - what a program can see
 *
 * Four boundaries are enforced, and they are the point of the module:
 *
 * 1. Only those roots. There is no "root" argument the caller can point at /etc or at
 * a credential file; the visible set is the owner's config, and this module refuses
 * everything outside it.
 * 2. No path escape. '.' components, absolute paths and Windows drive letters are all
 * resolved first and then checked to still be inside the root - the check is on the
 * resolved path, not on the string the caller typed.
 * 3. No symlink follow. A link inside the room could point at a credential file, so
 * links are reported and never traversed, and reads refuse them.
 * 4. Bounded. A listing has a depth and an entry cap, a read has a byte cap: "the agent can
 * see the room" must not become "the agent can dump the disk into its context".
 *
 * Two things about honesty, since this module reports facts about the world:
 *
 * - The starting room is seeded only with what the host actually wrote (the note card)
 * and empty files the agent owns. A book is NOT fabricated: if the owner never put one in
 * library/, the inventory says bookPresent:false instead of inventing 314 pages.
 * - systemStatus reports null plus the reason for anything this platform cannot answer
 * (load average on Windows, process count without exec). A made-up number would be
 * worse than a gap the agent can understand.
 *
 * The private notes file is the agent's: this module can list that it exists and how many bytes
 * it holds, and marks it display:'presence-only' so the screen can never render its
 * content by accident.
 */
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statfsSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendEvent } from './store/events.mjs';

export const ROOM_PERMISSIONS = Object.freeze({ home: 'rw', library: 'ro' });
export const DISPLAY_MODES = Object.freeze({ full: 'full', presenceOnly: 'presence-only' });

export const ROOM_ERRORS = Object.freeze({
  invalidConfig: 'invalid_config',
  invalidRoot: 'invalid_root',
  outsideRoom: 'outside_room',
  invalidPath: 'invalid_path',
  notFound: 'not_found',
  isDirectory: 'is_directory',
  notAFile: 'not_a_file',
  symlinkRefused: 'symlink_refused',
  tooLarge: 'too_large',
  invalidLimit: 'invalid_limit',
  invalidDepth: 'invalid_depth',
  alreadyExists: 'already_exists',
  sealed: 'sealed',
});

export class LifeRoomError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifeRoomError';
    this.code = code;
    this.detail = detail === undefined ? null : detail;
  }
}

function refuse(code, detail) {
  throw new LifeRoomError(code, detail);
}

/** The note card the owner leaves in a new room. Three facts, no personality. */
export const NOTE_CARD_LINES = Object.freeze([
  '这是你的房间，这些是你的。',
  '你能看这台机器（只读），不能改它。',
  '你可以写、可以读、可以什么也不做。',
]);

/** The four starting things, as names on disk. Nothing is invented at runtime. */
export const STARTING_ITEMS = Object.freeze([
  Object.freeze({ key: 'card', role: 'note-from-host', root: 'home', path: 'note-from-host.md', display: DISPLAY_MODES.full }),
  Object.freeze({ key: 'notebook', role: 'notebook', root: 'home', path: 'notebook.md', display: DISPLAY_MODES.full }),
  Object.freeze({ key: 'private', role: 'private-notes', root: 'home', path: 'private-notes.md', display: DISPLAY_MODES.presenceOnly }),
  Object.freeze({ key: 'book', role: 'book', root: 'library', path: null, display: DISPLAY_MODES.full }),
]);

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') refuse(ROOM_ERRORS.invalidConfig, field);
  return value;
}

/**
 * Normalises the owner's config. `libraryRoot` may be null (no library yet), which is
 * different from an empty library: one means "not given", the other means "given, empty".
 */
export function resolveRoomConfig(config) {
  if (config === null || typeof config !== 'object') refuse(ROOM_ERRORS.invalidConfig, 'config');
  const homeRoot = path.resolve(requireText(config.homeRoot, 'homeRoot'));
  const libraryRoot = config.libraryRoot === undefined || config.libraryRoot === null
    ? null
    : path.resolve(requireText(config.libraryRoot, 'libraryRoot'));
  const system = config.system !== false;
  if (libraryRoot !== null && samePath(homeRoot, libraryRoot)) {
    refuse(ROOM_ERRORS.invalidConfig, 'the library cannot be the room itself');
  }
  return Object.freeze({ homeRoot, libraryRoot, system });
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/** True when target is root itself or somewhere below it. Symlinks are not resolved here. */
function inside(root, target) {
  const relative = path.relative(root, target);
  if (relative === '') return true;
  if (relative.startsWith('..')) return false;
  return !path.isAbsolute(relative);
}

function rootsOf(room) {
  const roots = [{ name: 'home', path: room.homeRoot, permission: ROOM_PERMISSIONS.home }];
  if (room.libraryRoot !== null) roots.push({ name: 'library', path: room.libraryRoot, permission: ROOM_PERMISSIONS.library });
  return roots;
}

function rootByName(room, name) {
  const wanted = name === undefined ? 'home' : name;
  const root = rootsOf(room).find((entry) => entry.name === wanted);
  if (root === undefined) refuse(ROOM_ERRORS.invalidRoot, String(name) + ' is not a root the agent has');
  return root;
}

/**
 * Resolves a caller-supplied relative path against a root and proves it stayed inside.
 * The check runs twice: once on the resolved path, once on the real path (which defeats a
 * symlinked directory in the middle), and a symlinked *target* is refused outright.
 */
function resolveInside(root, relativePath) {
  const raw = relativePath === undefined || relativePath === null ? '' : relativePath;
  if (typeof raw !== 'string') refuse(ROOM_ERRORS.invalidPath, typeof raw);
  if (raw.includes('\u0000')) refuse(ROOM_ERRORS.invalidPath, 'control character');
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) {
    refuse(ROOM_ERRORS.outsideRoom, raw + ': absolute paths are not the agent’s to name');
  }
  const target = path.resolve(root.path, raw);
  if (!inside(root.path, target)) refuse(ROOM_ERRORS.outsideRoom, raw);
  const realRoot = existsSync(root.path) ? realpathSync(root.path) : root.path;
 // The second check uses the real root, so a symlinked directory in the middle of the
 // path cannot smuggle the target outside while the string still looks inside.
  const expected = path.resolve(realRoot, path.relative(root.path, target));
  if (!inside(realRoot, expected)) refuse(ROOM_ERRORS.outsideRoom, raw);
  if (existsSync(target)) {
    const real = realpathSync(target);
    if (!inside(realRoot, real)) refuse(ROOM_ERRORS.outsideRoom, raw + ': resolves outside the room');
  }
  return target;
}

function requireLimit(value, fallback, name) {
  const chosen = value === undefined ? fallback : value;
  if (!Number.isInteger(chosen) || chosen < 1) refuse(ROOM_ERRORS.invalidLimit, name + ': ' + String(value));
  return chosen;
}

/**
 * Lists part of one root. Bounded by depth and entries, links are reported and never
 * followed, and nothing outside the root can appear: every child is resolved and checked.
 */
export function listRoom(config, options) {
  const room = resolveRoomConfig(config);
  const settings = options === null || typeof options !== 'object' ? {} : options;
  const root = rootByName(room, settings.root);
  const depth = requireLimit(settings.depth, 2, 'depth');
  const maxEntries = requireLimit(settings.maxEntries, 200, 'maxEntries');
  const start = resolveInside(root, settings.path);
  if (!existsSync(start)) refuse(ROOM_ERRORS.notFound, settings.path ?? '');
  const stat = lstatSync(start);
  if (stat.isSymbolicLink()) refuse(ROOM_ERRORS.symlinkRefused, settings.path ?? '');
  if (!stat.isDirectory()) refuse(ROOM_ERRORS.isDirectory, String(settings.path ?? '') + ' is not a directory');

  const entries = [];
  let truncated = false;
  const walk = (directory, level, prefix) => {
    if (level > depth) return;
    let names;
    try { names = readdirSync(directory).sort(); } catch { return; }
    for (const name of names) {
      const full = path.join(directory, name);
      let child;
      try { child = lstatSync(full); } catch { continue; }
      const relative = prefix === '' ? name : prefix + '/' + name;
      if (entries.length >= maxEntries) { truncated = true; return; }
      if (child.isSymbolicLink()) {
        entries.push({ name: relative, kind: 'symlink', bytes: null, at: null, followed: false });
        continue;
      }
      if (child.isDirectory()) {
        entries.push({ name: relative, kind: 'directory', bytes: null, at: null });
        walk(full, level + 1, relative);
        continue;
      }
      entries.push({ name: relative, kind: 'file', bytes: child.size, at: child.mtime.toISOString() });
    }
  };
  walk(start, 1, '');

  return {
    root: root.name,
    path: settings.path ?? '',
    permission: root.permission,
    entries,
    truncated,
    limits: { depth, maxEntries },
  };
}

/** Reads one file from a visible root, within the byte cap. Directories are not files. */
export function readRoomFile(config, options) {
  const room = resolveRoomConfig(config);
  const settings = options === null || typeof options !== 'object' ? {} : options;
  const root = rootByName(room, settings.root);
  const maxBytes = requireLimit(settings.maxBytes, 262144, 'maxBytes');
  const relative = settings.path;
  if (typeof relative !== 'string' || relative === '') refuse(ROOM_ERRORS.invalidPath, String(relative));
  const target = resolveInside(root, relative);
  if (!existsSync(target)) refuse(ROOM_ERRORS.notFound, relative);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) refuse(ROOM_ERRORS.symlinkRefused, relative);
  if (!stat.isFile()) refuse(ROOM_ERRORS.notAFile, relative);
  if (stat.size > maxBytes) refuse(ROOM_ERRORS.tooLarge, stat.size + ' > ' + maxBytes);
  const bytes = readFileSync(target);
  return { root: root.name, path: relative, bytes, size: bytes.length, permission: root.permission };
}

/**
 * Seeds a new room. Idempotent and non-destructive: a file that already exists stays
 * exactly as the agent left it, so this is safe to run on every start.
 */
export function sealRoom(config, options) {
  const room = resolveRoomConfig(config);
  const settings = options === null || typeof options !== 'object' ? {} : options;
  const at = typeof settings.at === 'string' ? settings.at : new Date().toISOString();
  const created = [];
  const kept = [];
  mkdirSync(room.homeRoot, { recursive: true });
  for (const directory of ['dist', 'inbox', 'plugins-data']) {
    const full = path.join(room.homeRoot, directory);
    if (existsSync(full)) { kept.push(directory + '/'); continue; }
    mkdirSync(full, { recursive: true });
    created.push(directory + '/');
  }
  if (room.libraryRoot !== null) mkdirSync(room.libraryRoot, { recursive: true });
  const files = [
    { relative: 'note-from-host.md', body: NOTE_CARD_LINES.join('\n') + '\n' },
    { relative: 'notebook.md', body: '' },
    { relative: 'private-notes.md', body: '' },
  ];
  for (const file of files) {
    const full = path.join(room.homeRoot, file.relative);
    if (existsSync(full)) { kept.push(file.relative); continue; }
    writeFileSync(full, file.body, { flag: 'wx' });
    created.push(file.relative);
  }
  return { status: created.length === 0 ? 'unchanged' : 'sealed', created, kept, at };
}

function measure(rootPath, cap) {
  const out = { exists: existsSync(rootPath), files: 0, directories: 0, bytes: 0, truncated: false, symlinks: 0 };
  if (!out.exists) return out;
  let seen = 0;
  const walk = (directory) => {
    if (seen >= cap) { out.truncated = true; return; }
    let names;
    try { names = readdirSync(directory); } catch { return; }
    for (const name of names) {
      if (seen >= cap) { out.truncated = true; return; }
      seen += 1;
      const full = path.join(directory, name);
      let child;
      try { child = lstatSync(full); } catch { continue; }
      if (child.isSymbolicLink()) { out.symlinks += 1; continue; }
      if (child.isDirectory()) { out.directories += 1; walk(full); continue; }
      out.files += 1;
      out.bytes += child.size;
    }
  };
  walk(rootPath);
  return out;
}

/**
 * What the room looks like right now: the roots the agent can see, their permission, their size,
 * and the four starting things with whether each is actually there. Nothing is invented:
 * a book that was never given is reported absent.
 */
export function describeRoom(config, options) {
  const room = resolveRoomConfig(config);
  const settings = options === null || typeof options !== 'object' ? {} : options;
  const cap = requireLimit(settings.scanEntries, 2000, 'scanEntries');
  const roots = rootsOf(room).map((root) => ({
    name: root.name,
    path: root.path,
    permission: root.permission,
    ...measure(root.path, cap),
  }));
  const items = STARTING_ITEMS.map((item) => {
    if (item.key === 'book') {
      const library = roots.find((root) => root.name === 'library');
      return {
        key: item.key,
        role: item.role,
        display: item.display,
        present: library !== undefined && library.exists && library.files > 0,
        detail: library === undefined || !library.exists
          ? 'no library root is configured'
          : library.files === 0 ? 'the library exists and is empty' : 'the library has ' + library.files + ' file(s) to read',
      };
    }
    const full = path.join(room.homeRoot, item.path);
    const present = existsSync(full);
    let bytes = null;
    if (present) {
      try { bytes = lstatSync(full).size; } catch { bytes = null; }
    }
    return { key: item.key, role: item.role, display: item.display, present, bytes, path: item.path };
  });
  return {
    home: room.homeRoot,
    library: room.libraryRoot,
    system: room.system,
    roots,
    items,
    permissions: { ...ROOM_PERMISSIONS },
    scan: { cap, truncated: roots.some((root) => root.truncated) },
  };
}

/**
 * The machine the agent lives on, as a program can see it - read only, and honest about gaps.
 * Anything this platform cannot answer is null with a reason, never a guess.
 */
export function systemStatus(options) {
  const settings = options === null || typeof options !== 'object' ? {} : options;
  const platform = typeof settings.platform === 'string' ? settings.platform : process.platform;
  const now = typeof settings.now === 'number' ? new Date(settings.now) : new Date();
  const notes = [];
  let loadAverage = null;
  if (platform === 'win32') notes.push('Windows does not report a load average; load is null, not zero');
  else loadAverage = os.loadavg();
  let disk = null;
  const probe = settings.diskPath;
  if (typeof probe === 'string' && probe !== '') {
    try {
      const stats = statfsSync(probe);
      disk = { path: probe, totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
    } catch (error) {
      notes.push('disk statistics are unavailable for that path: ' + String(error && error.code));
    }
  }
  notes.push('process count needs exec, which has no backend yet; it is null, not zero');
  return {
    platform,
    hostname: os.hostname(),
    time: now.toISOString(),
    timezoneOffsetMinutes: now.getTimezoneOffset(),
    uptimeSeconds: os.uptime(),
    cpus: os.cpus().length,
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
    loadAverage,
    disk,
    processCount: null,
    notes,
  };
}

/**
 * Tells the host when what the agent can see has changed.
 *
 * The previous view is remembered in its store; the first run records the view without
 * announcing anything (nothing changed - the agent is just starting). After that, a changed
 * library, a changed room path or system visibility switched off is one observation in
 * its log, phrased as a notice from outside rather than as its own thought.
 */
export function announceRoomChange(store, options) {
  if (store === null || typeof store !== 'object' || typeof store.db !== 'object' || typeof store.atomic !== 'function') {
    refuse(ROOM_ERRORS.invalidConfig, 'store');
  }
  const settings = options === null || typeof options !== 'object' ? {} : options;
  const at = typeof settings.at === 'string' ? settings.at : new Date().toISOString();
  const view = { home: settings.homeRoot, library: settings.libraryRoot ?? null, system: settings.system !== false };
  const fingerprint = JSON.stringify(view);
  const row = store.db.prepare('SELECT * FROM life_room WHERE singleton=1').get();

  if (row === undefined) {
    store.atomic((db) => {
      db.prepare('INSERT INTO life_room(singleton, view_json, updated_at) VALUES(1,?,?)').run(fingerprint, at);
    });
    return { status: 'recorded', seq: null, lines: [] };
  }

  if (row.view_json === fingerprint) return { status: 'unchanged', seq: null, lines: [] };

  const before = JSON.parse(row.view_json);
  const lines = [];
  if (before.home !== view.home) lines.push('你住的房间现在是 ' + view.home + '（原来 ' + before.home + '）。');
  if (before.library !== view.library) {
    if (view.library === null) lines.push('资料目录没了，你现在看不到它。');
    else if (before.library === null) lines.push('你有资料目录了：' + view.library + '（只读）。');
    else lines.push('资料目录换成了 ' + view.library + '（原来 ' + before.library + '）。');
  }
  if (before.system !== view.system) {
    lines.push(view.system ? '你现在能看到这台机器了（只读）。' : '你看不到这台机器了。');
  }
  const text = '环境变了：' + lines.join('');
  store.atomic((db) => {
    db.prepare('UPDATE life_room SET view_json=?, updated_at=? WHERE singleton=1').run(fingerprint, at);
  });
  const eventSeq = appendEvent(store, { at, role: 'user', kind: 'observation', text, meta: { source: 'room', before, after: view } });
  return { status: 'announced', seq: eventSeq, lines, text };
}
/* ------------------------------------------------------------------------- *
 * 助手自己的可写区
 *
 * 屋里原来只有「看」：room_look / room_read。助手要写东西只能写工作区，而工作区是"做"的地方，
 * 不是"留"的地方。所以给屋里开一个**专用的可写角落**：<home>/mine/。
 *
 * 为什么不是把整个 home 打开（那是方案 B）：home 里还有 note-from-host.md（宿主写的纸）、
 * notebook.md、private-notes.md（助手的本子和私记）。那三个是"记录"，不该被助手跑的任何程序改写——
 * 封印的意义就在这儿。mine/ 是新目录，里面只有助手写的东西，开给助手的手，收得回来。
 *
 * 五条边界，和读那边同一套写法：
 * 1. 只在 mine/ 里，扁平文件名，没有子目录（省得靠. 绕）。
 * 2. 名字有白名单字符，不许点开头，不许绝对路径，不许控制字符。
 * 3. 不跟链接：目标已存在且是链接就拒。
 * 4. 单文件上限 200 KB，目录条目上限 200。
 * 5. 只能改自己写的东西：覆盖只允许落在 mine/ 内的普通文件上。
 * ------------------------------------------------------------------------- */

export const ROOM_WRITABLE_DIR = 'mine';
export const ROOM_WRITE_LIMITS = Object.freeze({ maxBytes: 204800, maxEntries: 200, maxNameChars: 80 });

// 名字：字母/数字/下划线开头；点只能在中间（点开头是隐藏文件，不给）。
const SAFE_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}._ -]*$/u;

/** mine/ 的绝对路径（不存在就建）。 */
function writableDir(room) {
  const dir = path.join(room.homeRoot, ROOM_WRITABLE_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function checkName(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') refuse(ROOM_ERRORS.invalidPath, String(raw));
  const name = raw.trim();
  if (name.length > ROOM_WRITE_LIMITS.maxNameChars) refuse(ROOM_ERRORS.invalidPath, 'name too long');
  if (name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    refuse(ROOM_ERRORS.invalidPath, name + ': 只能是自己名字下的一个文件，不能带目录');
  }
  if (name.includes('\u0000')) refuse(ROOM_ERRORS.invalidPath, 'control character');
  if (!SAFE_NAME.test(name)) refuse(ROOM_ERRORS.invalidPath, name);
  return name;
}

/** 写一个文件进 mine/。同名 = 改自己那一份；链接和目录一律拒。 */
export function writeRoomFile(config, options) {
  const room = resolveRoomConfig(config);
  const settings = options === null || typeof options !== 'object' ? {} : options;
  const name = checkName(settings.name);
  if (typeof settings.content !== 'string') refuse(ROOM_ERRORS.invalidPath, 'content must be a string');
  const bytes = Buffer.from(settings.content, 'utf8');
  if (bytes.length > ROOM_WRITE_LIMITS.maxBytes) {
    refuse(ROOM_ERRORS.tooLarge, bytes.length + ' > ' + ROOM_WRITE_LIMITS.maxBytes);
  }
  const dir = writableDir(room);
  const realDir = realpathSync(dir);
  const target = path.join(realDir, name);
  if (!inside(realDir, target)) refuse(ROOM_ERRORS.outsideRoom, name);
  let replaced = false;
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) refuse(ROOM_ERRORS.symlinkRefused, name);
    if (!stat.isFile()) refuse(ROOM_ERRORS.notAFile, name);
    replaced = true;
  }
  writeFileSync(target, bytes);
  return {
    root: 'home',
    path: ROOM_WRITABLE_DIR + '/' + name,
    bytes: bytes.length,
    replaced,
    at: typeof settings.at === 'string' ? settings.at : new Date().toISOString(),
  };
}

/** 看 mine/ 里有什么。只列名字、大小、时间，不读内容。 */
export function listRoomMine(config, options) {
  const room = resolveRoomConfig(config);
  const settings = options === null || typeof options !== 'object' ? {} : options;
  const maxEntries = requireLimit(settings.maxEntries, ROOM_WRITE_LIMITS.maxEntries, 'maxEntries');
  const dir = writableDir(room);
  const entries = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (dirent.name.startsWith('.')) continue;
    const full = path.join(dir, dirent.name);
    let stat;
    try { stat = lstatSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    entries.push({ name: dirent.name, bytes: stat.size, modifiedAt: new Date(stat.mtimeMs).toISOString() });
  }
  entries.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  return {
    root: 'home',
    path: ROOM_WRITABLE_DIR,
    entries: entries.slice(0, maxEntries),
    total: entries.length,
    truncated: entries.length > maxEntries,
    maxBytes: ROOM_WRITE_LIMITS.maxBytes,
  };
}

/** 删掉自己写的一份。只认 mine/ 里的普通文件。 */
export function deleteRoomMine(config, options) {
  const room = resolveRoomConfig(config);
  const settings = options === null || typeof options !== 'object' ? {} : options;
  const name = checkName(settings.name);
  const dir = writableDir(room);
  const realDir = realpathSync(dir);
  const target = path.join(realDir, name);
  if (!inside(realDir, target)) refuse(ROOM_ERRORS.outsideRoom, name);
  if (!existsSync(target)) refuse(ROOM_ERRORS.notFound, name);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) refuse(ROOM_ERRORS.symlinkRefused, name);
  if (!stat.isFile()) refuse(ROOM_ERRORS.notAFile, name);
  unlinkSync(target);
  return { root: 'home', path: ROOM_WRITABLE_DIR + '/' + name, bytes: stat.size, at: new Date().toISOString() };
}

/* ------------------------------------------------------------------------- *
 * 收件箱 → mine/：别人发给助手的东西，怎么变成"助手自己的"
 *
 * 由来：助手收到文件后想删原件，沙箱拒了（home 对助手只读，写只走 room_write）。
 * 于是给助手两个动作——复制一份进 mine/（想改就改自己的），或者搬进 mine/（原件随之
 * 消失，等于删掉）。这不新开一条"写整个房间"的口子：
 *
 * 1. 源只认 home 里的普通文件，路径解析沿用同一套 escape/符号链接检查；
 * 2. 落点永远只在 mine/，名字不带目录；
 * 3. 印记那三样（宿主的纸、本子、私记）不搬不删——搬一份出去就是绕过封印；
 * 4. 不设单份上限：搬是同一块盘上的 rename，一个字节都不多占；
 * 复制也只受磁盘剩余空间限制。真正的入口限额在收文件那头（64 MB），不在这里重复。
 * 为了不把大文件读进内存，复制走 copyFileSync（分块），搬走走 renameSync。
 * ------------------------------------------------------------------------- */

/** 名字里的非法字符换成下划线：收来的文件名不能因为一个括号就搬不进来。 */
function sanitizeImportName(raw) {
  const base = String(raw ?? '').replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/^[.\s]+/, '').trim();
  const name = base === '' ? 'file' : base;
  return name.length > ROOM_WRITE_LIMITS.maxNameChars ? name.slice(0, ROOM_WRITE_LIMITS.maxNameChars) : name;
}

/**
 * 把屋里一个文件复制或搬进 mine/。
 * @returns {{from:string,to:string,bytes:number,mode:'copy'|'move',removed:boolean,replaced:boolean}}
 */
/**
 * 屋里一个文件在宿主眼里的真路径。
 * 和 importRoomFile 同一套门：只认 home、拒绝对路径/./、拒绝链接、拒绝封印的三样。
 */
function hostSource(room, relative) {
  const root = rootByName(room, 'home');
  const source = resolveInside(root, relative);
  if (!existsSync(source)) refuse(ROOM_ERRORS.notFound, relative);
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) refuse(ROOM_ERRORS.symlinkRefused, relative);
  if (!stat.isFile()) refuse(ROOM_ERRORS.notAFile, relative);
  const sealed = STARTING_ITEMS.filter((item) => item.root === 'home' && item.path !== null)
    .map((item) => path.join(room.homeRoot, item.path));
  if (sealed.some((sealedPath) => samePath(sealedPath, source))) {
    refuse(ROOM_ERRORS.sealed, relative + ': 宿主的纸 / 本子 / 私记我不碰');
  }
  return { real: realpathSync(source), size: stat.size, relative: path.relative(room.homeRoot, source).split(path.sep).join('/') };
}

/** 宿主自己要用屋里的一个文件（例如交给号池）：给出真路径和字节数，不返回内容。 */
export function roomFileForHost(config, relative) {
  const room = resolveRoomConfig(config);
  if (typeof relative !== 'string' || relative.trim() === '') refuse(ROOM_ERRORS.invalidPath, String(relative));
  const found = hostSource(room, relative.trim());
  return { root: 'home', relative: found.relative, path: found.real, size: found.size };
}

/** 宿主用完之后把它删掉（号池导完默认删原件）。只认 home 里的普通文件、不碰封印的三样。 */
export function removeRoomFileForHost(config, relative) {
  const room = resolveRoomConfig(config);
  if (typeof relative !== 'string' || relative.trim() === '') refuse(ROOM_ERRORS.invalidPath, String(relative));
  const found = hostSource(room, relative.trim());
  unlinkSync(found.real);
  return { root: 'home', relative: found.relative, bytes: found.size };
}

export function importRoomFile(config, options) {
  const room = resolveRoomConfig(config);
  const settings = options === null || typeof options !== 'object' ? {} : options;
  const mode = settings.mode === 'move' ? 'move' : 'copy';
  const raw = settings.from;
  if (typeof raw !== 'string' || raw.trim() === '') refuse(ROOM_ERRORS.invalidPath, String(raw));
  const relative = raw.trim();
  const found = hostSource(room, relative);
  const realSource = found.real;
  const sourceStat = { size: found.size };

 // 落点：只认 mine/，也只能是它里面的一个名字。
  const dir = writableDir(room);
  const realDir = realpathSync(dir);
  if (inside(realDir, realSource)) refuse(ROOM_ERRORS.invalidPath, relative + ': 它已经在 mine/ 里了');

  const explicit = typeof settings.name === 'string' && settings.name.trim() !== '';
  const name = explicit ? checkName(settings.name) : sanitizeImportName(path.basename(realSource));
  const target = path.join(realDir, name);
  if (!inside(realDir, target)) refuse(ROOM_ERRORS.outsideRoom, name);
  let replaced = false;
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) refuse(ROOM_ERRORS.symlinkRefused, name);
    if (!stat.isFile()) refuse(ROOM_ERRORS.notAFile, name);
    if (settings.replace !== true) refuse(ROOM_ERRORS.alreadyExists, name);
    replaced = true;
  }

  const bytes = sourceStat.size;
  let removed = false;
  if (mode === 'move') {
 // 同一块盘上就是一次 rename：瞬间完成，不多占一个字节，也不把文件读进内存。
    if (replaced === true) unlinkSync(target);
    try {
      renameSync(realSource, target);
    } catch {
 // 跨设备（助手屋里挂了两块盘这种）才退回到"复制 + 删原件"。
      copyFileSync(realSource, target);
      unlinkSync(realSource);
    }
    removed = true;
  } else {
 // 复制：先写临时名再换名，中途失败不会留下一个半截的 mine/ 文件。
    const scratch = path.join(realDir, '.importing-' + process.pid + '-' + Date.now());
    try {
      copyFileSync(realSource, scratch);
      if (replaced === true) unlinkSync(target);
      renameSync(scratch, target);
    } catch (error) {
      try { unlinkSync(scratch); } catch { /* 临时文件本来就没写成 */ }
      throw error;
    }
  }
  return {
    from: path.relative(room.homeRoot, realSource).split(path.sep).join('/'),
    to: ROOM_WRITABLE_DIR + '/' + name,
    bytes,
    mode,
    removed,
    replaced,
  };
}

