import { shouldActivateMemory, prunePreRetrieval } from '../toolkit/prune.js';
import { compileStateBriefing, retrieveEpisodicDialogue } from './memory-store.js';

const COMPANION_MEMORY_KEYWORDS = [
  'schedule', 'today', 'routine', 'habit', 'habits', 'priority', 'priorities', 'task', 'tasks', 'todo', 'plan',
  'wife', 'daughter', 'partner', 'family', 'work', 'project', 'health', 'fitness',
  'remind', 'remember', 'prefer', 'decide', 'decided', 'dinner', 'dinners', 'coffee', 'sleep', 'morning', 'evening',
  'focus', 'nudge', 'stress', 'blocker', 'blockers', 'deadline', 'deadlines', 'commitment', 'commitments',
  'coach', 'reflection', 'streak',
  'next', 'tackle', 'board', 'list', 'done', 'complete', 'finish', 'check',
  'add', 'create', 'delete', 'remove', 'rollover', 'yesterday', 'pending',
  'left', 'remaining', 'progress', 'status', 'start', 'break down', 'split', 'subtask',
  'earlier', 'previous', 'session', 'sessions', 'chat', 'chats', 'talked', 'discussed', 'mentioned', 'conversation'
];

const EPISODIC_RECALL_PATTERN =
  /\b(?:earlier|previous|last\s+(?:session|chat|week|time)|talked\s+about|discussed|mentioned|what\s+did\s+(?:i|we)\s+(?:say|decide|discuss|talk)|remember\s+when)\b/i;

/**
 * Evaluates whether personal working memory should be activated for a user prompt,
 * and if so, compiles the structured state briefing plus optional source-preserving
 * cross-session episodic dialogue evidence (`Raw-RAG`, arXiv:2610.30755).
 */
export function evaluateCompanionContext(prompt, history = [], options = {}) {
  if (!prompt || typeof prompt !== 'string') {
    return {
      shouldInjectContext: false,
      contextPrompt: '',
      rationale: 'Empty prompt',
      episodicEvidenceCount: 0
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

  if (!activation.shouldActivate && !options.includeEpisodicRag) {
    return {
      shouldInjectContext: false,
      contextPrompt: '',
      rationale: activation.rationale,
      tokensSavedEst: activation.tokensSavedEst || 600,
      cleanQuery: pruned.query,
      episodicEvidenceCount: 0
    };
  }

  const briefing = compileStateBriefing();
  const wantEpisodic = Boolean(
    options.includeEpisodicRag || EPISODIC_RECALL_PATTERN.test(pruned.query)
  );

  let episodicSection = '';
  let episodicEvidenceCount = 0;
  let episodicBudgetPolicy = 'NONE';

  if (wantEpisodic) {
    const episodic = retrieveEpisodicDialogue(pruned.query, {
      maxEvidenceTokens: options.maxEpisodicTokens || 1800,
      excludeSessionId: options.sessionId || null
    });
    if (episodic.entries.length > 0 && episodic.contextText) {
      episodicSection = `\n\n## 📜 Relevant Past Dialogue (Source-Preserving Raw-RAG)\n${episodic.contextText}`;
      episodicEvidenceCount = episodic.entries.length;
      episodicBudgetPolicy = episodic.budgetPolicyTriggered;
    }
  }

  return {
    shouldInjectContext: true,
    contextPrompt: `${briefing}${episodicSection}`,
    rationale: activation.rationale,
    tokensSavedEst: 0,
    cleanQuery: pruned.query,
    episodicEvidenceCount,
    episodicBudgetPolicy
  };
}
