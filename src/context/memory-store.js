import { getDb } from '../db/index.js';

export const VALID_CATEGORIES = ['decision', 'invariant', 'bug', 'lesson', 'blocker'];

/**
 * Persist a new working memory or steering nugget into local storage.
 */
export function rememberMemory({ category = 'lesson', content, key = null, confidence = 1.0 }) {
  if (!VALID_CATEGORIES.includes(category)) {
    throw new Error(`Invalid category "${category}". Must be one of: ${VALID_CATEGORIES.join(', ')}`);
  }
  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('Memory content cannot be empty');
  }

  const db = getDb();

  // If a key is provided, check if an active record already exists with that key
  if (key) {
    const existing = db.prepare(`
      SELECT id FROM companion_context WHERE key = ? AND is_active = 1
    `).get(key);

    if (existing) {
      return supersedeMemory({
        targetId: existing.id,
        newContent: content.trim(),
        reason: `Updated key "${key}"`
      });
    }
  }

  const stmt = db.prepare(`
    INSERT INTO companion_context (category, content, key, is_active, confidence)
    VALUES (?, ?, ?, 1, ?)
  `);
  const info = stmt.run(category, content.trim(), key, confidence);
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
 * Compile active memory into a structured markdown prompt briefing.
 */
export function compileStateBriefing({ maxTokens = 2500 } = {}) {
  const memories = getActiveMemories();
  if (!memories || memories.length === 0) {
    return 'No active personal context stored yet.';
  }

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

  const lines = ['# 🧠 Krusch Companion Active Working Memory\n'];

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

  return lines.join('\n');
}
