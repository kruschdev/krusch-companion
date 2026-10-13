import path from 'path';
import { fileURLToPath } from 'url';
import { loadJsonConfig } from './toolkit/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const fileConfig = loadJsonConfig(path.join(projectRoot, 'config.json'));

export const config = {
  app: {
    name: process.env.APP_NAME || fileConfig.app?.name || 'Krusch Companion',
    port: parseInt(process.env.PORT || fileConfig.app?.port || 3004, 10),
    host: process.env.HOST || fileConfig.app?.host || '0.0.0.0'
  },
  cascade: {
    provider: process.env.LLM_PROVIDER || fileConfig.cascade?.provider || 'ollama',
    allowCloudEscalation: process.env.ALLOW_CLOUD_ESCALATION === 'true' || fileConfig.cascade?.allowCloudEscalation || false,
    l0HeuristicEnabled: fileConfig.cascade?.l0HeuristicEnabled !== false,
    speculativeHedging: fileConfig.cascade?.speculativeHedging !== false,
    edgeModel: process.env.EDGE_MODEL || fileConfig.cascade?.edgeModel || 'qwen2.5:7b',
    swarmModel: process.env.SWARM_MODEL || fileConfig.cascade?.swarmModel || 'qwen2.5-coder:14b',
    ollamaUrl: process.env.OLLAMA_HOST || fileConfig.cascade?.ollamaUrl || 'http://127.0.0.1:11434',
    swarmUrl: process.env.SWARM_VLLM_URL || fileConfig.cascade?.swarmUrl || 'http://127.0.0.1:8000/v1',
    openrouterApiKey: process.env.OPENROUTER_API_KEY || fileConfig.cascade?.openrouterApiKey || '',
    openrouterModel: process.env.OPENROUTER_MODEL || fileConfig.cascade?.openrouterModel || 'qwen/qwen-2.5-7b-instruct',
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

export default config;
