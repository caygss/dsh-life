/**
 * Things the agent has in hand.
 *
 * several unfinished things exist at once, each with its own record, and
 * switching attention does not overwrite the others. So this is one row per item, not a
 * single "what am I doing" slot.
 *
 * the material needed to carry on is stored as POINTERS, not copies.
 * Whatever is still inside the resident context window is not stored at all (it is
 * already there); what has rolled out is stored as a package id or an event range and
 * unpacked on demand. A pointer that smuggles a text copy is refused by name
 * (material_has_extra_fields), because that is exactly the copy the decision removed.
 *
 * At most one row is `active` - the thing the agent is on right now. Everything else is
 * `waiting` (has been started, not being done), `paused` (deliberately set aside),
 * `completed` or `unknown`. switchFocus is the only way to activate, and it demotes
 * the previous active row instead of deleting anything.
 *
 * Which changes are life events: creating, switching, pausing, resuming, completing.
 * Changing the focus text or a pending item is not - nobody remembers moving their
 * attention every few minutes, and writing that into the log would flood compression.
 */
import { getPackage } from './memory/packages.mjs';
import { findCorrection } from './memory/corrected.mjs';
import { readRange } from './store/events.mjs';

export const TASK_STATES = Object.freeze(['active', 'waiting', 'paused', 'completed', 'unknown']);
export const TASK_KINDS = Object.freeze(['read', 'write', 'think', 'wait', 'other']);
export const MATERIAL_TYPES = Object.freeze(['package', 'events', 'pref', 'book']);

const MAX_TITLE = 120;
const MAX_FOCUS = 200;
const MAX_LIST_ITEMS = 10;
const MAX_ITEM_CHARS = 200;
const MAX_MATERIALS = 20;
const MAX_MATERIAL_CHARS = 2000;
const ALLOWED_KEYS = Object.freeze({
  package: ['type', 'id'],
  events: ['type', 'startSeq', 'endSeq'],
  pref: ['type', 'id'],
  book: ['type', 'page'],
});

export class LifeTaskError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifeTaskError';
    this.code = code;
  }
}

function requireStore(store) {
  if (store === null || typeof store !== 'object' || typeof store.db !== 'object' || typeof store.atomic !== 'function') {
    throw new LifeTaskError('missing_store');
  }
}

function isoAt(value) {
  if (value === undefined) return new Date().toISOString();
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new LifeTaskError('invalid_time', String(value));
  return new Date(ms).toISOString();
}

function requireId(itemId) {
  if (typeof itemId !== 'string' || itemId.trim() === '') throw new LifeTaskError('invalid_item_id');
  const id = itemId.trim();
  if (id.length > 80) throw new LifeTaskError('invalid_item_id', 'too long');
  return id;
}

function requireText(value, name, max) {
  if (typeof value !== 'string') throw new LifeTaskError('invalid_' + name, String(value));
  const text = value.trim();
  if (text === '') throw new LifeTaskError('invalid_' + name, 'empty');
  if (text.length > max) throw new LifeTaskError('invalid_' + name, 'longer than ' + max);
  return text;
}

function normaliseList(raw, name) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new LifeTaskError('invalid_' + name);
  if (raw.length > MAX_LIST_ITEMS) throw new LifeTaskError('too_many_' + name, String(raw.length));
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') throw new LifeTaskError('invalid_' + name + '_item', String(entry));
    const text = entry.trim();
    if (text === '') continue;
    if (text.length > MAX_ITEM_CHARS) throw new LifeTaskError('invalid_' + name + '_item', 'too long');
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

function normaliseMaterials(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new LifeTaskError('invalid_materials');
  if (raw.length > MAX_MATERIALS) throw new LifeTaskError('too_many_materials', String(raw.length));
  const out = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new LifeTaskError('invalid_material');
    const type = entry.type;
    if (!MATERIAL_TYPES.includes(type)) throw new LifeTaskError('invalid_material_type', String(type));
    for (const key of Object.keys(entry)) {
      if (!ALLOWED_KEYS[type].includes(key)) {
 // The whole point of an earlier design: a material is a pointer, never a copy of the
 // text. Anything extra is refused rather than quietly dropped.
        throw new LifeTaskError('material_has_extra_fields', type + '.' + key);
      }
    }
    if (type === 'package' || type === 'pref') {
      out.push({ type, id: requireText(entry.id, 'material_id', 200) });
    } else if (type === 'events') {
      const startSeq = Number(entry.startSeq);
      const endSeq = Number(entry.endSeq);
      if (!Number.isInteger(startSeq) || startSeq < 1) throw new LifeTaskError('invalid_material_range', String(entry.startSeq));
      if (!Number.isInteger(endSeq) || endSeq < startSeq) throw new LifeTaskError('invalid_material_range', String(entry.endSeq));
      out.push({ type, startSeq, endSeq });
    } else {
      const page = Number(entry.page);
      if (!Number.isInteger(page) || page < 1) throw new LifeTaskError('invalid_material_page', String(entry.page));
      out.push({ type, page });
    }
  }
  return out;
}

function toTask(row) {
  return {
    itemId: row.item_id,
    version: Number(row.version),
    kind: row.kind,
    title: row.title,
    state: row.state,
    currentFocus: row.current_focus ?? null,
    materials: row.materials_json === '[]' ? [] : JSON.parse(row.materials_json),
    pending: row.pending_json === '[]' ? [] : JSON.parse(row.pending_json),
    deferred: row.deferred_json === '[]' ? [] : JSON.parse(row.deferred_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readTaskIn(db, itemId) {
  const row = db.prepare('SELECT * FROM life_tasks WHERE item_id=?').get(itemId);
  return row === undefined ? null : toTask(row);
}

export function getTask(store, itemId) {
  requireStore(store);
  return readTaskIn(store.db, requireId(itemId));
}

function writeTaskEvent(db, at, text, task, action) {
  const info = db.prepare('INSERT INTO life_events(at, kind, role, text, meta_json) VALUES(?,?,?,?,?)')
    .run(at, 'note', 'system', text, JSON.stringify({ task: { itemId: task.itemId, version: task.version, state: task.state, action } }));
  return Number(info.lastInsertRowid);
}

/** Demotes whichever row was active; the new focus is set by the caller. */
function demoteOthers(db, itemId, at) {
  const rows = db.prepare("SELECT item_id FROM life_tasks WHERE state='active' AND item_id<>?").all(itemId);
  db.prepare("UPDATE life_tasks SET state='waiting', version=version+1, updated_at=? WHERE state='active' AND item_id<>?").run(at, itemId);
  return rows.map((row) => row.item_id);
}

/**
 * Creates a task, or updates the existing one.
 *
 * @param {object} store
 * @param {object} draft itemId, title, kind, state, currentFocus, materials, pending,
 * deferred, at, expectedVersion, residentFromSeq
 * @returns {{task:object, created:boolean, eventSeq:number|null, demoted:string[]}}
 */
export function upsertTask(store, draft) {
  requireStore(store);
  if (draft === null || typeof draft !== 'object') throw new LifeTaskError('invalid_task');
  const itemId = requireId(draft.itemId);
  const at = isoAt(draft.at);
  const kind = draft.kind ?? 'other';
  if (!TASK_KINDS.includes(kind)) throw new LifeTaskError('invalid_task_kind', String(kind));
  const title = requireText(draft.title, 'title', MAX_TITLE);
  const state = draft.state ?? 'active';
  if (!TASK_STATES.includes(state)) throw new LifeTaskError('invalid_task_state', String(state));
  const focus = draft.currentFocus === undefined || draft.currentFocus === null
    ? null
    : requireText(draft.currentFocus, 'focus', MAX_FOCUS);
  const materials = normaliseMaterials(draft.materials);
  const pending = normaliseList(draft.pending, 'pending');
  const deferred = normaliseList(draft.deferred, 'deferred');
  const residentFrom = draft.residentFromSeq === undefined || draft.residentFromSeq === null
    ? null
    : Number(draft.residentFromSeq);
  if (residentFrom !== null && !Number.isInteger(residentFrom)) throw new LifeTaskError('invalid_resident_from', String(draft.residentFromSeq));
  for (const material of materials) {
    if (material.type !== 'events' || residentFrom === null) continue;
    if (material.startSeq >= residentFrom) {
      throw new LifeTaskError('material_already_resident', material.startSeq + ' >= ' + residentFrom);
    }
  }

  return store.atomic((db) => {
    const existing = readTaskIn(db, itemId);
    if (existing === null) {
      db.prepare('INSERT INTO life_tasks(item_id, version, kind, title, state, current_focus, materials_json, pending_json, deferred_json, created_at, updated_at) ' +
        'VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(itemId, 1, kind, title, state, focus, JSON.stringify(materials), JSON.stringify(pending), JSON.stringify(deferred), at, at);
      const demoted = state === 'active' ? demoteOthers(db, itemId, at) : [];
      const task = readTaskIn(db, itemId);
      const eventSeq = writeTaskEvent(db, at, '开始一件新的事（' + title + '）', task, 'created');
      return { task, created: true, eventSeq, demoted };
    }

    if (draft.expectedVersion !== undefined && Number(draft.expectedVersion) !== existing.version) {
      throw new LifeTaskError('version_conflict', String(existing.version) + ' != ' + String(draft.expectedVersion));
    }
    const version = existing.version + 1;
    const demoted = state === 'active' && existing.state !== 'active' ? demoteOthers(db, itemId, at) : [];
    db.prepare('UPDATE life_tasks SET version=?, kind=?, title=?, state=?, current_focus=?, materials_json=?, pending_json=?, deferred_json=?, updated_at=? WHERE item_id=?')
      .run(version, kind, title, state, focus, JSON.stringify(materials), JSON.stringify(pending), JSON.stringify(deferred), at, itemId);
    const task = readTaskIn(db, itemId);
    const lifecycle = existing.state !== state || existing.title !== title || existing.kind !== kind;
    const eventSeq = lifecycle ? writeTaskEvent(db, at, describeChange(existing, task), task, state === 'completed' ? 'completed' : 'updated') : null;
    return { task, created: false, eventSeq, demoted };
  });
}

function describeChange(before, after) {
  if (after.state === 'completed') return '做完了一件事（' + after.title + '）';
  if (after.state === 'paused') return '把事情放到一边（' + after.title + '）';
  if (before.title !== after.title) return '事情的名字改了（' + before.title + ' → ' + after.title + '）';
  if (after.state === 'active') return '接着做（' + after.title + '）';
  return '更新了手头的事（' + after.title + '）';
}

/** Puts one item in its hands and demotes whatever was active. Nothing is deleted. */
export function switchFocus(store, itemId, options) {
  requireStore(store);
  const id = requireId(itemId);
  const opts = options === null || typeof options !== 'object' ? {} : options;
  const at = isoAt(opts.at);
  return store.atomic((db) => {
    const existing = readTaskIn(db, id);
    if (existing === null) throw new LifeTaskError('task_not_found', id);
    if (existing.state === 'completed') throw new LifeTaskError('task_completed', id);
    const demoted = demoteOthers(db, id, at);
    db.prepare("UPDATE life_tasks SET state='active', version=version+1, updated_at=? WHERE item_id=?").run(at, id);
    const task = readTaskIn(db, id);
    const eventSeq = writeTaskEvent(db, at, '手头的事换成（' + task.title + '）', task, 'focused');
    return { task, eventSeq, demoted };
  });
}

export function pauseTask(store, itemId, options) {
  return changeState(store, itemId, 'paused', options, '把事情放到一边（');
}

export function resumeTask(store, itemId, options) {
  return changeState(store, itemId, 'active', options, '接着做（');
}

function changeState(store, itemId, state, options, label) {
  requireStore(store);
  const id = requireId(itemId);
  const opts = options === null || typeof options !== 'object' ? {} : options;
  const at = isoAt(opts.at);
  return store.atomic((db) => {
    const existing = readTaskIn(db, id);
    if (existing === null) throw new LifeTaskError('task_not_found', id);
    if (existing.state === state) throw new LifeTaskError('already_in_state', state);
    if (existing.state === 'completed' && state !== 'completed') throw new LifeTaskError('task_completed', id);
    const demoted = state === 'active' ? demoteOthers(db, id, at) : [];
    db.prepare('UPDATE life_tasks SET state=?, version=version+1, updated_at=? WHERE item_id=?').run(state, at, id);
    const task = readTaskIn(db, id);
    const eventSeq = writeTaskEvent(db, at, label + task.title + '）', task, state === 'active' ? 'resumed' : 'paused');
    return { task, eventSeq, demoted };
  });
}

export function completeTask(store, itemId, options) {
  requireStore(store);
  const id = requireId(itemId);
  const opts = options === null || typeof options !== 'object' ? {} : options;
  const at = isoAt(opts.at);
  const note = opts.note === undefined || opts.note === null ? null : requireText(opts.note, 'note', MAX_FOCUS);
  return store.atomic((db) => {
    const existing = readTaskIn(db, id);
    if (existing === null) throw new LifeTaskError('task_not_found', id);
    if (existing.state === 'completed') throw new LifeTaskError('already_completed', id);
    db.prepare("UPDATE life_tasks SET state='completed', current_focus=NULL, version=version+1, updated_at=? WHERE item_id=?").run(at, id);
    const task = readTaskIn(db, id);
    const text = '做完了一件事（' + task.title + '）' + (note === null ? '' : '：' + note);
    const eventSeq = writeTaskEvent(db, at, text, task, 'completed');
    return { task, eventSeq };
  });
}

/** The one task the agent is on, or null. More than one active row means a bug, not a state. */
export function focusTask(store) {
  requireStore(store);
  const rows = store.db.prepare("SELECT * FROM life_tasks WHERE state='active' ORDER BY updated_at DESC").all();
  if (rows.length > 1) throw new LifeTaskError('multiple_active', rows.map((row) => row.item_id).join(','));
  return rows.length === 0 ? null : toTask(rows[0]);
}

export function listTasks(store, options) {
  requireStore(store);
  const opts = options === null || typeof options !== 'object' ? {} : options;
  const states = opts.states === undefined ? ['active', 'waiting', 'paused'] : opts.states;
  if (!Array.isArray(states) || states.length === 0) throw new LifeTaskError('invalid_states');
  for (const state of states) if (!TASK_STATES.includes(state)) throw new LifeTaskError('invalid_task_state', String(state));
  const limit = opts.limit === undefined ? 50 : Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new LifeTaskError('invalid_limit', String(opts.limit));
  const marks = states.map(() => '?').join(',');
  return store.db.prepare('SELECT * FROM life_tasks WHERE state IN (' + marks + ') ORDER BY updated_at DESC, item_id LIMIT ?')
    .all(...states, limit).map(toTask);
}

function preview(text) {
  return text.length > 80 ? text.slice(0, 80) + '…' : text;
}

/**
 * Turns material pointers into text on demand.
 * A pointer to a withdrawn package follows the correction chain instead
 * of failing: the corrected memory is what the agent should be reading.
 */
export function resolveMaterials(store, itemId, options) {
  requireStore(store);
  const id = requireId(itemId);
  const opts = options === null || typeof options !== 'object' ? {} : options;
  const limit = opts.limitChars === undefined ? MAX_MATERIAL_CHARS : Number(opts.limitChars);
  if (!Number.isInteger(limit) || limit < 1) throw new LifeTaskError('invalid_limit', String(opts.limitChars));
  const task = readTaskIn(store.db, id);
  if (task === null) throw new LifeTaskError('task_not_found', id);
  const resolved = task.materials.map((material) => {
    if (material.type === 'package') return resolvePackage(store, material, limit);
    if (material.type === 'events') return resolveEvents(store, material, limit);
    if (material.type === 'pref') return resolvePref(store, material, limit);
    return { type: 'book', ref: String(material.page), ok: true, page: material.page, text: null, note: 'book_text_unavailable' };
  });
  return { itemId: task.itemId, title: task.title, materials: resolved };
}

function clipped(text, limit) {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

function resolvePackage(store, material, limit) {
  const record = getPackage(store, material.id);
  if (record === null) return { type: 'package', ref: material.id, ok: false, error: 'material_unavailable' };
  if (record.status !== 'withdrawn') {
    const cut = clipped(record.text, limit);
    return { type: 'package', ref: material.id, ok: true, text: cut.text, truncated: cut.truncated, corrected: false };
  }
  const pointer = findCorrection(store, material.id);
  if (pointer === null) return { type: 'package', ref: material.id, ok: false, error: 'material_withdrawn' };
  const correctedRecord = getPackage(store, pointer.to);
  if (correctedRecord === null) return { type: 'package', ref: material.id, ok: false, error: 'material_unavailable' };
  const cut = clipped(correctedRecord.text, limit);
  return { type: 'package', ref: material.id, ok: true, text: cut.text, truncated: cut.truncated, corrected: true, via: pointer.to };
}

function resolveEvents(store, material, limit) {
  let rows;
  try {
    rows = readRange(store, material.startSeq, material.endSeq);
  } catch {
    return { type: 'events', ref: material.startSeq + '-' + material.endSeq, ok: false, error: 'material_unavailable' };
  }
  if (rows.length === 0) return { type: 'events', ref: material.startSeq + '-' + material.endSeq, ok: false, error: 'material_unavailable' };
  const joined = rows.map((row) => row.text).join('\n');
  const cut = clipped(joined, limit);
  return { type: 'events', ref: material.startSeq + '-' + material.endSeq, ok: true, text: cut.text, truncated: cut.truncated, events: rows.length };
}

function resolvePref(store, material, limit) {
  const row = store.db.prepare("SELECT text FROM life_prefs WHERE id=? AND status='active' ORDER BY version DESC LIMIT 1").get(material.id);
  if (row === undefined) return { type: 'pref', ref: material.id, ok: false, error: 'material_unavailable' };
  const cut = clipped(row.text, limit);
  return { type: 'pref', ref: material.id, ok: true, text: cut.text, truncated: cut.truncated };
}

/** Short line for the tail segment: what the agent is on, and what is waiting. */
export function describeFocus(store) {
  requireStore(store);
  const focus = focusTask(store);
  const waiting = listTasks(store, { states: ['waiting', 'paused'], limit: 5 });
  return {
    focus: focus === null ? null : { itemId: focus.itemId, title: focus.title, currentFocus: focus.currentFocus },
    waiting: waiting.map((task) => ({ itemId: task.itemId, title: task.title, state: task.state, currentFocus: task.currentFocus })),
    preview: focus === null ? null : preview(focus.title + (focus.currentFocus === null ? '' : '：' + focus.currentFocus)),
  };
}