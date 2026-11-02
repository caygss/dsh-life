/**
 * 助手自己的立场。
 *
 * 偏好和记忆不是一回事：记忆是「发生过什么」，偏好是「我怎么想」——「别叫我老师」
 * 「我不喜欢在别人忙的时候打断」「我晚上不陪人熬夜」。记忆按相关度想起，
 * 偏好**一直在场**：它进 system 的稳定中段（budget.mjs 的 prefs 5k），不靠召回。
 *
 * 谁写：助手自己。这条模块只提供表上的动作，不判断内容对不对——内容判断归助手，
 * 违不违反也归助手（设计 §3.7：助手违反自己的偏好不拦截）。
 *
 * 三条硬规矩：
 * 1) 只增不删：改 = 同一个 id 多一个版本；撤 = 多一个 withdrawn 版本。历史全留着，
 * 「助手以前是这么想的」永远查得到。
 * 2) 只有每个 id 的**最新一版**算数：以前插入过 active、后来撤回的，不能因为
 * 旧行还是 active 就又冒出来。
 * 3) 进场只用 active 的全部原文，不做截断、不做摘要、不按权重挑。
 */
import { lastSeq } from './store/events.mjs';

/** 上限集中在这里，插件、报告、测试用的是同一份数字。 */
export const PREFERENCE_LIMITS = Object.freeze({
  textMaxChars: 200,
  idMaxChars: 24,
  maxActive: 12,
  listMax: 40,
});

export class LifePreferenceError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifePreferenceError';
    this.code = code;
  }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 按码点算字数：一个汉字 = 1。 */
export function charCount(value) {
  return Array.from(String(value ?? '')).length;
}

function rowToPreference(row) {
  let refs = [];
  try {
    const parsed = JSON.parse(String(row.source_refs_json ?? '[]'));
    if (Array.isArray(parsed)) refs = parsed.filter((item) => typeof item === 'string');
  } catch { /* 坏掉的引用不影响正文 */ }
  return {
    id: String(row.id),
    version: Number(row.version),
    status: String(row.status),
    text: String(row.text),
    at: String(row.created_at),
    sourceRefs: refs,
  };
}

/** 每个 id 的最新一版（撤回过的也在这里，由调用方看 status）。 */
const LATEST_SQL = 'SELECT p.id, p.version, p.status, p.text, p.created_at, p.source_refs_json FROM life_prefs p '
  + 'JOIN (SELECT id, MAX(version) AS v FROM life_prefs GROUP BY id) m ON m.id = p.id AND m.v = p.version ';

/** 助手此刻生效的全部立场，按 id 排序（顺序稳定，前缀缓存不会被无谓打散）。 */
export function listPreferences(store) {
  const rows = store.db.prepare(LATEST_SQL + "WHERE p.status = 'active' ORDER BY p.id").all();
  return rows.map(rowToPreference);
}

/** 进 system 的那几段：一条一个 part，带 id 方便助手以后改。 */
export function preferenceParts(store) {
  return listPreferences(store).map((item) => ({ id: 'pref-' + item.id, text: '· ' + item.text }));
}

/** 给助手看的一行：「p-2（第 2 版）」这种。 */
export function latestPreference(store, id) {
  const row = store.db.prepare(LATEST_SQL + 'WHERE p.id = ?').get(String(id));
  return row === undefined ? null : rowToPreference(row);
}

function nextId(db) {
  const rows = db.prepare('SELECT id FROM life_prefs').all();
  let max = 0;
  for (const row of rows) {
    const match = /^p-(\d+)$/.exec(String(row.id));
    if (match !== null) max = Math.max(max, Number(match[1]));
  }
  return 'p-' + (max + 1);
}

function refsFor(store, sourceSeq) {
  const seq = Number.isFinite(Number(sourceSeq)) ? Math.floor(Number(sourceSeq)) : lastSeq(store);
  return seq > 0 ? ['seq:' + seq] : [];
}

function normaliseAt(at) {
  const parsed = Date.parse(String(at ?? ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function refuse(code, extra = {}) {
  return { ok: false, code, ...extra };
}

/** 写一条新立场。没给 id 就自己开一条。 */
export function addPreference(store, input = {}) {
  const body = text(input.text);
  if (body === '') return refuse('text_required');
  const chars = charCount(body);
  if (chars > PREFERENCE_LIMITS.textMaxChars) return refuse('text_too_long', { chars, max: PREFERENCE_LIMITS.textMaxChars });
  const at = normaliseAt(input.at);
  const refs = refsFor(store, input.sourceSeq);
  return store.atomic((db) => {
    const active = db.prepare(LATEST_SQL + "WHERE p.status = 'active'").all().length;
    if (active >= PREFERENCE_LIMITS.maxActive) {
      return refuse('too_many_preferences', { active, max: PREFERENCE_LIMITS.maxActive });
    }
    const id = nextId(db);
    db.prepare('INSERT INTO life_prefs(id, version, status, text, created_at, source_refs_json) VALUES(?,?,?,?,?,?)')
      .run(id, 1, 'active', body, at, JSON.stringify(refs));
    return { ok: true, id, version: 1, at, text: body };
  });
}

/** 改一条：新版本顶上去，旧的那一版原样留着。 */
export function revisePreference(store, input = {}) {
  const id = text(input.id);
  const body = text(input.text);
  if (id === '') return refuse('id_required');
  if (body === '') return refuse('text_required');
  const chars = charCount(body);
  if (chars > PREFERENCE_LIMITS.textMaxChars) return refuse('text_too_long', { chars, max: PREFERENCE_LIMITS.textMaxChars });
  const at = normaliseAt(input.at);
  const refs = refsFor(store, input.sourceSeq);
  return store.atomic((db) => {
    const current = latestPreference(store, id);
    if (current === null) return refuse('not_found', { id });
    if (current.status !== 'active') return refuse('already_withdrawn', { id });
    const version = current.version + 1;
    db.prepare('INSERT INTO life_prefs(id, version, status, text, created_at, source_refs_json) VALUES(?,?,?,?,?,?)')
      .run(id, version, 'active', body, at, JSON.stringify(refs));
    return { ok: true, id, version, from: current.version, at, text: body };
  });
}

/** 撤回一条：写一个新版本标 withdrawn，正文不动，旧版本全部留着。 */
export function withdrawPreference(store, input = {}) {
  const id = text(input.id);
  if (id === '') return refuse('id_required');
  const at = normaliseAt(input.at);
  return store.atomic((db) => {
    const current = latestPreference(store, id);
    if (current === null) return refuse('not_found', { id });
    if (current.status !== 'active') return refuse('already_withdrawn', { id });
    const version = current.version + 1;
    db.prepare('INSERT INTO life_prefs(id, version, status, text, created_at, source_refs_json) VALUES(?,?,?,?,?,?)')
      .run(id, version, 'withdrawn', current.text, at, JSON.stringify(current.sourceRefs));
    return { ok: true, id, version, at };
  });
}

export function preferenceStats(store) {
  const rows = store.db.prepare(LATEST_SQL).all().map(rowToPreference);
  const active = rows.filter((row) => row.status === 'active').length;
  return { active, withdrawn: rows.length - active, maxActive: PREFERENCE_LIMITS.maxActive };
}

/**
 * 一个动作入口，插件只调这一个。
 * action: list（不给 text 时默认）/ add / revise / withdraw
 */
export function applyPreference(store, input = {}) {
  const action = text(input.action);
  const body = text(input.text);
  if (action === '' && body === '') return { ok: true, action: 'list', items: listPreferences(store) };
  if (action === 'list') return { ok: true, action: 'list', items: listPreferences(store) };
  if (action === 'withdraw') {
    const done = withdrawPreference(store, input);
    return done.ok === true ? { ...done, action: 'withdraw' } : done;
  }
  if (action === 'revise' || (action === '' && text(input.id) !== '')) {
    const done = revisePreference(store, input);
    return done.ok === true ? { ...done, action: 'revise' } : done;
  }
  const done = addPreference(store, input);
  return done.ok === true ? { ...done, action: 'add' } : done;
}
