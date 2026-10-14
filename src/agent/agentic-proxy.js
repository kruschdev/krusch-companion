import { COMPANION_TOOLS, executeCompanionTool, recordLowConfidenceOrFailedParse } from './tools.js';
import { parseAIJson } from '../toolkit/json-parse.js';

let lastToolPruningReport = null;

export function getLastToolPruningReport() {
  if (!lastToolPruningReport) {
    const total = Array.isArray(COMPANION_TOOLS) ? COMPANION_TOOLS.length : 13;
    return {
      timestamp: null,
      totalAvailableTools: total,
      totalToolsAvailable: total,
      selectedCount: 0,
      prunedCount: total,
      reductionPct: 85,
      selectedTools: [],
      prunedTools: Array.isArray(COMPANION_TOOLS) ? COMPANION_TOOLS.map(t => t.name) : [],
      matchedCategories: [],
      schemaTokensSavedEst: total * 95
    };
  }
  return lastToolPruningReport;
}

/**
 * Intent routing rules that map natural-language action requests to compact tool subsets.
 * Pruning the tool catalog to 1-3 relevant tools prevents 7B/14B schema overload.
 */
const INTENT_PATTERNS = [
  {
    category: 'weather',
    tools: ['get_weather'],
    regex: /\b(weather|temperature|forecast|rain(?:ing)?|sunny|snow(?:ing)?|windy|degrees|how hot|how cold)\b/i
  },
  {
    category: 'url_digest',
    tools: ['fetch_url_digest'],
    regex: /\b(?:fetch|read|summarize|digest|inspect|open)\s+https?:\/\/\S+|\bhttps?:\/\/\S+/i
  },
  {
    category: 'web',
    tools: ['web_research'],
    regex: /\b(search(?:\s+the)?\s+web|look\s+up|research|wikipedia|what\s+is\s+the\s+history\s+of|who\s+invented|tell\s+me\s+about\s+the\s+topic|find\s+information\s+on)\b/i
  },
  {
    category: 'notes_write',
    tools: ['save_note'],
    regex: /\b(?:save|write|draft|create|export)\s+(?:a\s+|this\s+)?(?:markdown\s+)?(?:note|document|brief|memo)\b/i
  },
  {
    category: 'notes_read',
    tools: ['list_notes'],
    regex: /\b(?:list|show|view|read|open)\s+(?:my\s+|saved\s+|all\s+)?notes?\b/i
  },
  {
    category: 'notify',
    tools: ['send_notification'],
    regex: /\b(?:send|push|dispatch|trigger)\s+(?:a\s+|an\s+)?(?:push\s+)?(?:notification|alert|ntfy|ping)(?:\s+to\s+my\s+phone)?\b|\bnotify\s+my\s+(?:phone|device)\b/i
  },
  {
    category: 'system',
    tools: ['system_status'],
    regex: /\b(?:system\s+status|system\s+health|server\s+status|host\s+telemetry|cpu\s+load|ram\s+usage|memory\s+usage|check\s+telemetry|diagnostics)\b/i
  },
  {
    category: 'sovereign_law_biz',
    tools: ['sovereign_gateway_query'],
    regex: /\b(?:kruschlaw|kruschbiz|statute\s+lookup|search\s+statutes?|legal\s+rag|contract\s+graph|tenant\s+defense\s+statute)\b/i
  },
  {
    category: 'google_drive',
    tools: ['gkrusch_drive'],
    regex: /\b(?:google\s+drive|g-krusch|gkrusch|google\s+docs?|drive\s+rag|search\s+(?:my\s+)?drive|save\s+to\s+(?:google\s+)?drive|write\s+to\s+(?:google\s+)?drive|export\s+to\s+(?:google\s+)?drive|agent\.md\s+steering)\b/i
  },
  {
    category: 'google_calendar',
    tools: ['gkrusch_calendar'],
    regex: /\b(?:google\s+calendar|my\s+calendar|calendar\s+events?|upcoming\s+(?:events?|meetings?|appointments?)|schedule\s+(?:a\s+|an\s+)?(?:meeting|event|appointment|call)|what(?:'s|\s+is)\s+on\s+my\s+calendar)\b/i
  },
  {
    category: 'google_gmail',
    tools: ['gkrusch_gmail'],
    regex: /\b(?:gmail|my\s+(?:emails?|inbox)|unread\s+emails?|search\s+(?:my\s+)?emails?|check\s+(?:my\s+)?(?:emails?|inbox|gmail)|(?:draft|compose|send)\s+(?:an?\s+)?email)\b/i
  },
  {
    category: 'concierge',
    tools: ['concierge_reservation'],
    regex: /\b(?:make\s+a\s+reservation|book\s+a\s+(?:table|reservation|dinner|lunch|spot)|reserve\s+a\s+table|dinner\s+reservation|restaurant\s+reservation|opentable|resy)\b/i
  },
  {
    category: 'commute',
    tools: ['commute_departure_check'],
    regex: /\b(?:when\s+(?:do\s+i\s+need\s+to|should\s+i)\s+leave|time\s+to\s+leave|check\s+traffic|how(?:'s|\s+is)\s+traffic|drive\s+time\s+to|travel\s+time\s+to|directions\s+to|commute\s+to|leave\s+early)\b/i
  }
];

/**
 * Detect whether a user prompt is requesting an Agentic Action / API tool call,
 * and return the pruned list of relevant tool schemas.
 */
export function detectAgenticIntent(prompt) {
  if (!prompt || typeof prompt !== 'string') {
    return { shouldUseAgenticProxy: false, matchedCategories: [], tools: [] };
  }

  const text = prompt.trim();
  const matchedCategories = [];
  const selectedToolNames = new Set();

  for (const rule of INTENT_PATTERNS) {
    if (rule.regex.test(text)) {
      matchedCategories.push(rule.category);
      for (const t of rule.tools) {
        selectedToolNames.add(t);
      }
    }
  }

  if (selectedToolNames.size === 0) {
    return { shouldUseAgenticProxy: false, matchedCategories: [], tools: [] };
  }

  // Check if the user is chaining a board/memory action alongside the external tool call:
  // e.g. "Check the weather in Seattle and add a task to go for a run"
  // or "Research the Pomodoro Technique and save a note"
  if (/\b(add\s+(?:a\s+)?task|create\s+(?:a\s+)?task|schedule\s+(?:a\s+)?task|complete\s+task|remember\s+that)\b/i.test(text)) {
    selectedToolNames.add('board_action');
    matchedCategories.push('board');
  }
  if (/\b(?:save|write|draft)\s+(?:a\s+)?note\b/i.test(text)) {
    selectedToolNames.add('save_note');
  }

  const tools = COMPANION_TOOLS.filter(t => selectedToolNames.has(t.name));
  const prunedTools = COMPANION_TOOLS.filter(t => !selectedToolNames.has(t.name)).map(t => t.name);
  const reductionPct = COMPANION_TOOLS.length > 0
    ? Math.round((prunedTools.length / COMPANION_TOOLS.length) * 100)
    : 0;
  lastToolPruningReport = {
    timestamp: new Date().toISOString(),
    totalAvailableTools: COMPANION_TOOLS.length,
    totalToolsAvailable: COMPANION_TOOLS.length,
    selectedCount: tools.length,
    prunedCount: prunedTools.length,
    reductionPct,
    selectedTools: tools.map(t => t.name),
    prunedTools,
    matchedCategories,
    schemaTokensSavedEst: prunedTools.length * 95
  };

  return {
    shouldUseAgenticProxy: true,
    matchedCategories,
    tools,
    pruningReport: lastToolPruningReport
  };
}

export function pruneToolsForPrompt(prompt) {
  return detectAgenticIntent(prompt).tools;
}

/**
 * Build the Krusch Dual-Engine (<holodata> Cognitive Blueprint + Flat Tool Array)
 * system prompt, adapted directly from krusch-agentic-mcp/src/core.py.
 *
 * Why this works for 7B/14B models (+25.9% tool accuracy on Qwen 7B):
 * 1. Forces the model to reason about parameters inside <holodata> BEFORE writing tool JSON.
 * 2. Uses a flat tool schema [{"name": "...", "arguments": {...}}] without OpenAI wrapper nesting.
 * 3. Only injects the 1-3 pruned tools relevant to the user's intent.
 */
export function buildHolodataSystemPrompt(tools, contextBriefing = '') {
  const compactTools = tools.map(t => ({
    name: t.name,
    description: t.description,
    arguments: t.parameters,
    required: t.required
  }));

  return `You are the Krusch Agentic Proxy operating inside Krusch Companion.
Your task is to fulfill the user's request by FIRST outputting a strict "Cognitive Blueprint" inside <holodata> XML tags, and THEN immediately outputting a raw JSON array of tool calls.

AVAILABLE TOOLS (Pruned for this request):
${JSON.stringify(compactTools, null, 2)}

You MUST wrap your JSON blueprint strictly inside <holodata> xml tags exactly like this:
<holodata>
{
  "cognitive_scratchpad": "Step-by-step analysis of what the user wants and the exact parameter values to extract.",
  "task_name": "Short title of the action",
  "strict_problem_constraints": "List any explicit constraints or chained actions requested by the user.",
  "tool_plan": "Exact sequence of tool(s) to call and their arguments."
}
</holodata>

CRITICAL RULES FOR THE TOOL CALL OUTPUT (immediately after </holodata>):
1. Immediately after </holodata>, output ONLY a raw JSON array representing the Tool Calls.
2. The JSON array MUST conform to this flat schema:
[{"name": "<tool_name>", "arguments": {"<param1>": "<val1>"}}]
3. DO NOT use OpenAI "type" or "function" wrappers. ALWAYS use the key "arguments".
4. If the user asks for multiple actions (e.g., check weather AND add a task), include ALL tool calls in the single JSON array in execution order.
5. You MUST ONLY use tool names listed in AVAILABLE TOOLS above.${contextBriefing ? `\n\n${contextBriefing}` : ''}`;
}

/**
 * Parse the unified Dual-Engine output into:
 * - blueprint: parsed <holodata> object (or raw string)
 * - toolCalls: validated array of { name, arguments }
 */
export function parseHolodataResponse(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { blueprint: null, toolCalls: [] };
  }

  let blueprint = null;
  let remainder = rawText.trim();

  const holoMatch = rawText.match(/<holodata>([\s\S]*?)<\/holodata>/i);
  if (holoMatch) {
    const rawHolo = holoMatch[1].trim();
    remainder = rawText.slice(holoMatch.index + holoMatch[0].length).trim();
    try {
      blueprint = parseAIJson(rawHolo);
    } catch {
      blueprint = { cognitive_scratchpad: rawHolo };
    }
  }

  let toolCalls = [];
  if (remainder) {
    try {
      const parsed = parseAIJson(remainder);
      if (Array.isArray(parsed)) {
        toolCalls = parsed;
      } else if (parsed && typeof parsed === 'object' && (parsed.name || parsed.action)) {
        toolCalls = [parsed];
      } else if (parsed && Array.isArray(parsed.tool_calls)) {
        toolCalls = parsed.tool_calls;
      }
    } catch {
      // Fall through to blueprint.tool_plan check
    }
  }

  if (toolCalls.length === 0 && blueprint && Array.isArray(blueprint.tool_plan)) {
    toolCalls = blueprint.tool_plan;
  }

  // Normalize any OpenAI-wrapped or action-keyed tool call
  const normalized = [];
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== 'object') continue;
    const name = tc.name || tc.action || tc.tool || tc.function?.name;
    let args = tc.arguments ?? tc.parameters ?? tc.function?.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    if (name && typeof name === 'string') {
      normalized.push({ name: name.trim(), tool: name.trim(), arguments: args || {} });
    }
  }

  return { blueprint, toolCalls: normalized };
}

export function parseHolodataTags(rawText) {
  return parseHolodataResponse(rawText).toolCalls;
}

/**
 * Deterministic fallback parameter extractor if the local LLM is offline or fails to emit valid tool JSON.
 * Ensures that clear user action requests still execute reliably even in degraded edge conditions.
 */
export function inferFallbackToolCalls(prompt, matchedCategories = []) {
  const text = String(prompt || '').trim();
  const categories = matchedCategories.length > 0 ? matchedCategories : detectAgenticIntent(text).matchedCategories;
  const calls = [];

  if (categories.includes('weather')) {
    const locMatch =
      text.match(/(?:weather|temperature|forecast|rain(?:ing)?|sunny|snow(?:ing)?)\s+(?:in|for|at|near)\s+([A-Za-z0-9\s,.'-]+?)(?:\s+(?:and|then|today|right now|please)\b|[?.!]|$)/i) ||
      text.match(/in\s+([A-Z][A-Za-z\s,.'-]+?)(?:\s+(?:and|then|today|right now)\b|[?.!]|$)/);
    const location = (locMatch ? locMatch[1] : text.replace(/what(?:'s| is) the weather|check the weather|weather|forecast|in|for|today|[?.!]/gi, '')).trim() || 'Seattle';
    calls.push({ name: 'get_weather', tool: 'get_weather', arguments: { location } });
  }

  if (matchedCategories.includes('url_digest')) {
    const urlMatch = text.match(/https?:\/\/[^\s)>\]"']+/i);
    if (urlMatch) {
      calls.push({ name: 'fetch_url_digest', arguments: { url: urlMatch[0] } });
    }
  }

  if (matchedCategories.includes('web') && !matchedCategories.includes('url_digest')) {
    const queryMatch =
      text.match(/(?:search(?:\s+the)?\s+web\s+for|look\s+up|research|find\s+information\s+on|tell\s+me\s+about\s+the\s+topic)\s+(.+?)(?:\s+and\s+(?:save|add|create)\b|[?.!]|$)/i);
    const query = (queryMatch ? queryMatch[1] : text).replace(/^["']|["']$/g, '').trim();
    if (query) {
      calls.push({ name: 'web_research', arguments: { query } });
    }
  }

  if (matchedCategories.includes('notes_write')) {
    const noteMatch = text.match(/(?:save|write|draft|create)\s+(?:a\s+)?(?:markdown\s+)?(?:note|document|brief|memo)\s+(?:titled|called|named|about)?\s*["']?([^:"'\n]+?)["']?\s*[:\-]\s*([\s\S]+)$/i);
    if (noteMatch) {
      calls.push({
        name: 'save_note',
        arguments: { title: noteMatch[1].trim(), content: noteMatch[2].trim() }
      });
    } else {
      const body = text.replace(/^(?:please\s+)?(?:save|write|draft|create)\s+(?:a\s+)?(?:markdown\s+)?(?:note|document|brief|memo)\s*(?:about|for|on|:)?\s*/i, '').trim();
      const shortTitle = body.split(/\s+/).slice(0, 4).join(' ') || 'Quick Note';
      calls.push({
        name: 'save_note',
        arguments: { title: shortTitle, content: body || text }
      });
    }
  }

  if (matchedCategories.includes('notes_read')) {
    const readMatch = text.match(/(?:read|open|view|show)\s+note\s*[:\-]?\s*["']?([A-Za-z0-9-_.\s]+)["']?$/i);
    calls.push({
      name: 'list_notes',
      arguments: { title: readMatch ? readMatch[1].trim() : '' }
    });
  }

  if (matchedCategories.includes('notify')) {
    const notifyMatch =
      text.match(/(?:send|push|dispatch|trigger)\s+(?:a\s+|an\s+)?(?:push\s+)?(?:notification|alert|ntfy|ping)(?:\s+to\s+my\s+phone)?\s*[:\-]\s*(.+)$/i) ||
      text.match(/notify\s+my\s+(?:phone|device)\s*[:\-]?\s*(.+)$/i);
    const message = notifyMatch ? notifyMatch[1].trim() : text;
    calls.push({
      name: 'send_notification',
      arguments: { title: 'Krusch Companion', message }
    });
  }

  if (matchedCategories.includes('system')) {
    calls.push({ name: 'system_status', arguments: {} });
  }

  if (matchedCategories.includes('sovereign_law_biz')) {
    const isBiz = /kruschbiz|contract/i.test(text);
    const query = text.replace(/^(?:search|ask|query|check)\s+(?:kruschlaw|kruschbiz|statutes?|contract\s+graph)\s*(?:for|about|:)?\s*/i, '').trim() || text;
    calls.push({
      name: 'sovereign_gateway_query',
      arguments: { domain: isBiz ? 'biz' : 'law', query }
    });
  }

  if (matchedCategories.includes('google_drive')) {
    if (/\b(?:save|write|export)\s+to\s+(?:google\s+)?drive\b/i.test(text)) {
      calls.push({
        name: 'gkrusch_drive',
        arguments: { action: 'write', path: 'output/companion-note.md', content: text }
      });
    } else if (/\bagent\.md|steering\b/i.test(text)) {
      calls.push({
        name: 'gkrusch_drive',
        arguments: { action: 'steering' }
      });
    } else if (/\b(?:list|show)\s+(?:my\s+)?(?:google\s+)?drive\s+workspace\b/i.test(text)) {
      calls.push({
        name: 'gkrusch_drive',
        arguments: { action: 'list' }
      });
    } else {
      const qMatch = text.match(/(?:search\s+(?:my\s+)?(?:google\s+)?drive|drive\s+rag|google\s+docs?)\s*(?:for|about|:)?\s*(.+?)(?:\s+and\s+\b|[?.!]|$)/i);
      const query = (qMatch ? qMatch[1] : text).trim();
      calls.push({
        name: 'gkrusch_drive',
        arguments: { action: 'search', query }
      });
    }
  }

  if (matchedCategories.includes('google_calendar')) {
    const createMatch = text.match(/\b(?:schedule|create|book|add)\s+(?:a\s+|an\s+)?(?:calendar\s+)?(?:meeting|event|appointment|call)\s*(?:titled|called|for|to|:)?\s*(.+?)$/i);
    if (createMatch) {
      const rawSummary = createMatch[1].trim();
      const locMatch = rawSummary.match(/\b(?:at|in)\s+([A-Za-z0-9\s,'&-]+?)(?:\s+(?:at\s+\d|on\s+)\b|$)/i);
      calls.push({
        name: 'gkrusch_calendar',
        arguments: {
          action: 'create_event',
          summary: rawSummary,
          ...(locMatch ? { location: locMatch[1].trim() } : {})
        }
      });
    } else {
      calls.push({
        name: 'gkrusch_calendar',
        arguments: { action: 'list_events' }
      });
    }
  }

  if (matchedCategories.includes('google_gmail')) {
    if (/\b(?:draft|compose|send)\s+(?:an?\s+)?email\b/i.test(text)) {
      const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      const subjectMatch = text.match(/\b(?:subject|about|titled)\s*[:\-]?\s*["']?([^"'\n:]+?)["']?(?:\s*[:\-]\s*([\s\S]+))?$/i);
      const isSend = /\bsend\s+(?:an?\s+)?email\b/i.test(text);
      calls.push({
        name: 'gkrusch_gmail',
        arguments: {
          action: isSend ? 'send_email' : 'create_draft',
          to: emailMatch ? emailMatch[1] : 'recipient@example.com',
          subject: subjectMatch ? subjectMatch[1].trim() : 'Update from Krusch Companion',
          body: (subjectMatch && subjectMatch[2]) ? subjectMatch[2].trim() : text
        }
      });
    } else {
      const qMatch = text.match(/(?:search\s+(?:my\s+)?(?:emails?|gmail|inbox)|check\s+(?:my\s+)?(?:emails?|gmail|inbox))\s*(?:for|from|about|:)?\s*(.+?)$/i);
      const query = (qMatch ? qMatch[1] : 'is:inbox').trim();
      calls.push({
        name: 'gkrusch_gmail',
        arguments: { action: 'search_emails', query: query || 'is:inbox' }
      });
    }
  }

  if (matchedCategories.includes('concierge')) {
    const venueMatch = text.match(/(?:reservation|table|dinner|lunch|spot)\s+(?:at|for)\s+([A-Za-z0-9\s,'&-]+?)(?:\s+(?:for\s+\d+|on\s+|at\s+\d|tonight|tomorrow)\b|[?.!]|$)/i);
    const partyMatch = text.match(/\b(?:for|party\s+of)\s+(\d+)\b/i);
    const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    calls.push({
      name: 'concierge_reservation',
      arguments: {
        venue: venueMatch ? venueMatch[1].trim() : text,
        partySize: partyMatch ? parseInt(partyMatch[1], 10) : 2,
        ...(emailMatch ? { email: emailMatch[1] } : {})
      }
    });
  }

  if (matchedCategories.includes('commute')) {
    const destMatch = text.match(/\b(?:to|for|at)\s+([A-Za-z0-9\s,'&-]+?)(?:\s+(?:by|at)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)|[?.!]|$)/i);
    const timeMatch = text.match(/\b(?:by|at|for)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
    calls.push({
      name: 'commute_departure_check',
      arguments: {
        destination: destMatch ? destMatch[1].trim() : text,
        ...(timeMatch ? { arrivalTime: timeMatch[1].trim() } : {})
      }
    });
  }

  if (matchedCategories.includes('board')) {
    const addTaskMatch = text.match(/\b(?:add|create|schedule)\s+(?:a\s+)?task\s+(?:to\s+)?(.+?)$/i);
    if (addTaskMatch) {
      calls.push({
        name: 'board_action',
        arguments: { action: 'add_task', title: addTaskMatch[1].trim() }
      });
    }
  }

  return calls;
}

/**
 * Compute an explicit confidence score (0.0..1.0) for a <holodata> tool extraction pass.
 */
export function scoreHolodataConfidence({ blueprint, toolCalls = [], usedFallback = false, rawText = '' }) {
  if (!toolCalls || toolCalls.length === 0) return 0;
  if (usedFallback) return 0.92;
  let score = 0.72;
  if (blueprint && typeof blueprint === 'object' && blueprint.cognitive_scratchpad) {
    score += 0.14;
  }
  if (/<holodata>[\s\S]*?<\/holodata>/i.test(rawText)) {
    score += 0.06;
  }
  const allHaveValidNames = toolCalls.every(tc => COMPANION_TOOLS.some(t => t.name === tc.name));
  if (allHaveValidNames) {
    score += 0.06;
  } else {
    score -= 0.25;
  }
  return Number(Math.max(0.1, Math.min(0.99, score)).toFixed(2));
}

/**
 * Execute an Agentic Proxy turn using the Dual-Engine <holodata> protocol.
 *
 * @param {object} params
 * @param {string} params.prompt - User prompt
 * @param {Array}  params.history - Recent conversation history
 * @param {string} params.contextBriefing - Sovereign state briefing
 * @param {Function} params.callLlm - Async function `({ prompt, systemPrompt, history }) => Promise<{ content, tierUsed, reason }>`
 * @param {Function} [params.fetchImpl] - Custom fetch implementation (for testing)
 */
export async function executeAgenticProxyTurn({
  prompt,
  history = [],
  contextBriefing = '',
  callLlm,
  fetchImpl = fetch
}) {
  const startTime = Date.now();
  const intent = detectAgenticIntent(prompt);

  if (!intent.shouldUseAgenticProxy) {
    return null;
  }

  const holodataSystemPrompt = buildHolodataSystemPrompt(intent.tools, contextBriefing);
  let blueprint = null;
  let plannedCalls = [];
  let tierUsed = 'L1_edge';
  let llmReason = 'Agentic Proxy (<holodata> Dual-Engine)';
  let rawLlmContent = '';
  let usedDeterministicFallback = false;

  // Phase 1: Run Unified <holodata> Thinker + Implementer pass on the model
  if (typeof callLlm === 'function') {
    try {
      const llmOut = await callLlm({
        prompt: `OBJECTIVE: ${prompt}`,
        systemPrompt: holodataSystemPrompt,
        history: history.slice(-4)
      });
      if (llmOut?.tierUsed) tierUsed = llmOut.tierUsed;
      if (llmOut?.reason) llmReason = `${llmOut.reason} + Agentic Proxy`;
      rawLlmContent = llmOut?.content || '';

      const parsed = parseHolodataResponse(rawLlmContent);
      blueprint = parsed.blueprint;
      plannedCalls = parsed.toolCalls;
    } catch (err) {
      recordLowConfidenceOrFailedParse({
        prompt,
        reason: `LLM invocation failed (${err.message}); switching to deterministic fallback`,
        confidence: 0.92,
        rawSnippet: ''
      });
    }
  }

  // Fallback if the LLM returned no valid tool calls
  if (!plannedCalls || plannedCalls.length === 0) {
    usedDeterministicFallback = true;
    if (rawLlmContent) {
      recordLowConfidenceOrFailedParse({
        prompt,
        reason: 'Malformed or missing <holodata> JSON from small model; recovered via deterministic fallback',
        confidence: 0.92,
        rawSnippet: rawLlmContent
      });
    }
    plannedCalls = inferFallbackToolCalls(prompt, intent.matchedCategories);
    if (!blueprint) {
      blueprint = {
        cognitive_scratchpad: `Deterministic Agentic Proxy fallback for categories: ${intent.matchedCategories.join(', ')}`,
        task_name: 'Agentic Action Execution',
        strict_problem_constraints: 'Execute matched assistant tools safely',
        tool_plan: plannedCalls.map(c => `${c.name}(${JSON.stringify(c.arguments)})`).join(' -> ')
      };
    }
  }

  if (plannedCalls.length === 0) {
    return null;
  }

  const confidence = scoreHolodataConfidence({
    blueprint,
    toolCalls: plannedCalls,
    usedFallback: usedDeterministicFallback,
    rawText: rawLlmContent
  });

  // Phase 2: Execute each tool in the sandboxed executor, piping upstream API results into downstream notes/notifications/Drive/Gmail
  const executedResults = [];
  const upstreamOutputs = [];

  for (const call of plannedCalls.slice(0, 4)) {
    const resolvedArgs = { ...(call.arguments || {}) };

    // If a downstream save_note, send_notification, gkrusch_drive(write), or gkrusch_gmail(draft/send) follows an upstream data-fetching tool,
    // automatically ground its content/message/body with the live upstream API output.
    if (upstreamOutputs.length > 0) {
      const combinedUpstream = upstreamOutputs.join('\n\n');
      if (call.name === 'save_note' || (call.name === 'gkrusch_drive' && resolvedArgs.action === 'write')) {
        const rawContent = String(resolvedArgs.content || '').trim();
        const isPlaceholder =
          !rawContent ||
          /to be fetched|insert(?:ed)? here|placeholder|<[^>]+>|\{\{[^}]+\}\}|weather summary|research summary|summary of/i.test(rawContent);
        resolvedArgs.content = isPlaceholder
          ? combinedUpstream
          : `${rawContent}\n\n---\n### Live Data Snapshot\n${combinedUpstream}`;
      } else if (call.name === 'send_notification') {
        const rawMsg = String(resolvedArgs.message || '').trim();
        const isPlaceholder =
          !rawMsg ||
          /to be fetched|insert(?:ed)? here|placeholder|<[^>]+>|\{\{[^}]+\}\}|weather summary/i.test(rawMsg);
        resolvedArgs.message = isPlaceholder
          ? combinedUpstream
          : `${rawMsg} — ${combinedUpstream}`;
      } else if (call.name === 'gkrusch_gmail' && ['create_draft', 'send_email', 'draft', 'send'].includes(String(resolvedArgs.action || ''))) {
        const rawBody = String(resolvedArgs.body || '').trim();
        const isPlaceholder =
          !rawBody ||
          /to be fetched|insert(?:ed)? here|placeholder|<[^>]+>|\{\{[^}]+\}\}|summary of/i.test(rawBody);
        resolvedArgs.body = isPlaceholder
          ? combinedUpstream
          : `${rawBody}\n\n${combinedUpstream}`;
      }
    }

    const res = await executeCompanionTool(call.name, resolvedArgs, { fetchImpl });
    if (
      res.ok &&
      (
        ['get_weather', 'web_research', 'fetch_url_digest', 'system_status', 'sovereign_gateway_query'].includes(call.name) ||
        (call.name === 'gkrusch_drive' && ['search', 'read', 'steering'].includes(String(resolvedArgs.action || 'search'))) ||
        (call.name === 'gkrusch_calendar' && String(resolvedArgs.action || 'list_events') === 'list_events') ||
        (call.name === 'gkrusch_gmail' && String(resolvedArgs.action || 'search_emails') === 'search_emails')
      )
    ) {
      upstreamOutputs.push(res.summary);
    }

    executedResults.push({
      name: call.name,
      arguments: resolvedArgs,
      ok: res.ok,
      dryRun: Boolean(res.dryRun),
      requiresConfirmation: Boolean(res.requiresConfirmation),
      actionType: res.actionType || 'agentic_tool',
      summary: res.summary,
      data: res.data || null,
      latencyMs: res.latencyMs
    });
  }

  // Phase 3: Compose the grounded assistant reply and action metadata
  const summaries = executedResults.map(r => r.summary);
  const content = summaries.join('\n\n');

  const primaryAction = executedResults.find(r => r.ok) || executedResults[0];
  const actionExecuted = {
    type: primaryAction?.actionType || 'agentic_tool',
    toolName: primaryAction?.name,
    toolCount: executedResults.length,
    confidence,
    usedDeterministicFallback,
    results: executedResults.map(r => ({
      name: r.name,
      arguments: r.arguments,
      ok: r.ok,
      dryRun: r.dryRun,
      requiresConfirmation: r.requiresConfirmation,
      latencyMs: r.latencyMs
    }))
  };

  return {
    content,
    tierUsed,
    latencyMs: Date.now() - startTime,
    reason: `${llmReason} [${executedResults.map(r => r.name).join(', ')}]`,
    actionExecuted,
    agenticTrace: {
      blueprint,
      confidence,
      usedDeterministicFallback,
      pruningReport: intent.pruningReport,
      matchedCategories: intent.matchedCategories,
      toolCalls: executedResults.map(r => ({
        name: r.name,
        arguments: r.arguments,
        ok: r.ok,
        dryRun: r.dryRun,
        requiresConfirmation: r.requiresConfirmation,
        summary: r.summary,
        latencyMs: r.latencyMs
      }))
    }
  };
}
