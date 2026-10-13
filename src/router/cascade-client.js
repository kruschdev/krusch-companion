import { classifyPreRoute, detectKnowledgeBoundary, pruneText } from 'krusch-cascade-router';
import { sanitizeAgentMessage } from '@krusch/toolkit/trajectory-guard';
import config from '../config.js';
import { rememberMemory } from '../context/memory-store.js';

export const TIERS = {
  L0_HEURISTIC: 'L0_heuristic',
  L1_EDGE: 'L1_edge',
  L2_SWARM: 'L2_swarm',
  L3_CLOUD: 'L3_cloud'
};

/**
 * Completely safe AST recursive-descent arithmetic evaluator.
 * Eliminates eval() and Function() code execution risks entirely.
 */
export function safeEvaluateArithmetic(expr) {
  if (!expr || typeof expr !== 'string') return null;

  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/\d/.test(ch) || ch === '.') {
      let numStr = '';
      while (i < expr.length && (/[\d.]/.test(expr[i]))) {
        numStr += expr[i];
        i++;
      }
      const num = parseFloat(numStr);
      if (isNaN(num)) return null;
      tokens.push({ type: 'NUM', value: num });
      continue;
    }
    if ('+-*/%^()'.includes(ch)) {
      tokens.push({ type: 'OP', value: ch });
      i++;
      continue;
    }
    return null; // Invalid token
  }

  if (tokens.length === 0) return null;

  let pos = 0;
  function peek() { return tokens[pos]; }
  function consume() { return tokens[pos++]; }

  function parseExpression() {
    let left = parseTerm();
    if (left === null) return null;
    while (peek() && (peek().value === '+' || peek().value === '-')) {
      const op = consume().value;
      const right = parseTerm();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm() {
    let left = parseFactor();
    if (left === null) return null;
    while (peek() && (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
      const op = consume().value;
      const right = parseFactor();
      if (right === null) return null;
      if (op === '/') {
        if (right === 0) return null; // Safe divide-by-zero prevention
        left = left / right;
      } else if (op === '%') {
        if (right === 0) return null;
        left = left % right;
      } else {
        left = left * right;
      }
    }
    return left;
  }

  function parseFactor() {
    let left = parsePrimary();
    if (left === null) return null;
    while (peek() && peek().value === '^') {
      consume();
      const right = parseFactor();
      if (right === null) return null;
      left = Math.pow(left, right);
    }
    return left;
  }

  function parsePrimary() {
    const t = peek();
    if (!t) return null;
    if (t.type === 'OP' && t.value === '-') {
      consume();
      const val = parsePrimary();
      return val === null ? null : -val;
    }
    if (t.type === 'OP' && t.value === '+') {
      consume();
      return parsePrimary();
    }
    if (t.type === 'NUM') {
      consume();
      return t.value;
    }
    if (t.type === 'OP' && t.value === '(') {
      consume();
      const val = parseExpression();
      if (!peek() || peek().value !== ')') return null;
      consume();
      return val;
    }
    return null;
  }

  const result = parseExpression();
  if (pos !== tokens.length || result === null || !isFinite(result)) return null;
  return Math.round(result * 1000000) / 1000000;
}

/**
 * Fast-path evaluator: determines if a query can be handled directly in <15µs
 * by deterministic rules or arithmetic without LLM invocation.
 */
export function evaluateL0Heuristic(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const text = rawText.trim();

  // 1. Safe AST arithmetic: e.g. "what is 25 * 4", "calculate 120 / 4", "500 + 42", "2 ^ 8"
  const mathMatch = text.match(/^(?:what is|calculate|compute|solve)?\s*([0-9\s.+\-*/%^()]+)\??$/i);
  if (mathMatch && /[\d]/.test(mathMatch[1]) && /[+\-*/%^]/.test(mathMatch[1])) {
    const expr = mathMatch[1].trim();
    const result = safeEvaluateArithmetic(expr);
    if (typeof result === 'number' && !isNaN(result)) {
      return {
        handled: true,
        tier: TIERS.L0_HEURISTIC,
        content: `${expr} = **${result}**`,
        reason: 'L0 Heuristic: deterministic arithmetic evaluated in <15µs'
      };
    }
  }

  // 2. Direct memory note: e.g. "Remember that ...", "Note that ...", "Habit: ..."
  const memoryMatch = text.match(/^(?:remember that|note that|save note|habit:)\s+(.+)$/i);
  if (memoryMatch) {
    const memoryContent = memoryMatch[1].trim();
    try {
      const saved = rememberMemory({
        category: 'decision',
        content: memoryContent
      });
      return {
        handled: true,
        tier: TIERS.L0_HEURISTIC,
        content: `I've committed that to your sovereign working memory:\n> "${saved.content}" *(Memory #${saved.id})*`,
        reason: 'L0 Heuristic: direct working memory persistence'
      };
    } catch {
      // Fall through to LLM if error
    }
  }

  return null;
}

/**
 * Classifies prompt into appropriate execution tier using Krusch Cascade Router.
 */
export function classifyCompanionPrompt(prompt) {
  // Check L0 first
  const l0 = evaluateL0Heuristic(prompt);
  if (l0 && l0.handled) {
    return {
      tier: TIERS.L0_HEURISTIC,
      isFastPath: true,
      confidence: 'high',
      complexityScore: 0.0,
      suggestedAction: 'dispatch_specialist',
      l0Result: l0
    };
  }

  // Use krusch-cascade-router's sub-15µs classifier
  const preRoute = classifyPreRoute(prompt, {
    prunePreRouting: true,
    knowledgeBoundaryGating: true,
    lengthThreshold: 1500
  });

  let tier = TIERS.L1_EDGE;

  // Escalate to L2 if prompt has high complexity score or deep reasoning role
  if (
    preRoute.complexityScore >= 0.40 ||
    preRoute.role === 'reasoning_deep' ||
    preRoute.role === 'comprehension_rc'
  ) {
    tier = TIERS.L2_SWARM;
  }

  return {
    tier,
    isFastPath: preRoute.isFastPath,
    role: preRoute.role,
    confidence: preRoute.confidence,
    complexityScore: preRoute.complexityScore,
    suggestedAction: preRoute.suggestedAction
  };
}

/**
 * Call local Ollama chat endpoint with hardened timeout and circuit breaking.
 */
async function callOllama({ prompt, history = [], systemPrompt = '', model = null, timeoutMs = 12000 }) {
  const ollamaUrl = config.cascade.ollamaUrl;
  const targetModel = model || config.cascade.edgeModel;

  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  for (const h of history) {
    messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: 'user', content: prompt });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: targetModel,
        messages,
        stream: false,
        options: {
          temperature: 0.7
        }
      })
    });

    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    return data?.message?.content || '';
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`Ollama call timed out after ${timeoutMs}ms on model ${targetModel}`);
    }
    throw err;
  }
}

/**
 * Dispatch conversational turn through the cascade router hierarchy.
 */
export async function dispatchCompanionChat({ prompt, history = [], contextBriefing = '', systemPrompt = null }) {
  const startTime = Date.now();

  // 1. Sanitize incoming prompt for security & injection containment (arXiv: 2608.10218)
  const sanitized = sanitizeAgentMessage(prompt);
  const cleanPrompt = sanitized.sanitizedMessage || prompt;

  // 2. Check L0 heuristic
  const l0 = evaluateL0Heuristic(cleanPrompt);
  if (l0 && l0.handled) {
    return {
      content: l0.content,
      tierUsed: TIERS.L0_HEURISTIC,
      latencyMs: Date.now() - startTime,
      reason: l0.reason
    };
  }

  // 3. Classify tier
  const classification = classifyCompanionPrompt(cleanPrompt);

  const baseSystemPrompt = systemPrompt || `You are Krusch Companion, a sovereign, empathetic, and exceptionally capable personal assistant and executive partner.
You speak clearly, warmly, and constructively. You help the user manage their energy, ADHD focus, priorities, and daily tasks.
All personal data is private and sovereign. When referencing personal context, be natural and encouraging without being overly robotic.`;

  const fullSystemPrompt = contextBriefing
    ? `${baseSystemPrompt}\n\n${contextBriefing}`
    : baseSystemPrompt;

  // 4. Execution with resilient hedging
  if (classification.tier === TIERS.L2_SWARM) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);

      const res = await fetch(`${config.cascade.swarmUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: config.cascade.swarmModel,
          messages: [
            { role: 'system', content: fullSystemPrompt },
            ...history,
            { role: 'user', content: cleanPrompt }
          ],
          temperature: 0.6
        })
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        if (content) {
          return {
            content,
            tierUsed: TIERS.L2_SWARM,
            latencyMs: Date.now() - startTime,
            reason: `L2 Swarm (${config.cascade.swarmModel})`
          };
        }
      }
    } catch {
      // Fallback to local L1 edge
      console.log('⚡ L2 Swarm unreachable; gracefully falling back to local L1 Edge');
    }
  }

  // L1 Local Edge (Ollama)
  try {
    const edgeContent = await callOllama({
      prompt: cleanPrompt,
      history,
      systemPrompt: fullSystemPrompt,
      model: config.cascade.edgeModel,
      timeoutMs: 12000
    });

    return {
      content: edgeContent,
      tierUsed: TIERS.L1_EDGE,
      latencyMs: Date.now() - startTime,
      reason: `L1 Local Edge (${config.cascade.edgeModel})`
    };
  } catch (err) {
    // If edge model fails or model not found, try fallback to hermes3
    if (config.cascade.edgeModel !== 'hermes3:latest') {
      try {
        const fallbackContent = await callOllama({
          prompt: cleanPrompt,
          history,
          systemPrompt: fullSystemPrompt,
          model: 'hermes3:latest',
          timeoutMs: 12000
        });
        return {
          content: fallbackContent,
          tierUsed: TIERS.L1_EDGE,
          latencyMs: Date.now() - startTime,
          reason: 'L1 Local Edge (hermes3:latest fallback)'
        };
      } catch {
        // Fallback failed
      }
    }

    throw new Error(`Companion LLM dispatch failed: ${err.message}`);
  }
}
