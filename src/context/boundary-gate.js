import { shouldActivateMemory, prunePreRetrieval } from '../toolkit/prune.js';
import { compileStateBriefing } from './memory-store.js';

const COMPANION_MEMORY_KEYWORDS = [
  'schedule', 'today', 'routine', 'habit', 'habits', 'priority', 'priorities', 'task', 'tasks', 'todo', 'plan',
  'wife', 'daughter', 'partner', 'family', 'work', 'project', 'health', 'fitness',
  'remind', 'remember', 'prefer', 'decide', 'decided', 'dinner', 'dinners', 'coffee', 'sleep', 'morning', 'evening',
  'focus', 'nudge', 'stress', 'blocker', 'blockers', 'deadline', 'deadlines', 'commitment', 'commitments',
  'coach', 'reflection', 'streak',
  'next', 'tackle', 'board', 'list', 'done', 'complete', 'finish', 'check',
  'add', 'create', 'delete', 'remove', 'rollover', 'yesterday', 'pending',
  'left', 'remaining', 'progress', 'status', 'start', 'break down', 'split', 'subtask'
];

/**
 * Evaluates whether personal working memory should be activated for a user prompt,
 * and if so, compiles and returns the state briefing.
 */
export function evaluateCompanionContext(prompt, history = []) {
  if (!prompt || typeof prompt !== 'string') {
    return {
      shouldInjectContext: false,
      contextPrompt: '',
      rationale: 'Empty prompt'
    };
  }

  // Pre-prune query to remove politeness fluff and estimate savings
  const pruned = prunePreRetrieval(prompt, history, {
    maxHistoryTurns: 5,
    stripPoliteness: true
  });

  // Evaluate memory activation
  const activation = shouldActivateMemory(pruned.query, {
    memoryTriggerKeywords: COMPANION_MEMORY_KEYWORDS
  });

  if (!activation.shouldActivate) {
    return {
      shouldInjectContext: false,
      contextPrompt: '',
      rationale: activation.rationale,
      tokensSavedEst: activation.tokensSavedEst || 600,
      cleanQuery: pruned.query
    };
  }

  const briefing = compileStateBriefing();

  return {
    shouldInjectContext: true,
    contextPrompt: briefing,
    rationale: activation.rationale,
    tokensSavedEst: 0,
    cleanQuery: pruned.query
  };
}
