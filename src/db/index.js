import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import config from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db = null;

export const TIER_POINTS = { 1: 50, 2: 30, 3: 20, 4: 15, 5: 10 };
export const EXECUTION_PRIORITY_POINTS = { 1: 50, 2: 35, 3: 25, 4: 15 };
export const COMPLETION_BONUS = 50;

/**
 * Axis 1: Execution Priority Lanes (Controls Today's Board Order — What Must Happen First Today)
 */
export const EXECUTION_LANES = [
  {
    level: 1,
    key: 'must_do',
    name: 'Must Happen Today — Deadlines & Provision',
    shortName: 'Must Happen Today',
    emoji: '🚨',
    color: '#ef4444',
    description: 'Urgent life necessities, bills/invoices, hard deadlines, appointments & family provision.'
  },
  {
    level: 2,
    key: 'high_impact',
    name: 'High-Impact Focus — Move the Needle',
    shortName: 'High-Impact Focus',
    emoji: '⚡',
    color: '#38bdf8',
    description: 'Key daily deliverables, projects, family commitments & health goals.'
  },
  {
    level: 3,
    key: 'daily_habits',
    name: 'Daily Habits & Anchors',
    shortName: 'Daily Habits',
    emoji: '🌱',
    color: '#2dd4bf',
    description: 'Recurring daily grounding routines — never buries urgent deadlines or provision.'
  },
  {
    level: 4,
    key: 'backlog',
    name: 'Backlog — When Time Permits',
    shortName: 'Backlog',
    emoji: '📥',
    color: '#94a3b8',
    description: 'Low-urgency errands, ideas, and tasks that can wait.'
  }
];

/**
 * Axis 2: Life Pillar Tags (Color-coded badges showing WHO/WHAT domain a task serves)
 */
export const LIFE_PILLARS = [
  { key: 'values', name: 'Core Values & Faith', emoji: '🙏', color: '#f0c040', tier: 1 },
  { key: 'family', name: 'Family & Partner', emoji: '💕', color: '#e8587a', tier: 2 },
  { key: 'kids', name: 'Children & Loved Ones', emoji: '👧', color: '#a78bfa', tier: 3 },
  { key: 'health', name: 'Health & Self', emoji: '💪', color: '#2dd4bf', tier: 4 },
  { key: 'work', name: 'Work & Mastery', emoji: '🔧', color: '#60a5fa', tier: 5 },
  { key: 'finance', name: 'Provision & Finance', emoji: '🏠', color: '#f59e0b', tier: 5 }
];

export function getExecutionLanes() {
  return EXECUTION_LANES;
}

export function getLifePillars() {
  return LIFE_PILLARS;
}

/**
 * Automatically infer Execution Priority (1..4) and Life Pillar tag from task metadata & text.
 * Ensures urgent bills, family provision, deadlines, and appointments float to Priority 1 (Must Happen Today)
 * while recurring habits stay in Priority 3 (Daily Habits).
 */
export function inferExecutionPriorityAndPillar({
  title = '',
  notes = '',
  recurring = 0,
  priority_id = 5,
  execution_priority = null,
  pillar = null
} = {}) {
  const combined = `${title} ${notes || ''}`.toLowerCase();

  // 1. Determine Life Pillar tag
  let resolvedPillar = pillar;
  if (!resolvedPillar) {
    if (/\b(bill|invoice|mortgage|rent|tax|taxes|insurance|paycheck|budget|bank|payment|utility|electric|water heater|plumb|car repair|lease|contract|dishes|dishwasher|laundry|grocery|groceries|trash|garbage|clean|vacuum|sweep|mop|kitchen|yard|errands?)\b/.test(combined)) {
      resolvedPillar = 'Provision & Finance';
    } else if (priority_id === 1 || /\b(pray|prayer|gratitude|meditat|faith|church|scripture|devotional|worship)\b/.test(combined)) {
      resolvedPillar = 'Core Values & Faith';
    } else if (priority_id === 2 || /\b(wife|husband|partner|spouse|marriage|anniversary|date night|reservation)\b/.test(combined)) {
      resolvedPillar = 'Family & Partner';
    } else if (priority_id === 3 || /\b(daughter|son|kid|kids|children|school|teacher|parent|mom|dad)\b/.test(combined)) {
      resolvedPillar = 'Children & Loved Ones';
    } else if (priority_id === 4 || /\b(water|hydrat|vitamin|medication|prescription|doctor|dentist|workout|gym|walk|run|stretch|sleep|exercise)\b/.test(combined)) {
      resolvedPillar = 'Health & Self';
    } else {
      resolvedPillar = 'Work & Mastery';
    }
  }

  // 2. Determine Execution Priority (1 = Must Happen Today, 2 = High-Impact Focus, 3 = Daily Habits, 4 = Backlog)
  let resolvedExec = execution_priority ? Number(execution_priority) : null;
  if (!resolvedExec || resolvedExec < 1 || resolvedExec > 4) {
    const isUrgentOrDeadline =
      /\b(urgent|asap|must|critical|emergency|immediately|deadline|due today|overdue|shutoff)\b/.test(combined) ||
      /\b(before|by|at)\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/.test(combined) ||
      /\b(pay|bill|invoice|mortgage|rent|tax|taxes|prescription|dentist|doctor|appointment|reservation hold)\b/.test(combined) ||
      combined.includes('[email action]') ||
      combined.includes('[urgent]');

    const isBacklog = /\b(backlog|someday|eventually|when time permits|maybe later|low priority|nice to have)\b/.test(combined);

    if (isUrgentOrDeadline && !recurring) {
      resolvedExec = 1; // 🚨 Must Happen Today — Deadlines & Provision
    } else if (recurring) {
      resolvedExec = 3; // 🌱 Daily Habits & Anchors
    } else if (isBacklog) {
      resolvedExec = 4; // 📥 Backlog — When Time Permits
    } else {
      resolvedExec = 2; // ⚡ High-Impact Focus
    }
  }

  return {
    execution_priority: resolvedExec,
    pillar: resolvedPillar
  };
}

export function normalizeChecklistItems(itemsOrText) {
  if (!itemsOrText) return [];
  let rawList = [];
  if (Array.isArray(itemsOrText)) {
    rawList = itemsOrText.map(x => String(x || '').trim()).filter(Boolean);
  } else if (typeof itemsOrText === 'string') {
    const trimmed = itemsOrText.trim();
    if (!trimmed) return [];
    if (/[\n;]/.test(trimmed)) {
      rawList = trimmed.split(/[\n;]+/).map(s => s.trim()).filter(Boolean);
    } else if (trimmed.includes(',')) {
      rawList = trimmed.split(/\s*,\s*(?:and\s+)?/i).map(s => s.trim()).filter(Boolean);
    } else if (/\s+and\s+/i.test(trimmed) && trimmed.split(/\s+/).length >= 4) {
      rawList = trimmed.split(/\s+and\s+/i).map(s => s.trim()).filter(Boolean);
    } else {
      rawList = [trimmed];
    }
  }

  return rawList
    .map(line => {
      const checkedMatch = line.match(/^[-*•]?\s*\[([xX])\]\s*(.+)$/);
      const isChecked = Boolean(checkedMatch);
      const clean = (checkedMatch ? checkedMatch[2] : line)
        .replace(/^[-*•]\s*(?:\[\s*\]\s*)?/, '')
        .replace(/^\d+[.)]\s*/, '')
        .replace(/^["']|["']$/g, '')
        .trim();
      if (!clean) return null;
      const capitalized = clean.charAt(0).toUpperCase() + clean.slice(1);
      return `- [${isChecked ? 'x' : ' '}] ${capitalized}`;
    })
    .filter(Boolean);
}

export function parseTaskChecklist(notes) {
  if (!notes || typeof notes !== 'string') return [];
  const lines = notes.split('\n').map(l => l.trim()).filter(Boolean);
  const items = [];
  lines.forEach((line, idx) => {
    const boxMatch = line.match(/^[-*•]?\s*\[([ xX])\]\s+(.+)$/);
    if (boxMatch) {
      items.push({
        index: idx,
        text: boxMatch[2].trim(),
        checked: boxMatch[1].toLowerCase() === 'x'
      });
    } else if (/^[-*•]\s+(.+)$/.test(line)) {
      items.push({
        index: idx,
        text: line.replace(/^[-*•]\s+/, '').trim(),
        checked: false
      });
    }
  });
  return items;
}

export function enrichTaskWithDualAxis(row) {
  if (!row) return null;
  const inferred = inferExecutionPriorityAndPillar(row);
  const execLevel = row.execution_priority || inferred.execution_priority || 2;
  const lane = EXECUTION_LANES.find(l => l.level === execLevel) || EXECUTION_LANES[1];
  const pillarName = row.pillar || inferred.pillar || row.priority_name || 'Work & Mastery';
  const pillarMeta = LIFE_PILLARS.find(
    p => p.name.toLowerCase() === pillarName.toLowerCase() || p.key === pillarName.toLowerCase()
  ) || {
    key: 'work',
    name: row.priority_name || pillarName,
    emoji: row.priority_emoji || '🔧',
    color: row.priority_color || '#60a5fa'
  };

  let laneReason = 'Key daily focus';
  if (execLevel === 1) {
    laneReason = 'Urgent deadline or household provision — ranked above daily habits';
  } else if (execLevel === 3 || row.recurring) {
    laneReason = 'Recurring daily grounding habit — never buries urgent deadlines';
  } else if (execLevel === 4) {
    laneReason = 'Backlog — tackle when time permits';
  }

  return {
    ...row,
    execution_priority: execLevel,
    execution_lane_key: lane.key,
    execution_lane_name: lane.name,
    execution_lane_short: lane.shortName,
    execution_lane_emoji: lane.emoji,
    execution_lane_color: lane.color,
    lane_reason: laneReason,
    pillar: pillarMeta.name,
    pillar_emoji: pillarMeta.emoji,
    pillar_color: pillarMeta.color,
    checklist: parseTaskChecklist(row.notes)
  };
}

export function today() {
  return new Date().toISOString().split('T')[0];
}

const seededDatesCache = new Set();

export function initCompanionDb(customPath = null) {
  if (db) return db;
  seededDatesCache.clear();

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

  // Safe idempotent migration for existing databases created prior to Dual-Axis Priority upgrade
  const cols = db.prepare("PRAGMA table_info('tasks')").all().map(c => c.name);
  if (!cols.includes('execution_priority')) {
    db.exec('ALTER TABLE tasks ADD COLUMN execution_priority INTEGER NOT NULL DEFAULT 2');
    db.exec('UPDATE tasks SET execution_priority = 3 WHERE recurring = 1');
  }
  if (!cols.includes('pillar')) {
    db.exec('ALTER TABLE tasks ADD COLUMN pillar TEXT');
  }

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
      'INSERT INTO tasks (priority_id, execution_priority, pillar, title, recurring, date) VALUES (?, 3, ?, ?, 1, ?)'
    );
    insertTask.run(1, 'Core Values & Faith', 'Morning gratitude & prayer', dateToday);
    insertTask.run(2, 'Family & Partner', 'Check in with partner', dateToday);
    insertTask.run(4, 'Health & Self', 'Hydrate & morning movement', dateToday);
    insertTask.run(5, 'Work & Mastery', 'Review top priority for today', dateToday);
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
  if (seededDatesCache.has(targetDate)) return 0;

  const database = getDb();
  const seedKey = `recurring_seeded_${targetDate}`;

  const alreadySeeded = database.prepare('SELECT value FROM config WHERE key = ?').get(seedKey);
  if (alreadySeeded) {
    seededDatesCache.add(targetDate);
    return 0;
  }

  const recurringTemplates = database.prepare(`
    SELECT priority_id, pillar, title, notes, energy_level
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
      INSERT INTO tasks (priority_id, execution_priority, pillar, title, notes, recurring, energy_level, date)
      VALUES (?, 3, ?, ?, ?, 1, ?, ?)
    `);
    for (const tmpl of recurringTemplates) {
      const norm = tmpl.title.toLowerCase().trim();
      if (!existingTitles.has(norm)) {
        const inferred = inferExecutionPriorityAndPillar({ ...tmpl, recurring: 1 });
        insertStmt.run(
          tmpl.priority_id,
          tmpl.pillar || inferred.pillar,
          tmpl.title,
          tmpl.notes || null,
          tmpl.energy_level || 'medium',
          targetDate
        );
        existingTitles.add(norm);
        inserted++;
      }
    }
    database.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(seedKey, new Date().toISOString());
  });

  tx();
  seededDatesCache.add(targetDate);
  return inserted;
}

export function getTasksForDate(date) {
  const targetDate = date || today();
  ensureRecurringTasksForDate(targetDate);
  const rows = getDb().prepare(`
    SELECT t.*, p.name as priority_name, p.emoji as priority_emoji, p.color as priority_color, p.tier
    FROM tasks t
    JOIN priorities p ON t.priority_id = p.id
    WHERE t.date = ?
    ORDER BY t.completed ASC, COALESCE(t.execution_priority, 2) ASC, p.tier ASC, t.id ASC
  `).all(targetDate);
  return rows.map(enrichTaskWithDualAxis);
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
      `).all(...rolledIds).map(enrichTaskWithDualAxis)
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

  // 0. Conversational pronoun / recent task reference ("that task", "my task", "the task", "it", "last task")
  if (/^(?:that|this|my|the|last|latest|recent|new)\s*task$|^it$/i.test(norm)) {
    const nonRecurring = candidates.filter(t => !t.recurring);
    const pool = nonRecurring.length > 0 ? nonRecurring : candidates;
    return [...pool].sort((a, b) => b.id - a.id)[0] || null;
  }

  const strippedNorm = norm
    .replace(/^(?:my|the|a|an|task)\s+/i, '')
    .replace(/\s+(?:task|on\s+my\s+list|in\s+my\s+list|on\s+the\s+board)$/i, '')
    .trim() || norm;

  // 1. Exact title match
  const exact = candidates.find(
    t => t.title.toLowerCase().trim() === norm || t.title.toLowerCase().trim() === strippedNorm
  );
  if (exact) return exact;

  // 2. Substring match (task title contains query or query contains task title)
  const sub = candidates.find(
    t =>
      t.title.toLowerCase().includes(strippedNorm) ||
      (strippedNorm.length >= 4 && strippedNorm.includes(t.title.toLowerCase()))
  );
  if (sub) return sub;

  // 3. Token overlap match
  const stopWords = new Set(['task', 'list', 'the', 'and', 'for', 'with', 'from', 'that', 'this']);
  const queryWords = strippedNorm.split(/\s+/).filter(w => w.length >= 3 && !stopWords.has(w));
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

export function createTask({
  title,
  priority_id = 5,
  execution_priority = null,
  pillar = null,
  notes = null,
  items = null,
  recurring = 0,
  energy_level = 'medium',
  date = null
}) {
  const targetDate = date || today();
  ensureRecurringTasksForDate(targetDate);
  const formattedItems = items ? normalizeChecklistItems(items).join('\n') : null;
  const finalNotes = [notes, formattedItems].filter(Boolean).join('\n') || null;
  const inferred = inferExecutionPriorityAndPillar({
    title,
    notes: finalNotes,
    recurring,
    priority_id,
    execution_priority,
    pillar
  });
  const stmt = getDb().prepare(`
    INSERT INTO tasks (priority_id, execution_priority, pillar, title, notes, recurring, energy_level, date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    priority_id,
    inferred.execution_priority,
    inferred.pillar,
    title,
    finalNotes,
    recurring ? 1 : 0,
    energy_level,
    targetDate
  );
  const row = getDb().prepare(`
    SELECT t.*, p.name as priority_name, p.emoji as priority_emoji, p.color as priority_color, p.tier
    FROM tasks t
    JOIN priorities p ON t.priority_id = p.id
    WHERE t.id = ?
  `).get(info.lastInsertRowid);
  return enrichTaskWithDualAxis(row);
}

export function addListToTask(id, { items = null, notes = null, append = true } = {}) {
  const database = getDb();
  const existing = database.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!existing) return null;

  const newChecklistLines = normalizeChecklistItems(items ?? notes);
  let nextNotes = existing.notes || '';

  if (newChecklistLines.length > 0) {
    if (append && nextNotes.trim()) {
      const existingLines = nextNotes.split('\n').map(l => l.trim()).filter(Boolean);
      const existingNormSet = new Set(
        existingLines.map(l => l.replace(/^[-*•]?\s*\[[ xX]\]\s*/, '').toLowerCase().trim())
      );
      for (const line of newChecklistLines) {
        const cleanItem = line.replace(/^[-*•]?\s*\[[ xX]\]\s*/, '').toLowerCase().trim();
        if (!existingNormSet.has(cleanItem)) {
          existingLines.push(line);
          existingNormSet.add(cleanItem);
        }
      }
      nextNotes = existingLines.join('\n');
    } else {
      nextNotes = newChecklistLines.join('\n');
    }
  } else if (notes !== null) {
    nextNotes = append && nextNotes.trim() ? `${nextNotes.trim()}\n${String(notes).trim()}` : String(notes).trim();
  }

  database.prepare('UPDATE tasks SET notes = ? WHERE id = ?').run(nextNotes || null, id);

  const row = database.prepare(`
    SELECT t.*, p.name as priority_name, p.emoji as priority_emoji, p.color as priority_color, p.tier
    FROM tasks t
    JOIN priorities p ON t.priority_id = p.id
    WHERE t.id = ?
  `).get(id);
  return enrichTaskWithDualAxis(row);
}

export function toggleTaskChecklistItem(id, itemIndex = 0) {
  const database = getDb();
  const existing = database.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!existing || !existing.notes) return null;

  const lines = existing.notes.split('\n').map(l => l.trim()).filter(Boolean);
  const idx = Number(itemIndex);
  if (isNaN(idx) || idx < 0 || idx >= lines.length) return null;

  const line = lines[idx];
  const boxMatch = line.match(/^([-*•]?\s*)\[([ xX])\]\s+(.+)$/);
  if (boxMatch) {
    const nextCheck = boxMatch[2].toLowerCase() === 'x' ? ' ' : 'x';
    lines[idx] = `- [${nextCheck}] ${boxMatch[3]}`;
  } else {
    lines[idx] = `- [x] ${line.replace(/^[-*•]\s+/, '')}`;
  }

  database.prepare('UPDATE tasks SET notes = ? WHERE id = ?').run(lines.join('\n'), id);

  const row = database.prepare(`
    SELECT t.*, p.name as priority_name, p.emoji as priority_emoji, p.color as priority_color, p.tier
    FROM tasks t
    JOIN priorities p ON t.priority_id = p.id
    WHERE t.id = ?
  `).get(id);
  return enrichTaskWithDualAxis(row);
}

export function findTaskChecklistItemByQuery(query, date = null) {
  const norm = String(query || '').toLowerCase().replace(/^["']|["']$/g, '').trim();
  if (!norm) return null;
  const tasks = getTasksForDate(date || today()).filter(t => !t.completed && Array.isArray(t.checklist) && t.checklist.length > 0);
  for (const t of tasks) {
    const match = t.checklist.find(
      item => !item.checked && (item.text.toLowerCase().includes(norm) || norm.includes(item.text.toLowerCase()))
    );
    if (match) {
      return { task: t, item: match };
    }
  }
  return null;
}

export function updateTaskPriority(id, { execution_priority = null, priority_id = null, pillar = null } = {}) {
  const database = getDb();
  const existing = database.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!existing) return null;

  const nextExec = execution_priority !== null ? Math.min(4, Math.max(1, Number(execution_priority))) : existing.execution_priority;
  const nextPriId = priority_id !== null ? Number(priority_id) : existing.priority_id;
  const nextPillar = pillar !== null ? String(pillar) : existing.pillar;

  database.prepare(`
    UPDATE tasks
    SET execution_priority = ?, priority_id = ?, pillar = ?
    WHERE id = ?
  `).run(nextExec, nextPriId, nextPillar, id);

  const row = database.prepare(`
    SELECT t.*, p.name as priority_name, p.emoji as priority_emoji, p.color as priority_color, p.tier
    FROM tasks t
    JOIN priorities p ON t.priority_id = p.id
    WHERE t.id = ?
  `).get(id);
  return enrichTaskWithDualAxis(row);
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

  const row = getDb().prepare(`
    SELECT t.*, p.name as priority_name, p.emoji as priority_emoji, p.color as priority_color, p.tier
    FROM tasks t
    JOIN priorities p ON t.priority_id = p.id
    WHERE t.id = ?
  `).get(id);
  return enrichTaskWithDualAxis(row);
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
  const current = new Date(today() + 'T00:00:00Z');
  for (const row of rows) {
    const rowDate = new Date(row.date + 'T00:00:00Z');
    const diffDays = Math.round((current - rowDate) / (1000 * 60 * 60 * 24));
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

export function getDialogueHistory(sessionId, limit = 100) {
  return getDb().prepare(`
    SELECT * FROM (
      SELECT * FROM companion_dialogue
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ?
    )
    ORDER BY id ASC
  `).all(sessionId, limit);
}

export function listDialogueSessions(limit = 30) {
  const database = getDb();
  const rows = database.prepare(`
    SELECT
      session_id as sessionId,
      COUNT(*) as messageCount,
      MIN(created_at) as createdAt,
      MAX(created_at) as updatedAt,
      (
        SELECT content FROM companion_dialogue d2
        WHERE d2.session_id = companion_dialogue.session_id AND d2.role = 'user'
        ORDER BY d2.id DESC LIMIT 1
      ) as firstUserMessage,
      (
        SELECT content FROM companion_dialogue d3
        WHERE d3.session_id = companion_dialogue.session_id
        ORDER BY d3.id DESC LIMIT 1
      ) as lastMessage
    FROM companion_dialogue
    GROUP BY session_id
    ORDER BY MAX(id) DESC
    LIMIT ?
  `).all(limit);

  return rows.map((r) => {
    const rawTitle = String(r.firstUserMessage || r.lastMessage || 'Conversation')
      .replace(/^Add task:\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const title = rawTitle.length > 38 ? `${rawTitle.slice(0, 38)}…` : (rawTitle || 'New Chat');
    return {
      sessionId: r.sessionId,
      title,
      messageCount: r.messageCount,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lastPreview: String(r.lastMessage || '').replace(/\*\*|\`/g, '').slice(0, 60)
    };
  });
}

export function deleteDialogueSession(sessionId) {
  return getDb().prepare('DELETE FROM companion_dialogue WHERE session_id = ?').run(sessionId);
}

// ── Weekly Review & Bulk Actions ───────────────────────────────────────────
export function getWeeklyReviewSummary(endDate = null) {
  const targetEnd = endDate || today();
  const rows = getDb().prepare(`
    SELECT t.*, p.tier, p.name as priority_name, p.emoji as priority_emoji, p.color as priority_color
    FROM tasks t
    LEFT JOIN priorities p ON t.priority_id = p.id
    WHERE t.date <= ? AND t.date >= date(?, '-6 days')
    ORDER BY t.date DESC, t.execution_priority ASC, t.id ASC
  `).all(targetEnd, targetEnd);

  const enriched = rows.map(enrichTaskWithDualAxis);
  const totalTasks = enriched.length;
  const completedTasks = enriched.filter(t => t.completed).length;
  const unfinishedRolloverCandidates = enriched.filter(t => !t.completed && !t.recurring && t.date < targetEnd).length;

  const byPillar = LIFE_PILLARS.map(p => {
    const pTasks = enriched.filter(t => t.pillar === p.name);
    const done = pTasks.filter(t => t.completed).length;
    const pct = pTasks.length > 0 ? Math.round((done / pTasks.length) * 100) : 0;
    return {
      key: p.key,
      name: p.name,
      emoji: p.emoji,
      color: p.color,
      total: pTasks.length,
      completed: done,
      completionRate: pct,
      completionPct: pct
    };
  });

  const byLane = EXECUTION_LANES.map(l => {
    const lTasks = enriched.filter(t => t.execution_priority === l.level);
    const done = lTasks.filter(t => t.completed).length;
    return {
      level: l.level,
      shortName: l.shortName,
      emoji: l.emoji,
      color: l.color,
      total: lTasks.length,
      completed: done
    };
  });

  const neglectedPillars = byPillar.filter(p => p.total === 0).map(p => p.name);
  const startRow = getDb().prepare(`SELECT date(?, '-6 days') as start_date`).get(targetEnd);

  return {
    windowStart: startRow?.start_date || targetEnd,
    windowEnd: targetEnd,
    totalTasks,
    completedTasks,
    completionRate: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
    unfinishedRolloverCandidates,
    unfinishedPriorDaysCount: unfinishedRolloverCandidates,
    byPillar,
    pillarBreakdown: byPillar,
    byLane,
    neglectedPillars,
    recommendation:
      unfinishedRolloverCandidates > 0
        ? `You have ${unfinishedRolloverCandidates} unfinished task(s) from earlier this week ready to roll over.`
        : neglectedPillars.length > 0
          ? `Consider adding a small anchor task for: ${neglectedPillars.slice(0, 2).join(', ')}.`
          : 'Balanced execution across all active Life Pillars this week!'
  };
}

export function executeBulkTaskAction(actionOrObj, maybeDate = null) {
  const action = typeof actionOrObj === 'string' ? actionOrObj : actionOrObj?.action;
  const date = typeof actionOrObj === 'string' ? maybeDate : actionOrObj?.date;
  const targetDate = date || today();
  const dbConn = getDb();
  if (action === 'complete_habits') {
    const info = dbConn.prepare(`
      UPDATE tasks
      SET completed = 1, completed_at = datetime('now')
      WHERE date = ? AND completed = 0 AND (execution_priority = 3 OR recurring = 1)
    `).run(targetDate);
    return { action, affected: info.changes, updatedCount: info.changes, tasks: getTasksForDate(targetDate) };
  }
  if (action === 'clear_completed') {
    const info = dbConn.prepare(`
      DELETE FROM tasks
      WHERE date = ? AND completed = 1
    `).run(targetDate);
    return { action, affected: info.changes, deletedCount: info.changes, tasks: getTasksForDate(targetDate) };
  }
  if (action === 'rollover_all') {
    const res = rolloverUnfinishedTasks(targetDate);
    return { action, affected: res.rolledOverCount, updatedCount: res.rolledOverCount, tasks: getTasksForDate(targetDate) };
  }
  throw new Error(`Unknown bulk action: ${action}`);
}
