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
export function ensureRecurringTasksForDate(date = null) {
  const targetDate = date || today();
  const database = getDb();
  const seedKey = `recurring_seeded_${targetDate}`;

  const alreadySeeded = database.prepare('SELECT value FROM config WHERE key = ?').get(seedKey);
  if (alreadySeeded) return 0;

  const recurringTemplates = database.prepare(`
    SELECT priority_id, title, notes, energy_level
    FROM tasks
    WHERE recurring = 1
    GROUP BY lower(trim(title))
    ORDER BY id ASC
  `).all();

  if (recurringTemplates.length === 0) return 0;

  const existingTitles = new Set(
    database.prepare('SELECT lower(trim(title)) as norm_title FROM tasks WHERE date = ?')
      .all(targetDate)
      .map(r => r.norm_title)
  );

  let inserted = 0;
  const tx = database.transaction(() => {
    const insertStmt = database.prepare(`
      INSERT INTO tasks (priority_id, title, notes, recurring, energy_level, date)
      VALUES (?, ?, ?, 1, ?, ?)
    `);
    for (const tmpl of recurringTemplates) {
      const norm = tmpl.title.toLowerCase().trim();
      if (!existingTitles.has(norm)) {
        insertStmt.run(tmpl.priority_id, tmpl.title, tmpl.notes || null, tmpl.energy_level || 'medium', targetDate);
        existingTitles.add(norm);
        inserted++;
      }
    }
    database.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(seedKey, new Date().toISOString());
  });

  tx();
  return inserted;
}

export function getTasksForDate(date) {
  const targetDate = date || today();
  ensureRecurringTasksForDate(targetDate);
  return getDb().prepare(`
    SELECT t.*, p.name as priority_name, p.emoji as priority_emoji, p.color as priority_color, p.tier
    FROM tasks t
    JOIN priorities p ON t.priority_id = p.id
    WHERE t.date = ?
    ORDER BY p.tier ASC, t.completed ASC, t.id ASC
  `).all(targetDate);
}

export function rolloverUnfinishedTasks(targetDate = null) {
  const destDate = targetDate || today();
  const database = getDb();
  ensureRecurringTasksForDate(destDate);

  const staleIncomplete = database.prepare(`
    SELECT * FROM tasks
    WHERE completed = 0 AND date < ?
    ORDER BY date DESC, id ASC
  `).all(destDate);

  if (staleIncomplete.length === 0) {
    return { rolledOverCount: 0, tasks: [] };
  }

  const existingTitles = new Set(
    database.prepare('SELECT lower(trim(title)) as norm_title FROM tasks WHERE date = ?')
      .all(destDate)
      .map(r => r.norm_title)
  );

  const rolledIds = [];
  const tx = database.transaction(() => {
    const updateStmt = database.prepare('UPDATE tasks SET date = ? WHERE id = ?');
    const deleteDuplicateStmt = database.prepare('DELETE FROM tasks WHERE id = ?');

    for (const task of staleIncomplete) {
      const norm = task.title.toLowerCase().trim();
      if (existingTitles.has(norm)) {
        // If it's a recurring task that already exists on destDate, clean up the old uncompleted duplicate
        if (task.recurring) {
          deleteDuplicateStmt.run(task.id);
        }
        continue;
      }
      updateStmt.run(destDate, task.id);
      existingTitles.add(norm);
      rolledIds.push(task.id);
    }
  });

  tx();

  const rolledTasks = rolledIds.length > 0
    ? database.prepare(`
        SELECT t.*, p.name as priority_name, p.emoji as priority_emoji, p.color as priority_color, p.tier
        FROM tasks t
        JOIN priorities p ON t.priority_id = p.id
        WHERE t.id IN (${rolledIds.map(() => '?').join(',')})
      `).all(...rolledIds)
    : [];

  return {
    rolledOverCount: rolledTasks.length,
    tasks: rolledTasks
  };
}

export function findTaskByQuery(query, date = null, { onlyIncomplete = false } = {}) {
  const targetDate = date || today();
  const tasks = getTasksForDate(targetDate);
  const candidates = onlyIncomplete ? tasks.filter(t => !t.completed) : tasks;
  if (!query) return candidates[0] || null;

  const raw = String(query).trim();
  const idMatch = raw.match(/^#?(\d+)$/);
  if (idMatch) {
    const id = parseInt(idMatch[1], 10);
    return candidates.find(t => t.id === id) || tasks.find(t => t.id === id) || null;
  }

  const norm = raw.toLowerCase().replace(/^["']|["']$/g, '').trim();
  if (!norm) return null;

  // 1. Exact title match
  const exact = candidates.find(t => t.title.toLowerCase().trim() === norm);
  if (exact) return exact;

  // 2. Substring match (task title contains query or query contains task title)
  const sub = candidates.find(
    t => t.title.toLowerCase().includes(norm) || (norm.length >= 4 && norm.includes(t.title.toLowerCase()))
  );
  if (sub) return sub;

  // 3. Token overlap match
  const queryWords = norm.split(/\s+/).filter(w => w.length >= 3);
  if (queryWords.length > 0) {
    let bestTask = null;
    let bestScore = 0;
    for (const t of candidates) {
      const titleLower = t.title.toLowerCase();
      const hits = queryWords.filter(w => titleLower.includes(w)).length;
      if (hits > bestScore) {
        bestScore = hits;
        bestTask = t;
      }
    }
    if (bestScore > 0) return bestTask;
  }

  return null;
}

export function createTask({ title, priority_id = 5, notes = null, recurring = 0, energy_level = 'medium', date = null }) {
  const targetDate = date || today();
  ensureRecurringTasksForDate(targetDate);
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
