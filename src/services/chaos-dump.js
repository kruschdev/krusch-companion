import { parseAIJson } from '@krusch/toolkit/json-parse';
import { dispatchCompanionChat, TIERS } from '../router/cascade-client.js';
import { createTask, getPriorities, today } from '../db/index.js';
import { rememberMemory } from '../context/memory-store.js';

/**
 * Takes unformatted voice transcription or stream-of-consciousness text,
 * extracts actionable tasks with 5-tier priority assignments, identifies
 * permanent life memories/habits, and auto-persists them to SQLite.
 */
export async function processChaosDump({
  text,
  date = null,
  autoSaveTasks = true,
  autoSaveMemories = true
}) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Chaos dump text cannot be empty');
  }

  const targetDate = date || today();
  const priorities = getPriorities();
  const priorityGuide = priorities
    .map(p => `Tier ${p.tier}: ${p.name} (${p.emoji})`)
    .join('\n');

  const systemPrompt = `You are Krusch Companion's Executive Triage Engine.
Your task is to analyze an unformatted, rambling stream-of-consciousness thought dump from the user (who may have ADHD or feel overwhelmed).
Extract actionable tasks, categorize each task into the user's 5-Tier Priority Framework, and extract any lasting life facts, habits, or decisions into memories.

User's 5-Tier Priority Framework:
${priorityGuide}

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
      "tier": 1 to 5,
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
  "companionNotes": "A warm, grounding 2-sentence empathetic note acknowledging their current state, reducing anxiety, and highlighting the #1 top-priority thing to do first."
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
    for (const t of rawTasks) {
      const priorityId = tierToPriorityId[t.tier] || tierToPriorityId[5] || 5;
      const created = createTask({
        title: t.title,
        priority_id: priorityId,
        notes: t.notes || null,
        energy_level: t.energy_level || 'medium',
        date: targetDate
      });
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
    rawTasks,
    rawMemories,
    savedTasks,
    savedMemories,
    companionNotes,
    tierUsed: dispatchResult.tierUsed,
    latencyMs: Date.now() - startTime
  };
}
