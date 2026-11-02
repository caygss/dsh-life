/**
 * The agent's five states.
 *
 * 自在 free - awake, nothing in hand
 * 沉浸 absorbed - working on something, current_focus is not empty
 * 倾听 listening - talking with you / listening to you
 * 睡着 asleep - asleep
 * 暂离 away - not in the room
 *
 * Three rules make this a state machine instead of a label:
 * 1. Only the transitions in TRANSITIONS are legal; everything else is refused.
 * 2. Each state has a minimum dwell time. That is anti-flapping, not a limit:
 * it constrains natural transitions only and never caps how long the agent stays.
 * 3. Every change appends one kind='state' event. The segmenter and the day roller
 * already treat that kind as a boundary (segments.mjs, roll.mjs), so a state
 * change ends a stretch of experience instead of being compressed as content.
 *
 * Why the state lives in its own table instead of a second flag on the scheduler:
 * two owners of it being asleep produce the classic split-brain bug - the machine
 * says asleep, the timer says awake, and the day boundary fires at the wrong moment.
 * state.mjs owns it; scheduler.mjs takes a stateOf getter and derives from it.
 *
 * Physiology never sets the state directly: rhythm.mjs only answers whether the agent is
 * sleepy or rested, and the caller passes that in as guards. the design (falling
 * asleep is its decision) is enforced by requiring guards.mustSleep only for
 * why='sleepy', not for why='decided_sleep'.
 */
export const STATES = Object.freeze(['free', 'absorbed', 'listening', 'asleep', 'away']);

export const STATE_LABELS = Object.freeze({
  free: '自在',
  absorbed: '沉浸',
  listening: '倾听',
  asleep: '睡着',
  away: '暂离',
});

export const TRANSITIONS = Object.freeze({
  free: Object.freeze(['absorbed', 'listening', 'asleep', 'away']),
  absorbed: Object.freeze(['free', 'listening', 'asleep', 'away']),
  listening: Object.freeze(['free', 'absorbed', 'asleep', 'away']),
 // Waking can only land in free or listening: the agent does not resume a task in the same
 // instant the agent opens its eyes, and the agent cannot leave the room while asleep.
  asleep: Object.freeze(['free', 'listening']),
 // Coming back means being in the room awake, not diving straight into a task.
  away: Object.freeze(['free']),
});

/** Anti-flapping floor. Not a limit on how long a state may last. */
export const MIN_DWELL_MS = Object.freeze({
  free: 0,
  absorbed: 60_000,
  listening: 20_000,
  asleep: 20 * 60_000,
  away: 10 * 60_000,
});

export const WHY = Object.freeze([
  'task_focus',
  'task_dropped',
  'you_spoke',
  'she_spoke',
  'sleepy',
  'decided_sleep',
  'natural_wake',
  'called_wake',
  'left_room',
  'returned',
  'conversation_ended',
]);

export const WHY_LABELS = Object.freeze({
  task_focus: '开始手头的事',
  task_dropped: '放下手头的事',
  you_spoke: '你说话',
  she_spoke: '助手开口',
  sleepy: '撑不住了',
  decided_sleep: '自己决定睡',
  natural_wake: '自然醒来',
  called_wake: '被叫醒',
  left_room: '离开房间',
  returned: '回到房间',
  conversation_ended: '话说完',
});

/** Which target state each reason is allowed to produce. */
export const WHY_TARGETS = Object.freeze({
  task_focus: Object.freeze(['absorbed']),
  task_dropped: Object.freeze(['free']),
  you_spoke: Object.freeze(['listening']),
  she_spoke: Object.freeze(['listening']),
  sleepy: Object.freeze(['asleep']),
  decided_sleep: Object.freeze(['asleep']),
  natural_wake: Object.freeze(['free', 'listening']),
  called_wake: Object.freeze(['free', 'listening']),
  left_room: Object.freeze(['away']),
  returned: Object.freeze(['free']),
 // Talking can end into either being idle or going back to what the agent was doing.
  conversation_ended: Object.freeze(['free', 'absorbed']),
});

/** What happens to something you say while the agent is in each state. */
export const INTAKE = Object.freeze({
  free: 'immediate',
  listening: 'immediate',
  absorbed: 'notify',
  asleep: 'defer',
  away: 'notify',
});

export class LifeStateError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifeStateError';
    this.code = code;
  }
}

function requireStore(store) {
  if (store === null || typeof store !== 'object' || typeof store.db !== 'object' || typeof store.atomic !== 'function') {
    throw new LifeStateError('missing_store');
  }
}

function requireState(state) {
  if (!STATES.includes(state)) throw new LifeStateError('invalid_state', String(state));
  return state;
}

function isoAt(value) {
  if (value === undefined) return new Date().toISOString();
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new LifeStateError('invalid_time', String(value));
  return new Date(ms).toISOString();
}

export function describeState(state) {
  requireState(state);
  return STATE_LABELS[state];
}

export function isAsleep(state) {
  return requireState(state) === 'asleep';
}

export function intakeDisposition(state) {
  return INTAKE[requireState(state)];
}

export function canTransition(from, to) {
  return TRANSITIONS[requireState(from)].includes(requireState(to));
}

function rowToState(row) {
  if (row === undefined || row === null) return null;
  return {
    state: row.state,
    since: row.since,
    focusItemId: row.focus_item_id ?? null,
    updatedAt: row.updated_at,
  };
}

export function readState(store) {
  requireStore(store);
  return rowToState(store.db.prepare('SELECT state, since, focus_item_id, updated_at FROM life_state WHERE singleton=1').get());
}

/**
 * Reads the state, creating the initial free row if the database has never had one.
 * The creation writes no event: a default is not something that happened in its day.
 */
function ensureInTransaction(db, at) {
  const row = db.prepare('SELECT state, since, focus_item_id, updated_at FROM life_state WHERE singleton=1').get();
  if (row !== undefined) return rowToState(row);
  db.prepare('INSERT INTO life_state(singleton, state, since, focus_item_id, updated_at) VALUES(1,?,?,?,?)')
    .run('free', at, null, at);
  return { state: 'free', since: at, focusItemId: null, updatedAt: at };
}

export function ensureState(store, options) {
  requireStore(store);
  const at = isoAt(options === null || typeof options !== 'object' ? undefined : options.at);
  return store.atomic((db) => ensureInTransaction(db, at));
}

/**
 * One state change.
 *
 * @param {object} store
 * @param {object} input to, why, at, itemId, guards{mustSleep,canWake}, force
 * @returns {{changed:boolean, state:string, since:string, focusItemId:string|null, eventSeq:number|null}}
 */
export function transition(store, input) {
  requireStore(store);
  const options = input === null || typeof input !== 'object' ? {} : input;
  const to = requireState(options.to);
  const why = options.why;
  if (!WHY.includes(why)) throw new LifeStateError('invalid_why', String(why));
  if (!WHY_TARGETS[why].includes(to)) throw new LifeStateError('why_mismatch', why + ' -> ' + to);
  const at = isoAt(options.at);
  const force = options.force === true;
  const guards = options.guards === null || typeof options.guards !== 'object' ? {} : (options.guards ?? {});
  const requestedItem = typeof options.itemId === 'string' && options.itemId !== '' ? options.itemId : null;
  if (to === 'absorbed' && requestedItem === null) throw new LifeStateError('focus_required');
  const itemId = to === 'absorbed' ? requestedItem : null;

  return store.atomic((db) => {
    const current = ensureInTransaction(db, at);
    const from = current.state;

    if (from === to) {
 // Same state: not an event. Switching focus while absorbed updates the focus only.
      let focusItemId = current.focusItemId;
      if (to === 'absorbed' && itemId !== current.focusItemId) {
        db.prepare('UPDATE life_state SET focus_item_id=?, updated_at=? WHERE singleton=1').run(itemId, at);
        focusItemId = itemId;
      }
      return { changed: false, state: to, since: current.since, focusItemId, eventSeq: null };
    }

    if (!TRANSITIONS[from].includes(to)) throw new LifeStateError('invalid_transition', from + ' -> ' + to);
    if (to === 'asleep' && why === 'sleepy' && guards.mustSleep !== true) {
      throw new LifeStateError('not_sleepy_enough', 'why=sleepy requires guards.mustSleep');
    }
    if (why === 'natural_wake' && guards.canWake !== true) {
      throw new LifeStateError('not_rested_enough', 'natural_wake requires guards.canWake');
    }

    const elapsed = Date.parse(at) - Date.parse(current.since);
    if (!force && elapsed < MIN_DWELL_MS[from]) {
      throw new LifeStateError('dwell_not_elapsed', from + ': ' + elapsed + 'ms < ' + MIN_DWELL_MS[from] + 'ms');
    }

    db.prepare('UPDATE life_state SET state=?, since=?, focus_item_id=?, updated_at=? WHERE singleton=1')
      .run(to, at, itemId, at);
    const text = '状态：' + STATE_LABELS[from] + ' → ' + STATE_LABELS[to] + '（' + WHY_LABELS[why] + '）';
    const info = db.prepare('INSERT INTO life_events(at, kind, role, text, meta_json) VALUES(?,?,?,?,?)')
      .run(at, 'state', 'system', text, JSON.stringify({ state: { from, to, why, itemId } }));
    return {
      changed: true,
      from,
      state: to,
      since: at,
      focusItemId: itemId,
      eventSeq: Number(info.lastInsertRowid),
      text,
    };
  });
}

/** Newest first. Rows without a state payload are skipped rather than guessed at. */
export function listStateEvents(store, limit = 100) {
  requireStore(store);
  const cap = Number(limit);
  if (!Number.isInteger(cap) || cap <= 0) throw new LifeStateError('invalid_limit', String(limit));
  const rows = store.db.prepare("SELECT seq, at, text, meta_json FROM life_events WHERE kind='state' ORDER BY seq DESC LIMIT ?").all(cap);
  const out = [];
  for (const row of rows) {
    let meta;
    try { meta = JSON.parse(row.meta_json); } catch { continue; }
    const payload = meta === null || typeof meta !== 'object' ? undefined : meta.state;
    if (payload === null || typeof payload !== 'object') continue;
    out.push({
      seq: Number(row.seq),
      at: row.at,
      from: payload.from,
      to: payload.to,
      why: payload.why,
      itemId: payload.itemId ?? null,
      text: row.text,
    });
  }
  return out;
}