import fs from 'fs';
import path from 'path';
import { getDb, getTasksForDate, getStreak, getDailyFocus, today } from '../db/index.js';

export const VALID_CATEGORIES = ['decision', 'invariant', 'bug', 'lesson', 'blocker'];

/**
 * Persist a new working memory or steering nugget into local storage with deduplication.
 */
export function rememberMemory({ category = 'lesson', content, key = null, confidence = 1.0 }) {
  if (!VALID_CATEGORIES.includes(category)) {
    throw new Error(`Invalid category "${category}". Must be one of: ${VALID_CATEGORIES.join(', ')}`);
  }
  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('Memory content cannot be empty');
  }

  const db = getDb();
  const trimmed = content.trim();

  // If a key is provided, check if an active record already exists with that key
  if (key) {
    const existing = db.prepare(`
      SELECT id FROM companion_context WHERE key = ? AND is_active = 1
    `).get(key);

    if (existing) {
      return supersedeMemory({
        targetId: existing.id,
        newContent: trimmed,
        reason: `Updated key "${key}"`
      });
    }
  }

  // Deduplication: prevent near-duplicate active memory inserts
  const duplicate = db.prepare(`
    SELECT * FROM companion_context 
    WHERE is_active = 1 AND lower(trim(content)) = lower(?)
  `).get(trimmed);

  if (duplicate) {
    db.prepare(`UPDATE companion_context SET updated_at = datetime('now') WHERE id = ?`).run(duplicate.id);
    return duplicate;
  }

  const stmt = db.prepare(`
    INSERT INTO companion_context (category, content, key, is_active, confidence)
    VALUES (?, ?, ?, 1, ?)
  `);
  const info = stmt.run(category, trimmed, key, confidence);
  return db.prepare('SELECT * FROM companion_context WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * Retrieve all currently active memory nuggets, optionally filtered by category.
 */
export function getActiveMemories(category = null) {
  const db = getDb();
  if (category) {
    if (!VALID_CATEGORIES.includes(category)) {
      throw new Error(`Invalid category "${category}"`);
    }
    return db.prepare(`
      SELECT * FROM companion_context
      WHERE is_active = 1 AND category = ?
      ORDER BY id DESC
    `).all(category);
  }

  return db.prepare(`
    SELECT * FROM companion_context
    WHERE is_active = 1
    ORDER BY category ASC, id DESC
  `).all();
}

/**
 * Retrieve decay candidates (memories older than N days without refresh).
 */
export function getDecayCandidates(days = 30) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM companion_context
    WHERE is_active = 1
      AND updated_at <= datetime('now', '-' || ? || ' days')
    ORDER BY updated_at ASC
  `).all(days);
}

/**
 * Invalidate an obsolete memory or supersede it with an updated fact.
 */
export function supersedeMemory({ targetId, newContent = null, reason = 'Superseded by user update' }) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM companion_context WHERE id = ?').get(targetId);
  if (!existing) {
    throw new Error(`Memory record #${targetId} not found`);
  }

  let newId = null;

  const transaction = db.transaction(() => {
    if (newContent) {
      const insertStmt = db.prepare(`
        INSERT INTO companion_context (category, content, key, is_active, confidence)
        VALUES (?, ?, ?, 1, ?)
      `);
      const insertInfo = insertStmt.run(
        existing.category,
        newContent.trim(),
        existing.key,
        existing.confidence
      );
      newId = insertInfo.lastInsertRowid;
    }

    db.prepare(`
      UPDATE companion_context
      SET is_active = 0, superseded_by = ?, invalidation_reason = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(newId, reason, targetId);
  });

  transaction();

  return {
    invalidatedId: targetId,
    newId,
    reason
  };
}

/**
 * Safely snapshot the SQLite database using VACUUM INTO for sovereign zero-lock backups.
 */
export function createDatabaseBackup(backupDir = null) {
  const db = getDb();
  const targetDir = backupDir || path.resolve(process.cwd(), 'data', 'backups');
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(targetDir, `companion-backup-${timestamp}.db`);
  db.prepare(`VACUUM INTO ?`).run(backupFile);
  return {
    backupFile,
    timestamp,
    sizeBytes: fs.statSync(backupFile).size
  };
}

/**
 * Keyword search across memories.
 */
export function searchMemories(query) {
  if (!query || typeof query !== 'string') return [];
  const db = getDb();
  const pattern = `%${query.trim()}%`;
  return db.prepare(`
    SELECT * FROM companion_context
    WHERE content LIKE ? OR key LIKE ?
    ORDER BY is_active DESC, id DESC
  `).all(pattern, pattern);
}

/**
 * Compile active memory and live daily priority board into a structured markdown prompt briefing.
 */
export function compileStateBriefing({ maxTokens = 2500, date = null, includeTasks = true } = {}) {
  const memories = getActiveMemories();
  const targetDate = date || today();
  const tasks = includeTasks ? getTasksForDate(targetDate) : [];
  const streakInfo = includeTasks ? getStreak() : { streak: 0 };
  const dailyFocus = includeTasks ? getDailyFocus(targetDate) : null;

  if ((!memories || memories.length === 0) && (!tasks || tasks.length === 0)) {
    return 'No active personal context stored yet.';
  }

  const lines = ['# 🧠 Krusch Companion Active Working Memory\n'];

  if (includeTasks && tasks && tasks.length > 0) {
    const pending = tasks.filter(t => !t.completed);
    const completed = tasks.filter(t => t.completed);
    lines.push(`## 📋 Today's Live Priority Board (${targetDate})`);
    lines.push(`- **Progress**: ${completed.length} / ${tasks.length} tasks completed | **Current Streak**: ${streakInfo.streak} day(s)`);
    if (dailyFocus?.focus_text) {
      lines.push(`- **Morning Focus**: ${dailyFocus.focus_text}`);
    }
    if (pending.length > 0) {
      lines.push('### ⏳ Pending Tasks (Ordered by Priority Tier)');
      for (const t of pending) {
        lines.push(`- **[#${t.id}] [Tier ${t.tier}: ${t.priority_name} ${t.priority_emoji}]** ${t.title}${t.notes ? ` *(${t.notes})*` : ''} (energy: ${t.energy_level || 'medium'})`);
      }
    } else {
      lines.push('### 🎉 All scheduled tasks for today are completed!');
    }
    if (completed.length > 0) {
      lines.push('### ✅ Completed Today');
      for (const t of completed) {
        lines.push(`- ~~[#${t.id}] [Tier ${t.tier}] ${t.title}~~`);
      }
    }
    lines.push('');
  }

  if (memories && memories.length > 0) {
    const grouped = {
      invariant: [],
      decision: [],
      bug: [],      // Life habits & friction quirks
      lesson: [],
      blocker: []
    };

    for (const m of memories) {
      if (grouped[m.category]) {
        grouped[m.category].push(m);
      }
    }

    if (grouped.invariant.length > 0) {
      lines.push('## 🛡️ Core Rules & Invariants');
      for (const item of grouped.invariant) {
        lines.push(`- **#${item.id}**${item.key ? ` [${item.key}]` : ''}: ${item.content}`);
      }
      lines.push('');
    }

    if (grouped.decision.length > 0) {
      lines.push('## 🎯 Decisions & Established Preferences');
      for (const item of grouped.decision) {
        lines.push(`- **#${item.id}**${item.key ? ` [${item.key}]` : ''}: ${item.content}`);
      }
      lines.push('');
    }

    if (grouped.bug.length > 0) {
      lines.push('## ⚡ Personal Friction Points & Quirks');
      for (const item of grouped.bug) {
        lines.push(`- **#${item.id}**: ${item.content}`);
      }
      lines.push('');
    }

    if (grouped.lesson.length > 0) {
      lines.push('## 📖 Routines & Lessons Learned');
      for (const item of grouped.lesson) {
        lines.push(`- **#${item.id}**: ${item.content}`);
      }
      lines.push('');
    }

    if (grouped.blocker.length > 0) {
      lines.push('## 🚧 Active Blockers & Life Stressors');
      for (const item of grouped.blocker) {
        lines.push(`- **#${item.id}**: ${item.content}`);
      }
      lines.push('');
    }
  }

  const fullText = lines.join('\n');
  const maxChars = maxTokens * 4;
  return fullText.length > maxChars ? fullText.slice(0, maxChars) : fullText;
}
