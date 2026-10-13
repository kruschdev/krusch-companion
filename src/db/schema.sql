-- Krusch Companion Database Schema (SQLite WAL)

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS priorities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL,
  color TEXT NOT NULL,
  tier INTEGER NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  priority_id INTEGER NOT NULL REFERENCES priorities(id),
  title TEXT NOT NULL,
  notes TEXT,
  completed INTEGER DEFAULT 0,
  recurring INTEGER DEFAULT 0,
  energy_level TEXT DEFAULT 'medium',
  date TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS companion_context (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL CHECK(category IN ('decision', 'invariant', 'bug', 'lesson', 'blocker')),
  content TEXT NOT NULL,
  key TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  superseded_by INTEGER REFERENCES companion_context(id),
  invalidation_reason TEXT,
  confidence REAL DEFAULT 1.0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_date_priority ON tasks(date, priority_id, completed);

CREATE INDEX IF NOT EXISTS idx_companion_context_active ON companion_context(is_active, category);
CREATE INDEX IF NOT EXISTS idx_companion_context_key ON companion_context(key);
CREATE INDEX IF NOT EXISTS idx_companion_context_decay ON companion_context(is_active, updated_at);

CREATE TABLE IF NOT EXISTS companion_dialogue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  tier_used TEXT DEFAULT 'L1_edge',
  latency_ms INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dialogue_session ON companion_dialogue(session_id, created_at);

CREATE TABLE IF NOT EXISTS daily_focus (
  date TEXT PRIMARY KEY,
  focus_text TEXT NOT NULL,
  friction_notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_reflections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT UNIQUE,
  reflection TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_gamify (
  date TEXT PRIMARY KEY,
  opted_in INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
