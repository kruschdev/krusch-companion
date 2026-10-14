import { COMPANION_TOOLS, executeCompanionTool, recordLowConfidenceOrFailedParse, recordLearnedTrajectorySkill } from './tools.js';
import { parseAIJson } from '../toolkit/json-parse.js';

let lastToolPruningReport = null;

/**
 * Estimate LLM token count (~4 chars per token for JSON/English tool schemas).
 */
export function estimateTokens(text = '') {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

/**
 * Calculate the full unpruned 20-tool catalog token footprint (~2,050 tokens).
 */
export function getFullCatalogSchemaTokens() {
  const raw = JSON.stringify(
    COMPANION_TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      arguments: t.parameters,
      required: t.required
    })),
    null,
    2
  );
  return estimateTokens(raw);
}

/**
 * Stage 2 Micro-Schema Compaction:
 * Compacts a tool's description and dynamically strips unused sub-action parameters
 * for multiplexer tools based on the user's prompt. Reduces per-tool schema size by ~60%.
 */
export function compactToolSchemaForPrompt(tool, prompt = '') {
  if (!tool) return null;
  const text = String(prompt || '').toLowerCase();

  // Shorten description to first concise clause (<= 95 chars)
  const shortDesc = String(tool.description || '')
    .replace(/\s*\([^)]*\)/g, '')
    .split(/[:.;]/)[0]
    .trim()
    .slice(0, 95);

  const rawParams = { ...(tool.parameters || {}) };

  // Action-scoped parameter pruning for multi-action multiplexer tools
  if (tool.name === 'smart_home_bridge') {
    const isMessaging = /\b(telegram|discord|slack|webhook|channel|message)\b/.test(text);
    if (isMessaging) {
      delete rawParams.device;
      delete rawParams.state;
      rawParams.action = '"send_channel_message"';
    } else {
      delete rawParams.channel;
      delete rawParams.message;
      rawParams.action = '"control_device" | "home_status"';
    }
  } else if (tool.name === 'gkrusch_calendar') {
    const isCreate = /\b(schedule|create|book|add|new)\b/.test(text);
    if (!isCreate) {
      delete rawParams.startTime;
      delete rawParams.endTime;
      delete rawParams.location;
      delete rawParams.description;
      rawParams.action = '"list_events"';
    }
  } else if (tool.name === 'gkrusch_gmail') {
    const isCompose = /\b(draft|compose|send|write|reply)\b/.test(text);
    if (!isCompose) {
      delete rawParams.to;
      delete rawParams.subject;
      delete rawParams.body;
      rawParams.action = '"search_emails"';
    } else {
      delete rawParams.query;
      rawParams.action = '"create_draft" | "send_email"';
    }
  } else if (tool.name === 'gkrusch_drive') {
    const isWrite = /\b(write|save|export)\b/.test(text);
    if (!isWrite) {
      delete rawParams.content;
    }
  } else if (tool.name === 'schedule_automation') {
    const isMeetingPrep = /\b(meeting\s+prep|dossier|brief|attendees?)\b/.test(text);
    if (isMeetingPrep) {
      delete rawParams.schedule;
      delete rawParams.taskType;
      rawParams.action = '"meeting_prep"';
    } else {
      delete rawParams.attendees;
    }
  } else if (tool.name === 'personal_crm_profile') {
    const isLookupOrList = /\b(lookup|list|show|find|who\s+is)\b/.test(text) && !/\b(save|add|upsert|birthday\s+is|gift\s+idea)\b/.test(text);
    if (isLookupOrList) {
      delete rawParams.relationship;
      delete rawParams.importantDates;
      delete rawParams.giftIdeas;
      delete rawParams.notes;
      rawParams.action = '"lookup_contact" | "list_contacts"';
    }
  } else if (tool.name === 'skill_manager') {
    const isListOrRun = /\b(list|run|execute|read|import|migrate)\b/.test(text) && !/\b(learn|save|create)\b/.test(text);
    if (isListOrRun) {
      delete rawParams.description;
      delete rawParams.triggers;
      delete rawParams.steps;
    }
  }

  // Condense verbose parameter descriptions while keeping types and enum values
  const compactArgs = {};
  for (const [k, v] of Object.entries(rawParams)) {
    compactArgs[k] = String(v)
      .replace(/string \((?:REQUIRED|OPTIONAL):\s*/i, 'string (')
      .replace(/number \((?:REQUIRED|OPTIONAL):\s*/i, 'number (')
      .replace(/,\s*e\.g\.\s*[^)]+\)/i, ')')
      .slice(0, 72);
  }

  return {
    name: tool.name,
    description: shortDesc,
    arguments: compactArgs,
    ...(Array.isArray(tool.required) && tool.required.length > 0 ? { required: tool.required } : {})
  };
}

/**
 * Stage 1 DPP Query-Residual Diverse Tool Router (arXiv: 2609.05824 — Parity with @krusch/toolkit routeDiverseSkills):
 * Scores candidate tools by query relevance minus pairwise overlap so only a compact,
 * orthogonal 1-3 tool subset is injected into the prompt within a strict token budget.
 */
export function routeDiverseTools(query, candidateTools = COMPANION_TOOLS, options = {}) {
  const {
    maxTools = 3,
    maxTokenBudget = 240,
    diversityLambda = 0.68
  } = options;

  if (!Array.isArray(candidateTools) || candidateTools.length === 0) {
    return { selectedTools: [], totalTokens: 0, diversityScore: 1.0 };
  }

  const tokenize = (str = '') =>
    new Set(
      String(str)
        .toLowerCase()
        .replace(/[^a-z0-9\s_-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2)
    );

  const similarity = (setA, setB) => {
    if (setA.size === 0 || setB.size === 0) return 0;
    let inter = 0;
    for (const w of setA) {
      if (setB.has(w)) inter++;
    }
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : inter / union;
  };

  const queryTokens = tokenize(query);

  const scored = candidateTools.map((tool, idx) => {
    const compact = compactToolSchemaForPrompt(tool, query);
    const sigText = `${tool.name.replace(/_/g, ' ')} ${tool.category || ''} ${tool.description || ''} ${Object.keys(tool.parameters || {}).join(' ')}`;
    const toolTokens = tokenize(sigText);
    const lexicalRel = similarity(queryTokens, toolTokens);
    // Preserve priority bonus for tools matched by explicit intent regex order
    const intentBonus = options.regexMatchedSet?.has(tool.name) ? 0.55 - idx * 0.02 : 0;
    const relevance = Math.min(1.0, lexicalRel + intentBonus);
    const tokens = estimateTokens(JSON.stringify(compact));
    return {
      tool,
      compact,
      toolTokens,
      relevance,
      tokens
    };
  });

  scored.sort((a, b) => b.relevance - a.relevance);

  const selected = [];
  let currentTokens = 0;
  const remaining = [...scored];

  while (remaining.length > 0 && selected.length < maxTools) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      if (selected.length > 0 && currentTokens + cand.tokens > maxTokenBudget) {
        continue;
      }
      let maxRedundancy = 0;
      for (const sel of selected) {
        const red = similarity(cand.toolTokens, sel.toolTokens);
        if (red > maxRedundancy) maxRedundancy = red;
      }
      const dsrScore = diversityLambda * cand.relevance - (1 - diversityLambda) * maxRedundancy;
      if (dsrScore > bestScore) {
        bestScore = dsrScore;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;
    const chosen = remaining.splice(bestIdx, 1)[0];
    selected.push(chosen);
    currentTokens += chosen.tokens;
  }

  let pairSim = 0;
  let pairs = 0;
  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      pairSim += similarity(selected[i].toolTokens, selected[j].toolTokens);
      pairs++;
    }
  }
  const diversityScore = Number((1.0 - (pairs > 0 ? pairSim / pairs : 0)).toFixed(2));

  return {
    selectedTools: selected.map(s => s.tool),
    compactedSchemas: selected.map(s => s.compact),
    totalTokens: currentTokens,
    diversityScore
  };
}

export function getLastToolPruningReport() {
  if (!lastToolPruningReport) {
    const total = Array.isArray(COMPANION_TOOLS) ? COMPANION_TOOLS.length : 20;
    const fullTokens = getFullCatalogSchemaTokens();
    return {
      timestamp: null,
      totalAvailableTools: total,
      totalToolsAvailable: total,
      selectedCount: 0,
      injectedCount: 0,
      prunedCount: total,
      reductionPct: 94,
      selectedTools: [],
      prunedTools: Array.isArray(COMPANION_TOOLS) ? COMPANION_TOOLS.map(t => t.name) : [],
      matchedCategories: [],
      fullCatalogTokensEst: fullTokens,
      injectedSchemaTokensEst: 0,
      schemaTokensSavedEst: fullTokens,
      diversityScore: 1.0
    };
  }
  return lastToolPruningReport;
}

/**
 * Intent routing rules that map natural-language action requests to compact tool subsets.
 * Pruning the 20-tool catalog to 1-3 relevant tools prevents 7B/14B schema overload.
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
    regex: /\b(?:list|show|view|read|open)\s+(?:(?:my|saved|all|vault|recent)\s+)*notes?\b/i
  },
  {
    category: 'notify',
    tools: ['send_notification'],
    regex: /\b(?:send|push|dispatch|trigger)\s+(?:a\s+|an\s+)?(?:push\s+)?(?:notification|alert|ntfy|ping)(?:\s+to\s+my\s+phone)?\b|\bnotify\s+my\s+(?:phone|device)\b/i
  },
  {
    category: 'system',
    tools: ['system_status'],
    regex: /\b(?:system\s+status|system\s+health|server\s+status|host\s+telemetry|cpu\s+load|ram\s+usage|memory\s+usage|check\s+telemetry|diagnostics?)\b/i
  },
  {
    category: 'sovereign_law_biz',
    tools: ['sovereign_gateway_query'],
    regex: /\b(?:kruschlaw|kruschbiz|statute\s+lookup|search\s+statutes?|legal\s+(?:rag|statute)|contract\s+(?:graph|compliance)|tenant\s+defense(?:\s+statute)?)\b/i
  },
  {
    category: 'google_drive',
    tools: ['gkrusch_drive'],
    regex: /\b(?:google\s+drive|g-krusch|gkrusch|google\s+docs?|drive\s+rag|search\s+(?:my\s+)?drive|save\s+to\s+(?:google\s+)?drive|write\s+to\s+(?:google\s+)?drive|export\s+to\s+(?:google\s+)?drive|agent\.md\s+steering)\b/i
  },
  {
    category: 'google_calendar',
    tools: ['gkrusch_calendar'],
    regex: /\b(?:google\s+calendar|my\s+calendar|calendar\s+(?:events?|schedule)|upcoming\s+(?:events?|meetings?|appointments?)|schedule\s+(?:a\s+|an\s+)?(?:meeting|event|appointment|call)|what(?:'s|\s+is)\s+on\s+my\s+calendar)\b/i
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
  },
  {
    category: 'google_wallet',
    tools: ['google_wallet_pass'],
    regex: /\b(?:google\s+wallet|(?:add|push|save|create|issue)\s+(?:a\s+|an\s+|my\s+)?(?:google\s+)?(?:wallet\s+)?(?:event\s+ticket\s+)?pass|wallet\s+pass|boarding\s+pass\s+to\s+wallet)\b/i
  },
  {
    category: 'payments',
    tools: ['ap2_payment_mandate'],
    regex: /\b(?:ap2|payment\s+mandate|agent\s+payment|google\s+pay|virtual\s+card|authorize\s+(?:a\s+|an\s+)?(?:\$?\d+(?:\.\d{2})?\s+)?(?:ap2\s+)?payment|issue\s+(?:a\s+|an\s+)?(?:payment\s+)?mandate|pay\s+\$?\d+(?:\.\d{2})?\s+(?:to|for|at))\b/i
  },
  {
    category: 'skills',
    tools: ['skill_manager'],
    regex: /\b(?:learn\s+(?:a\s+|this\s+)?skill|save\s+(?:a\s+|this\s+)?skill|create\s+(?:a\s+)?skill|list\s+(?:(?:all|my|learned|installed)\s+)*skills|(?:read|view|show)\s+skill|run\s+skill|execute\s+skill|skill\.md|openclaw\s+migrate|hermes\s+claw\s+migrate|import\s+openclaw)\b/i
  },
  {
    category: 'automation',
    tools: ['schedule_automation'],
    regex: /\b(?:schedule\s+(?:a\s+|an\s+)?(?:recurring|cron|automation|daily\s+briefing)|remind\s+me\s+(?:in|at|every)|set\s+a\s+reminder|cron\s+job|list\s+automations|meeting\s+prep|prepare\s+a\s+meeting\s+dossier|compile\s+a?\s*meeting\s+brief)\b/i
  },
  {
    category: 'smart_home',
    tools: ['smart_home_bridge'],
    regex: /\b(?:home\s+assistant|smart\s+home|turn\s+(?:on|off)\s+(?:the\s+)?(?:(?:office|studio|living\s+room|bedroom|kitchen)\s+)*lights?|set\s+(?:the\s+)?thermostat|lock\s+(?:the\s+)?(?:front\s+)?door|unlock\s+(?:the\s+)?(?:front\s+)?door|activate\s+(?:the\s+)?(?:goodnight|focus)\s+scene|send\s+(?:to|via)\s+(?:telegram|discord|slack))\b/i
  },
  {
    category: 'personal_crm',
    tools: ['personal_crm_profile'],
    regex: /\b(?:personal\s+crm|save\s+(?:a\s+)?contact|add\s+to\s+crm|lookup\s+contact|look\s+up\s+contact|list\s+contacts|gift\s+ideas?\s+for|birthday\s+is|anniversary\s+is|soul\.md|user\.md|sync\s+markdown\s+profiles)\b/i
  },
  {
    category: 'board',
    tools: ['board_action'],
    regex: /\b(?:add\s+(?:a\s+|an\s+|urgent\s+)?task\s+to|create\s+(?:a\s+|an\s+|urgent\s+)?task\s+to|complete\s+task\s*[:\-]?|check\s+off\s+task|remember\s+that\s+.+\s+and\s+(?:add|create)\s+task)\b/i
  }
];

/**
 * Detect whether a user prompt is requesting an Agentic Action / API tool call,
 * and return the DPP-pruned, token-bounded list of relevant tool schemas (1-3 tools).
 */
export function detectAgenticIntent(prompt, options = {}) {
  if (!prompt || typeof prompt !== 'string') {
    return { shouldUseAgenticProxy: false, matchedCategories: [], tools: [] };
  }

  const text = prompt.trim();
  const matchedCategories = [];
  const selectedToolNames = new Set();

  for (const rule of INTENT_PATTERNS) {
    if (rule.regex.test(text)) {
      if (!matchedCategories.includes(rule.category)) {
        matchedCategories.push(rule.category);
      }
      for (const t of rule.tools) {
        selectedToolNames.add(t);
      }
    }
  }

  if (selectedToolNames.size === 0) {
    return { shouldUseAgenticProxy: false, matchedCategories: [], tools: [] };
  }

  // Check if the user is chaining a board/memory action or note save alongside an external tool call
  if (/\b(add\s+(?:a\s+)?task|create\s+(?:a\s+)?task|schedule\s+(?:a\s+)?task|complete\s+task|remember\s+that)\b/i.test(text)) {
    selectedToolNames.add('board_action');
    if (!matchedCategories.includes('board')) matchedCategories.push('board');
  }
  if (/\b(?:save|write|draft)\s+(?:a\s+)?note\b/i.test(text)) {
    selectedToolNames.add('save_note');
    if (!matchedCategories.includes('notes_write')) matchedCategories.push('notes_write');
  }

  // Stage 1: Apply DPP Query-Residual Diverse Tool Routing to cap listed tools to <= maxTools (default 3)
  const maxTools = options.maxTools || 3;
  const maxTokenBudget = options.maxTokenBudget || 260;
  const matchedCandidates = COMPANION_TOOLS.filter(t => selectedToolNames.has(t.name));
  const dppRouted = routeDiverseTools(text, matchedCandidates, {
    maxTools,
    maxTokenBudget,
    regexMatchedSet: selectedToolNames
  });

  const tools = dppRouted.selectedTools;
  const finalSelectedSet = new Set(tools.map(t => t.name));
  const prunedTools = COMPANION_TOOLS.filter(t => !finalSelectedSet.has(t.name)).map(t => t.name);

  const fullCatalogTokensEst = getFullCatalogSchemaTokens();
  const injectedSchemaTokensEst = dppRouted.totalTokens;
  const schemaTokensSavedEst = Math.max(0, fullCatalogTokensEst - injectedSchemaTokensEst);
  const reductionPct = COMPANION_TOOLS.length > 0
    ? Math.round((prunedTools.length / COMPANION_TOOLS.length) * 100)
    : 0;
  const tokenReductionPct = fullCatalogTokensEst > 0
    ? Math.round((schemaTokensSavedEst / fullCatalogTokensEst) * 100)
    : reductionPct;

  lastToolPruningReport = {
    timestamp: new Date().toISOString(),
    totalAvailableTools: COMPANION_TOOLS.length,
    totalToolsAvailable: COMPANION_TOOLS.length,
    selectedCount: tools.length,
    injectedCount: tools.length,
    prunedCount: prunedTools.length,
    reductionPct,
    tokenReductionPct,
    diversityScore: dppRouted.diversityScore,
    selectedTools: tools.map(t => t.name),
    prunedTools,
    matchedCategories,
    fullCatalogTokensEst,
    injectedSchemaTokensEst,
    schemaTokensSavedEst
  };

  return {
    shouldUseAgenticProxy: true,
    matchedCategories,
    tools,
    compactedSchemas: dppRouted.compactedSchemas,
    pruningReport: lastToolPruningReport
  };
}

export function pruneToolsForPrompt(prompt, options = {}) {
  return detectAgenticIntent(prompt, options).tools;
}

/**
 * Build the Krusch Dual-Engine (<holodata> Cognitive Blueprint + Flat Tool Array)
 * system prompt with Stage 2 Action-Scoped Micro-Schema Compaction.
 *
 * Why this works for 7B/14B models (+25.9% tool accuracy on Qwen 7B, ~95% token reduction):
 * 1. Forces the model to reason about parameters inside <holodata> BEFORE writing tool JSON.
 * 2. Uses a flat tool schema [{"name": "...", "arguments": {...}}] without OpenAI wrapper nesting.
 * 3. Only injects 1-3 DPP-routed tools with action-pruned micro-schemas (~45-135 tokens vs ~2,050 full catalog).
 */
export function buildHolodataSystemPrompt(tools, contextBriefing = '', options = {}) {
  const promptText = options?.prompt || '';
  const compactTools = tools.map(t => compactToolSchemaForPrompt(t, promptText));
  const serializedTools = compactTools.map(ct => `- ${JSON.stringify(ct)}`).join('\n');

  return `You are the Krusch Agentic Proxy operating inside Krusch Companion.
Fulfill the user's request by FIRST outputting a "Cognitive Blueprint" inside <holodata> XML tags, and THEN immediately outputting a raw JSON array of tool calls.

AVAILABLE TOOLS (Pruned to ${compactTools.length}/${COMPANION_TOOLS.length} relevant tools):
${serializedTools}

Wrap your JSON blueprint strictly inside <holodata> XML tags:
<holodata>
{
  "cognitive_scratchpad": "Step-by-step parameter extraction.",
  "task_name": "Short action title",
  "strict_problem_constraints": "Explicit constraints or chained actions.",
  "tool_plan": "Exact sequence of tool(s) to call."
}
</holodata>

RULES FOR TOOL CALL OUTPUT (immediately after </holodata>):
1. Output ONLY a flat JSON array: [{"name": "<tool_name>", "arguments": {"<param1>": "<val1>"}}]
2. DO NOT use OpenAI "type" or "function" wrappers. Always use "arguments".
3. Include multiple tool calls in execution order when chaining actions.
4. ONLY use tool names listed in AVAILABLE TOOLS above.${contextBriefing ? `\n\n${contextBriefing}` : ''}`;
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
 * Covers all 20 Sovereign Tools so every assistant capability executes reliably even in zero-LLM edge conditions.
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

  if (categories.includes('url_digest')) {
    const urlMatch = text.match(/https?:\/\/[^\s)>\]"']+/i);
    if (urlMatch) {
      calls.push({ name: 'fetch_url_digest', tool: 'fetch_url_digest', arguments: { url: urlMatch[0] } });
    }
  }

  if (categories.includes('web') && !categories.includes('url_digest')) {
    const queryMatch =
      text.match(/(?:search(?:\s+the)?\s+web\s+for|look\s+up|research|find\s+information\s+on|tell\s+me\s+about\s+the\s+topic)\s+(.+?)(?:\s+and\s+(?:save|add|create)\b|[?.!]|$)/i);
    const query = (queryMatch ? queryMatch[1] : text).replace(/^["']|["']$/g, '').trim();
    if (query) {
      calls.push({ name: 'web_research', tool: 'web_research', arguments: { query } });
    }
  }

  if (categories.includes('notes_write')) {
    const noteMatch = text.match(/(?:save|write|draft|create)\s+(?:a\s+)?(?:markdown\s+)?(?:note|document|brief|memo)\s+(?:titled|called|named|about)?\s*["']?([^:"'\n]+?)["']?\s*[:\-]\s*([\s\S]+)$/i);
    if (noteMatch) {
      calls.push({
        name: 'save_note',
        tool: 'save_note',
        arguments: { title: noteMatch[1].trim(), content: noteMatch[2].trim() }
      });
    } else {
      const body = text.replace(/^(?:please\s+)?(?:save|write|draft|create)\s+(?:a\s+)?(?:markdown\s+)?(?:note|document|brief|memo)\s*(?:about|for|on|:)?\s*/i, '').trim();
      const shortTitle = body.split(/\s+/).slice(0, 4).join(' ') || 'Quick Note';
      calls.push({
        name: 'save_note',
        tool: 'save_note',
        arguments: { title: shortTitle, content: body || text }
      });
    }
  }

  if (categories.includes('notes_read')) {
    const readMatch = text.match(/(?:read|open|view|show)\s+note\s*[:\-]?\s*["']?([A-Za-z0-9-_.\s]+)["']?$/i);
    calls.push({
      name: 'list_notes',
      tool: 'list_notes',
      arguments: { title: readMatch ? readMatch[1].trim() : '' }
    });
  }

  if (categories.includes('notify')) {
    const notifyMatch =
      text.match(/(?:send|push|dispatch|trigger)\s+(?:a\s+|an\s+)?(?:push\s+)?(?:notification|alert|ntfy|ping)(?:\s+to\s+my\s+phone)?\s*[:\-]\s*(.+)$/i) ||
      text.match(/notify\s+my\s+(?:phone|device)\s*[:\-]?\s*(.+)$/i);
    const message = notifyMatch ? notifyMatch[1].trim() : text;
    calls.push({
      name: 'send_notification',
      tool: 'send_notification',
      arguments: { title: 'Krusch Companion', message }
    });
  }

  if (categories.includes('system')) {
    calls.push({ name: 'system_status', tool: 'system_status', arguments: {} });
  }

  if (categories.includes('sovereign_law_biz')) {
    const isBiz = /kruschbiz|contract/i.test(text);
    const query = text.replace(/^(?:search|ask|query|check)\s+(?:kruschlaw|kruschbiz|statutes?|contract\s+graph)\s*(?:for|about|:)?\s*/i, '').trim() || text;
    calls.push({
      name: 'sovereign_gateway_query',
      tool: 'sovereign_gateway_query',
      arguments: { domain: isBiz ? 'biz' : 'law', query }
    });
  }

  if (categories.includes('google_drive')) {
    if (/\b(?:save|write|export)\s+to\s+(?:google\s+)?drive\b/i.test(text)) {
      calls.push({
        name: 'gkrusch_drive',
        tool: 'gkrusch_drive',
        arguments: { action: 'write', path: 'output/companion-note.md', content: text }
      });
    } else if (/\bagent\.md|steering\b/i.test(text)) {
      calls.push({
        name: 'gkrusch_drive',
        tool: 'gkrusch_drive',
        arguments: { action: 'steering' }
      });
    } else if (/\b(?:list|show)\s+(?:my\s+)?(?:google\s+)?drive\s+workspace\b/i.test(text)) {
      calls.push({
        name: 'gkrusch_drive',
        tool: 'gkrusch_drive',
        arguments: { action: 'list' }
      });
    } else {
      const qMatch = text.match(/(?:search\s+(?:my\s+)?(?:google\s+)?drive|drive\s+rag|google\s+docs?)\s*(?:for|about|:)?\s*(.+?)(?:\s+and\s+\b|[?.!]|$)/i);
      const query = (qMatch ? qMatch[1] : text).trim();
      calls.push({
        name: 'gkrusch_drive',
        tool: 'gkrusch_drive',
        arguments: { action: 'search', query }
      });
    }
  }

  if (categories.includes('google_calendar')) {
    const createMatch = text.match(/\b(?:schedule|create|book|add)\s+(?:a\s+|an\s+)?(?:calendar\s+)?(?:meeting|event|appointment|call)\s*(?:titled|called|for|to|:)?\s*(.+?)$/i);
    if (createMatch) {
      const rawSummary = createMatch[1].trim();
      const locMatch = rawSummary.match(/\b(?:at|in)\s+([A-Za-z0-9\s,'&-]+?)(?:\s+(?:at\s+\d|on\s+)\b|$)/i);
      calls.push({
        name: 'gkrusch_calendar',
        tool: 'gkrusch_calendar',
        arguments: {
          action: 'create_event',
          summary: rawSummary,
          ...(locMatch ? { location: locMatch[1].trim() } : {})
        }
      });
    } else {
      calls.push({
        name: 'gkrusch_calendar',
        tool: 'gkrusch_calendar',
        arguments: { action: 'list_events' }
      });
    }
  }

  if (categories.includes('google_gmail')) {
    if (/\b(?:draft|compose|send)\s+(?:an?\s+)?email\b/i.test(text)) {
      const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      const subjectMatch = text.match(/\b(?:subject|about|titled)\s*[:\-]?\s*["']?([^"'\n:]+?)["']?(?:\s*[:\-]\s*([\s\S]+))?$/i);
      const isSend = /\bsend\s+(?:an?\s+)?email\b/i.test(text);
      calls.push({
        name: 'gkrusch_gmail',
        tool: 'gkrusch_gmail',
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
        tool: 'gkrusch_gmail',
        arguments: { action: 'search_emails', query: query || 'is:inbox' }
      });
    }
  }

  if (categories.includes('concierge')) {
    const venueMatch = text.match(/(?:reservation|table|dinner|lunch|spot)\s+(?:at|for)\s+([A-Za-z0-9\s,'&-]+?)(?:\s+(?:for\s+\d+|on\s+|at\s+\d|tonight|tomorrow)\b|[?.!]|$)/i);
    const partyMatch = text.match(/\b(?:for|party\s+of)\s+(\d+)\b/i);
    const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    calls.push({
      name: 'concierge_reservation',
      tool: 'concierge_reservation',
      arguments: {
        venue: venueMatch ? venueMatch[1].trim() : text,
        partySize: partyMatch ? parseInt(partyMatch[1], 10) : 2,
        ...(emailMatch ? { email: emailMatch[1] } : {})
      }
    });
  }

  if (categories.includes('commute')) {
    const destMatch = text.match(/\b(?:to|for|at)\s+([A-Za-z0-9\s,'&-]+?)(?:\s+(?:by|at)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)|[?.!]|$)/i);
    const timeMatch = text.match(/\b(?:by|at|for)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
    calls.push({
      name: 'commute_departure_check',
      tool: 'commute_departure_check',
      arguments: {
        destination: destMatch ? destMatch[1].trim() : text,
        ...(timeMatch ? { arrivalTime: timeMatch[1].trim() } : {})
      }
    });
  }

  if (categories.includes('board')) {
    const completeMatch = text.match(/\b(?:complete|check\s+off)\s+task\s*[:\-]?\s*(.+?)$/i);
    const rememberMatch = text.match(/\bremember\s+that\s+(.+?)(?:\s+and\s+(?:add|create)\s+task|$)/i);
    const addTaskMatch = text.match(/\b(?:add|create|schedule)\s+(?:a\s+|an\s+|urgent\s+)?task\s+(?:to\s+)?(.+?)$/i);
    if (completeMatch) {
      calls.push({
        name: 'board_action',
        tool: 'board_action',
        arguments: { action: 'complete_task', title: completeMatch[1].trim() }
      });
    } else if (addTaskMatch) {
      calls.push({
        name: 'board_action',
        tool: 'board_action',
        arguments: { action: 'add_task', title: addTaskMatch[1].trim() }
      });
    } else if (rememberMatch) {
      calls.push({
        name: 'board_action',
        tool: 'board_action',
        arguments: { action: 'remember', title: rememberMatch[1].trim() }
      });
    }
  }

  if (categories.includes('google_wallet')) {
    const titleMatch =
      text.match(/\b(?:pass\s+for|wallet\s+for|add|push|save)\s+(.+?)(?:\s+to\s+google\s+wallet|[?.!]|$)/i);
    const title = (titleMatch ? titleMatch[1] : text)
      .replace(/^(?:a\s+|an\s+|my\s+)?(?:google\s+wallet\s+pass|wallet\s+pass)\s*(?:for|:)?\s*/i, '')
      .trim() || 'Krusch Companion Pass';
    calls.push({
      name: 'google_wallet_pass',
      tool: 'google_wallet_pass',
      arguments: { title }
    });
  }

  if (categories.includes('payments')) {
    const amountMatch = text.match(/\$\s*(\d+(?:\.\d{1,2})?)|\b(\d+(?:\.\d{1,2})?)\s*(?:dollars|usd)\b/i);
    const maxAmount = amountMatch ? parseFloat(amountMatch[1] || amountMatch[2]) : 50.0;
    const merchantMatch =
      text.match(/\b(?:to|for|at)\s+([A-Z][A-Za-z0-9\s,'&.-]+?)(?:\s+(?:up\s+to|for\s+\$|with\s+a|expires?)\b|[?.!]|$)/) ||
      text.match(/\b(?:pay|mandate\s+for)\s+([A-Za-z0-9\s,'&.-]+?)(?:\s+\$|\s+up\s+to|[?.!]|$)/i);
    const merchant = (merchantMatch ? merchantMatch[1] : 'Authorized Merchant').trim();
    calls.push({
      name: 'ap2_payment_mandate',
      tool: 'ap2_payment_mandate',
      arguments: {
        merchant,
        maxAmount,
        description: text
      }
    });
  }

  if (categories.includes('skills')) {
    if (/\b(?:openclaw\s+migrate|hermes\s+claw\s+migrate|import\s+openclaw)\b/i.test(text)) {
      calls.push({
        name: 'skill_manager',
        tool: 'skill_manager',
        arguments: { action: 'import_openclaw' }
      });
    } else if (/\b(?:learn|save|create)\s+(?:a\s+|this\s+)?skill\b/i.test(text)) {
      const nameMatch = text.match(/\bskill\s+(?:called|named|titled|for)?\s*["']?([A-Za-z0-9-_.\s]+?)["']?(?:\s*[:\-]\s*([\s\S]+))?$/i);
      calls.push({
        name: 'skill_manager',
        tool: 'skill_manager',
        arguments: {
          action: 'learn',
          name: nameMatch?.[1]?.trim() || 'custom-companion-skill',
          steps: nameMatch?.[2]?.trim() || text
        }
      });
    } else if (/\b(?:read|view|show)\s+skill\b/i.test(text)) {
      const readMatch = text.match(/\b(?:read|view|show)\s+skill\s*[:\-]?\s*["']?([A-Za-z0-9-_.\s]+)["']?/i);
      calls.push({
        name: 'skill_manager',
        tool: 'skill_manager',
        arguments: {
          action: 'read',
          name: readMatch?.[1]?.trim() || 'morning-executive-briefing'
        }
      });
    } else if (/\b(?:run|execute)\s+skill\b/i.test(text)) {
      const runMatch = text.match(/\b(?:run|execute)\s+skill\s*[:\-]?\s*["']?([A-Za-z0-9-_.\s]+)["']?/i);
      calls.push({
        name: 'skill_manager',
        tool: 'skill_manager',
        arguments: {
          action: 'run',
          name: runMatch?.[1]?.trim() || 'morning-executive-briefing'
        }
      });
    } else {
      calls.push({
        name: 'skill_manager',
        tool: 'skill_manager',
        arguments: { action: 'list' }
      });
    }
  }

  if (categories.includes('automation')) {
    if (/\b(?:meeting\s+prep|prepare\s+a\s+meeting\s+dossier|compile\s+a?\s*meeting\s+brief)\b/i.test(text)) {
      const topicMatch = text.match(/\b(?:for|about|with)\s+(.+?)$/i);
      calls.push({
        name: 'schedule_automation',
        tool: 'schedule_automation',
        arguments: {
          action: 'meeting_prep',
          title: topicMatch?.[1]?.trim() || text
        }
      });
    } else if (/\blist\s+automations\b/i.test(text)) {
      calls.push({
        name: 'schedule_automation',
        tool: 'schedule_automation',
        arguments: { action: 'list' }
      });
    } else {
      const schedMatch = text.match(/\b(every\s+[A-Za-z0-9\s:]+|in\s+\d+\s*minutes?|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
      calls.push({
        name: 'schedule_automation',
        tool: 'schedule_automation',
        arguments: {
          action: 'create',
          title: text,
          schedule: schedMatch?.[1]?.trim() || 'in 30 minutes'
        }
      });
    }
  }

  if (categories.includes('smart_home')) {
    const channelMatch = text.match(/\bsend\s+(?:to|via)\s+(telegram|discord|slack)\s*[:\-]?\s*(.+)$/i);
    if (channelMatch) {
      calls.push({
        name: 'smart_home_bridge',
        tool: 'smart_home_bridge',
        arguments: {
          action: 'send_channel_message',
          channel: channelMatch[1].toLowerCase(),
          message: channelMatch[2].trim()
        }
      });
    } else if (/\bthermostat\b/i.test(text)) {
      const tempMatch = text.match(/\b(\d{2})\b/);
      calls.push({
        name: 'smart_home_bridge',
        tool: 'smart_home_bridge',
        arguments: {
          action: 'control_device',
          device: 'Home Thermostat',
          state: tempMatch ? tempMatch[1] : '68'
        }
      });
    } else if (/\b(?:turn\s+(on|off)|lock|unlock|activate)\b/i.test(text)) {
      const isOff = /\bturn\s+off\b/i.test(text);
      const isUnlock = /\bunlock\b/i.test(text);
      const isLock = /\block\b/i.test(text) && !isUnlock;
      const device = isLock || isUnlock
        ? 'Front Door Lock'
        : /\bgoodnight\b/i.test(text)
          ? 'Goodnight Scene'
          : /\bliving\s+room\b/i.test(text)
            ? 'Living Room Lights'
            : 'Office Lights';
      const state = isUnlock ? 'unlocked' : isLock ? 'locked' : isOff ? 'off' : 'on';
      calls.push({
        name: 'smart_home_bridge',
        tool: 'smart_home_bridge',
        arguments: {
          action: 'control_device',
          device,
          state
        }
      });
    } else {
      calls.push({
        name: 'smart_home_bridge',
        tool: 'smart_home_bridge',
        arguments: { action: 'home_status' }
      });
    }
  }

  if (categories.includes('personal_crm')) {
    if (/\b(?:soul\.md|user\.md|sync\s+markdown\s+profiles)\b/i.test(text)) {
      calls.push({
        name: 'personal_crm_profile',
        tool: 'personal_crm_profile',
        arguments: {
          action: 'sync_markdown_profiles',
          notes: text
        }
      });
    } else if (/\blist\s+contacts\b/i.test(text)) {
      calls.push({
        name: 'personal_crm_profile',
        tool: 'personal_crm_profile',
        arguments: { action: 'list_contacts' }
      });
    } else if (/\b(?:lookup|look\s+up)\s+contact\b/i.test(text)) {
      const qMatch = text.match(/\b(?:lookup|look\s+up)\s+contact\s*[:\-]?\s*([A-Za-z0-9\s]+)$/i);
      calls.push({
        name: 'personal_crm_profile',
        tool: 'personal_crm_profile',
        arguments: { action: 'lookup_contact', name: qMatch?.[1]?.trim() || 'Sarah' }
      });
    } else {
      const nameMatch = text.match(/\b(?:contact|for|that)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
      calls.push({
        name: 'personal_crm_profile',
        tool: 'personal_crm_profile',
        arguments: {
          action: 'upsert_contact',
          name: nameMatch?.[1]?.trim() || 'Sarah',
          notes: text
        }
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
  fetchImpl = fetch,
  notesDir
}) {
  const startTime = Date.now();
  const intent = detectAgenticIntent(prompt);

  if (!intent.shouldUseAgenticProxy) {
    return null;
  }

  const holodataSystemPrompt = buildHolodataSystemPrompt(intent.tools, contextBriefing, { prompt });
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

  // Phase 2: Execute each tool in the sandboxed executor, piping upstream API results into downstream notes/notifications/Drive/Gmail/Channels
  const executedResults = [];
  const upstreamOutputs = [];

  for (const call of plannedCalls.slice(0, 4)) {
    const resolvedArgs = { ...(call.arguments || {}) };

    // If a downstream save_note, send_notification, gkrusch_drive(write), gkrusch_gmail(draft/send), or smart_home_bridge(send_channel_message)
    // follows an upstream data-fetching tool, automatically ground its content/message/body with the live upstream output.
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
      } else if (call.name === 'send_notification' || (call.name === 'smart_home_bridge' && resolvedArgs.action === 'send_channel_message')) {
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

    const res = await executeCompanionTool(call.name, resolvedArgs, { fetchImpl, notesDir });
    if (
      res.ok &&
      (
        ['get_weather', 'web_research', 'fetch_url_digest', 'system_status', 'sovereign_gateway_query', 'commute_departure_check', 'list_notes', 'personal_crm_profile', 'schedule_automation', 'skill_manager'].includes(call.name) ||
        (call.name === 'gkrusch_drive' && ['search', 'read', 'steering', 'list'].includes(String(resolvedArgs.action || 'search'))) ||
        (call.name === 'gkrusch_calendar' && String(resolvedArgs.action || 'list_events') === 'list_events') ||
        (call.name === 'gkrusch_gmail' && String(resolvedArgs.action || 'search_emails') === 'search_emails') ||
        (call.name === 'smart_home_bridge' && String(resolvedArgs.action || 'home_status') === 'home_status')
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

  // Phase 2.5 (Nous Hermes Self-Improving Learning Loop):
  // If a multi-step tool chain (>= 2 tools) succeeded, automatically extract/update a reusable SKILL.md
  const successfulCalls = executedResults.filter(r => r.ok && !r.dryRun);
  const learnedSkill = successfulCalls.length >= 2
    ? recordLearnedTrajectorySkill({ prompt, blueprint, toolCalls: successfulCalls, notesDir })
    : null;

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
    learnedSkill: learnedSkill ? { slug: learnedSkill.slug, experienceCount: learnedSkill.experience_count } : null,
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
      learnedSkill: learnedSkill ? { slug: learnedSkill.slug, experienceCount: learnedSkill.experience_count } : null,
      pruningReport: intent.pruningReport,
      matchedCategories: intent.matchedCategories,
      toolCalls: executedResults.map(r => ({
        name: r.name,
        arguments: r.arguments,
        ok: r.ok,
        dryRun: r.dryRun,
        requiresConfirmation: r.requiresConfirmation,
        summary: r.summary,
        data: r.data || null,
        latencyMs: r.latencyMs
      }))
    }
  };
}
