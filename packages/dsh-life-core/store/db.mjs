/**
 * Store skeleton for the life core.
 *
 * Uses the runtime's built-in node:sqlite (DatabaseSync), the same driver the
 * rest of this repository already uses, so there is no new dependency.
 *
 * Durability choices:
 * journal_mode=WAL, synchronous=FULL -> a committed transaction survives a crash
 * foreign_keys=ON -> orphan vectors/terms are refused, not tolerated
 * trusted_schema=OFF -> a tampered schema cannot run functions
 *
 * Atomicity note for later tasks: atomic runs a *synchronous* callback inside
 * BEGIN IMMEDIATE.. COMMIT. Do not await inside it. Work that needs a model
 * call must finish first and then commit a prepared batch, so
 * no SQLite write transaction is ever held across a network wait.
 */
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 17;

export class LifeStoreError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifeStoreError';
    this.code = code;
  }
}

/**
 * The plugin receipt log. Kept in one place because schema v10 had to rebuild it: SQLite
 * cannot widen a CHECK constraint in place, and 'uninstall' had to be added to the
 * allowed actions. The rebuild copies every row, so the same list has to be usable twice.
 */
const RECEIPT_TABLE = [
  'CREATE TABLE IF NOT EXISTS life_plugin_receipts(' +
    'seq INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'at TEXT NOT NULL,' +
    'plugin_id TEXT,' +
    "action TEXT NOT NULL CHECK(action IN ('install','enable','disable','uninstall'))," +
    "outcome TEXT NOT NULL CHECK(outcome IN ('ok','refused'))," +
    'code TEXT,' +
    "detail_json TEXT NOT NULL DEFAULT '{}')",
  'CREATE INDEX IF NOT EXISTS life_plugin_receipts_plugin ON life_plugin_receipts(plugin_id, seq)',
  'CREATE TRIGGER IF NOT EXISTS life_plugin_receipts_no_update BEFORE UPDATE ON life_plugin_receipts ' +
    "BEGIN SELECT RAISE(ABORT, 'life_plugin_receipts_is_append_only'); END",
  'CREATE TRIGGER IF NOT EXISTS life_plugin_receipts_no_delete BEFORE DELETE ON life_plugin_receipts ' +
    "BEGIN SELECT RAISE(ABORT, 'life_plugin_receipts_is_append_only'); END",
];

/**
 * The agent's reminders / alarms (schema v15, widened in v16). Kept in one place for the same
 * reason as RECEIPT_TABLE: v16 adds 'alarm' to the allowed kinds, and SQLite cannot
 * widen a CHECK constraint in place, so the table has to be rebuilt from this same list.
 *
 * kind 'remind' - a moment the agent picked to come back to something; if it comes due while
 * the agent sleeps it waits for it, like a message.
 * kind 'alarm' - a moment the agent picked that is allowed to wake the agent:
 * "如果闹钟的时间在助手睡觉的时候，那么就能将助手唤醒".
 */
const REMINDER_TABLE = [
  'CREATE TABLE IF NOT EXISTS life_reminders(' +
    'id TEXT PRIMARY KEY,' +
    'due_at TEXT NOT NULL,' +
    'note TEXT NOT NULL,' +
    "kind TEXT NOT NULL DEFAULT 'remind' CHECK(kind IN ('remind','alarm'))," +
    "status TEXT NOT NULL CHECK(status IN ('pending','fired','cancelled'))," +
    'created_at TEXT NOT NULL,' +
    'fired_at TEXT,' +
    'cancelled_at TEXT,' +
    'cancel_reason TEXT,' +
    'late_notice_at TEXT,' +
    "source TEXT NOT NULL DEFAULT 'agent' CHECK(source IN ('agent','host'))," +
    "meta_json TEXT NOT NULL DEFAULT '{}')",
  'CREATE INDEX IF NOT EXISTS life_reminders_due ON life_reminders(status, due_at)',
];

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS life_meta(' +
    'singleton INTEGER PRIMARY KEY CHECK(singleton=1),' +
    'identity_id TEXT NOT NULL,' +
    'schema_version INTEGER NOT NULL,' +
    'created_at TEXT NOT NULL,' +
 // 助手自己的节奏状态：随机数状态 + 下一次该醒的时刻。
 // 要避免的毛病：rng 用固定种子、每个进程重新播种、状态从不落盘，
 // 于是重启之后助手的"随机间隔"从头重复（同一对间隔反复出现）。
    "scheduler_json TEXT NOT NULL DEFAULT '{}')",
  'CREATE TABLE IF NOT EXISTS life_events(' +
    'seq INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'at TEXT NOT NULL,' +
    'kind TEXT NOT NULL,' +
    'role TEXT NOT NULL,' +
    'text TEXT NOT NULL,' +
    "meta_json TEXT NOT NULL DEFAULT '{}')",
  'CREATE TABLE IF NOT EXISTS life_packages(' +
    'id TEXT PRIMARY KEY,' +
    'created_at TEXT NOT NULL,' +
    'kind TEXT NOT NULL,' +
    "status TEXT NOT NULL CHECK(status IN ('active','withdrawn'))," +
    'text TEXT NOT NULL,' +
    'tokens INTEGER NOT NULL,' +
    'start_seq INTEGER NOT NULL,' +
    'end_seq INTEGER NOT NULL,' +
    'importance INTEGER NOT NULL DEFAULT 3 CHECK(importance BETWEEN 1 AND 5),' +
    "links_json TEXT NOT NULL DEFAULT '[]'," +
 // Addressable fields (schema v3). The need: a package used to carry only its
 // text and when it was written, so "which one" could not be answered - two lines
 // about the same subject looked equally close. These three columns are
 // what a query can actually point at: when it happened, what it was about, and
 // which occurrence of that subject it was.
    'occurred_at TEXT,' +
    "subjects_json TEXT NOT NULL DEFAULT '[]'," +
    'ordinal INTEGER)',
  'CREATE TABLE IF NOT EXISTS life_package_vectors(' +
    'package_id TEXT NOT NULL REFERENCES life_packages(id) ON DELETE CASCADE,' +
    'encoder TEXT NOT NULL,' +
    'dim INTEGER NOT NULL,' +
    'vector BLOB NOT NULL,' +
    'PRIMARY KEY(package_id, encoder))',
  'CREATE TABLE IF NOT EXISTS life_package_terms(' +
    'package_id TEXT NOT NULL REFERENCES life_packages(id) ON DELETE CASCADE,' +
    'term TEXT NOT NULL,' +
    'PRIMARY KEY(package_id, term))',
  'CREATE TABLE IF NOT EXISTS life_activation(' +
    'package_id TEXT NOT NULL REFERENCES life_packages(id) ON DELETE CASCADE,' +
    'recalled_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS life_rolls(' +
    'id TEXT PRIMARY KEY,' +
    'from_seq INTEGER NOT NULL,' +
    'to_seq INTEGER NOT NULL,' +
    'package_ids_json TEXT NOT NULL,' +
    'committed_at TEXT NOT NULL)',
 // Every compression attempt is recorded, failed ones included. A truncated answer
 // therefore leaves a pending stretch, not a silently lost piece of it life: the
 // events are still in the append-only log and the compression can be redone.
  'CREATE TABLE IF NOT EXISTS life_compression_attempts(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'start_seq INTEGER NOT NULL,' +
    'end_seq INTEGER NOT NULL,' +
    'attempted_at TEXT NOT NULL,' +
    "status TEXT NOT NULL CHECK(status IN ('completed','truncated','empty','too_short','too_long','failed'))," +
    'error_code TEXT,' +
    'output_chars INTEGER,' +
    'prompt_version TEXT,' +
    'model TEXT)',
  'CREATE INDEX IF NOT EXISTS life_compression_pending ON life_compression_attempts(start_seq, end_seq, status)',
 // Compression lock: an open row means a compression of that range is in flight. A
 // process that dies mid-compression leaves the row behind, which is exactly the
 // signal a later pass needs to avoid compressing the same stretch twice. Stale rows
 // are taken over by age, not deleted by a timer.
  'CREATE TABLE IF NOT EXISTS life_compression_locks(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'start_seq INTEGER NOT NULL,' +
    'end_seq INTEGER NOT NULL,' +
    'started_at TEXT NOT NULL,' +
    'prompt_version TEXT,' +
    'model TEXT,' +
    'UNIQUE(start_seq, end_seq))',
 // Correction closure. A wrong memory is never deleted and
 // never silently overwritten: the old package is withdrawn, a new one carrying the
 // corrected text re-covers the same log range, and this row is the pointer between
 // them. Without it the wrong and the right version would both sit in memory with
 // nothing tying them together, and the agent could mix them or repeat the wrong one.
  'CREATE TABLE IF NOT EXISTS life_corrections(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'from_package_id TEXT NOT NULL REFERENCES life_packages(id),' +
    'to_package_id TEXT NOT NULL REFERENCES life_packages(id),' +
    'reason TEXT NOT NULL,' +
    'at TEXT NOT NULL,' +
    'UNIQUE(from_package_id))',
  'CREATE INDEX IF NOT EXISTS life_corrections_to ON life_corrections(to_package_id)',
 // The agent's current state. One row, written only by state.mjs so the
 // five states have exactly one owner; scheduler.mjs derives "asleep" from here.
 // The row is created lazily on first use and is not seeded at database creation:
 // a default of "free" is not an event in its day, so no state event is written for it.
  'CREATE TABLE IF NOT EXISTS life_state(' +
    'singleton INTEGER PRIMARY KEY CHECK(singleton=1),' +
    "state TEXT NOT NULL CHECK(state IN ('free','absorbed','listening','asleep','away'))," +
    'since TEXT NOT NULL,' +
    'focus_item_id TEXT,' +
    'updated_at TEXT NOT NULL)',
 // Things the agent has in hand. One row per item, so
 // several unfinished things stay independent and switching focus does not overwrite
 // another record. `materials_json` holds POINTERS only (package id / event range /
 // pref id / book page): the original text stays in the log or in a package, never a
 // copy here. At most one row is `active` - the thing the agent is doing right now.
  'CREATE TABLE IF NOT EXISTS life_tasks(' +
    'item_id TEXT PRIMARY KEY,' +
    'version INTEGER NOT NULL,' +
    'kind TEXT NOT NULL,' +
    'title TEXT NOT NULL,' +
    "state TEXT NOT NULL CHECK(state IN ('active','waiting','paused','completed','unknown'))," +
    'current_focus TEXT,' +
    "materials_json TEXT NOT NULL DEFAULT '[]'," +
    "pending_json TEXT NOT NULL DEFAULT '[]'," +
    "deferred_json TEXT NOT NULL DEFAULT '[]'," +
    'created_at TEXT NOT NULL,' +
    'updated_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS life_tasks_state ON life_tasks(state, updated_at)',
 // Things that arrived for it to notice. One
 // row per arrival, never coalesced: the system guarantees only that the agent can see it,
 // not that the agent answers. `disposition` records the state the agent was in when it arrived
 // (immediate / notify / defer), so a message that came while the agent slept stays marked
 // as such even after the agent wakes. This queue is not the log - the message itself is
 // already an event, and duplicating it here would double-count its day.
  'CREATE TABLE IF NOT EXISTS life_attention(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'at TEXT NOT NULL,' +
    'source TEXT NOT NULL,' +
    'channel TEXT,' +
    'text TEXT NOT NULL,' +
    "meta_json TEXT NOT NULL DEFAULT '{}'," +
    "disposition TEXT NOT NULL CHECK(disposition IN ('immediate','notify','defer'))," +
    "status TEXT NOT NULL CHECK(status IN ('pending','seen'))," +
    'seen_at TEXT)',
  'CREATE INDEX IF NOT EXISTS life_attention_pending ON life_attention(status, at)',
  'CREATE INDEX IF NOT EXISTS life_attention_disposition ON life_attention(disposition, status)',
 // The agent's plugin table. Capabilities belong to the
 // agent, not to the runtime it happens to live in, so the table sits in the agent's store.
 // Three facts stay apart: declared (the manifest), granted (the owner's allowlist at
 // enable time), active (derived: enabled AND granted). Install never grants anything.
  'CREATE TABLE IF NOT EXISTS life_plugins(' +
    'id TEXT PRIMARY KEY,' +
    'version TEXT NOT NULL,' +
    'api_version INTEGER NOT NULL,' +
    "status TEXT NOT NULL CHECK(status IN ('disabled','enabled'))," +
    'manifest_json TEXT NOT NULL,' +
    'capabilities_json TEXT NOT NULL,' +
    "granted_json TEXT NOT NULL DEFAULT '[]'," +
    'installed_at TEXT NOT NULL,' +
    'updated_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS life_plugins_status ON life_plugins(status, id)',
 // One row per accepted AND refused operation (install/enable/disable). Append-only
 // by trigger: "what did I allow, and when" must stay answerable, including for the
 // attempts that were turned down.
  ...RECEIPT_TABLE,
 // Delivery channels. Two fail-closed layers that are
 // deliberately separate rows: a channel's master switch (default off) and the grant
 // rows that actually allow one combination. An empty grant table is NOT "allow all" -
 // it is "nothing has been allowed yet", which is why the first version ships with no
 // channel at all.
  'CREATE TABLE IF NOT EXISTS life_channels(' +
    'id TEXT PRIMARY KEY,' +
    "kind TEXT NOT NULL CHECK(kind IN ('file','message'))," +
    'label TEXT,' +
    'enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),' +
    'created_at TEXT NOT NULL,' +
    'updated_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS life_channel_grants(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'channel_id TEXT NOT NULL REFERENCES life_channels(id) ON DELETE CASCADE,' +
    'plugin_id TEXT NOT NULL,' +
    'types_json TEXT NOT NULL,' +
    'recipient TEXT NOT NULL,' +
    'per_day INTEGER NOT NULL CHECK(per_day >= 1),' +
    'enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),' +
    'created_at TEXT NOT NULL,' +
    'revoked_at TEXT)',
  'CREATE INDEX IF NOT EXISTS life_channel_grants_channel ON life_channel_grants(channel_id, enabled)',
 // One row per attempt that reached a channel: authorized, delivered, or refused. The
 // delivered flag is separate from the outcome on purpose - "the host allowed it" and
 // "something actually left" must never be the same claim.
  'CREATE TABLE IF NOT EXISTS life_channel_receipts(' +
    'seq INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'at TEXT NOT NULL,' +
    'channel_id TEXT,' +
    'grant_id INTEGER,' +
    'plugin_id TEXT,' +
    'recipient TEXT,' +
    'artifact TEXT,' +
    'media TEXT,' +
    'bytes INTEGER,' +
    'sha256 TEXT,' +
    "outcome TEXT NOT NULL CHECK(outcome IN ('ok','refused'))," +
    'delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1)),' +
    'code TEXT,' +
    "detail_json TEXT NOT NULL DEFAULT '{}')",
  'CREATE INDEX IF NOT EXISTS life_channel_receipts_grant ON life_channel_receipts(grant_id, at)',
  'CREATE TRIGGER IF NOT EXISTS life_channel_receipts_no_update BEFORE UPDATE ON life_channel_receipts ' +
    "BEGIN SELECT RAISE(ABORT, 'life_channel_receipts_is_append_only'); END",
  'CREATE TRIGGER IF NOT EXISTS life_channel_receipts_no_delete BEFORE DELETE ON life_channel_receipts ' +
    "BEGIN SELECT RAISE(ABORT, 'life_channel_receipts_is_append_only'); END",
 // Inbound doors. One row per plugin that may receive
 // anything from outside. Created only by registerInbound, and created CLOSED: the door
 // exists before it opens. The row is foreign-keyed to it plugin table, so uninstalling
 // the plugin takes its inbox door with it - the files already inside stay, because they
 // are the agent's, and uninstall never deletes its data.
  'CREATE TABLE IF NOT EXISTS life_inbound(' +
    'plugin_id TEXT PRIMARY KEY REFERENCES life_plugins(id) ON DELETE CASCADE,' +
    'types_json TEXT NOT NULL,' +
    'max_bytes INTEGER NOT NULL CHECK(max_bytes >= 1),' +
    'max_per_day INTEGER NOT NULL CHECK(max_per_day >= 1),' +
    'enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),' +
    'created_at TEXT NOT NULL,' +
    'updated_at TEXT NOT NULL)',
 // One row per arrival, accepted or refused, plus every door change. "What came in, from
 // which plugin, and what was stripped off it" has to outlive its disk: a refused arrival
 // is as interesting as an accepted one, which is why refusals are written here too.
  'CREATE TABLE IF NOT EXISTS life_inbound_receipts(' +
    'seq INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'at TEXT NOT NULL,' +
    'plugin_id TEXT,' +
    "action TEXT NOT NULL CHECK(action IN ('register','enable','disable','accept'))," +
    "outcome TEXT NOT NULL CHECK(outcome IN ('ok','refused'))," +
    'name TEXT,' +
    'media TEXT,' +
    'bytes_in INTEGER,' +
    'bytes_out INTEGER,' +
    'sha256 TEXT,' +
    'stripped_json TEXT,' +
    'code TEXT,' +
    "detail_json TEXT NOT NULL DEFAULT '{}')",
  'CREATE INDEX IF NOT EXISTS life_inbound_receipts_plugin ON life_inbound_receipts(plugin_id, at)',
  'CREATE TRIGGER IF NOT EXISTS life_inbound_receipts_no_update BEFORE UPDATE ON life_inbound_receipts ' +
    "BEGIN SELECT RAISE(ABORT, 'life_inbound_receipts_is_append_only'); END",
  'CREATE TRIGGER IF NOT EXISTS life_inbound_receipts_no_delete BEFORE DELETE ON life_inbound_receipts ' +
    "BEGIN SELECT RAISE(ABORT, 'life_inbound_receipts_is_append_only'); END",
 // What the agent could see the last time the host told it.
 // A row here is not a grant: the grant is the owner's config file. This row is the
 // memory of the previous view, so a changed view can be *announced* instead of
 // silently rearranging the world under it.
  'CREATE TABLE IF NOT EXISTS life_room(' +
    'singleton INTEGER PRIMARY KEY CHECK(singleton=1),' +
    'view_json TEXT NOT NULL,' +
    'updated_at TEXT NOT NULL)',
 // The agent's daily output counter (schema v14; an earlier design used a fixed daily
 // cap with no carry-over, reset at its local midnight). One row per day, not a running total, because
 // "today" has to be answerable after a crash: the row IS the persistence, and a new day is
 // a new row rather than a subtracted value.
  'CREATE TABLE IF NOT EXISTS life_budget(' +
    'day TEXT PRIMARY KEY,' +
    'output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),' +
    'updated_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS life_prefs(' +
    'id TEXT NOT NULL,' +
    'version INTEGER NOT NULL,' +
    "status TEXT NOT NULL CHECK(status IN ('active','withdrawn'))," +
    'text TEXT NOT NULL,' +
    'created_at TEXT NOT NULL,' +
    "source_refs_json TEXT NOT NULL DEFAULT '[]'," +
    'PRIMARY KEY(id, version))',
 // The log is append-only (design hard boundary). Enforced here, not by convention:
 // a caller that tries to rewrite or erase the record gets an error, not silent success.
  'CREATE TRIGGER IF NOT EXISTS life_events_no_update BEFORE UPDATE ON life_events ' +
    "BEGIN SELECT RAISE(ABORT, 'life_events_is_append_only'); END",
  'CREATE TRIGGER IF NOT EXISTS life_events_no_delete BEFORE DELETE ON life_events ' +
    "BEGIN SELECT RAISE(ABORT, 'life_events_is_append_only'); END",
  'CREATE INDEX IF NOT EXISTS life_events_kind ON life_events(kind, seq)',
  'CREATE INDEX IF NOT EXISTS life_packages_status ON life_packages(status, created_at)',
  'CREATE INDEX IF NOT EXISTS life_packages_range ON life_packages(start_seq, end_seq)',
  'CREATE INDEX IF NOT EXISTS life_package_terms_term ON life_package_terms(term)',
  'CREATE INDEX IF NOT EXISTS life_activation_package ON life_activation(package_id, recalled_at)',
  'CREATE INDEX IF NOT EXISTS life_prefs_active ON life_prefs(status, id)',
 // The agent's own reminders. A row is a moment the agent
  // 选了回到某件事上："过十分钟再问你" / "19 点记着吃饭" / "睡前提醒关灯"。
 // It is not a task and not an arrival: tasks are unfinished work, arrivals came from
 // outside, this one is the agent's. Status changes to fired/cancelled in place (like attention),
 // the row is never deleted - "what did I ask myself to remember" stays answerable.
  ...REMINDER_TABLE,
];

/**
 * Additive column upgrade. CREATE TABLE IF NOT EXISTS cannot add a column to a table
 * that already exists, and a destructive rewrite is not acceptable for it memory, so
 * missing columns are added in place. Existing rows keep NULL / '[]' and stay readable.
 */
const COLUMNS = Object.freeze({
  life_meta: {
    scheduler_json: "TEXT NOT NULL DEFAULT '{}'",
  },
 // v17：一次「没响成」只记一次。闹钟可以迟到；迟到久了不再把助手叫起来，但必须让助手知道
 // 这一条在该响的时候没响，所以这一列记「已经告诉过助手一次」。
  life_reminders: {
    late_notice_at: 'TEXT',
  },
  life_packages: {
    occurred_at: 'TEXT',
    subjects_json: "TEXT NOT NULL DEFAULT '[]'",
    ordinal: 'INTEGER',
  },
});

function ensureColumns(db) {
  for (const [table, columns] of Object.entries(COLUMNS)) {
    const existing = new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map((row) => row.name));
    for (const [name, definition] of Object.entries(columns)) {
      if (existing.has(name)) continue;
      db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + name + ' ' + definition);
    }
  }
}

export const TABLES = Object.freeze([
  'life_meta',
  'life_compression_attempts',
  'life_events',
  'life_packages',
  'life_package_vectors',
  'life_package_terms',
  'life_activation',
  'life_rolls',
  'life_compression_locks',
  'life_corrections',
  'life_state',
  'life_tasks',
  'life_attention',
  'life_prefs',
  'life_plugins',
  'life_plugin_receipts',
  'life_channels',
  'life_channel_grants',
  'life_channel_receipts',
  'life_inbound',
  'life_inbound_receipts',
  'life_room',
  'life_budget',
  'life_reminders',
]);

/**
 * v10: widen the receipt action check with 'uninstall'.
 *
 * SQLite cannot alter a CHECK constraint, so the table is rebuilt: triggers and index
 * dropped, table renamed, new table created from RECEIPT_TABLE, rows copied with their
 * original seq, old table dropped. All of it inside one transaction, so a crash leaves
 * either the v9 table or the v10 table, never a half-copied log.
 *
 * No receipt is lost and none is rewritten: this is a shape change, not a rewrite.
 */
function widenReceiptActions(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='life_plugin_receipts'").get();
  if (row === undefined) return false;
  if (String(row.sql).includes("'uninstall'")) return false;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DROP TRIGGER IF EXISTS life_plugin_receipts_no_update');
    db.exec('DROP TRIGGER IF EXISTS life_plugin_receipts_no_delete');
    db.exec('DROP INDEX IF EXISTS life_plugin_receipts_plugin');
    db.exec('ALTER TABLE life_plugin_receipts RENAME TO life_plugin_receipts_v9');
    for (const statement of RECEIPT_TABLE) db.exec(statement);
    db.exec('INSERT INTO life_plugin_receipts(seq, at, plugin_id, action, outcome, code, detail_json) ' +
      'SELECT seq, at, plugin_id, action, outcome, code, detail_json FROM life_plugin_receipts_v9');
    db.exec('DROP TABLE life_plugin_receipts_v9');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* the original error is the useful one */ }
    throw error;
  }
  return true;
}

/**
 * v16: a reminder may also be an alarm, i.e. a moment that is allowed
 * to wake the agent up instead of waiting for it. Same row shape, same limits; only the CHECK
 * on kind has to widen, and SQLite cannot do that in place. Rebuilt exactly like the
 * receipt table above: one transaction, every row copied, old table dropped last.
 *
 * Nothing is rewritten: a v15 reminder stays kind 'remind', which is what it meant.
 */
function widenReminderKinds(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='life_reminders'").get();
  if (row === undefined) return false;
  if (String(row.sql).includes("'alarm'")) return false;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DROP INDEX IF EXISTS life_reminders_due');
    db.exec('ALTER TABLE life_reminders RENAME TO life_reminders_v15');
    for (const statement of REMINDER_TABLE) db.exec(statement);
    db.exec('INSERT INTO life_reminders(id, due_at, note, kind, status, created_at, fired_at, cancelled_at, cancel_reason, source, meta_json, late_notice_at) ' +
      'SELECT id, due_at, note, kind, status, created_at, fired_at, cancelled_at, cancel_reason, source, meta_json, NULL FROM life_reminders_v15');
    db.exec('DROP TABLE life_reminders_v15');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* the original error is the useful one */ }
    throw error;
  }
  return true;
}

function readMeta(db) {
  const row = db.prepare('SELECT identity_id, schema_version, created_at FROM life_meta WHERE singleton=1').get();
  return row === undefined ? null : row;
}

/**
 * Creates the schema if missing and binds the database to one identity.
 * Idempotent: running it twice changes nothing.
 */
export function migrate(db, options = {}) {
  if (db === null || typeof db !== 'object' || typeof db.exec !== 'function') {
    throw new LifeStoreError('invalid_database');
  }
  const identityId = options.identityId ?? 'local';
  if (typeof identityId !== 'string' || identityId === '') throw new LifeStoreError('invalid_identity');

  for (const statement of SCHEMA) db.exec(statement);
  ensureColumns(db);

  const meta = readMeta(db);
  if (meta === null) {
    db.prepare('INSERT INTO life_meta(singleton, identity_id, schema_version, created_at) VALUES(1,?,?,?)')
      .run(identityId, SCHEMA_VERSION, new Date().toISOString());
    return { created: true, schemaVersion: SCHEMA_VERSION, identityId };
  }
  if (meta.identity_id !== identityId) {
    throw new LifeStoreError('identity_mismatch', meta.identity_id + ' != ' + identityId);
  }
  if (meta.schema_version > SCHEMA_VERSION) {
    throw new LifeStoreError('schema_from_future', String(meta.schema_version));
  }
  if (meta.schema_version < SCHEMA_VERSION) {
 // Every statement above is CREATE.. IF NOT EXISTS, so replaying the list is a
 // valid upgrade for additive changes. A destructive migration must not be added
 // here without an explicit, tested step.
    for (const statement of SCHEMA) db.exec(statement);
    const receiptsRebuilt = widenReceiptActions(db);
    const remindersWidened = widenReminderKinds(db);
    db.prepare('UPDATE life_meta SET schema_version=? WHERE singleton=1').run(SCHEMA_VERSION);
    return { created: false, migratedFrom: meta.schema_version, schemaVersion: SCHEMA_VERSION, identityId, receiptsRebuilt, remindersWidened };
  }
  return { created: false, schemaVersion: meta.schema_version, identityId };
}

function applyPragmas(db, path) {
  if (path !== ':memory:') db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA synchronous=FULL');
  db.exec('PRAGMA trusted_schema=OFF');
  db.exec('PRAGMA busy_timeout=5000');
}

/**
 * @param {string} path file path, or ':memory:' for tests
 * @param {object} [options] identityId
 */
export function openStore(path, options = {}) {
  if (typeof path !== 'string' || path === '') throw new LifeStoreError('invalid_path');
  const db = new DatabaseSync(path);
  try {
    applyPragmas(db, path);
    const migrated = migrate(db, options);
    return createHandle(db, path, migrated);
  } catch (error) {
    try { db.close(); } catch { /* the original error is the useful one */ }
    throw error;
  }
}

function createHandle(db, path, migrated) {
  let inTransaction = false;
  return {
    path,
    db,
    identityId: migrated.identityId,
    schemaVersion: migrated.schemaVersion,
    created: migrated.created,
 /**
 * Runs a synchronous callback inside one write transaction. Nested use is
 * refused rather than silently flattened, and a throw rolls everything back.
 */
    atomic(fn) {
      if (typeof fn !== 'function') throw new LifeStoreError('invalid_callback');
      if (inTransaction) throw new LifeStoreError('nested_transaction');
      db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      try {
        const result = fn(db);
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          throw new LifeStoreError('async_transaction_body');
        }
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* rollback failure must not hide the cause */ }
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    count(table) {
      if (!TABLES.includes(table)) throw new LifeStoreError('unknown_table', String(table));
      const row = db.prepare('SELECT COUNT(*) AS n FROM ' + table).get();
      return Number(row.n);
    },
    close() { db.close(); },
  };
}
