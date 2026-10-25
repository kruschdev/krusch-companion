/**
 * Health & Biometric Readiness Sync + Media/Jellyfin Controller Extension
 *
 * Enforces Invariant INV-EXT-07 (Biometric Energy Board Adaptation & Jellyfin Media Twin):
 * - Deterministic readiness score (0-100) and energy band ('low_recovery' | 'medium' | 'high').
 * - Low-recovery board adaptation demotes non-urgent high-energy tasks (execution_priority >= 2
 *   and energy_level === 'high') to Lane 4 (Backlog) while keeping Lane 1 (Must Happen Today) untouched.
 * - Media & Focus Soundscape controller queries Jellyfin (JELLYFIN_URL or http://127.0.0.1:8096)
 *   when JELLYFIN_API_KEY is configured and falls back cleanly (ok: true) to the local
 *   companion_media_sessions SQLite state twin.
 */

import { getDb, getTasksForDate, updateTaskPriority, today } from '../db/index.js';
import { rememberMemory } from '../context/memory-store.js';

export const DEFAULT_MEDIA_PROFILES = [
  {
    session_key: 'focus_brown_noise',
    title: 'Deep Focus Brown Noise (432Hz Warm Filter)',
    media_type: 'focus_audio',
    provider: 'local_focus_synth',
    playback_state: 'stopped',
    volume: 65,
    stream_url: 'synth://brown-noise'
  },
  {
    session_key: 'focus_rain_ambient',
    title: 'Pacific Northwest Rain & Distant Thunder',
    media_type: 'focus_audio',
    provider: 'local_focus_synth',
    playback_state: 'stopped',
    volume: 60,
    stream_url: 'synth://rain-ambient'
  },
  {
    session_key: 'focus_lofi_beats',
    title: 'Late Night Lo-Fi Study Beats',
    media_type: 'focus_audio',
    provider: 'local_focus_synth',
    playback_state: 'stopped',
    volume: 55,
    stream_url: 'synth://lofi-beats'
  },
  {
    session_key: 'jellyfin_cinema',
    title: 'KruschMedia Jellyfin Cinema Stream',
    media_type: 'jellyfin_stream',
    provider: 'jellyfin',
    playback_state: 'stopped',
    volume: 75,
    stream_url: process.env.JELLYFIN_URL || 'http://127.0.0.1:8096'
  }
];

/**
 * Ensure SQLite tables for biometric health metrics and media session state twin exist,
 * and seed default focus soundscape & Jellyfin profiles if empty.
 */
export function ensureHealthAndMediaTables() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS companion_health_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      sleep_hours REAL DEFAULT 7.5,
      sleep_score INTEGER DEFAULT 80,
      hrv_ms INTEGER DEFAULT 55,
      resting_hr INTEGER DEFAULT 60,
      steps INTEGER DEFAULT 0,
      readiness_score INTEGER DEFAULT 80,
      energy_band TEXT DEFAULT 'high',
      source TEXT DEFAULT 'manual',
      notes TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS companion_media_sessions (
      session_key TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      media_type TEXT DEFAULT 'focus_audio',
      provider TEXT DEFAULT 'local_focus_synth',
      playback_state TEXT DEFAULT 'stopped',
      volume INTEGER DEFAULT 65,
      stream_url TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const countRow = db.prepare('SELECT COUNT(*) as count FROM companion_media_sessions').get();
  if (!countRow || countRow.count === 0) {
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO companion_media_sessions (
        session_key, title, media_type, provider, playback_state, volume, stream_url, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    const seedTx = db.transaction(() => {
      for (const profile of DEFAULT_MEDIA_PROFILES) {
        insertStmt.run(
          profile.session_key,
          profile.title,
          profile.media_type,
          profile.provider,
          profile.playback_state,
          profile.volume,
          profile.stream_url
        );
      }
    });
    seedTx();
  }

  return true;
}

/**
 * Deterministically compute readinessScore (0-100) and energyBand ('low_recovery' | 'medium' | 'high').
 *
 * Rules (INV-EXT-07):
 * - 'low_recovery' when readinessScore < 60 or sleepHours < 6.0
 * - 'medium' when readinessScore >= 60 && readinessScore < 78
 * - 'high' when readinessScore >= 78
 */
export function computeEnergyBand({
  sleepHours = 7.5,
  sleepScore = 80,
  readinessScore = null,
  hrvMs = 55
} = {}) {
  const safeSleepHours = Number.isFinite(Number(sleepHours))
    ? Math.max(0, Math.min(24, Number(sleepHours)))
    : 7.5;
  const safeSleepScore = Number.isFinite(Number(sleepScore))
    ? Math.max(0, Math.min(100, Math.round(Number(sleepScore))))
    : 80;
  const safeHrvMs = Number.isFinite(Number(hrvMs))
    ? Math.max(1, Math.min(250, Math.round(Number(hrvMs))))
    : 55;

  let resolvedReadiness;
  if (readinessScore !== null && readinessScore !== undefined && readinessScore !== '' && Number.isFinite(Number(readinessScore))) {
    resolvedReadiness = Math.max(0, Math.min(100, Math.round(Number(readinessScore))));
  } else {
    const sleepDurationComponent = Math.max(0, Math.min(100, Math.round((safeSleepHours / 8.0) * 100)));
    const hrvComponent = Math.max(15, Math.min(100, Math.round((safeHrvMs / 65.0) * 85)));
    resolvedReadiness = Math.max(
      0,
      Math.min(
        100,
        Math.round(safeSleepScore * 0.45 + sleepDurationComponent * 0.35 + hrvComponent * 0.2)
      )
    );
  }

  let energyBand = 'high';
  if (resolvedReadiness < 60 || safeSleepHours < 6.0) {
    energyBand = 'low_recovery';
  } else if (resolvedReadiness >= 60 && resolvedReadiness < 78) {
    energyBand = 'medium';
  } else {
    energyBand = 'high';
  }

  return {
    readinessScore: resolvedReadiness,
    energyBand,
    sleepHours: safeSleepHours,
    sleepScore: safeSleepScore,
    hrvMs: safeHrvMs
  };
}

function enrichHealthRow(row) {
  if (!row) return null;
  return {
    ...row,
    sleepHours: row.sleep_hours,
    sleepScore: row.sleep_score,
    hrvMs: row.hrv_ms,
    restingHr: row.resting_hr,
    readinessScore: row.readiness_score,
    energyBand: row.energy_band
  };
}

/**
 * Record or update daily biometric health metrics in SQLite and working memory.
 */
export function recordHealthMetrics({
  date = null,
  sleepHours = 7.5,
  sleepScore = 80,
  hrvMs = 55,
  restingHr = 60,
  steps = 0,
  readinessScore = null,
  source = 'apple_health_shortcut',
  notes = ''
} = {}) {
  ensureHealthAndMediaTables();
  const db = getDb();
  const targetDate = date || today();

  const computed = computeEnergyBand({
    sleepHours,
    sleepScore,
    readinessScore,
    hrvMs
  });

  const safeRestingHr = Number.isFinite(Number(restingHr))
    ? Math.max(30, Math.min(220, Math.round(Number(restingHr))))
    : 60;
  const safeSteps = Number.isFinite(Number(steps))
    ? Math.max(0, Math.round(Number(steps)))
    : 0;
  const safeSource = String(source || 'apple_health_shortcut').trim() || 'apple_health_shortcut';
  const safeNotes = String(notes || '').trim();

  db.prepare(`
    INSERT INTO companion_health_metrics (
      date, sleep_hours, sleep_score, hrv_ms, resting_hr, steps,
      readiness_score, energy_band, source, notes, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(date) DO UPDATE SET
      sleep_hours = excluded.sleep_hours,
      sleep_score = excluded.sleep_score,
      hrv_ms = excluded.hrv_ms,
      resting_hr = excluded.resting_hr,
      steps = excluded.steps,
      readiness_score = excluded.readiness_score,
      energy_band = excluded.energy_band,
      source = excluded.source,
      notes = excluded.notes,
      updated_at = datetime('now')
  `).run(
    targetDate,
    computed.sleepHours,
    computed.sleepScore,
    computed.hrvMs,
    safeRestingHr,
    safeSteps,
    computed.readinessScore,
    computed.energyBand,
    safeSource,
    safeNotes
  );

  try {
    rememberMemory({
      category: 'lesson',
      key: `health_readiness_${targetDate}`,
      content: `Biometric readiness on ${targetDate}: ${computed.readinessScore}/100 (${computed.energyBand}) — ${computed.sleepHours}h sleep, HRV ${computed.hrvMs}ms, RHR ${safeRestingHr}bpm via ${safeSource}.`
    });
  } catch {
    // Non-fatal if companion_context is unavailable in isolated test contexts
  }

  const saved = db.prepare('SELECT * FROM companion_health_metrics WHERE date = ?').get(targetDate);
  return enrichHealthRow(saved);
}

/**
 * Fetch today's (or latest) health metric along with recent history.
 */
export function getHealthMetrics({ date = null, limit = 7 } = {}) {
  ensureHealthAndMediaTables();
  const db = getDb();
  const targetDate = date || today();

  let current = db.prepare('SELECT * FROM companion_health_metrics WHERE date = ?').get(targetDate);
  if (!current) {
    current = db.prepare('SELECT * FROM companion_health_metrics ORDER BY date DESC, id DESC LIMIT 1').get();
  }

  const history = db
    .prepare('SELECT * FROM companion_health_metrics ORDER BY date DESC, id DESC LIMIT ?')
    .all(Math.max(1, Number(limit) || 7))
    .map(enrichHealthRow);

  const resolvedCurrent = current
    ? enrichHealthRow(current)
    : enrichHealthRow({
        id: null,
        date: targetDate,
        sleep_hours: 7.5,
        sleep_score: 80,
        hrv_ms: 55,
        resting_hr: 60,
        steps: 0,
        readiness_score: 80,
        energy_band: 'high',
        source: 'default_baseline',
        notes: ''
      });

  return {
    ok: true,
    date: targetDate,
    current: resolvedCurrent,
    latest: resolvedCurrent,
    history
  };
}

/**
 * Adapt Today's Priority Board based on biometric energy readiness (INV-EXT-07):
 * - Reads today's health metric (or latest).
 * - If energyBand === 'low_recovery', identifies non-urgent high-energy tasks
 *   (execution_priority >= 2 and energy_level === 'high') and demotes them to
 *   Lane 4 ('📥 Backlog — When Time Permits') while keeping Lane 1 ('🚨 Must Happen Today')
 *   completely untouched.
 * - Returns { ok: true, energyBand, readinessScore, adaptedTaskIds, recommendation }.
 */
export function adaptBoardToEnergyReadiness({ date = null } = {}) {
  ensureHealthAndMediaTables();
  const targetDate = date || today();
  const { current } = getHealthMetrics({ date: targetDate });

  const computed = computeEnergyBand({
    sleepHours: current.sleep_hours,
    sleepScore: current.sleep_score,
    readinessScore: current.readiness_score,
    hrvMs: current.hrv_ms
  });

  const energyBand = current.energy_band || computed.energyBand;
  const readinessScore = current.readiness_score ?? computed.readinessScore;

  const tasks = getTasksForDate(targetDate);
  const incompleteTasks = tasks.filter(t => !t.completed);
  const lane1Tasks = incompleteTasks.filter(t => Number(t.execution_priority || 2) === 1);
  const lowEnergyWins = incompleteTasks.filter(
    t => String(t.energy_level || '').toLowerCase() === 'low' || Number(t.execution_priority || 2) === 3
  );

  const adaptedTaskIds = [];
  const adaptedTasks = [];

  if (energyBand === 'low_recovery') {
    for (const task of incompleteTasks) {
      const execPriority = Number(task.execution_priority || 2);
      const energyLevel = String(task.energy_level || 'medium').toLowerCase();

      // Strictly protect Lane 1 (Must Happen Today) and skip tasks already in Lane 4 (Backlog)
      if (execPriority >= 2 && execPriority < 4 && energyLevel === 'high') {
        const updated = updateTaskPriority(task.id, { execution_priority: 4 });
        adaptedTaskIds.push(task.id);
        if (updated) {
          adaptedTasks.push(updated);
        }
      }
    }
  }

  let recommendation;
  if (energyBand === 'low_recovery') {
    if (adaptedTaskIds.length > 0) {
      recommendation = `Low recovery detected (readiness ${readinessScore}/100, ${current.sleep_hours}h sleep). Demoted ${adaptedTaskIds.length} non-urgent high-energy task(s) to Lane 4 (Backlog) while keeping ${lane1Tasks.length} Lane 1 (Must Happen Today) task(s) untouched. Focus on low-energy wins and recovery today.`;
    } else {
      recommendation = `Low recovery detected (readiness ${readinessScore}/100, ${current.sleep_hours}h sleep). Lane 1 (${lane1Tasks.length} urgent task(s)) remains protected; pace yourself with ${lowEnergyWins.length} low-energy/habit win(s) first.`;
    }
  } else if (energyBand === 'medium') {
    recommendation = `Balanced readiness (${readinessScore}/100, ${current.sleep_hours}h sleep). Board order preserved — tackle Lane 1 essentials first, then steady High-Impact work.`;
  } else {
    recommendation = `Peak readiness (${readinessScore}/100, ${current.sleep_hours}h sleep). Full cognitive bandwidth available for Lane 1 deadlines and high-energy deep work!`;
  }

  return {
    ok: true,
    date: targetDate,
    energyBand,
    readinessScore,
    sleepHours: current.sleep_hours,
    adaptedTaskIds,
    adaptedTasks,
    lowEnergyWins: lowEnergyWins.map(t => ({
      id: t.id,
      title: t.title,
      execution_priority: t.execution_priority,
      energy_level: t.energy_level
    })),
    mustDoProtectedCount: lane1Tasks.length,
    recommendation
  };
}

/**
 * Retrieve all local media sessions and current active playback state.
 */
export function getMediaSessions() {
  ensureHealthAndMediaTables();
  const db = getDb();
  const sessions = db
    .prepare('SELECT * FROM companion_media_sessions ORDER BY session_key ASC')
    .all();
  const activeSession = sessions.find(s => s.playback_state === 'playing') || null;
  return {
    ok: true,
    jellyfinConfigured: Boolean((process.env.JELLYFIN_API_KEY || '').trim()),
    jellyfinUrl: (process.env.JELLYFIN_URL || 'http://127.0.0.1:8096').replace(/\/+$/, ''),
    activeSession,
    sessions
  };
}

function resolveSessionKeyFromQuery(query = '', provider = '') {
  const q = `${query || ''} ${provider || ''}`.toLowerCase();
  if (q.includes('brown') || q.includes('432')) return 'focus_brown_noise';
  if (q.includes('rain') || q.includes('thunder') || q.includes('storm') || q.includes('ambient')) {
    return 'focus_rain_ambient';
  }
  if (q.includes('lofi') || q.includes('lo-fi') || q.includes('beats') || q.includes('study')) {
    return 'focus_lofi_beats';
  }
  if (q.includes('jellyfin') || q.includes('cinema') || q.includes('movie') || q.includes('kruschmedia')) {
    return 'jellyfin_cinema';
  }
  return 'focus_brown_noise';
}

/**
 * Execute media / soundscape / Jellyfin control actions with clean local twin fallback.
 */
export async function controlMedia({
  action = 'status',
  query = '',
  volume = null,
  provider = '',
  fetchImpl = fetch
} = {}) {
  ensureHealthAndMediaTables();
  const db = getDb();
  const normAction = String(action || 'status').toLowerCase().trim();
  const jellyfinUrl = (process.env.JELLYFIN_URL || 'http://127.0.0.1:8096').replace(/\/+$/, '');
  const jellyfinApiKey = String(process.env.JELLYFIN_API_KEY || '').trim();

  const safeVolume =
    volume !== null && volume !== undefined && volume !== '' && Number.isFinite(Number(volume))
      ? Math.max(0, Math.min(100, Math.round(Number(volume))))
      : null;

  if (normAction === 'search_jellyfin') {
    const searchTerm = String(query || '').trim();
    let remoteItems = null;
    let source = 'local_media_twin';

    if (jellyfinApiKey) {
      try {
        const url = `${jellyfinUrl}/Items?SearchTerm=${encodeURIComponent(searchTerm)}&IncludeItemTypes=Movie,Series,Audio&Recursive=true&Limit=8`;
        const res = await fetchImpl(url, {
          headers: { 'X-Emby-Token': jellyfinApiKey, Accept: 'application/json' },
          signal: AbortSignal.timeout(4500)
        });
        if (res.ok) {
          const payload = await res.json();
          if (Array.isArray(payload?.Items)) {
            remoteItems = payload.Items.map(item => ({
              id: item.Id,
              title: item.Name,
              type: item.Type,
              year: item.ProductionYear || null,
              provider: 'jellyfin'
            }));
            source = 'jellyfin_kruschmedia';
          }
        }
      } catch {
        // Clean fallback to local state twin
      }
    }

    const sessions = db.prepare('SELECT * FROM companion_media_sessions ORDER BY session_key ASC').all();
    const localMatches = sessions
      .filter(s => !searchTerm || s.title.toLowerCase().includes(searchTerm.toLowerCase()) || s.session_key.includes(searchTerm.toLowerCase()))
      .map(s => ({
        id: s.session_key,
        title: s.title,
        type: s.media_type,
        provider: s.provider,
        playback_state: s.playback_state,
        volume: s.volume
      }));

    const items = remoteItems && remoteItems.length > 0 ? remoteItems : localMatches;

    return {
      ok: true,
      tool: 'media_controller',
      actionType: 'media_search',
      source,
      query: searchTerm,
      items,
      summary: `🎬 **Media & Jellyfin Search (${source})**: Found ${items.length} matching profile(s)/item(s)${searchTerm ? ` for "${searchTerm}"` : ''}.`,
      data: {
        source,
        jellyfinUrl,
        query: searchTerm,
        items,
        sessions
      }
    };
  }

  if (normAction === 'play') {
    const targetKey = resolveSessionKeyFromQuery(query, provider);
    db.prepare(`UPDATE companion_media_sessions SET playback_state = 'stopped', updated_at = datetime('now')`).run();

    if (safeVolume !== null) {
      db.prepare(`
        UPDATE companion_media_sessions
        SET playback_state = 'playing', volume = ?, updated_at = datetime('now')
        WHERE session_key = ?
      `).run(safeVolume, targetKey);
    } else {
      db.prepare(`
        UPDATE companion_media_sessions
        SET playback_state = 'playing', updated_at = datetime('now')
        WHERE session_key = ?
      `).run(targetKey);
    }

    const activeSession = db
      .prepare('SELECT * FROM companion_media_sessions WHERE session_key = ?')
      .get(targetKey);

    let remoteReachable = false;
    if (jellyfinApiKey && (targetKey === 'jellyfin_cinema' || String(provider).toLowerCase() === 'jellyfin')) {
      try {
        const res = await fetchImpl(`${jellyfinUrl}/Sessions`, {
          headers: { 'X-Emby-Token': jellyfinApiKey },
          signal: AbortSignal.timeout(3500)
        });
        remoteReachable = res.ok;
      } catch {
        remoteReachable = false;
      }
    }

    const allSessions = db.prepare('SELECT * FROM companion_media_sessions ORDER BY session_key ASC').all();
    return {
      ok: true,
      tool: 'media_controller',
      actionType: 'media_play',
      activeSession,
      sessions: allSessions,
      remoteReachable,
      summary: `🎧 **Now Playing**: **${activeSession?.title || targetKey}** (Volume: ${activeSession?.volume ?? 65}% | Provider: \`${activeSession?.provider || 'local_focus_synth'}\`).`,
      data: {
        activeSession,
        sessions: allSessions,
        remoteReachable
      }
    };
  }

  if (normAction === 'pause' || normAction === 'stop') {
    const nextState = normAction === 'pause' ? 'paused' : 'stopped';
    if (query) {
      const targetKey = resolveSessionKeyFromQuery(query, provider);
      db.prepare(`
        UPDATE companion_media_sessions
        SET playback_state = ?, updated_at = datetime('now')
        WHERE session_key = ?
      `).run(nextState, targetKey);
    } else {
      db.prepare(`
        UPDATE companion_media_sessions
        SET playback_state = ?, updated_at = datetime('now')
        WHERE playback_state = 'playing' OR playback_state = 'paused'
      `).run(nextState);
    }

    if (safeVolume !== null) {
      db.prepare(`UPDATE companion_media_sessions SET volume = ?, updated_at = datetime('now')`).run(safeVolume);
    }

    const allSessions = db.prepare('SELECT * FROM companion_media_sessions ORDER BY session_key ASC').all();
    const activeSession = allSessions.find(s => s.playback_state === 'playing') || null;
    return {
      ok: true,
      tool: 'media_controller',
      actionType: `media_${normAction}`,
      activeSession,
      sessions: allSessions,
      summary: `⏹️ **Media Playback ${nextState === 'paused' ? 'Paused' : 'Stopped'}**.`,
      data: {
        activeSession,
        sessions: allSessions
      }
    };
  }

  // Default: status (optionally updating volume if passed)
  if (safeVolume !== null) {
    db.prepare(`UPDATE companion_media_sessions SET volume = ?, updated_at = datetime('now')`).run(safeVolume);
  }

  const state = getMediaSessions();
  return {
    ok: true,
    tool: 'media_controller',
    actionType: 'media_status',
    activeSession: state.activeSession,
    sessions: state.sessions,
    summary: state.activeSession
      ? `🎧 **Active Media Session**: **${state.activeSession.title}** (\`${state.activeSession.playback_state}\` at ${state.activeSession.volume}% volume).`
      : `🎧 **Media Controller Ready**: All ${state.sessions.length} soundscape/Jellyfin channels currently stopped.`,
    data: state
  };
}

/**
 * Opt-in Health, Sleep & Biometric Readiness Sync Tool (INV-EXT-07)
 */
export const HEALTH_READINESS_EXTENSION_TOOL = {
  name: 'health_energy_sync',
  category: 'health_biometrics',
  extensionId: 'health-biometric-sync',
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
  async execute(args = {}) {
    ensureHealthAndMediaTables();
    const action = String(args?.action || 'status').toLowerCase().trim();

    if (action === 'log_metrics' || action === 'log' || action === 'record') {
      const saved = recordHealthMetrics({
        date: args.date || null,
        sleepHours: args.sleepHours ?? 7.5,
        sleepScore: args.sleepScore ?? 80,
        hrvMs: args.hrvMs ?? 55,
        restingHr: args.restingHr ?? 60,
        steps: args.steps ?? 0,
        readinessScore: args.readinessScore ?? null,
        source: args.source || 'apple_health_shortcut',
        notes: args.notes || ''
      });

      return {
        ok: true,
        tool: 'health_energy_sync',
        actionType: 'health_metrics_logged',
        summary: `⌚ **Biometric Readiness Logged (${saved.date})**: Readiness **${saved.readiness_score}/100** (\`${saved.energy_band}\`) — Sleep: **${saved.sleep_hours}h** (score ${saved.sleep_score}), HRV: **${saved.hrv_ms}ms**, Steps: **${saved.steps}**.`,
        data: {
          metrics: saved,
          readinessScore: saved.readiness_score,
          energyBand: saved.energy_band
        }
      };
    }

    if (action === 'adapt_board' || action === 'adapt') {
      if (
        args.sleepHours !== undefined ||
        args.sleepScore !== undefined ||
        args.hrvMs !== undefined ||
        args.readinessScore !== undefined
      ) {
        recordHealthMetrics({
          date: args.date || null,
          sleepHours: args.sleepHours ?? 7.5,
          sleepScore: args.sleepScore ?? 80,
          hrvMs: args.hrvMs ?? 55,
          restingHr: args.restingHr ?? 60,
          steps: args.steps ?? 0,
          readinessScore: args.readinessScore ?? null,
          source: args.source || 'apple_health_shortcut',
          notes: args.notes || ''
        });
      }

      const result = adaptBoardToEnergyReadiness({ date: args.date || null });
      return {
        ok: true,
        tool: 'health_energy_sync',
        actionType: 'health_board_adapted',
        summary: `⚡ **Energy Board Adaptation (${result.energyBand.toUpperCase()})**: ${result.recommendation}`,
        data: result
      };
    }

    const status = getHealthMetrics({ date: args.date || null });
    return {
      ok: true,
      tool: 'health_energy_sync',
      actionType: 'health_status',
      summary: `⌚ **Biometric Readiness (${status.current.date})**: **${status.current.readiness_score}/100** (\`${status.current.energy_band}\`) — ${status.current.sleep_hours}h sleep, HRV ${status.current.hrv_ms}ms.`,
      data: status
    };
  }
};

/**
 * Opt-in Media, Focus Soundscape & Jellyfin Controller Tool (INV-EXT-07)
 */
export const MEDIA_CONTROLLER_EXTENSION_TOOL = {
  name: 'media_controller',
  category: 'media_controller',
  extensionId: 'media-jellyfin-controller',
  description:
    'Opt-in Media, Focus Soundscape & Jellyfin Controller (kruschmedia): play/pause focus soundscapes (brown noise, rain, lofi), search or control Jellyfin media on kruschmedia, and adjust volume.',
  parameters: {
    action: 'string (REQUIRED: "play" | "pause" | "stop" | "status" | "search_jellyfin")',
    query: 'string (Track, soundscape, movie, or show name)',
    volume: 'number (0-100 volume level)',
    provider: 'string ("focus_audio" | "jellyfin" | "spotify")'
  },
  required: ['action'],
  async execute(args = {}, { fetchImpl = fetch } = {}) {
    return controlMedia({
      action: args?.action || 'status',
      query: args?.query || '',
      volume: args?.volume ?? null,
      provider: args?.provider || '',
      fetchImpl
    });
  }
};
