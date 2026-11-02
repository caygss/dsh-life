/**
 * life-memory：助手自己的记忆，做成助手手上的五个动作（D1/D2，）。
 *
 * 和 life-room 一样，这是**住在插件目录里的宿主代码**：装、授权、启用的路一条不少
 * （声明里的 surface:'memory' 是那道门的名字，宿主只有在助手声明了它时才会把记忆服务交出来），
 * 工具进助手的工具表也只走同一条缝。不一样的地方在能力：这个插件读写助手的记忆。
 *
 * 逻辑不在这里。facade.mjs 做全部判断（区间、事务、修订链、撤回理由、上限），
 * 这个文件只把结构化结果翻成助手能读的中文——助手看到的是"记住了""没找到"，
 * 不是 JSON，也不是"操作成功"。
 *
 * 一条硬规矩：**找不到就说找不到**。这里没有任何"我记得你说过…"的回退，
 * 也没有把相似当成相同的兜底。
 */
export function create(context) {
  const memory = context.memory;
  if (memory === null || typeof memory !== 'object') {
    throw new Error('life-memory needs the host memory service (surface:memory)');
  }
  const config = context.config ?? {};
  const noteMaxChars = Number.isInteger(config.noteMaxChars) ? config.noteMaxChars : 1000;
  const reviseMaxChars = Number.isInteger(config.reviseMaxChars) ? config.reviseMaxChars : 500;
  const reasonMaxChars = Number.isInteger(config.reasonMaxChars) ? config.reasonMaxChars : 200;
  const recallDefaultLimit = Number.isInteger(config.recallDefaultLimit) ? config.recallDefaultLimit : 8;
  const recallMaxLimit = Number.isInteger(config.recallMaxLimit) ? config.recallMaxLimit : 20;
  const unpackDefaultChars = Number.isInteger(config.unpackDefaultChars) ? config.unpackDefaultChars : 1500;
  const unpackMaxChars = Number.isInteger(config.unpackMaxChars) ? config.unpackMaxChars : 6000;
  const prefMaxChars = Number.isInteger(config.prefMaxChars) ? config.prefMaxChars : 200;

 // 给助手看的时间一律本地钟点：以前是"UTC + 8 小时"的硬偏移，
 // 只在东八区碰巧对；现在按真时区格式化，输出形状不变（18:12）。
  const displayZone = typeof context.config.timeZone === 'string' && context.config.timeZone.trim() !== ''
    ? context.config.timeZone.trim() : 'UTC';
  function when(at) {
    const stamp = Date.parse(String(at ?? ''));
    if (!Number.isFinite(stamp)) return String(at ?? '');
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: displayZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(stamp));
      const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
      return pick('year') + '-' + pick('month') + '-' + pick('day') + ' ' + pick('hour') + ':' + pick('minute');
    } catch {
      return String(at ?? '');
    }
  }

  const REFUSALS = Object.freeze({
    text_required: '要记的东西是空的，没记。',
    text_too_long: '这段太长了，一次记不下；拆短一点。',
    id_required: '要动哪一条？给我 id。',
    id_or_seq_required: '要展开哪一条？给我 id（记着的）或者 seq（原话）。',
    reason_required: '改或撤要说清为什么，不说我不动。',
    reason_too_long: '理由太长了，一句就够。',
    not_found: '没找到这一条。',
    withdrawn: '这一条是助手自己撤回的，不退回去了。',
    already_withdrawn: '这一条已经被改过或撤回了。',
    package_not_found: '没找到这一条。',
    too_many_preferences: '你写下的立场已经到上限了，先撤回一条再写新的。',
  });

  function refusal(result) {
    const known = REFUSALS[result.code];
    if (known !== undefined) return known;
    return '没做成（' + result.code + '）。';
  }

  context.tool('memory_note', {
    description: '把一段话的原文记进你自己的记忆，以后能自己想回来。写什么就存什么，不概括、不改写。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的原话（' + noteMaxChars + ' 字以内）' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const result = await memory.note(args ?? {});
      if (result.ok !== true) return refusal(result);
      const how = result.indexed === 'terms+vector' ? '按字面和意思都能想回来' : '先按字面想（这条没做成向量）';
      return '记住了：' + result.id + '（原文 ' + result.chars + ' 字，' + when(result.at) + '；' + how + '）';
    },
  });

  context.tool('memory_recall', {
    description: '想起以前的事：先翻你自己记着的，不够再翻当时的原话。不给词就是最近记着的。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '想找什么，一句话或几个词；不给就是最近记着的' },
        days: { type: 'integer', description: '只看最近这些天里的，不给就是全部' },
        limit: { type: 'integer', description: '最多几条，默认 ' + recallDefaultLimit + '，最多 ' + recallMaxLimit },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const settings = args ?? {};
      const limit = Number.isFinite(Number(settings.limit)) && Number(settings.limit) > 0
        ? Math.min(Math.floor(Number(settings.limit)), recallMaxLimit) : recallDefaultLimit;
      const result = await memory.recall({ ...settings, limit });
      if (result.ok !== true) return refusal(result);
      const lines = [];
      for (const entry of result.remembered) {
 // 「关于谁」摆在助手眼前：压缩时助手自己标的，召回时带上。
        const about = Array.isArray(entry.subjects) && entry.subjects.length > 0
          ? '（关于：' + entry.subjects.slice(0, 3).join('、') + '）'
          : '';
        lines.push('【记着的】' + when(entry.at) + ' ' + entry.id + about + '：' + excerpt(entry.text));
      }
      for (const entry of result.said) {
        lines.push('【原话】' + when(entry.at) + ' seq ' + entry.seq + ' ' + entry.who + '：' + excerpt(entry.text));
      }
      if (lines.length === 0) {
        const total = result.counts.remembered + result.counts.said;
        return total === 0
          ? (result.query === '' ? '你现在还没记下什么。' : '没找到跟「' + result.query + '」有关的：记着的没有，原话也没有。')
          : '没找到。';
      }
      const head = result.query === '' ? '最近记着的 ' + lines.length + ' 条：' : '找到 ' + lines.length + ' 条（' + result.query + '）：';
      const body = lines.join('\n');
      const tail = result.route === 'keyword_only' ? '\n（这次只按字面找，没走向量）' : '';
      return head + '\n' + body + tail;
    },
  });

  context.tool('memory_unpack', {
    description: '把一条记忆或一句原话展开成当时的原文，一个字都不改。给 id 展开记忆，给 seq 展开那前后的原话。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆的 id（memory_recall 里那个）' },
        seq: { type: 'integer', description: '原话的 seq（memory_recall 里【原话】那行的）' },
        chars: { type: 'integer', description: '最多回多少字，默认 ' + unpackDefaultChars + '，最多 ' + unpackMaxChars },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const settings = args ?? {};
      const chars = Number.isFinite(Number(settings.chars)) && Number(settings.chars) > 0
        ? Math.min(Math.floor(Number(settings.chars)), unpackMaxChars) : unpackDefaultChars;
      const result = await memory.unpack({ ...settings, chars });
      if (result.ok !== true) return refusal(result);
      const head = result.kind === 'package'
        ? (result.source === 'note' ? '【你当时写下的】' : '【原文】')
          + (result.correctedFrom === null ? result.id : result.id + '（原来那条已改，这是改后的）') + ' · 记于 ' + when(result.from)
        : '【原话】seq ' + result.seq + ' 前后';
      const tail = result.truncated ? '\n（后面还有，没全展开：还有 ' + result.droppedEvents + ' 条）' : '';
      return head + '\n' + result.text + tail;
    },
  });

  context.tool('memory_revise', {
    description: '改一条你自己记着的东西：原文留着、旧的标成已改，新的顶上去。要说清为什么改。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要改的那条 id' },
        text: { type: 'string', description: '改后的内容（' + reviseMaxChars + ' 字以内）' },
        reason: { type: 'string', description: '为什么改（' + reasonMaxChars + ' 字以内）' },
      },
      required: ['id', 'text', 'reason'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const result = memory.revise(args ?? {});
      if (result.ok !== true) return refusal(result);
      return '改好了：' + result.from + ' 标成已改，现在是 ' + result.to + '（原来那条还在，能查）。';
    },
  });

  context.tool('memory_withdraw', {
    description: '撤回一条你自己记着的东西：标成撤回、理由写下来，两条都不删。不说理由就不动。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要撤回的那条 id' },
        reason: { type: 'string', description: '为什么撤回（' + reasonMaxChars + ' 字以内）' },
      },
      required: ['id', 'reason'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const result = memory.withdraw(args ?? {});
      if (result.ok !== true) return refusal(result);
      return '撤回了：' + result.id + '（理由记下了，谁也没删）。';
    },
  });

 // 立场：和记忆不是一回事——记忆要想起来，立场一直在眼前。
 // 这里不判断助手能不能这么想，只负责让「我怎么想」有个地方落下去、还能改、还能撤。
  context.tool('memory_prefer', {
    description: '写你自己的立场：你怎么想、喜欢什么、不喜欢什么、什么不碰。这些会一直在你眼前，不用想起来才有。不给参数就是看现在写着的。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要写下的立场，一句话（' + prefMaxChars + ' 字以内）' },
        id: { type: 'string', description: '要改的那条 id；不给就是新写一条' },
        withdraw: { type: 'boolean', description: 'true 就是撤回这一条（要带 id）' },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const settings = args ?? {};
      const result = memory.prefer({
        action: settings.withdraw === true ? 'withdraw' : '',
        id: settings.id,
        text: settings.text,
      });
      if (result.ok !== true) return refusal(result);
      if (result.action === 'list') {
        if (result.items.length === 0) return '你现在还没写下任何立场。';
        const lines = result.items.map((item) => '【' + item.id + '】' + item.text);
        return '你现在写下的 ' + result.items.length + ' 条（一直在你眼前）：\n' + lines.join('\n')
          + (result.stats.active >= result.stats.maxActive ? '\n（到上限了，想写新的得先撤一条）' : '');
      }
      if (result.action === 'add') {
        return '写下了 ' + result.id + '：' + result.text + '（以后想改用这个 id）';
      }
      if (result.action === 'revise') {
        return '改了 ' + result.id + '，现在是第 ' + result.version + ' 版（旧那版还留着）。';
      }
      return '撤回了 ' + result.id + '：旧那版还留着，但它不会再出现在你眼前。';
    },
  });

  const described = typeof memory.describe === 'function' ? memory.describe() : null;
  context.log('life-memory ready: ' + (described === null ? 'no counts' : described.active + ' active / ' + described.notes + ' notes / ' + described.prefs + ' prefs / encoder ' + (described.encoder ?? 'none')));
}

function excerpt(value) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= 60 ? flat : chars.slice(0, 60).join('') + '…';
}
