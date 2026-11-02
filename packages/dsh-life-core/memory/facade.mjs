/**
 * 助手自己的记忆，做成助手手上的动作（D1/D2，）。
 *
 * 在这之前：记忆是**每轮宿主替助手塞进去的**——一次召回最多六段，助手不能自己翻旧账，
 * 也不能决定"这句我要原样记住"。修订和撤回在宿主侧早就有（corrected.mjs / withdraw.mjs），
 * 但从来没接到助手手上。这个模块就是那一层：五个动作，全部落在同一份追加日志和同一张
 * package 表上，不新建任何库。
 *
 * 五条纪律（不是为了好看，是因为每条都对应一个会坏的地方）：
 * 1) 「记住原文」= 一条 note 事件 + 一个同区间的 package。日志是唯一法源，package 只是索引，
 * 所以 unpack 回去读到的永远是助手当时写下的字，不是模型又转述一遍。
 * 2) package 的两种索引（词表 + 向量）和 package 本身在**同一个事务**里写完。分开写会出现
 * 「记住了一半」：不可见的记忆，比没记住更坏。
 * 3) note 事件的 role 是 system、kind 是 note。role 用 its 会让助手下一轮在对话历史里看见
 * 自己"说过"一段助手没说过的话（loop.mjs 对 system/tool 有明确过滤）。
 * 4) 修订 = 旧标 withdrawn + 同区间新版本 + 指针；撤回 = 标 withdrawn + 理由。两样都不删除。
 * 5) 想不起来时**如实说没有**，不退化成"我记得你说过"这种编造。找不到就是找不到。
 *
 * 编码器是可选的：远程 8B 时 note 要一次 embedding 请求、recall 也要一次；拿不到向量时
 * 就走词表那条路（关键词 / 原话 LIKE），并在结果里说明是哪种，不假装有语义。
 */
import { randomUUID } from 'node:crypto';

import { LifeStoreError } from '../store/db.mjs';
import { estimateTokens } from '../tokens.mjs';
import { insertPackage, getPackage } from './packages.mjs';
import { extractTerms, vectorToBlob } from './encoder.mjs';
import { recallPackages } from './recall.mjs';
import { unpackPackage } from './unpack.mjs';
import { shortClock } from '../tail.mjs';
import { correctPackage, latestCorrection } from './corrected.mjs';
import { withdrawPackage } from './withdraw.mjs';
import { recordActivation } from './activation.mjs';
import { lastSeq } from '../store/events.mjs';
import { applyPreference, listPreferences, preferenceStats } from '../preferences.mjs';

/** 上限集中在这里，收据和报告都用同一份数字。 */
export const MEMORY_TOOL_LIMITS = Object.freeze({
  noteMaxChars: 1000,
  reasonMaxChars: 200,
  reviseMaxChars: 500, // corrected.mjs 的硬限，这里只是提前说清楚
  recallDefaultLimit: 8,
  recallMaxLimit: 20,
  recallDaysMax: 3650,
  recallTermsMax: 24,
  unpackDefaultChars: 1500,
  unpackMaxChars: 6000,
  unpackSeqRadius: 5,
  excerptChars: 60,
  noteImportance: 3,
});

const DAY_MS = 86_400_000;

export class LifeMemoryToolError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifeMemoryToolError';
    this.code = code;
  }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 按码点算字数：一个汉字 = 1，不按字节。 */
function charCount(value) {
  return Array.from(value).length;
}

function cut(value, max) {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('') + '…';
}

export function excerpt(value, max = MEMORY_TOOL_LIMITS.excerptChars) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return cut(flat, max);
}

/**
 * 展开时的口径：只回**说过的话**和助手自己写下的旁注。
 * 日志里还有一类 role=system / kind=state 的机器流水（"醒来（timer）…""发出去了…""入口放行…"），
 * 那不是谁说的话，混进「原文」里只会把当时那段对话淹掉，所以展开时略过。
 */
function isBookkeeping(event) {
  return event.role === 'system' && event.kind === 'state';
}

/**
 * 给助手看的时间一律是本地钟点：以前这里直接贴库里存的 ISO（UTC）串，
 * 助手展开一条记忆读到 `[]`，就把晚上的话当成上午说的。
 * 库里的存储仍然保持 UTC，只有"给助手看"这一层换成本地。
 */
const DISPLAY_TIME_ZONE = 'UTC';

function stampAt(at) {
  const text = String(at ?? '');
  if (!Number.isFinite(Date.parse(text))) return text;
  try {
    return shortClock(text, DISPLAY_TIME_ZONE, Date.now());
  } catch {
    return text;
  }
}

function renderLine(event) {
  const who = event.role === 'user' ? '对方'
    : event.role === 'assistant' ? '助手'
      : event.role === 'tool' ? '回执' : '旁注';
  return '[' + stampAt(event.at) + '] ' + who + '：' + event.text;
}

function clampLimit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/** 查询词：先按空白/标点切，整句太长时退化成整句本身。 */
function queryWords(query) {
  const parts = String(query).split(/[\s,，。、；;:：!！?？"'“”‘’()（）\[\]【】]+/).filter(Boolean);
  return parts.length > 0 ? parts.slice(0, 8) : [String(query).trim()].filter(Boolean);
}

/**
 * 建一个记忆服务。宿主把它交给声明了 surface:'memory' 的插件（见 plugins/loader.mjs）。
 *
 * @param {object} input {store, now?: => number, embed?: (text) => Promise<Float32Array|null>, encoderName?: string}
 */
export function createMemoryFacade(input) {
  const store = input === null || typeof input !== 'object' ? null : input.store;
  if (store === null || typeof store !== 'object' || typeof store.db !== 'object' || typeof store.atomic !== 'function') {
    throw new LifeMemoryToolError('missing_store');
  }
  const now = typeof input.now === 'function' ? input.now : () => Date.now();
  const embed = typeof input.embed === 'function' ? input.embed : null;
  const encoderName = typeof input.encoderName === 'string' && input.encoderName !== '' ? input.encoderName : null;

  function nowIso() {
    const value = Number(now());
    return new Date(Number.isFinite(value) ? value : Date.now()).toISOString();
  }

 /** 一次编码，失败就是 null：不重试、不换模型（跟宿主一个口径）。 */
  async function embedOrNull(value) {
    if (embed === null || encoderName === null) return null;
    try {
      const vector = await embed(value);
      return vector instanceof Float32Array && vector.length > 0 ? vector : null;
    } catch {
      return null;
    }
  }

 // ---- 词表兜底：没有向量时按字面重合找，明说这是字面不是意思 ----
  function keywordPackages(terms, limit) {
    const wanted = terms.slice(0, MEMORY_TOOL_LIMITS.recallTermsMax);
    if (wanted.length === 0) return [];
    const marks = wanted.map(() => '?').join(',');
    const rows = store.db.prepare(
      'SELECT p.id, p.text, p.start_seq, p.end_seq, p.created_at, COUNT(*) AS hits ' +
      'FROM life_package_terms t JOIN life_packages p ON p.id = t.package_id ' +
      "WHERE p.status = 'active' AND t.term IN (" + marks + ') ' +
      'GROUP BY p.id ORDER BY hits DESC, p.start_seq DESC LIMIT ?',
    ).all(...wanted, limit);
    return rows.map((row) => ({
      packageId: row.id,
      text: row.text,
      startSeq: Number(row.start_seq),
      endSeq: Number(row.end_seq),
      createdAt: row.created_at,
      hits: Number(row.hits),
    }));
  }

 /** 原话那条路：助手说过的话和对方说的原话都在追加日志里，直接按字找。 */
  function logSearch(words, days, limit) {
    const clean = words.filter((word) => word !== '');
    if (clean.length === 0) return [];
    const clauses = clean.map(() => 'text LIKE ?').join(' OR ');
    const params = clean.map((word) => '%' + word + '%');
    let sql = "SELECT seq, at, role, kind, text FROM life_events WHERE role IN ('user','assistant') AND (" + clauses + ')';
    if (days > 0) {
      sql += ' AND at >= ?';
      params.push(new Date(Date.parse(nowIso()) - days * DAY_MS).toISOString());
    }
    sql += ' ORDER BY seq DESC LIMIT ?';
    params.push(limit);
    return store.db.prepare(sql).all(...params).map((row) => ({
      seq: Number(row.seq),
      at: row.at,
      who: row.role === 'user' ? '对方' : '助手',
      kind: row.kind,
      text: row.text,
    }));
  }

  function withinDays(at, days) {
    if (days <= 0) return true;
    const stamp = Date.parse(at);
    if (!Number.isFinite(stamp)) return true;
    return Date.parse(nowIso()) - stamp <= days * DAY_MS;
  }

 // ---- 1. 记住原文 --------------------------------------------------------
  async function note(args) {
    const body = text(args?.text);
    if (body === '') return { ok: false, code: 'text_required' };
    const chars = charCount(body);
    if (chars > MEMORY_TOOL_LIMITS.noteMaxChars) {
      return { ok: false, code: 'text_too_long', chars, max: MEMORY_TOOL_LIMITS.noteMaxChars };
    }
    const at = nowIso();
    const id = 'note-' + randomUUID().slice(0, 8);
 // 向量先算好：事务里只能同步。
    const vector = await embedOrNull(body);
    const terms = extractTerms(body);

    const written = store.atomic((db) => {
 // 事件正文就是原话本身（不加"记住："这类前缀）：日志是法源，改一个字都不是原文。
 // role 用 system、kind 用 note，所以它进不了助手的对话历史（loop.mjs 明确过滤）。
      const info = db.prepare('INSERT INTO life_events(at, kind, role, text, meta_json) VALUES(?,?,?,?,?)')
        .run(at, 'note', 'system', body, JSON.stringify({ memory: { id } }));
      const seq = Number(info.lastInsertRowid);
 // 一条 note 事件 = 一个同区间的 package：原话和索引指的是同一行日志，不会各说各的。
      insertPackage(db, {
        id,
        kind: 'note',
        text: body,
        tokens: estimateTokens(body),
        startSeq: seq,
        endSeq: seq,
        createdAt: at,
        importance: MEMORY_TOOL_LIMITS.noteImportance,
      });
      const insertTerm = db.prepare('INSERT OR IGNORE INTO life_package_terms(package_id, term) VALUES(?,?)');
      for (const term of terms) insertTerm.run(id, term);
      if (vector !== null) {
        db.prepare('INSERT INTO life_package_vectors(package_id, encoder, dim, vector) VALUES(?,?,?,?) ' +
          'ON CONFLICT(package_id, encoder) DO UPDATE SET dim=excluded.dim, vector=excluded.vector')
          .run(id, encoderName, vector.length, vectorToBlob(vector));
      }
      return { id, seq, terms: terms.length, indexed: vector !== null ? 'terms+vector' : 'terms' };
    });

    return {
      ok: true,
      id: written.id,
      seq: written.seq,
      at,
      chars,
      terms: written.terms,
      indexed: written.indexed,
    };
  }

 // ---- 2. 想起 ------------------------------------------------------------
  async function recall(args) {
    const limit = clampLimit(args?.limit, MEMORY_TOOL_LIMITS.recallDefaultLimit, MEMORY_TOOL_LIMITS.recallMaxLimit);
    const days = clampLimit(args?.days, 0, MEMORY_TOOL_LIMITS.recallDaysMax);
    const query = text(args?.query);
    const terms = query === '' ? [] : extractTerms(query).slice(0, MEMORY_TOOL_LIMITS.recallTermsMax);

    let remembered = [];
    let route = 'none';
    if (query !== '') {
      const cueVector = await embedOrNull(query);
      const packages = Number(store.db.prepare("SELECT COUNT(*) AS n FROM life_packages WHERE status='active'").get().n);
      if (packages > 0) {
        if (cueVector !== null && encoderName !== null) {
          try {
            const result = recallPackages({
              store,
              cue: { text: query },
              cueVector,
              encoderName,
              options: { mode: 'fused', perRoute: 20, limit },
            });
            route = 'fused';
            remembered = result.candidates.map((candidate) => ({
              id: candidate.packageId,
              at: candidate.createdAt,
              text: candidate.text,
              score: candidate.total,
            }));
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            route = 'keyword_only';
          }
        } else {
          route = 'keyword_only';
        }
        if (route === 'keyword_only') {
          remembered = keywordPackages(terms, limit).map((row) => ({
            id: row.packageId,
            at: row.createdAt,
            text: row.text,
            hits: row.hits,
          }));
        }
      }
    } else {
 // 不给词 = "最近记着的"，按写下来的时间倒序。
      remembered = store.db.prepare("SELECT id, created_at, text FROM life_packages WHERE status='active' ORDER BY created_at DESC LIMIT ?")
        .all(limit).map((row) => ({ id: row.id, at: row.created_at, text: row.text }));
      route = 'recent';
    }

    if (days > 0) remembered = remembered.filter((entry) => withinDays(entry.at, days));
    remembered = remembered.slice(0, limit);

 // 「关于谁」：subjects 以前只写不读——压缩时让助手标了，召回的
 // 时候却没人拿它出来，等于白写。这里一次查回来挂到每条上；查不到就是空，不影响召回。
    if (remembered.length > 0) {
      try {
        const marks = remembered.map(() => '?').join(',');
        const rows = store.db.prepare('SELECT id, subjects_json FROM life_packages WHERE id IN (' + marks + ')')
          .all(...remembered.map((entry) => entry.id));
        const byId = new Map(rows.map((row) => {
          let list = [];
          try { const parsed = JSON.parse(row.subjects_json ?? '[]'); if (Array.isArray(parsed)) list = parsed.filter((s) => typeof s === 'string' && s !== ''); } catch { /* 坏了就当没有 */ }
          return [row.id, list];
        }));
        remembered = remembered.map((entry) => ({ ...entry, subjects: byId.get(entry.id) ?? [] }));
      } catch { /* 查不到「关于谁」不该让想起失败 */ }
    }

 // 助手真的把这些想起来了：记一次激活，A 因子从此不是常数。
    for (const entry of remembered) {
      try { recordActivation(store, entry.id, nowIso()); } catch { /* 激活记不上不该让想起失败 */ }
    }

 // 原话那条路：还没压成记忆的旧事只能按字找，所以“记着的”不够时补一段原话。
    let said = [];
    if (query !== '' && remembered.length < limit) {
      said = logSearch(queryWords(query), days, limit - remembered.length).map((row) => ({
        seq: row.seq,
        at: row.at,
        who: row.who,
        kind: row.kind,
        text: row.text,
      }));
    }

    return {
      ok: true,
      query,
      route,
      remembered,
      said,
      counts: { remembered: remembered.length, said: said.length },
    };
  }

 // ---- 3. 展开 -----------------------------------------------------------
  function unpack(args) {
    const chars = clampLimit(args?.chars, MEMORY_TOOL_LIMITS.unpackDefaultChars, MEMORY_TOOL_LIMITS.unpackMaxChars);
    const id = text(args?.id);
    const seqRaw = args?.seq;
    const at = nowIso();

    if (id !== '') {
      let target = id;
      let correctedFrom = null;
      const record = getPackage(store, target);
      if (record === null) return { ok: false, code: 'not_found', id };
      if (record.status === 'withdrawn') {
 // 改过的：顺着指针读改后的那一版，并告诉助手这是改过的。
        let next = null;
        try { next = latestCorrection(store, target); } catch { next = null; }
        if (next === null || next.corrected !== true) return { ok: false, code: 'withdrawn', id };
        correctedFrom = target;
        target = next.packageId;
      }
      let unpacked;
      try {
        unpacked = unpackPackage(store, target, { maxTokens: 1_000_000 });
      } catch (error) {
        const code = error && error.code ? String(error.code) : 'unpack_failed';
        return { ok: false, code, id: target };
      }
 // 助手自己写下的那一条（note / 改过的 note）：区间里那一行就是这段话本身，
 // 直接回 package 的文字，别把它渲染成「system：…」这种旁注口吻。
      const sourceRow = store.db.prepare('SELECT kind FROM life_events WHERE seq=?').get(unpacked.package.startSeq);
      const ownWords = unpacked.package.startSeq === unpacked.package.endSeq
        && sourceRow !== undefined && sourceRow.kind === 'note';
      if (ownWords) {
        const body = cut(unpacked.package.text, chars);
        return {
          ok: true,
          kind: 'package',
          source: 'note',
          id: target,
          correctedFrom,
          at,
          from: unpacked.package.createdAt,
          range: { startSeq: unpacked.package.startSeq, endSeq: unpacked.package.endSeq },
          text: body,
          truncated: body.length !== unpacked.package.text.length,
          droppedEvents: 0,
        };
      }
      const speakable = unpacked.events.filter((event) => !isBookkeeping(event));
      const kept = [];
      let used = 0;
      let dropped = 0;
      for (const event of (speakable.length > 0 ? speakable : unpacked.events)) {
        const line = renderLine(event);
        const cost = charCount(line) + 1;
        if (used + cost > chars) { dropped += 1; continue; }
        kept.push(line);
        used += cost;
      }
      return {
        ok: true,
        kind: 'package',
        source: 'log',
        id: target,
        correctedFrom,
        at,
        from: unpacked.package.createdAt,
        range: { startSeq: unpacked.package.startSeq, endSeq: unpacked.package.endSeq },
        text: kept.join('\n'),
        truncated: dropped > 0,
        droppedEvents: dropped,
      };
    }

    const seq = Number(seqRaw);
    if (!Number.isInteger(seq) || seq <= 0) return { ok: false, code: 'id_or_seq_required' };
    const radius = MEMORY_TOOL_LIMITS.unpackSeqRadius;
    const rows = store.db.prepare('SELECT seq, at, kind, role, text FROM life_events WHERE seq BETWEEN ? AND ? ORDER BY seq')
      .all(seq - radius, seq + radius);
    if (rows.length === 0) return { ok: false, code: 'not_found', seq };
    const speakable = rows.filter((row) => !isBookkeeping(row));
    const lines = (speakable.length > 0 ? speakable : rows)
      .map((row) => ({ seq: Number(row.seq), line: renderLine({ at: row.at, role: row.role, text: row.text }) }));
    const kept = [];
    let used = 0;
    let dropped = 0;
    for (const entry of lines) {
      const cost = charCount(entry.line) + 1;
      if (used + cost > chars) { dropped += 1; continue; }
      kept.push(entry.line);
      used += cost;
    }
    return {
      ok: true,
      kind: 'log',
      seq,
      at,
      text: kept.join('\n'),
      truncated: dropped > 0,
      droppedEvents: dropped,
    };
  }

 // ---- 4. 修订 -----------------------------------------------------------
  function revise(args) {
    const id = text(args?.id);
    if (id === '') return { ok: false, code: 'id_required' };
    const reason = text(args?.reason);
    if (reason === '') return { ok: false, code: 'reason_required' };
    if (charCount(reason) > MEMORY_TOOL_LIMITS.reasonMaxChars) {
      return { ok: false, code: 'reason_too_long', max: MEMORY_TOOL_LIMITS.reasonMaxChars };
    }
    const body = text(args?.text);
    if (body === '') return { ok: false, code: 'text_required' };
    if (charCount(body) > MEMORY_TOOL_LIMITS.reviseMaxChars) {
      return { ok: false, code: 'text_too_long', chars: charCount(body), max: MEMORY_TOOL_LIMITS.reviseMaxChars };
    }
    try {
      const result = correctPackage(store, id, { reason, text: body, at: nowIso() });
      return { ok: true, from: result.from.id, to: result.to.id, at: nowIso() };
    } catch (error) {
      const code = error && error.code ? String(error.code) : 'revise_failed';
      return { ok: false, code, id };
    }
  }

 // ---- 5. 撤回 -----------------------------------------------------------
  function withdraw(args) {
    const id = text(args?.id);
    if (id === '') return { ok: false, code: 'id_required' };
    const reason = text(args?.reason);
    if (reason === '') return { ok: false, code: 'reason_required' };
    if (charCount(reason) > MEMORY_TOOL_LIMITS.reasonMaxChars) {
      return { ok: false, code: 'reason_too_long', max: MEMORY_TOOL_LIMITS.reasonMaxChars };
    }
    try {
      const result = withdrawPackage(store, id, { reason, at: nowIso() });
      return { ok: true, id, at: nowIso(), eventSeq: result.eventSeq };
    } catch (error) {
      const code = error && error.code ? String(error.code) : 'withdraw_failed';
      return { ok: false, code, id };
    }
  }

 // ---- 6. 立场------------------------------------------------
 // 偏好不是记忆：记忆按相关度想起，偏好一直在场（进 system 的稳定中段）。
 // 这里只转发，判断全在./preferences.mjs；写的时候顺手记下助手当时读到第几条事件。
  function prefer(args) {
    const input = args ?? {};
    try {
      const result = applyPreference(store, { ...input, at: nowIso(), sourceSeq: Number(lastSeq(store)) });
      if (result.ok !== true) return result;
      if (result.action === 'list') {
        return { ok: true, action: 'list', items: result.items, stats: preferenceStats(store) };
      }
      return { ...result, stats: preferenceStats(store) };
    } catch (error) {
      const code = error && error.code ? String(error.code) : 'prefer_failed';
      return { ok: false, code };
    }
  }

  function preferences() {
    return { ok: true, items: listPreferences(store), stats: preferenceStats(store) };
  }

 // ---- 只读复核：助手/宿主都能问“现在记着几条” ------------------------------
  function describe() {
    const active = Number(store.db.prepare("SELECT COUNT(*) AS n FROM life_packages WHERE status='active'").get().n);
    const withdrawn = Number(store.db.prepare("SELECT COUNT(*) AS n FROM life_packages WHERE status='withdrawn'").get().n);
    const notes = Number(store.db.prepare("SELECT COUNT(*) AS n FROM life_packages WHERE status='active' AND kind='note'").get().n);
    return { active, withdrawn, notes, encoder: encoderName, prefs: preferenceStats(store).active };
  }

  return Object.freeze({ note, recall, unpack, revise, withdraw, prefer, preferences, describe });
}