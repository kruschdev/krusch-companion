import path from 'path';
import { fileURLToPath } from 'url';
import { loadJsonConfig, loadEnvFile, envOr, envInt, envBool, dbPath as resolveDbPath } from './toolkit/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Load project .env and fallback to monorepo root .env without mutating process.env (BUG-01)
const projectEnv = loadEnvFile(path.join(projectRoot, '.env'));
const rootEnv = loadEnvFile(path.resolve(projectRoot, '..', '..', '.env'));
export const parsedEnv = Object.freeze({ ...rootEnv, ...projectEnv });

const fileConfig = loadJsonConfig(path.join(projectRoot, 'config.json'));

export const config = {
  app: {
    name: envOr('APP_NAME', fileConfig.app?.name, 'Krusch Companion'),
    port: envInt('PORT', fileConfig.app?.port, 3004),
    host: envOr('HOST', fileConfig.app?.host, '0.0.0.0'),
    ownerName: envOr('COMPANION_OWNER_NAME', fileConfig.app?.ownerName, 'Owner'),
    personaMode: envOr('COMPANION_PERSONA_MODE', fileConfig.app?.personaMode, 'chief_of_staff')
  },
  cascade: {
    provider: envOr('LLM_PROVIDER', fileConfig.cascade?.provider, 'ollama'),
    resourceMode: envOr('RESOURCE_MODE', fileConfig.cascade?.resourceMode, 'balanced'),
    allowCloudEscalation: envBool('ALLOW_CLOUD_ESCALATION', fileConfig.cascade?.allowCloudEscalation, false),
    l0HeuristicEnabled: fileConfig.cascade?.l0HeuristicEnabled !== false,
    speculativeHedging: fileConfig.cascade?.speculativeHedging !== false,
    edgeModel: envOr('EDGE_MODEL', fileConfig.cascade?.edgeModel, 'qwen2.5-coder:7b'),
    swarmModel: envOr('SWARM_MODEL', fileConfig.cascade?.swarmModel, 'inkling-2-mini:ud-iq4_xs-dspark'),
    swarmFallbackModel: envOr('SWARM_FALLBACK_MODEL', fileConfig.cascade?.swarmFallbackModel, 'qwen3-coder-30b-moe:latest'),
    ollamaUrl: envOr('OLLAMA_HOST', fileConfig.cascade?.ollamaUrl, 'http://127.0.0.1:11434'),
    swarmUrl: envOr('SWARM_VLLM_URL', fileConfig.cascade?.swarmUrl, 'http://kruschdev:18080/v1'),
    swarmFallbackUrl: envOr('SWARM_FALLBACK_URL', fileConfig.cascade?.swarmFallbackUrl, 'http://kruschserv:18080/v1'),
    colabBurstEnabled: envBool('COLAB_BURST_ENABLED', fileConfig.cascade?.colabBurstEnabled, true),
    colabBurstUrl: envOr('COLAB_BURST_URL', fileConfig.cascade?.colabBurstUrl, 'http://127.0.0.1:11435/v1'),
    colabBurstModel: envOr('COLAB_BURST_MODEL', fileConfig.cascade?.colabBurstModel, 'gpt-oss:120b'),
    geminiApiKey: envOr('GEMINI_API_KEY', fileConfig.cascade?.geminiApiKey, ''),
    geminiModel: envOr('GEMINI_MODEL', fileConfig.cascade?.geminiModel, 'gemini-2.5-flash'),
    openrouterApiKey: envOr('OPENROUTER_API_KEY', fileConfig.cascade?.openrouterApiKey, ''),
    openrouterModel: envOr('OPENROUTER_MODEL', fileConfig.cascade?.openrouterModel, 'qwen/qwen-2.5-72b-instruct'),
    frontierModel: envOr('FRONTIER_MODEL', fileConfig.cascade?.frontierModel, 'z-ai/glm-5.3'),
    openrouterBaseUrl: envOr('OPENROUTER_BASE_URL', fileConfig.cascade?.openrouterBaseUrl, 'https://openrouter.ai/api/v1'),
    openrouterZeroDataRetention: envBool('OPENROUTER_ZDR', fileConfig.cascade?.openrouterZeroDataRetention, true)
  },
  db: {
    path: envOr('DB_PATH', null, '') || path.resolve(projectRoot, fileConfig.db?.path || './data/companion.db')
  },
  dbPath() {
    return resolveDbPath(this.db.path);
  },
  context: {
    maxTokenBudget: envInt('CONTEXT_MAX_TOKENS', fileConfig.context?.maxTokenBudget, 3000),
    decayDays: envInt('CONTEXT_DECAY_DAYS', fileConfig.context?.decayDays, 30)
  },
  whisper: {
    host: envOr('WHISPER_HOST', fileConfig.whisper?.host, 'localhost'),
    port: envInt('WHISPER_PORT', fileConfig.whisper?.port, 9000),
    enabled: fileConfig.whisper?.enabled !== false
  }
};

/**
 * Validate resolved runtime configuration and return structured diagnostics.
 */
export function validateCompanionConfig(cfg = config) {
  const issues = [];
  if (!cfg?.app?.port || Number.isNaN(Number(cfg.app.port)) || cfg.app.port < 1 || cfg.app.port > 65535) {
    issues.push('Invalid app.port: must be an integer between 1 and 65535');
  }
  if (!cfg?.app?.ownerName || typeof cfg.app.ownerName !== 'string') {
    issues.push('Invalid app.ownerName: COMPANION_OWNER_NAME must be a non-empty string');
  }
  if (!cfg?.app?.personaMode || typeof cfg.app.personaMode !== 'string') {
    issues.push('Invalid app.personaMode: COMPANION_PERSONA_MODE must be a non-empty string');
  }
  if (!cfg?.cascade?.ollamaUrl || !/^https?:\/\//i.test(cfg.cascade.ollamaUrl)) {
    issues.push('Invalid cascade.ollamaUrl: must be an HTTP(S) URL');
  }
  if (!cfg?.cascade?.swarmUrl || !/^https?:\/\//i.test(cfg.cascade.swarmUrl)) {
    issues.push('Invalid cascade.swarmUrl: must be an HTTP(S) URL');
  }
  if (cfg?.cascade?.swarmFallbackUrl && !/^https?:\/\//i.test(cfg.cascade.swarmFallbackUrl)) {
    issues.push('Invalid cascade.swarmFallbackUrl: must be an HTTP(S) URL when set');
  }
  if (cfg?.cascade?.colabBurstUrl && !/^https?:\/\//i.test(cfg.cascade.colabBurstUrl)) {
    issues.push('Invalid cascade.colabBurstUrl: must be an HTTP(S) URL when set');
  }
  if (!cfg?.db?.path || typeof cfg.db.path !== 'string') {
    issues.push('Invalid db.path: must be a non-empty file path string');
  }
  return {
    ok: issues.length === 0,
    issues
  };
}

export const KNOWN_EXTENSION_ENV_FLAGS = Object.freeze(
  new Set([
    'ENABLE_KRUSCH_FS_EXTENSION',
    'ENABLE_VISION_EXTENSION',
    'ENABLE_FINANCE_EXTENSION',
    'ENABLE_HEALTH_EXTENSION',
    'ENABLE_MEDIA_EXTENSION',
    'ENABLE_SKYLIGHT_CONNECTOR',
    'ENABLE_BROWSER_EXTENSION',
    'ENABLE_SELFGRAPH_EXTENSION'
  ])
);

/**
 * Resolve an extension enablement flag across `process.env` and non-mutating `.env` (`parsedEnv`),
 * failing loudly on unknown/typo'd flag names or unparseable boolean values (`BUG-01`).
 */
export function resolveExtensionEnvFlag(flagName, { allowCustom = false, envSource = parsedEnv } = {}) {
  if (typeof flagName !== 'string' || !/^ENABLE_[A-Z0-9_]+$/.test(flagName)) {
    throw new Error(`Invalid extension envFlag "${String(flagName)}": expected ENABLE_<UPPER_SNAKE_CASE>`);
  }
  if (!allowCustom && !KNOWN_EXTENSION_ENV_FLAGS.has(flagName)) {
    throw new Error(
      `Unknown extension envFlag "${flagName}": add it to KNOWN_EXTENSION_ENV_FLAGS in src/config.js or pass allowCustom=true`
    );
  }
  const raw =
    process.env[flagName] !== undefined && process.env[flagName] !== ''
      ? process.env[flagName]
      : envSource?.[flagName];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return false;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  throw new Error(
    `Invalid boolean value "${String(raw)}" for extension flag ${flagName}: expected "1", "0", "true", or "false"`
  );
}

export default config;
