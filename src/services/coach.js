import { dispatchCompanionChat } from '../router/cascade-client.js';
import { getTasksForDate, setDailyFocus, saveDailyReflection, today } from '../db/index.js';
import { compileStateBriefing } from '../context/memory-store.js';

export async function generateDailyFocus(date = null) {
  const targetDate = date || today();
  const tasks = getTasksForDate(targetDate);
  const contextBriefing = compileStateBriefing();

  const pending = tasks.filter(t => !t.completed);
  const topTask = pending[0] || tasks[0] || null;
  const taskList = tasks
    .map(
      t =>
        `- [Execution Priority ${t.execution_priority || 2}: ${t.execution_lane_short || 'High-Impact Focus'} ${t.execution_lane_emoji || '⚡'} | Pillar: ${t.pillar || t.priority_name}] ${t.title} (${t.completed ? 'COMPLETED' : 'PENDING'})`
    )
    .join('\n');

  const systemPrompt = `You are Krusch Companion, an empathetic, supportive personal assistant and daily coach.
Given today's Dual-Axis Priority Board (sorted by Execution Priority: 1 = Must Happen Today — Deadlines & Provision, 2 = High-Impact Focus, 3 = Daily Habits & Anchors, 4 = Backlog), generate a concise, inspiring morning focus briefing (max 3-4 sentences).
Highlight the #1 Execution Priority task ("${topTask ? topTask.title : 'your top priority'}") to conquer first before non-urgent habits, and provide a grounding mindset tip.
Be warm, direct, and energizing. Avoid corporate jargon.`;

  const prompt = `Today's Dual-Axis Board (${targetDate}):\n${taskList || 'No tasks scheduled yet.'}\n\nWhat should my single focus be today?`;

  const res = await dispatchCompanionChat({
    prompt,
    contextBriefing,
    systemPrompt
  });

  const focus = setDailyFocus(targetDate, res.content);
  return {
    focusText: res.content,
    tierUsed: res.tierUsed,
    latencyMs: res.latencyMs,
    record: focus
  };
}

export async function generateDailyReflection(date = null) {
  const targetDate = date || today();
  const tasks = getTasksForDate(targetDate);
  const completed = tasks.filter(t => t.completed);
  const pending = tasks.filter(t => !t.completed);

  const systemPrompt = `You are Krusch Companion, an empathetic, non-judgmental evening coach.
Review the day's accomplishments. Celebrate what got done, normalize what didn't without guilt, and provide a calm close to the evening.
Keep it under 4 sentences.`;

  const prompt = `Day's Progress:
- Completed (${completed.length}): ${completed.map(t => t.title).join(', ') || 'None yet'}
- Remaining (${pending.length}): ${pending.map(t => t.title).join(', ') || 'None'}

Give me my evening reflection.`;

  const res = await dispatchCompanionChat({
    prompt,
    systemPrompt
  });

  const reflection = saveDailyReflection(targetDate, res.content);
  return {
    reflectionText: res.content,
    tierUsed: res.tierUsed,
    latencyMs: res.latencyMs,
    record: reflection
  };
}

export async function generateNudge(date = null) {
  const targetDate = date || today();
  const tasks = getTasksForDate(targetDate).filter(t => !t.completed);
  if (tasks.length === 0) {
    return {
      nudge: 'All tasks completed for today! Take a moment to rest and celebrate your wins.',
      tierUsed: 'L0_heuristic'
    };
  }

  const topTask = tasks[0];
  const systemPrompt = `You are Krusch Companion. Give a punchy, warm, 1-2 sentence micro-nudge to help the user build momentum and get started on their current task: "${topTask.title}". Suggest doing just 3 minutes of it to get rolling.`;

  const res = await dispatchCompanionChat({
    prompt: `Nudge me to start "${topTask.title}".`,
    systemPrompt
  });

  return {
    nudge: res.content,
    targetTask: topTask,
    tierUsed: res.tierUsed,
    latencyMs: res.latencyMs
  };
}
