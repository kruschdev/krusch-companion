import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadJsonConfig } from './toolkit/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function loadEnvFile(envPath) {
  try {
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;
      const key = line.slice(0, eqIdx).trim();
      const val = line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (key && process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch (err) {
    if (process.env.KRUSCH_DEBUG === '1') {
      console.debug(`[KruschConfig:loadEnvFile] ${envPath}: ${err.message}`);
    }
  }
}

// Load project .env and fallback to monorepo root .env (unless running hermetic unit tests)
if (process.env.NODE_ENV !== 'test') {
  loadEnvFile(path.join(projectRoot, '.env'));
  loadEnvFile(path.resolve(projectRoot, '..', '..', '.env'));
}

const fileConfig = loadJsonConfig(path.join(projectRoot, 'config.json'));

export const config = {
  app: {
    name: process.env.APP_NAME || fileConfig.app?.name || 'Krusch Companion',
    port: parseInt(process.env.PORT || fileConfig.app?.port || 3004, 10),
    host: process.env.HOST || fileConfig.app?.host || '0.0.0.0'
  },
  cascade: {
    provider: process.env.LLM_PROVIDER || fileConfig.cascade?.provider || 'ollama',
    allowCloudEscalation:
      process.env.ALLOW_CLOUD_ESCALATION === 'true' ||
      (process.env.ALLOW_CLOUD_ESCALATION !== 'false' && Boolean(fileConfig.cascade?.allowCloudEscalation)),
    l0HeuristicEnabled: fileConfig.cascade?.l0HeuristicEnabled !== false,
    speculativeHedging: fileConfig.cascade?.speculativeHedging !== false,
    edgeModel: process.env.EDGE_MODEL || fileConfig.cascade?.edgeModel || 'qwen2.5-coder:7b',
    swarmModel: process.env.SWARM_MODEL || fileConfig.cascade?.swarmModel || 'qwen3-coder-30b-moe:latest',
    swarmFallbackModel:
      process.env.SWARM_FALLBACK_MODEL || fileConfig.cascade?.swarmFallbackModel || 'hermes3:latest',
    ollamaUrl: process.env.OLLAMA_HOST || fileConfig.cascade?.ollamaUrl || 'http://127.0.0.1:11434',
    swarmUrl: process.env.SWARM_VLLM_URL || fileConfig.cascade?.swarmUrl || 'http://kruschdev:11434/v1',
    swarmFallbackUrl:
      process.env.SWARM_FALLBACK_URL || fileConfig.cascade?.swarmFallbackUrl || 'http://kruschserv:11434/v1',
    openrouterApiKey: process.env.OPENROUTER_API_KEY || fileConfig.cascade?.openrouterApiKey || '',
    openrouterModel: process.env.OPENROUTER_MODEL || fileConfig.cascade?.openrouterModel || 'qwen/qwen-2.5-72b-instruct',
    frontierModel:
      process.env.FRONTIER_MODEL || fileConfig.cascade?.frontierModel || 'z-ai/glm-5.3',
    openrouterBaseUrl: process.env.OPENROUTER_BASE_URL || fileConfig.cascade?.openrouterBaseUrl || 'https://openrouter.ai/api/v1',
    openrouterZeroDataRetention: process.env.OPENROUTER_ZDR !== 'false' && (fileConfig.cascade?.openrouterZeroDataRetention !== false)
  },
  db: {
    path: process.env.DB_PATH || path.resolve(projectRoot, fileConfig.db?.path || './data/companion.db')
  },
  context: {
    maxTokenBudget: parseInt(process.env.CONTEXT_MAX_TOKENS || fileConfig.context?.maxTokenBudget || 3000, 10),
    decayDays: parseInt(process.env.CONTEXT_DECAY_DAYS || fileConfig.context?.decayDays || 30, 10)
  },
  whisper: {
    host: process.env.WHISPER_HOST || fileConfig.whisper?.host || 'localhost',
    port: parseInt(process.env.WHISPER_PORT || fileConfig.whisper?.port || 9000, 10),
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
