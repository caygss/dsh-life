/**
 * life-time：助手自己定的时刻，做成助手手上的三个动作（D3，）。
 *
 * 以前助手只有"节奏"：宿主每隔 5–70 分钟随机叫助手一次，助手醒了再看现在几点、再决定说什么。
 * 于是"19 点提醒对方吃饭"这种事只能靠运气撞上。这个插件把"到点回来"变成一个助手能自己下的动作。
 *
 * 和 life-memory 一样，这是住在插件目录里的宿主代码：声明里的 surface:'schedule' 是那道门的
 * 名字，宿主只有在助手声明了它时才会把"助手的时刻"交出来；工具进助手的工具表也走同一条缝。
 *
 * 逻辑不在这里：reminders.mjs 做全部判断（时刻、上限、到点、取消），宿主自己的循环负责到点叫醒助手。
 *
 * 闹钟：同一个动作带一个 alarm 开关。提醒到助手睡着的时候只等助手醒，
 * 闹钟会把助手叫起来——差别只在宿主循环怎么处理到点那一刻，行、上限、只响一次都一样。
 * 第四个动作 time_snooze：「再睡十分钟」——把刚响过的那条闹钟顺延，不新增一条。
 * 这个文件只把结构化结果翻成助手能读的中文——助手看到的是"定好了""到点了还没念"，
 * 不是 JSON，也不是"操作成功"。
 */
export function create(context) {
  const reminders = context.reminders;
  if (reminders === null || typeof reminders !== 'object') {
    throw new Error('life-time needs the host reminders service (surface:schedule)');
  }
  const config = context.config ?? {};
  const timeZone = typeof config.timeZone === 'string' && config.timeZone !== '' ? config.timeZone : 'UTC';
  const noteMaxChars = Number.isInteger(config.noteMaxChars) ? config.noteMaxChars : 200;
  const listDefault = Number.isInteger(config.listDefault) ? config.listDefault : 10;
  const listMax = Number.isInteger(config.listMax) ? config.listMax : 30;

  function when(value) {
    const ms = Date.parse(String(value ?? ''));
    if (!Number.isFinite(ms)) return String(value ?? '');
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone, month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(ms));
    const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
    return pick('month') + '月' + pick('day') + '日 ' + pick('weekday') + ' ' + pick('hour') + ':' + pick('minute');
  }

  function gap(ms) {
    const minutes = Math.round(Number(ms) / 60_000);
    if (!Number.isFinite(minutes)) return '';
    if (minutes <= 0) return '已经到点';
    if (minutes < 60) return minutes + ' 分钟后';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 24) return hours + ' 小时' + (rest === 0 ? '' : ' ' + rest + ' 分钟') + '后';
    return Math.floor(hours / 24) + ' 天后';
  }

  const REFUSALS = Object.freeze({
    note_required: '要提醒什么？那句话不能是空的。',
    note_too_long: '那句话太长了（' + noteMaxChars + ' 字以内），说短一点我才能原样记着。',
    due_required: '什么时候提醒你？给个时刻，或者给多少分钟以后。',
    due_invalid: '这个时间我没看懂；写成 2026-10-30T19:00:00+08:00 这样，或者直接说多少分钟以后。',
    reminder_too_soon: '太近了，至少 30 秒以后——不然等于我自言自语。',
    reminder_too_far: '太远了，最多 30 天。',
    reminder_queue_full: '你手上已经挂着 20 件了，先做掉几件，或者取消几件再定。',
    reminder_not_found: '没找到这一条。',
    reminder_not_pending: '这条已经到点了，或者已经被取消了。',
    reason_too_long: '理由太长了，一句就够。',
    invalid_kind: '只分两种：提醒（等你醒）和闹钟（到点叫醒你）。',
    snooze_invalid: '再睡多少分钟？给个正数。',
    snooze_too_long: '一次最多再睡 240 分钟，再长就不是打盹了。',
    no_recent_alarm: '最近没有响过的闹钟可以顺延（半小时内）。',
    not_an_alarm: '只有闹钟能顺延；提醒本来就等你醒，不用推迟。',
  });

  function refusal(result) {
    const known = REFUSALS[result.code];
    if (known !== undefined) return known;
    return '没做成（' + result.code + '）。';
  }

  context.tool('time_schedule', {
    description: '给自己定一个时刻：到点我会自己回来想起这件事。可以说多少分钟以后，也可以说到几点。'
      + '要给睡觉时的自己上闹钟，就加上 alarm。',
    parameters: {
      type: 'object',
      properties: {
        dueAt: { type: 'string', description: '什么时候，例如 2026-10-30T19:00:00+08:00；跟 inMinutes 二选一' },
        inMinutes: { type: 'integer', description: '多少分钟以后（1–43200）；跟 dueAt 二选一' },
        note: { type: 'string', description: '到点要想起的那句话（' + noteMaxChars + ' 字以内，原样记着）' },
        alarm: { type: 'boolean', description: 'true = 闹钟：到点时你在睡，也会把你叫起来；不填 = 普通提醒，只等你醒' },
      },
      required: ['note'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const result = reminders.schedule(args ?? {});
      if (result.ok !== true) return refusal(result);
      if (result.kind === 'alarm') {
        return '闹钟定好了：' + when(result.dueAt) + ' 叫你「' + result.note + '」（' + gap(result.dueInMs) + '；id ' + result.id + '）。'
          + '到点时就算我在睡，也会自己醒过来。';
      }
      return '定好了：' + when(result.dueAt) + ' 想起来「' + result.note + '」（' + gap(result.dueInMs) + '；id ' + result.id + '）。'
        + '到点我自己会回来，不用你提醒我。';
    },
  });

  context.tool('time_list', {
    description: '看看你自己定过什么时刻、还剩多久；也可以看已经到点或取消掉的。',
    parameters: {
      type: 'object',
      properties: {
        includeFinished: { type: 'boolean', description: '连已到点、已取消的也一起列' },
        limit: { type: 'integer', description: '最多几条，默认 ' + listDefault + '，最多 ' + listMax },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const settings = args ?? {};
      const limit = Number.isFinite(Number(settings.limit)) && Number(settings.limit) > 0
        ? Math.min(Math.floor(Number(settings.limit)), listMax) : listDefault;
      const result = reminders.list({ ...settings, limit });
      if (result.ok !== true) return refusal(result);
      if (result.reminders.length === 0) {
        return settings.includeFinished === true ? '你还没定过什么时刻。' : '你现在没有定着什么事。';
      }
      const lines = result.reminders.map((reminder) => {
        const alarm = reminder.kind === 'alarm';
 // 坏闹钟：该响的时候没响，就要写成没响成，不能写成准点过。
        const missed = reminder.late === true;
        const state = reminder.status === 'pending'
          ? (missed
            ? '没响成：' + gap(reminder.lateByMs).replace(/后$/, '') + '前就该响，那会儿机器停着'
            : (reminder.overdue ? (alarm ? '已经到点了，还没叫到你' : '已经到点了，等你') : '还有 ' + gap(reminder.dueInMs).replace(/后$/, '')))
          : (reminder.status === 'fired' ? '已经到点过' : '已取消');
        const who = missed
          ? (reminder.source === 'host' ? '宿主的坏闹钟' : '坏闹钟')
          : (alarm
            ? (reminder.source === 'host' ? '宿主闹钟' : '闹钟')
            : (reminder.source === 'host' ? '宿主放的' : '定的'));
        return '【' + who + '】' + when(reminder.dueAt) + ' ' + reminder.id + '（' + state + '）：' + reminder.note;
      });
      return '一共 ' + result.counts.pending + ' 件还挂着：\n' + lines.join('\n');
    },
  });

  context.tool('time_cancel', {
    description: '取消一个你自己定的时刻：到点就不会再响。已经到点或已经取消过的取消不了。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要取消的那条 id' },
        reason: { type: 'string', description: '为什么取消（可省，200 字以内）' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const result = reminders.cancel(args ?? {});
      if (result.ok !== true) return refusal(result);
      return '取消了：' + result.id + '。到点不会再响，记录还留着。';
    },
  });

  context.tool('time_snooze', {
    description: '再睡一会儿：把你自己的闹钟往后顺延，不新增一条。被闹钟叫醒之后说「再睡十分钟」就用它。',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'integer', description: '再睡多少分钟（默认 10，最多 240）' },
        id: { type: 'string', description: '要顺延的那条 id（可省：不填就是刚刚响过的那条闹钟）' },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const result = reminders.snooze(args ?? {});
      if (result.ok !== true) return refusal(result);
      return '行，再睡 ' + result.minutes + ' 分钟：这条闹钟顺到 ' + when(result.dueAt) + '（' + gap(result.dueInMs) + '；第 '
        + result.snoozes + ' 次往后推，id ' + result.id + '）。到点我再叫你。';
    },
  });

  const described = typeof reminders.describe === 'function' ? reminders.describe() : null;
  context.log('life-time ready: ' + (described === null
    ? 'no counts'
    : described.pending + ' pending / ' + described.overdue + ' overdue / ' + (described.alarms ?? 0) + ' alarms'));
}
