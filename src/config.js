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
    swarmModel: envOr('SWARM_MODEL', fileConfig.cascade?.swarmModel, 'qwen3-coder-30b-moe:latest'),
    swarmFallbackModel: envOr('SWARM_FALLBACK_MODEL', fileConfig.cascade?.swarmFallbackModel, 'hermes3:latest'),
    ollamaUrl: envOr('OLLAMA_HOST', fileConfig.cascade?.ollamaUrl, 'http://127.0.0.1:11434'),
    swarmUrl: envOr('SWARM_VLLM_URL', fileConfig.cascade?.swarmUrl, 'http://kruschdev:11434/v1'),
    swarmFallbackUrl: envOr('SWARM_FALLBACK_URL', fileConfig.cascade?.swarmFallbackUrl, 'http://kruschserv:11434/v1'),
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
  if (!cfg?.db?.path || typeof cfg.db.path !== 'string') {
    issues.push('Invalid db.path: must be a non-empty file path string');
  }
  return {
    ok: issues.length === 0,
    issues
  };
}

export default config;
