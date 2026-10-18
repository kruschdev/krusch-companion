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

/**
 * Safely loads key=value pairs from a .env file into process.env without overwriting existing keys.
 */
export function loadEnvFile(envPath, { skipInTest = true } = {}) {
  if (skipInTest && process.env.NODE_ENV === 'test') return;
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
    console.warn(`[Config:loadEnvFile] ${envPath}: ${err.message}`);
  }
}

/**
 * Layered string configuration resolver (Env -> File Config -> Default).
 */
export function envOr(envKey, fileVal, defaultVal = '') {
  const raw = process.env[envKey];
  if (raw !== undefined && raw !== '') return String(raw);
  if (fileVal !== undefined && fileVal !== null && fileVal !== '') return String(fileVal);
  return defaultVal;
}

/**
 * Layered integer configuration resolver (Env -> File Config -> Default).
 */
export function envInt(envKey, fileVal, defaultVal = 0) {
  const raw = process.env[envKey];
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
export function envBool(envKey, fileVal, defaultVal = false) {
  const raw = process.env[envKey];
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  if (fileVal !== undefined && fileVal !== null) return Boolean(fileVal);
  return defaultVal;
}
