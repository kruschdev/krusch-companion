import fs from 'fs';

/**
 * Loads a JSON configuration file safely, returning an empty object if missing or corrupt.
 */
export function loadJsonConfig(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {}
  return {};
}
