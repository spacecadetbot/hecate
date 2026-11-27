import { DatabaseSync } from 'node:sqlite';

const SCHEMA_V1 = `
CREATE TABLE users (
  id TEXT PRIMARY KEY, apple_sub TEXT UNIQUE NOT NULL, email TEXT, display_name TEXT,
  role TEXT NOT NULL DEFAULT 'user', disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, last_seen_at INTEGER
);
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT, refresh_hash TEXT UNIQUE, prev_refresh_hash TEXT,
  created_at INTEGER NOT NULL, last_used_at INTEGER, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_user ON auth_sessions(user_id);
CREATE TABLE invites (
  code TEXT PRIMARY KEY, created_by TEXT, note TEXT, max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0, expires_at INTEGER, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT UNIQUE NOT NULL, created_by TEXT,
  created_at INTEGER NOT NULL, last_used_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE model_servers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key_enc TEXT,
  default_tier TEXT NOT NULL DEFAULT 'fast', enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unknown', last_checked_at INTEGER, last_ok_at INTEGER,
  latency_ms INTEGER, last_error TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE models (
  id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES model_servers(id) ON DELETE CASCADE,
  upstream_id TEXT NOT NULL, display_name TEXT, tier TEXT NOT NULL DEFAULT 'fast',
  capabilities TEXT NOT NULL DEFAULT '["text"]', options TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1, present INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
  UNIQUE(server_id, upstream_id)
);
CREATE TABLE agents (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT, persona TEXT, tier TEXT, model_id TEXT, tools TEXT NOT NULL DEFAULT '[]',
  hermes_profile TEXT, hermes_api_key_enc TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_agents_user ON agents(user_id);
CREATE TABLE chats (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat', pinned INTEGER NOT NULL DEFAULT 0, agent_id TEXT,
  model_prefs TEXT NOT NULL DEFAULT '{}', use_memory INTEGER NOT NULL DEFAULT 1, system_prompt TEXT,
  hermes_session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_chats_user ON chats(user_id, pinned DESC, updated_at DESC);
CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
  role TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', reasoning TEXT, status TEXT NOT NULL DEFAULT 'complete',
  model TEXT, usage TEXT, error TEXT, run_id TEXT, client_id TEXT, thinking_ms INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_chat ON messages(chat_id, seq);
CREATE UNIQUE INDEX idx_messages_client ON messages(chat_id, client_id) WHERE client_id IS NOT NULL;
CREATE TABLE attachments (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, message_id TEXT,
  kind TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT,
  path TEXT NOT NULL, thumb_path TEXT, extracted_text TEXT, meta TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ready', created_at INTEGER NOT NULL
);
CREATE INDEX idx_attachments_msg ON attachments(message_id);
CREATE INDEX idx_attachments_user ON attachments(user_id);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, message_id TEXT NOT NULL,
  user_message_id TEXT, status TEXT NOT NULL, model_id TEXT, error TEXT, hermes_run_id TEXT,
  params TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE INDEX idx_runs_chat ON runs(chat_id, created_at);
CREATE TABLE run_events (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
) WITHOUT ROWID;
CREATE TABLE memories (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual', chat_id TEXT, embedding BLOB, embedding_model TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_memories_user ON memories(user_id, updated_at DESC);
`;

const MIGRATION_V2 = `
ALTER TABLE model_servers ADD COLUMN kind TEXT NOT NULL DEFAULT 'openai';
ALTER TABLE models ADD COLUMN info TEXT NOT NULL DEFAULT '{}';
`;

const MIGRATION_V3 = `
ALTER TABLE chats ADD COLUMN auto_title TEXT;
`;

const MIGRATION_V4 = `
ALTER TABLE users ADD COLUMN show_disclaimer INTEGER NOT NULL DEFAULT 1;
`;

const MIGRATION_V5 = `
ALTER TABLE users ADD COLUMN rules TEXT NOT NULL DEFAULT '';
`;

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const v = db.prepare('PRAGMA user_version').get().user_version;
  if (v < 1) { db.exec('BEGIN'); db.exec(SCHEMA_V1); db.exec('PRAGMA user_version = 1'); db.exec('COMMIT'); }
  if (v < 2) { db.exec('BEGIN'); db.exec(MIGRATION_V2); db.exec('PRAGMA user_version = 2'); db.exec('COMMIT'); }
  if (v < 3) { db.exec('BEGIN'); db.exec(MIGRATION_V3); db.exec('PRAGMA user_version = 3'); db.exec('COMMIT'); }
  if (v < 4) { db.exec('BEGIN'); db.exec(MIGRATION_V4); db.exec('PRAGMA user_version = 4'); db.exec('COMMIT'); }
  if (v < 5) { db.exec('BEGIN'); db.exec(MIGRATION_V5); db.exec('PRAGMA user_version = 5'); db.exec('COMMIT'); }

  const cache = new Map();
  const st = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  const norm = (p) => p.map((x) => (x === undefined ? null : typeof x === 'boolean' ? (x ? 1 : 0) : x));
  return {
    raw: db,
    get: (sql, ...p) => st(sql).get(...norm(p)),
    all: (sql, ...p) => st(sql).all(...norm(p)),
    run: (sql, ...p) => st(sql).run(...norm(p)),
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    backupTo(file) { db.exec(`VACUUM INTO '${String(file).replace(/'/g, "''")}'`); },
    close() { db.close(); },
  };
}
