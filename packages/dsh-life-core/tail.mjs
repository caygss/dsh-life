/**
 * The tail of the frame: what the agent must know to speak right now.
 *
 * Three named groups, in this order, because they answer three different questions:
 *
 * scene - what time it is, what state the agent is in, what the agent has in hand
 * plan - what is set aside and still unfinished (titles only, never bodies)
 * pending - what arrived and is waiting for it, ONE part per arrival
 *
 * Two rules are enforced here rather than by discipline:
 * - arrivals are never merged. Each gets its own part id, so "等你了解的 3 条" is three
 * lines and not one summary.
 * - materials are never resolved into this section. A plan line shows the task title and
 * its focus text; the material pointers are unpacked only when the agent actually continues
 * the task. Copying a body in here would undo the whole point of pointers.
 *
 * The tail is volatile by design: it changes every turn and must not influence the cache
 * prefix (assemble.mjs hashes only the stable segments).
 */
import { readState, describeState } from './state.mjs';
import { describeFocus } from './continuation.mjs';
import { pendingItems } from './attention.mjs';
import { pendingReminders, reminderStats, REMINDER_LIMITS } from './reminders.mjs';

export class LifeTailError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifeTailError';
    this.code = code;
  }
}

/** Local wall clock in words. A UTC stamp gets read as local time and the agent says it is 3 a.m. */
export function clockText(at, timeZone) {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) throw new LifeTailError('invalid_time', String(at));
  if (typeof timeZone !== 'string' || timeZone === '') throw new LifeTailError('invalid_time_zone');
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
 // 一个月/日的中文写法要带上「月」「日」两个字：以前只拼了数字，助手读到的是「2026年1030」。
  return pick('year') + '年' + pick('month') + '月' + pick('day') + '日 ' + pick('weekday') + ' ' + pick('hour') + ':' + pick('minute');
}

/**
 * 「对方什么时候说的」的最小写法：同一天只写 00:44，跨天写 10月29日 00:44。
 * 要避免的毛病：对方深夜发的一句话，助手几小时后被闹钟叫醒后当成刚发的，
 * 回了一句「三点了才下班」——原因就是助手读到的每一句都没有时间。
 */
export function shortClock(at, timeZone, nowAt) {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) throw new LifeTailError('invalid_time', String(at));
  if (typeof timeZone !== 'string' || timeZone === '') throw new LifeTailError('invalid_time_zone');
  const nowMs = nowAt === undefined ? Date.now() : (typeof nowAt === 'number' ? nowAt : Date.parse(String(nowAt)));
  const partsOf = (value) => new Intl.DateTimeFormat('zh-CN', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(value));
  const pick = (parts, type) => parts.find((part) => part.type === type)?.value ?? '';
  const then = partsOf(ms);
  const clock = pick(then, 'hour') + ':' + pick(then, 'minute');
  if (!Number.isFinite(nowMs)) return clock;
  const now = partsOf(nowMs);
  const sameDay = pick(then, 'year') === pick(now, 'year')
    && pick(then, 'month') === pick(now, 'month')
    && pick(then, 'day') === pick(now, 'day');
  return sameDay ? clock : pick(then, 'month') + '月' + pick(then, 'day') + '日 ' + clock;
}

/** A length of its own time in words: "12 分钟" / "1 小时 5 分钟" / "2 天". */
export function gapText(ms) {
  const minutes = Math.max(0, Math.round(Number(ms) / 60_000));
  if (!Number.isFinite(minutes)) throw new LifeTailError('invalid_time', String(ms));
  if (minutes < 1) return '不到一分钟';
  if (minutes < 60) return minutes + ' 分钟';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return hours + ' 小时' + (rest === 0 ? '' : ' ' + rest + ' 分钟');
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return days + ' 天' + (restHours === 0 ? '' : ' ' + restHours + ' 小时');
}

/**
 * @param {object} input store, at, timeZone, limit?
 * @returns {{parts:Array<{id:string, group:string, text:string}>, summary:object}}
 */
export function buildTail(input) {
  if (input === null || typeof input !== 'object') throw new LifeTailError('invalid_input');
  const { store } = input;
  if (store === null || typeof store !== 'object' || typeof store.db !== 'object') throw new LifeTailError('missing_store');
  const at = input.at === undefined ? Date.now() : input.at;
  const timeZone = input.timeZone;
  const limit = Number.isInteger(input.limit) ? input.limit : 20;
  if (!Number.isInteger(limit) || limit < 1) throw new LifeTailError('invalid_limit', String(input.limit));

  const current = readState(store);
  const focus = describeFocus(store);
  const waiting = pendingItems(store, { limit });

  const parts = [];
  const push = (id, group, text) => parts.push({ id, group, text });

  push('scene-time', 'scene', '现在是 ' + clockText(at, timeZone) + '。');
  push('scene-state', 'scene', '你现在的状态：' + describeState(current === null ? 'free' : current.state) + '。');
  if (focus.preview === null) push('scene-focus', 'scene', '你手头没有在做的事。');
  else push('scene-focus', 'scene', '你手头在做：' + focus.preview + '。');

  if (focus.waiting.length > 0) {
 // Titles only: the body lives behind a pointer and is unpacked when the agent continues.
    push('plan-waiting', 'plan', '放在一边还没做完的：' + focus.waiting.map((task) => task.title).join('、') + '。');
  }

 // 助手自己定的时刻（D3）。活着的时间只有一种用法：到点想起来。所以助手得看得见
 // 自己定过什么、还剩多久——不然助手会在同一件事上定两遍，或者忘了自己说过"过十分钟再问"。
  const atMs = typeof at === 'number' ? at : Date.parse(String(at));
  const reminders = pendingReminders(store, { at: atMs, limit: REMINDER_LIMITS.tailDisplay });
  for (const reminder of reminders) {
    const when = clockText(reminder.dueAt, timeZone);
 // 谁定的要说清楚：宿主放的（维护/验收）不能让助手以为是自己的记忆。
 // 闹钟也写清楚：这是到点会把助手叫起来的那种，不是等助手醒的。
 // 坏闹钟更要说清楚：该响的时候没响，不能装成准点响过。
    const alarm = reminder.kind === 'alarm';
    const lateAlarm = alarm && reminder.late === true;
    const state = lateAlarm
      ? '（没响成：那会儿机器停着，晚了 ' + gapText(reminder.lateByMs) + '，等你醒）'
      : (reminder.overdue ? '（已经到点了，等你）' : '（还有 ' + gapText(reminder.dueInMs) + '）');
    const who = lateAlarm
      ? (reminder.source === 'host' ? '宿主给你放的闹钟没响成：' : '你定的闹钟没响成：')
      : (alarm
        ? (reminder.source === 'host' ? '宿主给你放的闹钟：' : '你定的闹钟：')
        : (reminder.source === 'host' ? '宿主放的提醒：' : '你给自己定的：'));
    const body = alarm ? '『' + reminder.note + '』' : '想起来「' + reminder.note + '」';
    push('remind-' + reminder.id, 'remind', who + when + ' ' + body + state);
  }
  if (reminders.length > 0) {
    const counts = reminderStats(store, atMs);
    const alarms = counts.alarms === 0 ? '' : '，其中 ' + counts.alarms + ' 个是闹钟（到点在睡也会把你叫起来）';
    const missed = counts.missed === 0 ? '' : '，有 ' + counts.missed + ' 个没响成';
    push('remind-count', 'remind', '你自己定了 ' + counts.pending + ' 件要回来做/想的事' + alarms + missed + '。');
  }

 // 醒着时到的话是「有人对助手说的」，睡着时到的话才是「待办」。
 //
 // 判据用入库时记下的 disposition，不用「现在几点/现在什么状态」：
 // attention.submit 在助手那时候的状态上写死了 immediate / notify / defer（asleep -> defer），
 // 所以助手睡醒之后仍然分得清「这条是睡着时到的」，也分得清「这条是刚有人对我说的」。
 // 以前两种都写成「等你了解（…）：」，助手读到的是一张待办清单，不是在跟人说话。
 // 什么时候说的必须写出来：助手睡了三小时再看见这句话，
 // 不写时间就等于「刚刚说的」。
  let waited = 0;
  for (const item of waiting) {
    const said = shortClock(item.at, timeZone, atMs);
    const ago = gapText(atMs - Date.parse(item.at));
    if (item.disposition === 'defer') {
      waited += 1;
      push('pending-' + item.id, 'pending', '等你了解（' + said + ' 说的，' + ago + '前）：' + item.text);
      continue;
    }
    push('pending-' + item.id, 'pending', '[' + said + '] 对方：' + item.text + '（' + ago + '前说的）');
  }
  if (waited > 0) {
    push('pending-count', 'pending', '一共 ' + waited + ' 条等你了解。');
  }

  return {
    parts,
    summary: {
      at: new Date(typeof at === 'number' ? at : Date.parse(at)).toISOString(),
      timeZone,
      state: current === null ? 'free' : current.state,
      focus: focus.preview,
      waiting: focus.waiting.map((task) => task.title),
      pending: waiting.map((item) => ({ id: item.id, disposition: item.disposition })),
      reminders: reminders.map((reminder) => ({ id: reminder.id, dueAt: reminder.dueAt, overdue: reminder.overdue, kind: reminder.kind, missed: reminder.late === true })),
    },
  };
}