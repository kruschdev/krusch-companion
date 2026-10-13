import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import config from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db = null;

export const TIER_POINTS = { 1: 50, 2: 30, 3: 20, 4: 15, 5: 10 };
export const COMPLETION_BONUS = 50;

export function today() {
  return new Date().toISOString().split('T')[0];
}

export function initCompanionDb(customPath = null) {
  if (db) return db;

  const dbPath = customPath || config.db.path;
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Load and execute schema
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schemaSql);

  // Seed default priorities if empty
  const count = db.prepare('SELECT COUNT(*) as count FROM priorities').get().count;
  if (count === 0) {
    const insertPriority = db.prepare(
      'INSERT INTO priorities (name, emoji, color, tier) VALUES (?, ?, ?, ?)'
    );
    insertPriority.run('Core Values & Faith', '🙏', '#f0c040', 1);
    insertPriority.run('Family & Partner', '💕', '#e8587a', 2);
    insertPriority.run('Children & Loved Ones', '👧', '#a78bfa', 3);
    insertPriority.run('Health & Self', '💪', '#2dd4bf', 4);
    insertPriority.run('Work & Mastery', '🔧', '#60a5fa', 5);

    const dateToday = today();
    const insertTask = db.prepare(
      'INSERT INTO tasks (priority_id, title, recurring, date) VALUES (?, ?, 1, ?)'
    );
    insertTask.run(1, 'Morning gratitude & prayer', dateToday);
    insertTask.run(2, 'Check in with partner', dateToday);
    insertTask.run(4, 'Hydrate & morning movement', dateToday);
    insertTask.run(5, 'Review top priority for today', dateToday);
  }

  return db;
}

export function getDb() {
  if (!db) {
    return initCompanionDb();
  }
  return db;
}

// ── Priorities ──────────────────────────────────────────────────────────────
export function getPriorities() {
  return getDb().prepare('SELECT * FROM priorities ORDER BY tier ASC').all();
}

// ── Tasks ───────────────────────────────────────────────────────────────────
export function getTasksForDate(date) {
  const targetDate = date || today();
  return getDb().prepare(`
    SELECT t.*, p.name as priority_name, p.emoji as priority_emoji, p.color as priority_color, p.tier
    FROM tasks t
    JOIN priorities p ON t.priority_id = p.id
    WHERE t.date = ?
    ORDER BY p.tier ASC, t.completed ASC, t.id ASC
  `).all(targetDate);
}

export function createTask({ title, priority_id = 5, notes = null, recurring = 0, energy_level = 'medium', date = null }) {
  const targetDate = date || today();
  const stmt = getDb().prepare(`
    INSERT INTO tasks (priority_id, title, notes, recurring, energy_level, date)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(priority_id, title, notes, recurring ? 1 : 0, energy_level, targetDate);
  return getDb().prepare(`
    SELECT t.*, p.name as priority_name, p.emoji as priority_emoji, p.color as priority_color, p.tier
    FROM tasks t
    JOIN priorities p ON t.priority_id = p.id
    WHERE t.id = ?
  `).get(info.lastInsertRowid);
}

export function toggleTask(id) {
  const database = getDb();
  const task = database.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return null;

  const newCompleted = task.completed ? 0 : 1;
  const completedAt = newCompleted ? new Date().toISOString() : null;

  database.prepare(`
    UPDATE tasks SET completed = ?, completed_at = ? WHERE id = ?
  `).run(newCompleted, completedAt, id);

  return getDb().prepare(`
    SELECT t.*, p.name as priority_name, p.emoji as priority_emoji, p.color as priority_color, p.tier
    FROM tasks t
    JOIN priorities p ON t.priority_id = p.id
    WHERE t.id = ?
  `).get(id);
}

export function deleteTask(id) {
  return getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

// ── Daily Focus & Reflection ───────────────────────────────────────────────
export function getDailyFocus(date) {
  const targetDate = date || today();
  return getDb().prepare('SELECT * FROM daily_focus WHERE date = ?').get(targetDate) || null;
}

export function setDailyFocus(date, focusText, frictionNotes = null) {
  const targetDate = date || today();
  getDb().prepare(`
    INSERT INTO daily_focus (date, focus_text, friction_notes)
    VALUES (?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET focus_text = excluded.focus_text, friction_notes = excluded.friction_notes
  `).run(targetDate, focusText, frictionNotes);
  return getDailyFocus(targetDate);
}

export function getDailyReflection(date) {
  const targetDate = date || today();
  return getDb().prepare('SELECT * FROM daily_reflections WHERE date = ?').get(targetDate) || null;
}

export function saveDailyReflection(date, reflection) {
  const targetDate = date || today();
  getDb().prepare(`
    INSERT INTO daily_reflections (date, reflection)
    VALUES (?, ?)
    ON CONFLICT(date) DO UPDATE SET reflection = excluded.reflection
  `).run(targetDate, reflection);
  return getDailyReflection(targetDate);
}

// ── Gamify & Streak ────────────────────────────────────────────────────────
export function getGamifyStatus(date) {
  const targetDate = date || today();
  const row = getDb().prepare('SELECT * FROM daily_gamify WHERE date = ?').get(targetDate);
  return row ? { ...row, opted_in: Boolean(row.opted_in), locked: Boolean(row.locked) } : { date: targetDate, opted_in: false, points: 0, locked: false };
}

export function setGamifyOptIn(date, optedIn) {
  const targetDate = date || today();
  getDb().prepare(`
    INSERT INTO daily_gamify (date, opted_in, points, locked)
    VALUES (?, ?, 0, 0)
    ON CONFLICT(date) DO UPDATE SET opted_in = excluded.opted_in
  `).run(targetDate, optedIn ? 1 : 0);
  return getGamifyStatus(targetDate);
}

export function addGamifyPoints(date, pts) {
  const targetDate = date || today();
  getDb().prepare(`
    INSERT INTO daily_gamify (date, opted_in, points, locked)
    VALUES (?, 1, max(0, ?), 1)
    ON CONFLICT(date) DO UPDATE SET points = max(0, points + ?), locked = 1
  `).run(targetDate, pts, pts);
  return getGamifyStatus(targetDate);
}

export function getStreak() {
  const rows = getDb().prepare(`
    SELECT DISTINCT date FROM tasks WHERE completed = 1 ORDER BY date DESC
  `).all();

  let streak = 0;
  const current = new Date();
  for (const row of rows) {
    const rowDate = new Date(row.date + 'T00:00:00');
    const diffDays = Math.floor((current - rowDate) / (1000 * 60 * 60 * 24));
    if (diffDays === streak || diffDays === streak + 1) {
      streak++;
    } else {
      break;
    }
  }
  return { streak, totalCompletedDays: rows.length };
}

// ── Dialogue ────────────────────────────────────────────────────────────────
export function saveDialogueMessage({ sessionId, role, content, tierUsed = 'L1_edge', latencyMs = 0 }) {
  const stmt = getDb().prepare(`
    INSERT INTO companion_dialogue (session_id, role, content, tier_used, latency_ms)
    VALUES (?, ?, ?, ?, ?)
  `);
  const info = stmt.run(sessionId, role, content, tierUsed, latencyMs);
  return getDb().prepare('SELECT * FROM companion_dialogue WHERE id = ?').get(info.lastInsertRowid);
}

export function getDialogueHistory(sessionId, limit = 20) {
  return getDb().prepare(`
    SELECT * FROM companion_dialogue WHERE session_id = ? ORDER BY id ASC LIMIT ?
  `).all(sessionId, limit);
}
