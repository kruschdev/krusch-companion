import fs from 'fs';

/**
 * Loads a JSON configuration file safely, returning an empty object if missing or corrupt.
 */
export function loadJsonConfig(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (err) {
    console.warn(`[Config] Failed loading ${filePath}: ${err.message}`);
  }
  return {};
}

const loadedEnvStore = {};

/**
 * Safely loads key=value pairs from a .env file, returning a frozen key-value map
 * without mutating process.env (BUG-01).
 */
export function loadEnvFile(envPath, { skipInTest = true } = {}) {
  const parsed = {};
  if (
    skipInTest &&
    (process.env.NODE_ENV === 'test' ||
      Boolean(process.env.NODE_TEST_CONTEXT) ||
      process.execArgv.includes('--test'))
  ) {
    return Object.freeze(parsed);
  }
  try {
    if (!fs.existsSync(envPath)) return Object.freeze(parsed);
    const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;
      const key = line.slice(0, eqIdx).trim();
      const val = line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (key) {
        parsed[key] = val;
        if (loadedEnvStore[key] === undefined) {
          loadedEnvStore[key] = val;
        }
      }
    }
  } catch (err) {
    console.warn(`[Config:loadEnvFile] ${envPath}: ${err.message}`);
  }
  return Object.freeze(parsed);
}

/**
 * Return a frozen snapshot of all keys loaded via loadEnvFile.
 */
export function getLoadedEnv() {
  return Object.freeze({ ...loadedEnvStore });
}

function readEnvValue(envKey, envSource = loadedEnvStore) {
  if (process.env[envKey] !== undefined && process.env[envKey] !== '') {
    return process.env[envKey];
  }
  if (envSource && envSource[envKey] !== undefined && envSource[envKey] !== '') {
    return envSource[envKey];
  }
  return undefined;
}

/**
 * Layered string configuration resolver (Env -> File Config -> Default).
 */
export function envOr(envKey, fileVal, defaultVal = '', envSource = loadedEnvStore) {
  const raw = readEnvValue(envKey, envSource);
  if (raw !== undefined && raw !== '') return String(raw);
  if (fileVal !== undefined && fileVal !== null && fileVal !== '') return String(fileVal);
  return defaultVal;
}

/**
 * Layered integer configuration resolver (Env -> File Config -> Default).
 */
export function envInt(envKey, fileVal, defaultVal = 0, envSource = loadedEnvStore) {
  const raw = readEnvValue(envKey, envSource);
  if (raw !== undefined && raw !== '') {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (fileVal !== undefined && fileVal !== null) {
    const parsed = parseInt(String(fileVal), 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return defaultVal;
}

/**
 * Layered boolean configuration resolver (Env -> File Config -> Default).
 */
export function envBool(envKey, fileVal, defaultVal = false, envSource = loadedEnvStore) {
  const raw = readEnvValue(envKey, envSource);
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  if (fileVal !== undefined && fileVal !== null) return Boolean(fileVal);
  return defaultVal;
}

/**
 * Resolve the active SQLite database path from environment or fallback config path.
 */
export const dbPath = (fallbackPath = '') => readEnvValue('DB_PATH') || fallbackPath;


