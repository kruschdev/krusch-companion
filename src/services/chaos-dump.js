import { parseAIJson } from '../toolkit/json-parse.js';
import { dispatchCompanionChat, TIERS } from '../router/cascade-client.js';
import { createTask, getPriorities, today, getTasksForDate } from '../db/index.js';
import { rememberMemory } from '../context/memory-store.js';

/**
 * Deterministic voice/text segment classifier & lightweight speaker diarization post-processor.
 * Tags each clause in a voice dump as an urgent_task, habit_task, focus_task, memory_fact, or context_note.
 */
export function classifyTranscriptSegments(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  const clauses = rawText
    .split(/(?:[.!?\n]+|,\s+(?:and|also|plus|then)\s+|;\s*)/i)
    .map(s => s.trim())
    .filter(Boolean);

  return clauses.map((clause, idx) => {
    let speaker = 'User';
    let text = clause;
    const speakerMatch = clause.match(/^(Speaker\s*\d+|Me|User|Partner|Wife|Husband|Client|Boss)\s*:\s*(.+)$/i);
    if (speakerMatch) {
      speaker = speakerMatch[1].trim();
      text = speakerMatch[2].trim();
    }

    let intent = 'context_note';
    let label = '💬 Context';
    if (/\b(?:remember\s+that|we\s+decided|decided\s+to|always\s+|never\s+|requested\s+a|prefers?\s+|rule\s+is)\b/i.test(text)) {
      intent = 'memory_fact';
      label = '🧠 Working Memory Fact';
    } else if (/\b(?:before\s+\d+\s*(?:am|pm)|urgent|asap|pay\s+.*(?:bill|invoice|tax|rent|mortgage)|due\s+today|prescription|dentist|doctor)\b/i.test(text)) {
      intent = 'urgent_task';
      label = '🚨 Task (P1: Must Happen Today)';
    } else if (/\b(?:drink\s+.*water|liters?\s+of\s+water|every\s+day|daily|morning\s+gratitude|prayer|stretch|workout\s+routine)\b/i.test(text)) {
      intent = 'habit_task';
      label = '🌱 Task (P3: Daily Habit)';
    } else if (/\b(?:need\s+to|have\s+to|must\s+|call\s+|email\s+|review\s+|finish\s+|schedule\s+|pick\s+up|buy\s+|prepare\s+|draft\s+|send\s+)\b/i.test(text)) {
      intent = 'focus_task';
      label = '⚡ Task (P2: High-Impact Focus)';
    }

    return {
      index: idx + 1,
      speaker,
      intent,
      label,
      text
    };
  });
}

/**
 * Takes unformatted voice transcription or stream-of-consciousness text,
 * extracts actionable tasks with 5-tier priority assignments, identifies
 * permanent life memories/habits, and auto-persists them to SQLite.
 */
export async function processThoughtStream({
  text,
  date = null,
  autoSaveTasks = true,
  autoSaveMemories = true
}) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Thought stream text cannot be empty');
  }

  const segments = classifyTranscriptSegments(text);
  const targetDate = date || today();
  const priorities = getPriorities();
  const priorityGuide = priorities
    .map(p => `Tier ${p.tier}: ${p.name} (${p.emoji})`)
    .join('\n');

  const systemPrompt = `You are Krusch Companion's Executive Triage Engine.
Your task is to analyze an unformatted, rambling stream-of-consciousness thought stream from the user.
Extract actionable tasks using the Dual-Axis Priority Framework (Execution Priority + Life Pillar Tag), and extract any lasting life facts, habits, or commitments into working memories.

Axis 1 — Execution Priority (1 to 4, controls Today's Board order):
- 1: Must Happen Today — Deadlines & Provision (urgent bills, invoices, family provision, hard deadlines, medical/time-locked appointments)
- 2: High-Impact Focus — Move the Needle (important non-recurring projects, family commitments, or health goals)
- 3: Daily Habits & Care (recurring routines and daily habits)
- 4: Backlog — When Time Permits (low-urgency ideas or errands)

Axis 2 — Life Pillar & Tier (1 to 5, shows WHO/WHAT domain the task serves):
${priorityGuide}
(Or use pillar: "Provision & Finance" for bills, taxes, invoices, mortgage/rent, and household provision.)

Category Taxonomy for Memories:
- 'decision': Established choices or firm commitments.
- 'invariant': Non-negotiable boundaries, constraints, or health rules.
- 'bug': Friction points, habits they want to break, or personal pitfalls.
- 'lesson': Helpful insights, routines, or tactical tricks learned.
- 'blocker': Active external dependencies, emotional blockades, or stressors.

OUTPUT FORMAT:
You MUST respond with valid JSON ONLY in the following format:
{
  "tasks": [
    {
      "title": "Clean, imperative task title",
      "execution_priority": 1 to 4,
      "tier": 1 to 5,
      "pillar": "Provision & Finance" | "Work & Mastery" | "Family & Partner" | "Children & Loved Ones" | "Health & Self" | "Core Values & Faith",
      "notes": "Optional deadline, sub-detail, or null",
      "energy_level": "low" | "medium" | "high"
    }
  ],
  "memories": [
    {
      "category": "decision" | "invariant" | "bug" | "lesson" | "blocker",
      "content": "Specific fact, habit, or commitment to remember",
      "key": "optional_slug_key_or_null"
    }
  ],
  "companionNotes": "A warm, grounding 2-sentence empathetic note acknowledging their current state, reducing anxiety, and highlighting the #1 Must-Happen-Today item to tackle first."
}`;

  const userPrompt = `Here is my thought dump:\n"""\n${text.trim()}\n"""\nExtract tasks and memories in JSON now.`;

  const startTime = Date.now();
  const dispatchResult = await dispatchCompanionChat({
    prompt: userPrompt,
    systemPrompt
  });

  const parsed = parseAIJson(dispatchResult.content, { allowPartial: true });
  const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  const rawMemories = Array.isArray(parsed.memories) ? parsed.memories : [];
  const companionNotes = parsed.companionNotes || 'I have organized your dump into clear priorities.';

  // Map priorities by tier
  const tierToPriorityId = {};
  for (const p of priorities) {
    tierToPriorityId[p.tier] = p.id;
  }

  const savedTasks = [];
  if (autoSaveTasks && rawTasks.length > 0) {
    const existingToday = getTasksForDate(targetDate);
    const existingTitles = new Set(existingToday.map(et => et.title.toLowerCase().trim()));

    for (const t of rawTasks) {
      if (!t.title) continue;
      const normalizedTitle = t.title.toLowerCase().trim();
      
      // Skip if task with identical title already scheduled for this date
      if (existingTitles.has(normalizedTitle)) {
        const match = existingToday.find(et => et.title.toLowerCase().trim() === normalizedTitle);
        if (match) savedTasks.push(match);
        continue;
      }

      const priorityId = tierToPriorityId[t.tier] || tierToPriorityId[5] || 5;
      const created = createTask({
        title: t.title,
        priority_id: priorityId,
        execution_priority: t.execution_priority || null,
        pillar: t.pillar || null,
        notes: t.notes || null,
        energy_level: t.energy_level || 'medium',
        date: targetDate
      });
      existingTitles.add(normalizedTitle);
      savedTasks.push(created);
    }
  }

  const savedMemories = [];
  if (autoSaveMemories && rawMemories.length > 0) {
    for (const m of rawMemories) {
      if (m.content) {
        try {
          const saved = rememberMemory({
            category: m.category || 'decision',
            content: m.content,
            key: m.key || null
          });
          savedMemories.push(saved);
        } catch {
          // Non-fatal
        }
      }
    }
  }

  return {
    segments,
    rawTasks,
    rawMemories,
    savedTasks,
    savedMemories,
    companionNotes,
    tierUsed: dispatchResult.tierUsed,
    latencyMs: Date.now() - startTime
  };
}

export const processChaosDump = processThoughtStream;
