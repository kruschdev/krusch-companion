/**
 * Stage-aware prompt pruning and memory activation gating utilities.
 */

export function prunePreRetrieval(prompt, history = [], options = {}) {
  if (!prompt || typeof prompt !== 'string') {
    return { query: '', strippedCount: 0, turnsRemaining: 0 };
  }
  let query = prompt.trim();
  if (options.stripPoliteness) {
    query = query.replace(/^(?:please|can you|could you|would you kindly|hey companion,?)\s*/i, '');
  }
  return { query, strippedCount: 0, turnsRemaining: history.length };
}

export function shouldActivateMemory(query, options = {}) {
  if (!query || typeof query !== 'string') {
    return { shouldActivate: false, rationale: 'Empty query' };
  }
  const lower = query.toLowerCase();
  // Pure math or closed-world code/conversion queries never require personal memory
  if (/^(?:convert|calculate|sort\s+the\s+numbers|write\s+a\s+regex|what\s+is\s+[\d\s()+*/^.-]+\??)$/i.test(lower.trim())) {
    return { shouldActivate: false, rationale: 'Closed-world utility query', tokensSavedEst: 600 };
  }
  const keywords = options.memoryTriggerKeywords || [];
  const matched = keywords.some(k => {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(lower);
  });
  if (matched) {
    return { shouldActivate: true, rationale: 'Matched companion memory trigger keywords', tokensSavedEst: 0 };
  }
  return { shouldActivate: false, rationale: 'No personal memory keywords detected', tokensSavedEst: 600 };
}
