/**
 * Krusch Companion Programmatic SDK Entrypoint (`krusch-companion`)
 *
 * Separates reusable SDK primitives (Agentic Proxy, 3-Stage Smart Tool Token Limiter,
 * 4-Tier Cascade Router, KruschContext Working Memory, and Skylight Calendar 2 Connector)
 * from the HTTP Express application server (`src/server.js`).
 */

export { config, validateCompanionConfig } from './config.js';
export {
  COMPANION_TOOLS,
  SKYLIGHT_CALENDAR_TOOL,
  getToolByName,
  executeCompanionTool,
  getAgenticToolStats,
  setAgenticDryRunMode,
  getAgenticDryRunMode
} from './agent/tools.js';
export {
  detectAgenticIntent,
  routeDiverseTools,
  compactToolSchemaForPrompt,
  pruneToolsForPrompt,
  buildHolodataSystemPrompt,
  parseHolodataResponse,
  executeAgenticProxyTurn,
  getFullCatalogSchemaTokens,
  getLastToolPruningReport
} from './agent/agentic-proxy.js';
export {
  dispatchCompanionChat,
  evaluateL0Heuristic,
  setCascadeResourceMode,
  getCascadeResourceMode
} from './router/cascade-client.js';
export {
  rememberMemory,
  getActiveMemories,
  supersedeMemory,
  deleteMemory,
  getSupersededMemories,
  compileStateBriefing,
  getDecayCandidates
} from './context/memory-store.js';
export * from './context/boundary-gate.js';
export {
  getOnboardingState,
  saveOnboardingProfile,
  skipOnboarding,
  STANDARD_ONBOARDING_QUESTIONS
} from './services/onboarding.js';
export {
  handleGoogleHomeTurn,
  broadcastToGoogleHome,
  buildCompanionTtsStreamUrl,
  getGoogleHomeSetupGuide
} from './services/google-home.js';
