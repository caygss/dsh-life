/**
 * The agent's own moments: "过十分钟再问你" / "19 点记着吃饭"。
 *
 * Everything else in its day is either something that happened (an arrival), something
 * unfinished (a task) or its own rhythm (the scheduler). This is the fourth thing: a moment
 * the agent picked, including a moment that looks like a clock time. Before this module the agent could
 * only come back to something when the scheduler happened to draw its awake, which is why
 * "助手怎么刚好在 19:00 问我吃饭" was a draw and not a plan.
 *
 * Shape of a reminder, and what is deliberately NOT here:
 * - no model call, no prompt text: a reminder is a row, firing it is the loop's job
 * - no deletion: pending -> fired/cancelled in place, the row stays
 * - no clock inside: the caller passes its own clock (at), so a sped-up test day works
 * - a due reminder is only SHOWN (tail) and only fires while the agent is awake; one that comes
 * due while the agent sleeps waits for it, like a message
 *
 * Two kinds in the same table:
 * 'remind' - comes due, waits for it if the agent is asleep, and the agent sees it when the agent wakes
 * 'alarm' - the same row and the same limits, except that a due alarm may wake the agent;
 * that is the whole difference, and the loop is the one that acts on it
 */
import { randomUUID } from 'node:crypto';

/** The two kinds, and what each one is allowed to do when its moment arrives. */
export const REMINDER_KINDS = Object.freeze(['remind', 'alarm']);

export const REMINDER_LIMITS = Object.freeze({
  noteMaxChars: 200,
  reasonMaxChars: 200,
  minLeadMs: 30_000,
  maxHorizonMs: 30 * 24 * 3600_000,
  maxPending: 20,
  listDefault: 10,
  listMax: 30,
  tailDisplay: 5,
 // 闹钟迟到多久还算「该把助手叫起来」：
 // <= 这个窗口 -> 照旧叫醒助手；
 // > 这个窗口 -> 不叫（机器停太久，那一声已经没有意义），但必须让助手知道这条没响成：
 // noteLateAlarm 只记一次，尾段/列表写「没响成」，等助手醒了再当那一轮说。
 // 这是「迟到」的窗口，不是「能定多远」的上限：往前定 20 小时、30 天都可以（maxHorizonMs）。
  alarmMaxLateMs: 2 * 3600_000,
 // 再睡一会儿：默认 10 分钟，最多 4 小时；
 // 不给 id 时找最近 30 分钟内响过的那条闹钟——助手说「再睡十分钟」时不必记得 id。
  snoozeDefaultMinutes: 10,
  snoozeMaxMinutes: 240,
  snoozeLookbackMs: 30 * 60_000,
});

export class LifeReminderError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifeReminderError';
    this.code = code;
  }
}

function requireStore(store) {
  if (store === null || typeof store !== 'object' || typeof store.db !== 'object') {
    throw new LifeReminderError('missing_store', typeof store);
  }
  return store;
}

function nowOf(input) {
  if (input === null || typeof input !== 'object') throw new LifeReminderError('invalid_input');
  const at = input.at;
  if (at === undefined) return Date.now();
  if (typeof at === 'number' && Number.isFinite(at)) return at;
  const parsed = Date.parse(String(at));
  if (!Number.isFinite(parsed)) throw new LifeReminderError('invalid_time', String(at));
  return parsed;
}

function noteOf(input) {
  const text = typeof input.note === 'string' ? input.note.trim() : '';
  if (text === '') throw new LifeReminderError('note_required');
  const chars = Array.from(text);
  if (chars.length > REMINDER_LIMITS.noteMaxChars) {
    throw new LifeReminderError('note_too_long', chars.length + ' > ' + REMINDER_LIMITS.noteMaxChars);
  }
  return text;
}

/**
 * When it comes due. Two shapes, because the agent says it two ways:
 * inMinutes - "过十分钟再问我" (relative)
 * dueAt - "19:00" as an ISO stamp with an offset
 * A stamp without an offset is read in the machine's own zone (whatever TZ it runs in,
 * container); the caller can also pass milliseconds.
 */
function dueOf(input, at) {
  const minutes = input.inMinutes;
  if (minutes !== undefined && minutes !== null) {
    const value = Number(minutes);
    if (!Number.isFinite(value)) throw new LifeReminderError('due_invalid', String(minutes));
    return at + Math.round(value * 60_000);
  }
  const dueAt = input.dueAt;
  if (dueAt === undefined || dueAt === null || dueAt === '') throw new LifeReminderError('due_required');
  if (typeof dueAt === 'number' && Number.isFinite(dueAt)) return dueAt;
  const parsed = Date.parse(String(dueAt));
  if (!Number.isFinite(parsed)) throw new LifeReminderError('due_invalid', String(dueAt));
  return parsed;
}

function rowToReminder(row, at) {
  const dueMs = Date.parse(row.due_at);
  const lateByMs = Math.max(0, at - dueMs);
  return {
    id: row.id,
    dueAt: row.due_at,
    dueInMs: dueMs - at,
    overdue: dueMs <= at,
    lateByMs,
 // 该响没响的闹钟：过点超过窗口，还挂着（这条要告诉助手，而不是悄悄补成一响）。
    late: row.kind === 'alarm' && row.status === 'pending' && lateByMs > REMINDER_LIMITS.alarmMaxLateMs,
    lateNoticedAt: row.late_notice_at ?? null,
    note: row.note,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    firedAt: row.fired_at ?? null,
    cancelledAt: row.cancelled_at ?? null,
    source: row.source,
  };
}

/** 'alarm' has to be said out loud, once; everything else is an ordinary reminder. */
function kindOf(input) {
  const raw = input.kind !== undefined ? input.kind : (input.alarm === true ? 'alarm' : 'remind');
  if (!REMINDER_KINDS.includes(raw)) throw new LifeReminderError('invalid_kind', String(raw));
  return raw;
}

function countPending(store) {
  return Number(store.db.prepare("SELECT COUNT(*) AS n FROM life_reminders WHERE status='pending'").get().n);
}

/**
 * @returns {object} ok/id/dueAt/dueInMs/note/status
 */
export function createReminder(store, input = {}) {
  requireStore(store);
  const at = nowOf(input);
  const note = noteOf(input);
  const kind = kindOf(input);
  const dueMs = dueOf(input, at);
  if (dueMs < at + REMINDER_LIMITS.minLeadMs) throw new LifeReminderError('reminder_too_soon', String(dueMs - at) + 'ms');
  if (dueMs > at + REMINDER_LIMITS.maxHorizonMs) throw new LifeReminderError('reminder_too_far', String(dueMs - at) + 'ms');
  const pending = countPending(store);
  if (pending >= REMINDER_LIMITS.maxPending) throw new LifeReminderError('reminder_queue_full', String(pending));

  const id = 'rem-' + randomUUID().slice(0, 8);
  const createdAt = new Date(at).toISOString();
  const dueAt = new Date(dueMs).toISOString();
  const source = input.source === 'host' ? 'host' : 'agent';
  store.db.prepare(
    'INSERT INTO life_reminders(id, due_at, note, kind, status, created_at, source, meta_json) VALUES(?,?,?,?,?,?,?,?)',
  ).run(id, dueAt, note, kind, 'pending', createdAt, source, '{}');
  return { ok: true, id, dueAt, dueInMs: dueMs - at, note, kind, status: 'pending', createdAt, source };
}

/**
 * 记下「这条闹钟在该响的时候没响，已经告诉助手了」。只写一次：循环每 tick 都会看见这条到点的
 * 闹钟，但「没响成」这件事助手只需要知道一次。
 *
 * @returns {{ok:true, id:string, at:string, lateByMs:number}|null} null = 已经记过（或已经不是待响的）
 */
export function noteLateAlarm(store, id, options = {}) {
  requireStore(store);
  if (typeof id !== 'string' || id === '') throw new LifeReminderError('invalid_id', String(id));
  const at = options.at === undefined ? Date.now() : Date.parse(String(options.at));
  if (!Number.isFinite(at)) throw new LifeReminderError('invalid_time', String(options.at));
  const noticedAt = new Date(at).toISOString();
  const result = store.db.prepare(
    "UPDATE life_reminders SET late_notice_at=? WHERE id=? AND status='pending' AND late_notice_at IS NULL",
  ).run(noticedAt, id);
  if (Number(result.changes) === 0) return null;
  const row = store.db.prepare('SELECT due_at FROM life_reminders WHERE id=?').get(id);
  return { ok: true, id, at: noticedAt, lateByMs: Math.max(0, at - Date.parse(row.due_at)) };
}

/** Pending rows, nearest first. overdue is computed against its clock, not the wall clock. */
export function pendingReminders(store, input = {}) {
  requireStore(store);
  const at = nowOf(input);
  const limit = Number.isInteger(input.limit) && input.limit > 0
    ? Math.min(input.limit, REMINDER_LIMITS.listMax) : REMINDER_LIMITS.listDefault;
  return store.db.prepare("SELECT * FROM life_reminders WHERE status='pending' ORDER BY due_at, id LIMIT ?").all(limit)
    .map((row) => rowToReminder(row, at));
}

/** Rows whose moment has arrived, nearest first. */
export function dueReminders(store, at, options = {}) {
  requireStore(store);
  const when = typeof at === 'number' ? at : Date.parse(String(at));
  if (!Number.isFinite(when)) throw new LifeReminderError('invalid_time', String(at));
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : REMINDER_LIMITS.listDefault;
  // The loop asks for the two kinds separately: an alarm may wake the agent, a reminder may not.
  const kind = options.kind === undefined ? null : options.kind;
  if (kind !== null && !REMINDER_KINDS.includes(kind)) throw new LifeReminderError('invalid_kind', String(kind));
  const where = kind === null
    ? "SELECT * FROM life_reminders WHERE status='pending' AND due_at <= ? ORDER BY due_at, id LIMIT ?"
    : "SELECT * FROM life_reminders WHERE status='pending' AND kind=? AND due_at <= ? ORDER BY due_at, id LIMIT ?";
  const rows = kind === null
    ? store.db.prepare(where).all(new Date(when).toISOString(), limit)
    : store.db.prepare(where).all(kind, new Date(when).toISOString(), limit);
  return rows.map((row) => rowToReminder(row, when));
}

export function listReminders(store, input = {}) {
  requireStore(store);
  const at = nowOf(input);
  const limit = Number.isInteger(input.limit) && input.limit > 0
    ? Math.min(input.limit, REMINDER_LIMITS.listMax) : REMINDER_LIMITS.listDefault;
  const finished = input.includeFinished === true;
  const where = finished ? '' : "WHERE status='pending' ";
  const order = finished ? 'ORDER BY created_at DESC, id DESC' : 'ORDER BY due_at, id';
  return store.db.prepare('SELECT * FROM life_reminders ' + where + order + ' LIMIT ?').all(limit)
    .map((row) => rowToReminder(row, at));
}

/** Marks one as arrived. Returns null when it was not pending any more (fired twice is a no-op). */
export function fireReminder(store, id, options = {}) {
  requireStore(store);
  if (typeof id !== 'string' || id === '') throw new LifeReminderError('invalid_id', String(id));
  const at = options.at === undefined ? Date.now() : Date.parse(String(options.at));
  if (!Number.isFinite(at)) throw new LifeReminderError('invalid_time', String(options.at));
  const firedAt = new Date(at).toISOString();
  const result = store.db.prepare("UPDATE life_reminders SET status='fired', fired_at=? WHERE id=? AND status='pending'").run(firedAt, id);
  if (Number(result.changes) === 0) return null;
  return { ok: true, id, status: 'fired', firedAt };
}

/** Cancels one the agent no longer wants. A finished reminder cannot be cancelled again. */
export function cancelReminder(store, input = {}) {
  requireStore(store);
  const id = input.id;
  if (typeof id !== 'string' || id === '') throw new LifeReminderError('invalid_id', String(id));
  const at = nowOf(input);
  const reasonText = typeof input.reason === 'string' ? input.reason.trim() : '';
  const chars = Array.from(reasonText);
  if (chars.length > REMINDER_LIMITS.reasonMaxChars) {
    throw new LifeReminderError('reason_too_long', chars.length + ' > ' + REMINDER_LIMITS.reasonMaxChars);
  }
  const cancelledAt = new Date(at).toISOString();
  const result = store.db.prepare(
    "UPDATE life_reminders SET status='cancelled', cancelled_at=?, cancel_reason=? WHERE id=? AND status='pending'",
  ).run(cancelledAt, reasonText === '' ? null : reasonText, id);
  if (Number(result.changes) === 0) {
    const row = store.db.prepare('SELECT status FROM life_reminders WHERE id=?').get(id);
    if (row === undefined) throw new LifeReminderError('reminder_not_found', id);
    throw new LifeReminderError('reminder_not_pending', String(row.status));
  }
  return { ok: true, id, status: 'cancelled', cancelledAt };
}

/** What the tail and the report want in one line. */
export function reminderStats(store, at) {
  requireStore(store);
  const when = typeof at === 'number' ? at : Date.parse(String(at));
  if (!Number.isFinite(when)) throw new LifeReminderError('invalid_time', String(at));
  const rows = store.db.prepare("SELECT due_at, kind FROM life_reminders WHERE status='pending' ORDER BY due_at, id").all();
  const pending = rows.length;
  const overdue = rows.filter((row) => Date.parse(row.due_at) <= when).length;
  // alarms: how many of the pending ones may wake the agent if they land in its sleep.
  const alarms = rows.filter((row) => row.kind === 'alarm').length;
 // missed: 该响没响的闹钟（过点超过窗口还挂着）——这一条助手会被告知，不会被悄悄补成一响。
  const missed = rows.filter((row) => row.kind === 'alarm' && when - Date.parse(row.due_at) > REMINDER_LIMITS.alarmMaxLateMs).length;
  return { pending, overdue, alarms, missed, nextDueAt: pending === 0 ? null : rows[0].due_at };
}

/**
 * 再睡一会儿：把助手自己的闹钟**顺延**，不新增一条。
 *
 * 被闹钟叫醒之后助手说「再睡十分钟」，宿主只是把同一条的 due_at 往后推、状态回到 pending，
 * meta 里记一次 snoozes。行不删、fired_at 留着（那是它上一次响的时刻）。
 *
 * @param {object} input {id?, minutes?, at?} 不给 id 就找最近 snoozeLookbackMs 内响过的闹钟
 */
export function snoozeReminder(store, input = {}) {
  requireStore(store);
  const at = nowOf(input);
  const rawMinutes = input.minutes === undefined || input.minutes === null ? REMINDER_LIMITS.snoozeDefaultMinutes : Number(input.minutes);
  if (!Number.isFinite(rawMinutes) || rawMinutes <= 0) throw new LifeReminderError('snooze_invalid', String(input.minutes));
  if (rawMinutes > REMINDER_LIMITS.snoozeMaxMinutes) {
    throw new LifeReminderError('snooze_too_long', rawMinutes + ' > ' + REMINDER_LIMITS.snoozeMaxMinutes);
  }
  const minutes = Math.round(rawMinutes);

  let row;
  if (typeof input.id === 'string' && input.id !== '') {
    row = store.db.prepare('SELECT * FROM life_reminders WHERE id=?').get(input.id);
    if (row === undefined) throw new LifeReminderError('reminder_not_found', input.id);
    if (row.kind !== 'alarm') throw new LifeReminderError('not_an_alarm', row.kind);
    if (row.status === 'cancelled') throw new LifeReminderError('reminder_not_pending', 'cancelled');
  } else {
    row = store.db.prepare(
      "SELECT * FROM life_reminders WHERE kind='alarm' AND status='fired' AND fired_at IS NOT NULL AND fired_at >= ? " +
      'ORDER BY fired_at DESC LIMIT 1',
    ).get(new Date(at - REMINDER_LIMITS.snoozeLookbackMs).toISOString());
    if (row === undefined) throw new LifeReminderError('no_recent_alarm');
  }

  const dueMs = at + minutes * 60_000;
  let meta = {};
  try { meta = JSON.parse(row.meta_json === '' ? '{}' : row.meta_json); } catch { meta = {}; }
  if (meta === null || typeof meta !== 'object') meta = {};
  meta.snoozes = Number(meta.snoozes ?? 0) + 1;
  meta.snoozedAt = new Date(at).toISOString();
  store.db.prepare("UPDATE life_reminders SET due_at=?, status='pending', cancelled_at=NULL, cancel_reason=NULL, meta_json=? WHERE id=?")
    .run(new Date(dueMs).toISOString(), JSON.stringify(meta), row.id);
  return {
    ok: true,
    id: row.id,
    note: row.note,
    source: row.source,
    minutes,
    dueAt: new Date(dueMs).toISOString(),
    dueInMs: minutes * 60_000,
    snoozes: meta.snoozes,
  };
}

/** The service the host hands to a plugin that declared surface:'schedule'.
 * Same shape as the memory facade: every call answers ok/code, never throws at the plugin.
 */
export function createReminderService(options = {}) {
  const store = requireStore(options.store);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const wrap = (fn) => {
    try { return fn(); }
    catch (error) {
      if (error instanceof LifeReminderError) return { ok: false, code: error.code, detail: error.message };
      return { ok: false, code: 'reminder_failed', detail: String((error && (error.code || error.message)) || error) };
    }
  };
  return {
    limits: REMINDER_LIMITS,
    schedule(input) { return wrap(() => createReminder(store, { ...(input ?? {}), at: now() })); },
    list(input) {
      return wrap(() => {
        const at = now();
        const rows = listReminders(store, { ...(input ?? {}), at });
        return { ok: true, at: new Date(at).toISOString(), reminders: rows, counts: reminderStats(store, at) };
      });
    },
    cancel(input) { return wrap(() => cancelReminder(store, { ...(input ?? {}), at: now() })); },
    snooze(input) { return wrap(() => snoozeReminder(store, { ...(input ?? {}), at: now() })); },
    describe() {
      try { return reminderStats(store, now()); }
      catch { return { pending: 0, overdue: 0, nextDueAt: null }; }
    },
  };
}
