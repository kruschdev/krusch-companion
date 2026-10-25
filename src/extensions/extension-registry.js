import { getDb } from '../db/index.js';
import { KRUSCH_FS_EXTENSION_TOOL } from './krusch-fs-extension.js';

/**
 * Create a lazy-loaded proxy tool that exposes full metadata synchronously
 * and dynamically imports its backing implementation on first execution or `ensureAllExtensionsLoaded()`.
 */
function createLazyExtensionTool({
  extensionId,
  name,
  category,
  description,
  parameters,
  required = [],
  loader
}) {
  let loadedTool = null;

  return {
    extensionId,
    name,
    category,
    description,
    parameters,
    required,
    isLazyProxy: true,
    async resolveTool() {
      if (loadedTool) return loadedTool;
      const resolved = await loader();
      if (resolved && typeof resolved.execute === 'function') {
        loadedTool = resolved;
        registerExtensionPlugin({
          extensionId: resolved.extensionId || extensionId,
          name: resolved.displayName || name,
          toolName: resolved.name || name,
          category: resolved.category || category,
          description: resolved.description || description,
          tool: resolved
        });
      }
      return loadedTool;
    },
    async execute(args = {}, options = {}) {
      const tool = await this.resolveTool();
      if (!tool) {
        return {
          ok: false,
          tool: name,
          summary: `Extension tool "${name}" is not available.`
        };
      }
      return tool.execute(args, options);
    }
  };
}

const LAZY_VISION_TOOL = createLazyExtensionTool({
  extensionId: 'gemma4-vision-capture',
  name: 'vision_capture',
  category: 'multimodal_vision',
  description:
    'Opt-in Multimodal Vision & Camera Triage (gemma4:e4b): analyze photos of paper bills, receipts, school flyers, or whiteboards to extract tasks onto Today Board, log expenses, and save notes.',
  parameters: {
    mode: 'string ("auto" | "receipt_or_bill" | "flyer_or_schedule" | "whiteboard_or_notes" | "general_vision")',
    prompt: 'string (Visual question or instructions)',
    base64Image: 'string (Base64-encoded image or data URI)',
    filename: 'string (Image filename)'
  },
  required: ['prompt'],
  loader: async () => {
    const mod = await import('../services/vision.js');
    return mod.VISION_CAPTURE_EXTENSION_TOOL;
  }
});

const LAZY_FINANCE_TOOL = createLazyExtensionTool({
  extensionId: 'finance-subscription-ledger',
  name: 'finance_subscription_ledger',
  category: 'finance_ledger',
  description:
    'Opt-in Subscription, Bill & Receipt Ledger: track recurring subscriptions, log receipt expenses, audit upcoming auto-renewals, and summarize monthly spend.',
  parameters: {
    action:
      'string (REQUIRED: "add_subscription" | "log_receipt" | "list_subscriptions" | "renewal_alerts" | "monthly_summary" | "cancel_subscription")',
    name: 'string (Subscription or merchant name)',
    amount: 'number (Dollar amount)',
    billingCycle: 'string ("monthly" | "yearly" | "weekly")',
    nextRenewalDate: 'string (YYYY-MM-DD renewal date)',
    category: 'string (Expense category)',
    daysAhead: 'number (Renewal alert lookahead window in days, default: 7)'
  },
  required: ['action'],
  loader: async () => {
    const mod = await import('./finance-ledger-extension.js');
    return mod.FINANCE_LEDGER_EXTENSION_TOOL;
  }
});

const LAZY_HEALTH_TOOL = createLazyExtensionTool({
  extensionId: 'health-biometric-sync',
  name: 'health_energy_sync',
  category: 'health_biometrics',
  description:
    'Opt-in Health, Sleep & Biometric Readiness Sync (Apple Health / Oura / Garmin / Whoop): log sleep hours, HRV, and recovery score, or automatically adapt Today Priority Board to match your energy readiness.',
  parameters: {
    action: 'string (REQUIRED: "log_metrics" | "status" | "adapt_board")',
    sleepHours: 'number (Hours slept, e.g. 6.2)',
    sleepScore: 'number (0-100 score)',
    hrvMs: 'number (HRV in ms)',
    steps: 'number (Daily steps)',
    source: 'string (e.g. "apple_health", "oura", "garmin")',
    notes: 'string'
  },
  required: ['action'],
  loader: async () => {
    const mod = await import('./health-media-extension.js');
    return mod.HEALTH_READINESS_EXTENSION_TOOL;
  }
});

const LAZY_MEDIA_TOOL = createLazyExtensionTool({
  extensionId: 'media-jellyfin-controller',
  name: 'media_controller',
  category: 'media_controller',
  description:
    'Opt-in Media, Focus Soundscape & Jellyfin Controller (kruschmedia): play/pause focus soundscapes (brown noise, rain, lofi), search or control Jellyfin media on kruschmedia, and adjust volume.',
  parameters: {
    action: 'string (REQUIRED: "play" | "pause" | "stop" | "status" | "search_jellyfin")',
    query: 'string (Track, soundscape, movie, or show name)',
    volume: 'number (0-100 volume level)',
    provider: 'string ("focus_audio" | "jellyfin" | "spotify")'
  },
  required: ['action'],
  loader: async () => {
    const mod = await import('./health-media-extension.js');
    return mod.MEDIA_CONTROLLER_EXTENSION_TOOL;
  }
});

const LAZY_SKYLIGHT_TOOL = createLazyExtensionTool({
  extensionId: 'skylight-calendar',
  name: 'skylight_calendar',
  category: 'skylight_calendar',
  description:
    'Opt-in Skylight Calendar 2 Family Chore, Star Reward, Meal Plan & Grocery List Connector.',
  parameters: {
    action: 'string (REQUIRED: "status" | "assign_chore" | "complete_chore" | "plan_meal" | "add_grocery")',
    title: 'string (Chore or item title)',
    assignee: 'string (Family member name)',
    stars: 'number (Reward stars)',
    meal: 'string (Meal description)'
  },
  required: ['action'],
  loader: async () => {
    const mod = await import('../agent/tools.js');
    return mod.SKYLIGHT_CALENDAR_TOOL;
  }
});

const LAZY_BROWSER_TOOL = createLazyExtensionTool({
  extensionId: 'chrome-browser-navigator',
  name: 'browser_navigate',
  category: 'browser_navigation',
  description:
    'Opt-in Headless Chrome Browser Navigator & Gemini 4 Argon Visual UI Auditor: navigate dynamic SPAs, execute multi-step click/type interactions, capture full-page screenshots, or run a 375/768/1440px responsive visual audit.',
  parameters: {
    action: 'string (REQUIRED: "navigate" | "interact" | "screenshot" | "audit")',
    url: 'string (REQUIRED: Target https:// URL to open in headless Chrome)',
    steps: 'string (Optional JSON array or semicolon-separated steps, e.g. "click:#submit; type:#search=query")',
    waitForSelector: 'string (Optional CSS selector to wait for before extracting DOM/screenshots)',
    prompt: 'string (Optional visual audit question or extraction goal)'
  },
  required: ['action', 'url'],
  loader: async () => {
    const mod = await import('./browser-navigator-extension.js');
    return mod.BROWSER_NAVIGATOR_EXTENSION_TOOL;
  }
});

/**
 * Canonical V3.8 Opt-In Extension Marketplace Catalog (`INV-EXT-01`).
 */
export const EXTENSION_CATALOG = [
  {
    extensionId: 'krusch-fs-bridge',
    aliases: ['krusch_fs_explorer', 'krusch_fs_extension', 'krusch-fs-explorer', 'krusch-fs', 'filesystem_bridge'],
    name: 'KruschFS Local Document, PDF & Fleet Page Explorer',
    toolName: 'krusch_fs_explorer',
    category: 'filesystem_bridge',
    description: KRUSCH_FS_EXTENSION_TOOL.description,
    envFlag: 'ENABLE_KRUSCH_FS_EXTENSION',
    defaultEnabled: false,
    tool: KRUSCH_FS_EXTENSION_TOOL
  },
  {
    extensionId: 'gemma4-vision-capture',
    aliases: ['vision_capture', 'vision-capture', 'multimodal-vision', 'gemma4-vision', 'multimodal_vision'],
    name: 'Gemma 4 Multimodal Vision & Camera Triage',
    toolName: 'vision_capture',
    category: 'multimodal_vision',
    description: LAZY_VISION_TOOL.description,
    envFlag: 'ENABLE_VISION_EXTENSION',
    defaultEnabled: false,
    tool: LAZY_VISION_TOOL
  },
  {
    extensionId: 'finance-subscription-ledger',
    aliases: ['finance_subscription_ledger', 'finance-subscription-sentinel', 'subscription_bill_tracker', 'finance-ledger', 'finance_ledger'],
    name: 'Sovereign Subscription, Bill & Receipt Ledger',
    toolName: 'finance_subscription_ledger',
    category: 'finance_ledger',
    description: LAZY_FINANCE_TOOL.description,
    envFlag: 'ENABLE_FINANCE_EXTENSION',
    defaultEnabled: false,
    tool: LAZY_FINANCE_TOOL
  },
  {
    extensionId: 'health-biometric-sync',
    aliases: ['health_energy_sync', 'health-readiness', 'health-energy-readiness', 'health_biometrics'],
    name: 'Health, Sleep & Biometric Readiness Sync',
    toolName: 'health_energy_sync',
    category: 'health_biometrics',
    description: LAZY_HEALTH_TOOL.description,
    envFlag: 'ENABLE_HEALTH_EXTENSION',
    defaultEnabled: false,
    tool: LAZY_HEALTH_TOOL
  },
  {
    extensionId: 'media-jellyfin-controller',
    aliases: ['media_controller', 'media-controller', 'jellyfin-media-controller'],
    name: 'Focus Soundscape & Jellyfin Media Controller',
    toolName: 'media_controller',
    category: 'media_controller',
    description: LAZY_MEDIA_TOOL.description,
    envFlag: 'ENABLE_MEDIA_EXTENSION',
    defaultEnabled: false,
    tool: LAZY_MEDIA_TOOL
  },
  {
    extensionId: 'skylight-calendar',
    aliases: ['skylight_calendar', 'skylight_calendar_hub', 'skylight', 'messaging-shortcut-bridge'],
    name: 'Skylight Calendar 2 Family Chore & Meal Connector',
    toolName: 'skylight_calendar',
    category: 'skylight_calendar',
    description: LAZY_SKYLIGHT_TOOL.description,
    envFlag: 'ENABLE_SKYLIGHT_CONNECTOR',
    defaultEnabled: false,
    tool: LAZY_SKYLIGHT_TOOL
  },
  {
    extensionId: 'chrome-browser-navigator',
    aliases: ['browser_navigate', 'browser-navigator', 'chrome-navigator', 'browser_navigation', 'argon-browser-audit'],
    name: 'Headless Chrome Browser Navigator & Gemini 4 Argon UI Auditor',
    toolName: 'browser_navigate',
    category: 'browser_navigation',
    description: LAZY_BROWSER_TOOL.description,
    envFlag: 'ENABLE_BROWSER_EXTENSION',
    defaultEnabled: false,
    tool: LAZY_BROWSER_TOOL
  }
];

const REGISTERED_PLUGINS_BY_ID = new Map();
const REGISTERED_TOOLS_BY_NAME = new Map();
const EXTENSION_ALIAS_MAP = new Map();

function indexCatalogEntry(entry) {
  REGISTERED_PLUGINS_BY_ID.set(entry.extensionId, entry);
  REGISTERED_TOOLS_BY_NAME.set(entry.toolName, entry.tool);
  EXTENSION_ALIAS_MAP.set(entry.extensionId.toLowerCase(), entry.extensionId);
  EXTENSION_ALIAS_MAP.set(entry.toolName.toLowerCase(), entry.extensionId);
  if (Array.isArray(entry.aliases)) {
    for (const alias of entry.aliases) {
      EXTENSION_ALIAS_MAP.set(String(alias).toLowerCase(), entry.extensionId);
    }
  }
}

for (const item of EXTENSION_CATALOG) {
  indexCatalogEntry(item);
}

/**
 * Resolve any extensionId, toolName, or alias to its canonical `extensionId`.
 */
function resolveCanonicalExtensionId(idOrToolName) {
  if (!idOrToolName) return null;
  const key = String(idOrToolName).trim().toLowerCase();
  if (!key) return null;
  return EXTENSION_ALIAS_MAP.get(key) || null;
}

/**
 * Register or update an extension plugin manifest and its executable tool definition.
 */
export function registerExtensionPlugin(manifest = {}) {
  const toolObj = manifest.tool || (typeof manifest.execute === 'function' ? manifest : null);
  const toolName = String(manifest.toolName || manifest.tool_name || toolObj?.name || manifest.name || '').trim();
  if (!toolName) return null;

  const existingCanonicalId =
    resolveCanonicalExtensionId(manifest.extensionId || manifest.extension_id) ||
    resolveCanonicalExtensionId(toolName);

  const extensionId =
    existingCanonicalId ||
    String(manifest.extensionId || manifest.extension_id || toolObj?.extensionId || toolName).trim();

  const existingEntry = REGISTERED_PLUGINS_BY_ID.get(extensionId);

  const mergedEntry = {
    extensionId,
    aliases: Array.from(
      new Set([
        ...(existingEntry?.aliases || []),
        ...(Array.isArray(manifest.aliases) ? manifest.aliases : []),
        manifest.extensionId,
        toolObj?.extensionId,
        toolName
      ].filter(Boolean))
    ),
    name:
      existingEntry?.name ||
      manifest.displayName ||
      (manifest.name && manifest.name !== toolName ? manifest.name : null) ||
      toolName,
    toolName,
    category: manifest.category || toolObj?.category || existingEntry?.category || 'extension',
    description: manifest.description || toolObj?.description || existingEntry?.description || '',
    envFlag: manifest.envFlag || existingEntry?.envFlag || null,
    defaultEnabled: Boolean(manifest.defaultEnabled ?? existingEntry?.defaultEnabled ?? false),
    tool: toolObj
      ? {
          ...toolObj,
          extensionId,
          name: toolName,
          category: toolObj.category || manifest.category || existingEntry?.category || 'extension'
        }
      : existingEntry?.tool || null
  };

  indexCatalogEntry(mergedEntry);

  const catalogIdx = EXTENSION_CATALOG.findIndex(c => c.extensionId === extensionId);
  if (catalogIdx >= 0) {
    EXTENSION_CATALOG[catalogIdx] = mergedEntry;
  } else {
    EXTENSION_CATALOG.push(mergedEntry);
  }

  return mergedEntry;
}

/**
 * Lazily load all companion extension modules (`vision.js`, `finance-ledger-extension.js`, `health-media-extension.js`)
 * and register their concrete tool implementations.
 */
export async function ensureAllExtensionsLoaded() {
  const loaders = [
    async () => {
      const mod = await import('../services/vision.js');
      if (mod?.VISION_CAPTURE_EXTENSION_TOOL) {
        registerExtensionPlugin({
          extensionId: 'gemma4-vision-capture',
          aliases: [mod.VISION_CAPTURE_EXTENSION_TOOL.extensionId, 'vision-capture', 'vision_capture'],
          toolName: mod.VISION_CAPTURE_EXTENSION_TOOL.name,
          category: mod.VISION_CAPTURE_EXTENSION_TOOL.category,
          description: mod.VISION_CAPTURE_EXTENSION_TOOL.description,
          tool: mod.VISION_CAPTURE_EXTENSION_TOOL
        });
      }
    },
    async () => {
      const mod = await import('./finance-ledger-extension.js');
      if (mod?.FINANCE_LEDGER_EXTENSION_TOOL) {
        registerExtensionPlugin({
          extensionId: 'finance-subscription-ledger',
          aliases: [mod.FINANCE_LEDGER_EXTENSION_TOOL.extensionId, 'finance-ledger', 'finance_subscription_ledger'],
          toolName: mod.FINANCE_LEDGER_EXTENSION_TOOL.name,
          category: mod.FINANCE_LEDGER_EXTENSION_TOOL.category,
          description: mod.FINANCE_LEDGER_EXTENSION_TOOL.description,
          tool: mod.FINANCE_LEDGER_EXTENSION_TOOL
        });
      }
    },
    async () => {
      const mod = await import('./health-media-extension.js');
      if (mod?.HEALTH_READINESS_EXTENSION_TOOL) {
        registerExtensionPlugin({
          extensionId: 'health-biometric-sync',
          aliases: [
            mod.HEALTH_READINESS_EXTENSION_TOOL.extensionId,
            'health-readiness',
            'health-energy-readiness',
            'health_energy_sync'
          ],
          toolName: mod.HEALTH_READINESS_EXTENSION_TOOL.name,
          category: mod.HEALTH_READINESS_EXTENSION_TOOL.category,
          description: mod.HEALTH_READINESS_EXTENSION_TOOL.description,
          tool: mod.HEALTH_READINESS_EXTENSION_TOOL
        });
      }
      if (mod?.MEDIA_CONTROLLER_EXTENSION_TOOL) {
        registerExtensionPlugin({
          extensionId: 'media-jellyfin-controller',
          aliases: [
            mod.MEDIA_CONTROLLER_EXTENSION_TOOL.extensionId,
            'media-controller',
            'jellyfin-media-controller',
            'media_controller'
          ],
          toolName: mod.MEDIA_CONTROLLER_EXTENSION_TOOL.name,
          category: mod.MEDIA_CONTROLLER_EXTENSION_TOOL.category,
          description: mod.MEDIA_CONTROLLER_EXTENSION_TOOL.description,
          tool: mod.MEDIA_CONTROLLER_EXTENSION_TOOL
        });
      }
    },
    async () => {
      const mod = await import('../agent/tools.js');
      if (typeof mod?.registerExternalToolResolver === 'function') {
        mod.registerExternalToolResolver(getExtensionToolByName);
      }
      if (mod?.SKYLIGHT_CALENDAR_TOOL) {
        registerExtensionPlugin({
          extensionId: 'skylight-calendar',
          aliases: ['skylight_calendar', 'skylight_calendar_hub', 'skylight', 'messaging-shortcut-bridge'],
          toolName: 'skylight_calendar',
          category: 'skylight_calendar',
          description: mod.SKYLIGHT_CALENDAR_TOOL.description,
          tool: {
            ...mod.SKYLIGHT_CALENDAR_TOOL,
            extensionId: 'skylight-calendar'
          }
        });
      }
    },
    async () => {
      const mod = await import('./browser-navigator-extension.js');
      if (mod?.BROWSER_NAVIGATOR_EXTENSION_TOOL) {
        registerExtensionPlugin({
          extensionId: 'chrome-browser-navigator',
          aliases: [
            mod.BROWSER_NAVIGATOR_EXTENSION_TOOL.extensionId,
            'browser_navigate',
            'browser-navigator',
            'chrome-navigator',
            'browser_navigation'
          ],
          toolName: mod.BROWSER_NAVIGATOR_EXTENSION_TOOL.name,
          category: mod.BROWSER_NAVIGATOR_EXTENSION_TOOL.category,
          description: mod.BROWSER_NAVIGATOR_EXTENSION_TOOL.description,
          tool: mod.BROWSER_NAVIGATOR_EXTENSION_TOOL
        });
      }
    }
  ];

  await Promise.allSettled(loaders.map(fn => fn()));
  return getRegisteredExtensionTools();
}

// Kick off background loading of sibling extension modules without blocking synchronous imports
ensureAllExtensionsLoaded().catch(() => {});

/**
 * Return all registered extension tool objects (both enabled and disabled).
 */
export function getRegisteredExtensionTools() {
  return Array.from(REGISTERED_PLUGINS_BY_ID.values())
    .map(entry => entry.tool)
    .filter(Boolean);
}

/**
 * Ensure the `companion_extensions` SQLite table exists and seed default marketplace entries.
 */
export function ensureExtensionRegistryTable() {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS companion_extensions (
      extension_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      config_json TEXT DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const insertStmt = database.prepare(`
    INSERT OR IGNORE INTO companion_extensions (
      extension_id, name, tool_name, category, description, enabled, config_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const entry of REGISTERED_PLUGINS_BY_ID.values()) {
    const envEnabled =
      entry.envFlag &&
      (process.env[entry.envFlag] === '1' || String(process.env[entry.envFlag]).toLowerCase() === 'true');
    const initialEnabled = envEnabled || entry.defaultEnabled ? 1 : 0;
    insertStmt.run(
      entry.extensionId,
      entry.name,
      entry.toolName,
      entry.category,
      entry.description,
      initialEnabled,
      '{}'
    );
  }
}

function formatExtensionRow(row) {
  if (!row) return null;
  const entry = REGISTERED_PLUGINS_BY_ID.get(row.extension_id);
  let parsedConfig = {};
  try {
    parsedConfig = row.config_json ? JSON.parse(row.config_json) : {};
  } catch {
    parsedConfig = {};
  }

  const envEnabled =
    entry?.envFlag &&
    (process.env[entry.envFlag] === '1' || String(process.env[entry.envFlag]).toLowerCase() === 'true');
  const isEnabled = Boolean(row.enabled) || Boolean(envEnabled);

  return {
    id: row.extension_id,
    extension_id: row.extension_id,
    extensionId: row.extension_id,
    name: row.name,
    tool_name: row.tool_name,
    toolName: row.tool_name,
    category: row.category,
    description: row.description,
    enabled: isEnabled,
    config_json: row.config_json || '{}',
    config: parsedConfig,
    updated_at: row.updated_at,
    updatedAt: row.updated_at,
    parameters: entry?.tool?.parameters || {},
    required: entry?.tool?.required || []
  };
}

/**
 * List all available extensions in the Krusch Companion Extension Marketplace.
 */
export function listExtensions() {
  ensureExtensionRegistryTable();
  const database = getDb();
  const rows = database.prepare('SELECT * FROM companion_extensions ORDER BY extension_id ASC').all();
  return rows.map(formatExtensionRow);
}

/**
 * Enable or disable an extension by `extension_id`, `tool_name`, or alias.
 */
export function setExtensionEnabled(extensionIdOrToolName, enabled, configPatch = null) {
  ensureExtensionRegistryTable();
  const database = getDb();
  const canonicalId = resolveCanonicalExtensionId(extensionIdOrToolName);
  const rawKey = String(extensionIdOrToolName || '').trim();

  const targetRow = database
    .prepare('SELECT * FROM companion_extensions WHERE extension_id = ? OR tool_name = ?')
    .get(canonicalId || rawKey, rawKey);

  if (!targetRow) {
    return null;
  }

  let nextConfigJson = targetRow.config_json || '{}';
  if (configPatch && typeof configPatch === 'object') {
    try {
      const current = JSON.parse(nextConfigJson);
      nextConfigJson = JSON.stringify({ ...current, ...configPatch });
    } catch {
      nextConfigJson = JSON.stringify(configPatch);
    }
  }

  database
    .prepare(
      `
      UPDATE companion_extensions
      SET enabled = ?, config_json = ?, updated_at = datetime('now')
      WHERE extension_id = ?
    `
    )
    .run(enabled ? 1 : 0, nextConfigJson, targetRow.extension_id);

  const updated = database
    .prepare('SELECT * FROM companion_extensions WHERE extension_id = ?')
    .get(targetRow.extension_id);

  return formatExtensionRow(updated);
}

/**
 * Check if an extension is currently enabled by `extension_id`, `tool_name`, or environment variable.
 */
export function isExtensionEnabled(extensionIdOrToolName) {
  ensureExtensionRegistryTable();
  const database = getDb();
  const canonicalId = resolveCanonicalExtensionId(extensionIdOrToolName);
  const rawKey = String(extensionIdOrToolName || '').trim();

  const row = database
    .prepare('SELECT * FROM companion_extensions WHERE extension_id = ? OR tool_name = ?')
    .get(canonicalId || rawKey, rawKey);

  const entry = REGISTERED_PLUGINS_BY_ID.get(canonicalId || row?.extension_id);
  const envEnabled =
    entry?.envFlag &&
    (process.env[entry.envFlag] === '1' || String(process.env[entry.envFlag]).toLowerCase() === 'true');

  return Boolean(row?.enabled) || Boolean(envEnabled);
}

/**
 * Return executable tool definitions for all currently enabled extensions.
 */
export function getEnabledExtensionTools() {
  const extensions = listExtensions();
  const enabledTools = [];

  for (const ext of extensions) {
    if (ext.enabled) {
      const tool = getExtensionToolByName(ext.toolName) || getExtensionToolByName(ext.extensionId);
      if (tool) {
        enabledTools.push(tool);
      }
    }
  }

  return enabledTools;
}

/**
 * Look up an extension tool definition by `toolName`, `extensionId`, or alias.
 * Always returns the tool definition even when opt-in disabled so on-demand execution
 * (`executeCompanionTool(name, args)`) and `/api/extensions` test invokes succeed (`INV-EXT-01`).
 */
export function getExtensionToolByName(toolName) {
  if (!toolName) return null;
  const raw = String(toolName).trim();
  if (REGISTERED_TOOLS_BY_NAME.has(raw)) {
    return REGISTERED_TOOLS_BY_NAME.get(raw);
  }
  const canonicalId = resolveCanonicalExtensionId(raw);
  if (canonicalId && REGISTERED_PLUGINS_BY_ID.has(canonicalId)) {
    return REGISTERED_PLUGINS_BY_ID.get(canonicalId).tool;
  }
  return null;
}

