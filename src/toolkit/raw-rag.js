/**
 * Standalone Source-Preserving Episodic Retrieval & Append-Only Memory Adapter (arXiv:2610.30755).
 *
 * Zero external dependencies so `krusch-companion` runs standalone in local & GitHub Actions CI.
 * Mirrors `@krusch/toolkit/raw-rag`:
 * - 256-token sliding windows with 32-token overlap (`stride = 224`) and session isolation
 * - Zero LLM ingestion calls (`llmIngestionCalls === 0`)
 * - Two-stage Top-128 feature-hashed dense recall + Top-15 cross-encoder relevance reranking
 * - Graceful 5,000-token context budget fallback (disables turn expansion before dropping chunks)
 * - Append-only `ADD` / `NONE` write normalization
 */

import crypto from 'crypto';

export const RAW_RAG_DEFAULTS = Object.freeze({
  windowTokens: 256,
  overlapTokens: 32,
  strideTokens: 224,
  denseCandidateK: 128,
  finalRerankK: 15,
  maxEvidenceTokens: 5000,
  turnExpansion: true,
  deduplicateTurns: false,
  chronologicalOrder: true,
  llmIngestionCalls: 0
});

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'had',
  'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how',
  'was', 'were', 'are', 'been', 'being', 'into', 'onto', 'upon', 'about',
  'does', 'did', 'doing', 'would', 'could', 'should', 'will', 'shall', 'may',
  'might', 'must', 'can', 'their', 'there', 'they', 'them', 'then', 'than',
  'your', 'yours', 'our', 'ours', 'his', 'her', 'hers', 'its'
]);

const VECTOR_CACHE_MAX = 512;
const vectorCache = new Map();

export function tokenizeWithOffsets(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const tokens = [];
  const pattern = /[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    tokens.push({
      token: match[0],
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return tokens;
}

export function estimateTokenCount(text) {
  return tokenizeWithOffsets(text).length;
}

export function serializeConversationTurn(turn, index = 0) {
  const safeTurn = turn && typeof turn === 'object' ? turn : { content: String(turn || '') };
  const turnId = String(safeTurn.turnId ?? safeTurn.id ?? `turn_${index}`);
  const rawDate = safeTurn.date ?? safeTurn.created_at ?? safeTurn.createdAt ?? null;
  const date = rawDate && String(rawDate).trim() ? String(rawDate).trim() : 'unknown';
  const speaker = String(safeTurn.speaker ?? safeTurn.role ?? `Speaker_${index + 1}`).trim() || `Speaker_${index + 1}`;
  const content = String(safeTurn.content ?? safeTurn.text ?? '').trim();
  const sessionKey = safeTurn.sessionKey ?? safeTurn.session_id ?? safeTurn.sessionId ?? null;
  const serialized = `[Date: ${date}] ${speaker}: ${content}`;

  return {
    turnIndex: index,
    turnId,
    date,
    speaker,
    content,
    sessionKey: sessionKey !== null && sessionKey !== undefined ? String(sessionKey) : null,
    serialized
  };
}

export function chunkConversationWindows(turns = [], options = {}) {
  if (!Array.isArray(turns) || turns.length === 0) {
    return { serializedTurns: [], windows: [], totalTokens: 0 };
  }

  const windowTokens = Math.max(
    16,
    Number.isInteger(options.windowTokens) && options.windowTokens > 0
      ? options.windowTokens
      : RAW_RAG_DEFAULTS.windowTokens
  );
  const rawOverlap = Number.isInteger(options.overlapTokens) && options.overlapTokens >= 0
    ? options.overlapTokens
    : RAW_RAG_DEFAULTS.overlapTokens;
  const overlapTokens = Math.min(rawOverlap, Math.floor(windowTokens / 2));
  const stride = Math.max(1, windowTokens - overlapTokens);
  const isolateSessions = options.isolateSessions !== false;

  const serializedTurns = turns.map((turn, idx) => serializeConversationTurn(turn, idx));

  const segments = [];
  if (!isolateSessions) {
    segments.push(serializedTurns);
  } else {
    let current = [];
    for (const sTurn of serializedTurns) {
      if (
        current.length > 0 &&
        sTurn.sessionKey !== current[current.length - 1].sessionKey &&
        (sTurn.sessionKey !== null || current[current.length - 1].sessionKey !== null)
      ) {
        segments.push(current);
        current = [sTurn];
      } else {
        current.push(sTurn);
      }
    }
    if (current.length > 0) segments.push(current);
  }

  const windows = [];
  let windowIndex = 0;
  let globalTokenOffset = 0;

  for (const segTurns of segments) {
    const pieces = [];
    const spans = [];
    let cursor = 0;

    for (let i = 0; i < segTurns.length; i++) {
      if (i > 0) {
        pieces.push('\n');
        cursor += 1;
      }
      const segText = segTurns[i].serialized;
      const startChar = cursor;
      const endChar = cursor + segText.length;
      pieces.push(segText);
      spans.push({ turnIndex: segTurns[i].turnIndex, startChar, endChar });
      cursor = endChar;
    }

    const segStream = pieces.join('');
    const segTokens = tokenizeWithOffsets(segStream);
    if (segTokens.length === 0) continue;

    for (let startTok = 0; startTok < segTokens.length; startTok += stride) {
      const endTok = Math.min(startTok + windowTokens, segTokens.length);
      const startChar = segTokens[startTok].start;
      const endChar = segTokens[endTok - 1].end;
      const text = segStream.slice(startChar, endChar);
      const contentHash = crypto.createHash('sha256').update(text).digest('hex');

      const turnIndices = [];
      for (const span of spans) {
        if (span.endChar > startChar && span.startChar < endChar) {
          turnIndices.push(span.turnIndex);
        }
      }

      windows.push({
        windowId: `dlg_win_${windowIndex}`,
        windowIndex,
        text,
        contentHash,
        startToken: globalTokenOffset + startTok,
        endToken: globalTokenOffset + endTok,
        tokenCount: endTok - startTok,
        turnIndices,
        sessionKey: segTurns[0].sessionKey
      });

      windowIndex += 1;
      if (endTok >= segTokens.length) break;
    }

    globalTokenOffset += segTokens.length;
  }

  return { serializedTurns, windows, totalTokens: globalTokenOffset };
}

function projectFeature(acc, feature, weight) {
  const digest = crypto.createHash('sha256').update(feature).digest();
  const dim = acc.length;
  for (let p = 0; p < 4; p++) {
    const off = p * 5;
    const slot = digest.readUInt32BE(off) % dim;
    const sign = (digest[off + 4] & 1) === 0 ? 1 : -1;
    acc[slot] += sign * weight;
  }
}

export function computeFeatureVector(text, contentHash = null, dim = 512) {
  const key = contentHash || crypto.createHash('sha256').update(String(text || '')).digest('hex');
  if (vectorCache.has(key)) {
    const cached = vectorCache.get(key);
    vectorCache.delete(key);
    vectorCache.set(key, cached);
    return cached;
  }

  const acc = new Float64Array(dim);
  const tokens = (String(text || '').toLowerCase().match(/[a-z0-9_]+/g) || [])
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));

  for (let i = 0; i < tokens.length; i++) {
    projectFeature(acc, `u:${tokens[i]}`, 1.0);
    if (i + 1 < tokens.length) {
      projectFeature(acc, `b:${tokens[i]}_${tokens[i + 1]}`, 1.15);
    }
  }

  let normSq = 0;
  for (let i = 0; i < dim; i++) normSq += acc[i] * acc[i];
  const norm = Math.sqrt(normSq);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) acc[i] /= norm;
  }

  if (vectorCache.size >= VECTOR_CACHE_MAX) {
    const oldest = vectorCache.keys().next().value;
    vectorCache.delete(oldest);
  }
  vectorCache.set(key, acc);
  return acc;
}

export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
  }
  return Number.isFinite(dot) ? dot : 0;
}

export function scoreDeterministicCrossEncoder(query, passage, denseScore = 0) {
  const qTokens = (String(query || '').toLowerCase().match(/[a-z0-9_]+/g) || [])
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
  const pLower = String(passage || '').toLowerCase();
  const pTokens = pLower.match(/[a-z0-9_]+/g) || [];
  const pSet = new Set(pTokens);

  if (qTokens.length === 0) return Math.max(0, Math.min(1, Number(denseScore) || 0));

  let weightedHits = 0;
  let totalWeight = 0;
  for (const tok of qTokens) {
    const isSpecific = /\d|_/.test(tok) || tok.length >= 7;
    const w = isSpecific ? 1.8 : 1.0;
    totalWeight += w;
    if (pSet.has(tok)) weightedHits += w;
  }
  const lexicalRecall = totalWeight > 0 ? weightedHits / totalWeight : 0;

  let bigramHits = 0;
  const totalBigrams = Math.max(0, qTokens.length - 1);
  if (totalBigrams > 0) {
    const pBigrams = new Set();
    for (let i = 0; i + 1 < pTokens.length; i++) {
      if (!STOPWORDS.has(pTokens[i]) && !STOPWORDS.has(pTokens[i + 1])) {
        pBigrams.add(`${pTokens[i]}_${pTokens[i + 1]}`);
      }
    }
    for (let i = 0; i < totalBigrams; i++) {
      if (pBigrams.has(`${qTokens[i]}_${qTokens[i + 1]}`)) bigramHits += 1;
    }
  }
  const bigramScore = totalBigrams > 0 ? bigramHits / totalBigrams : 0;
  const clampedDense = Math.max(0, Math.min(1, Number(denseScore) || 0));

  return Number(Math.max(0, Math.min(1, 0.52 * lexicalRecall + 0.23 * bigramScore + 0.25 * clampedDense)).toFixed(6));
}

export function rerankCandidateWindowsSync(query, candidates = [], topK = RAW_RAG_DEFAULTS.finalRerankK) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const scored = candidates.map(cand => {
    const denseScore = Number(cand.denseScore || 0);
    return {
      ...cand,
      denseScore,
      rerankScore: scoreDeterministicCrossEncoder(query, cand.text, denseScore)
    };
  });
  scored.sort((a, b) => {
    if (b.rerankScore !== a.rerankScore) return b.rerankScore - a.rerankScore;
    if (b.denseScore !== a.denseScore) return b.denseScore - a.denseScore;
    return (a.windowIndex ?? 0) - (b.windowIndex ?? 0);
  });
  return scored.slice(0, Math.max(1, topK));
}

export function assembleReaderEvidence(selectedWindows = [], turns = [], options = {}) {
  if (!Array.isArray(selectedWindows) || selectedWindows.length === 0) {
    return {
      contextText: '',
      entries: [],
      tokenCount: 0,
      selectedWindowCount: 0,
      retainedEntryCount: 0,
      turnExpansionApplied: false,
      budgetPolicyTriggered: 'NONE'
    };
  }

  const maxEvidenceTokens = Math.max(32, Number(options.maxEvidenceTokens) || RAW_RAG_DEFAULTS.maxEvidenceTokens);
  const wantTurnExpansion = options.turnExpansion !== undefined ? Boolean(options.turnExpansion) : true;
  const chronologicalOrder = options.chronologicalOrder !== undefined ? Boolean(options.chronologicalOrder) : true;

  const normalizedTurns = Array.isArray(turns) && turns.length > 0
    ? turns.map((t, idx) => (t && typeof t.serialized === 'string' ? t : serializeConversationTurn(t, idx)))
    : [];

  const sumTokens = list => list.reduce((acc, e) => acc + e.tokenCount, 0);

  if (wantTurnExpansion && normalizedTurns.length > 0) {
    const orderedWins = chronologicalOrder
      ? [...selectedWindows].sort((a, b) => (a.windowIndex ?? 0) - (b.windowIndex ?? 0))
      : [...selectedWindows];

    const expanded = orderedWins.map((win, idx) => {
      const validIndices = (win.turnIndices || []).filter(i => Boolean(normalizedTurns[i]));
      const text = validIndices.length > 0
        ? validIndices.map(i => normalizedTurns[i].serialized).join('\n')
        : win.text;
      return {
        entryId: win.windowId || `win_${idx}`,
        sourceType: validIndices.length > 0 ? 'expanded_window_turns' : 'raw_window',
        orderKey: win.windowIndex ?? idx,
        text,
        tokenCount: estimateTokenCount(text)
      };
    });

    const expandedTokens = sumTokens(expanded);
    if (expandedTokens <= maxEvidenceTokens) {
      return {
        contextText: expanded.map(e => e.text).join('\n\n'),
        entries: expanded,
        tokenCount: expandedTokens,
        selectedWindowCount: selectedWindows.length,
        retainedEntryCount: expanded.length,
        turnExpansionApplied: true,
        budgetPolicyTriggered: 'NONE'
      };
    }
  }

  const unexpandedByRank = selectedWindows.map((win, idx) => ({
    entryId: win.windowId || `win_${idx}`,
    sourceType: 'raw_window',
    orderKey: win.windowIndex ?? idx,
    text: win.text,
    tokenCount: win.tokenCount > 0 ? win.tokenCount : estimateTokenCount(win.text)
  }));
  const unexpandedTokens = sumTokens(unexpandedByRank);
  const disabledExpansion = wantTurnExpansion && normalizedTurns.length > 0;

  if (unexpandedTokens <= maxEvidenceTokens) {
    const ordered = chronologicalOrder
      ? [...unexpandedByRank].sort((a, b) => a.orderKey - b.orderKey)
      : unexpandedByRank;
    return {
      contextText: ordered.map(e => e.text).join('\n\n'),
      entries: ordered,
      tokenCount: unexpandedTokens,
      selectedWindowCount: selectedWindows.length,
      retainedEntryCount: ordered.length,
      turnExpansionApplied: false,
      budgetPolicyTriggered: disabledExpansion ? 'DISABLED_TURN_EXPANSION' : 'NONE'
    };
  }

  const packed = [];
  let running = 0;
  for (const entry of unexpandedByRank) {
    if (packed.length > 0 && running + entry.tokenCount > maxEvidenceTokens) break;
    packed.push(entry);
    running += entry.tokenCount;
    if (running >= maxEvidenceTokens) break;
  }

  const finalEntries = chronologicalOrder ? [...packed].sort((a, b) => a.orderKey - b.orderKey) : packed;
  return {
    contextText: finalEntries.map(e => e.text).join('\n\n'),
    entries: finalEntries,
    tokenCount: running,
    selectedWindowCount: selectedWindows.length,
    retainedEntryCount: finalEntries.length,
    turnExpansionApplied: false,
    budgetPolicyTriggered: 'PREFIX_COMPLETE_WINDOWS'
  };
}

export function normalizeAppendOnlyWriteOp(proposal = {}, existingRecords = [], options = {}) {
  const rawAction = String(proposal.action || 'NONE').trim().toUpperCase();
  const text = String(proposal.text ?? proposal.content ?? '').trim();
  const targetId = proposal.targetId !== undefined && proposal.targetId !== null
    ? String(proposal.targetId)
    : (proposal.id !== undefined && proposal.id !== null && rawAction !== 'ADD' ? String(proposal.id) : null);
  const active = Array.isArray(existingRecords) ? existingRecords.filter(r => r && r.is_active !== 0 && !r.deleted) : [];

  if (rawAction === 'DELETE') {
    const matched = targetId ? active.find(r => String(r.id) === targetId) : null;
    if (!matched) {
      return { action: 'NONE', originalAction: 'DELETE', effectiveWrite: false, supersedesId: null, targetId, text: '', reason: 'MALFORMED_TARGET_ID' };
    }
    if (options.explicitComplianceErase === true) {
      return { action: 'COMPLIANCE_TOMBSTONE', originalAction: 'DELETE', effectiveWrite: true, supersedesId: null, targetId, text: '', reason: 'EXPLICIT_COMPLIANCE_ERASE' };
    }
    return { action: 'NONE', originalAction: 'DELETE', effectiveWrite: false, supersedesId: null, targetId, text: '', reason: 'DESTRUCTIVE_DELETE_BLOCKED' };
  }

  if (rawAction === 'NONE') {
    return { action: 'NONE', originalAction: 'NONE', effectiveWrite: false, supersedesId: null, targetId, text, reason: 'EXPLICIT_NOOP' };
  }

  if (!text) {
    return { action: 'NONE', originalAction: rawAction, effectiveWrite: false, supersedesId: null, targetId, text: '', reason: 'EMPTY_CONTENT' };
  }

  const normText = text.toLowerCase().replace(/\s+/g, ' ');
  const dup = active.find(r => String(r.content ?? r.text ?? '').trim().toLowerCase().replace(/\s+/g, ' ') === normText);
  if (dup) {
    return { action: 'NONE', originalAction: rawAction, effectiveWrite: false, supersedesId: null, targetId: String(dup.id), text, reason: 'NOOP_IDENTICAL_TEXT' };
  }

  if (rawAction === 'UPDATE') {
    const matched = targetId ? active.find(r => String(r.id) === targetId) : null;
    if (!matched) {
      return { action: 'ADD', originalAction: 'UPDATE', effectiveWrite: true, supersedesId: null, targetId, text, reason: 'UPDATE_MISSING_TARGET_CONVERTED_TO_ADD' };
    }
    return { action: 'ADD', originalAction: 'UPDATE', effectiveWrite: true, supersedesId: String(matched.id), targetId: String(matched.id), text, reason: 'APPEND_ONLY_SUPERSEDE' };
  }

  return { action: 'ADD', originalAction: rawAction, effectiveWrite: true, supersedesId: null, targetId: null, text, reason: 'APPEND_ONLY_ADD' };
}
