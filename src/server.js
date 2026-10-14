import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import config from './config.js';
import * as db from './db/index.js';
import {
  rememberMemory,
  getActiveMemories,
  getSupersededMemories,
  deleteMemory,
  supersedeMemory,
  compileStateBriefing,
  createDatabaseBackup,
  getDecayCandidates
} from './context/memory-store.js';
import { evaluateCompanionContext } from './context/boundary-gate.js';
import { dispatchCompanionChat, classifyCompanionPrompt, breakdownTaskIntoSubtasks } from './router/cascade-client.js';
import {
  COMPANION_TOOLS,
  executeCompanionTool,
  calculateCommuteAndDeparture,
  getAgenticToolStats,
  setAgenticDryRunMode,
  getAgenticDryRunMode
} from './agent/tools.js';
import { processThoughtStream, processChaosDump } from './services/chaos-dump.js';
import { generateDailyFocus, generateDailyReflection, generateNudge } from './services/coach.js';
import { transcribeAudio } from './services/stt.js';
import {
  startSentinelDaemon,
  runSentinelTick,
  getSentinelStatus,
  getActiveSentinelAlerts,
  acknowledgeSentinelAlert
} from './services/sentinel-daemon.js';
import { runDoctorChecks } from '../scripts/doctor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

let runtimeResourceMode = process.env.RESOURCE_MODE || 'balanced'; // 'minimal' | 'balanced' | 'quality'
let lastRoutingDecision = null;

// Initialize database & start background Proactive Sentinel Watchdog Daemon
db.initCompanionDb();
startSentinelDaemon();

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

// Serve static frontend assets if built (with no-cache on index.html and sw.js so UI updates apply immediately)
const clientDist = path.join(projectRoot, 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(
    express.static(clientDist, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
      }
    })
  );
}

// ── Health ──────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'healthy',
    app: config.app.name,
    port: config.app.port,
    provider: config.cascade.provider,
    edgeModel: config.cascade.edgeModel,
    swarmModel: config.cascade.swarmModel,
    openrouterModel: config.cascade.openrouterModel,
    openrouterConfigured: Boolean(config.cascade.openrouterApiKey),
    allowCloudEscalation: config.cascade.allowCloudEscalation,
    dbPath: config.db.path
  });
});

// ── Priorities & Tasks ──────────────────────────────────────────────────────
app.get('/api/priorities', (_req, res) => {
  try {
    res.json(db.getPriorities());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/execution-lanes', (_req, res) => {
  try {
    res.json({
      lanes: db.getExecutionLanes(),
      pillars: db.getLifePillars()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks', (req, res) => {
  try {
    const date = req.query.date || db.today();
    res.json(db.getTasksForDate(date));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks', (req, res) => {
  try {
    const { title, priority_id, execution_priority, pillar, notes, recurring, energy_level, date } = req.body;
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'Task title is required' });
    }
    const task = db.createTask({
      title,
      priority_id,
      execution_priority,
      pillar,
      notes,
      recurring,
      energy_level,
      date
    });
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/tasks/:id/priority', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { execution_priority, priority_id, pillar } = req.body || {};
    const updated = db.updateTaskPriority(id, { execution_priority, priority_id, pillar });
    if (!updated) return res.status(404).json({ error: 'Task not found' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks/rollover', (req, res) => {
  try {
    const date = req.body?.date || db.today();
    const result = db.rolloverUnfinishedTasks(date);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/breakdown', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const date = req.body?.date || db.today();
    const result = await breakdownTaskIntoSubtasks({ taskQuery: `#${id}`, date });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/tasks/:id/complete', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const task = db.toggleTask(id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    let gamify = null;
    const dateStr = task.date || db.today();
    const status = db.getGamifyStatus(dateStr);
    if (status.opted_in) {
      const pts = db.EXECUTION_PRIORITY_POINTS[task.execution_priority] || db.TIER_POINTS[task.tier] || 20;
      gamify = db.addGamifyPoints(dateStr, task.completed ? pts : -pts);
    }

    res.json({ ...task, gamify });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tasks/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    db.deleteTask(id);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Gamify & Streak ────────────────────────────────────────────────────────
app.get('/api/streak', (_req, res) => {
  try {
    res.json(db.getStreak());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/gamify/today', (_req, res) => {
  try {
    const status = db.getGamifyStatus(db.today());
    const streak = db.getStreak();
    res.json({ ...status, streak: streak.streak });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gamify/opt-in', (req, res) => {
  try {
    const { optedIn } = req.body;
    res.json(db.setGamifyOptIn(db.today(), Boolean(optedIn)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Companion Conversational Chat (Cascade Router) ──────────────────────────
app.post('/api/companion/chat', async (req, res) => {
  try {
    const { prompt, sessionId = 'default-session', history = [] } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Evaluate Knowledge Boundary & prune
    const contextEval = evaluateCompanionContext(prompt, history);
    const contextBriefing = contextEval.shouldInjectContext ? contextEval.contextPrompt : '';

    // Dispatch via Cascade Router
    const result = await dispatchCompanionChat({
      prompt: contextEval.cleanQuery || prompt,
      history,
      contextBriefing
    });

    // Save dialogue turn to SQLite
    db.saveDialogueMessage({
      sessionId,
      role: 'user',
      content: prompt,
      tierUsed: result.tierUsed,
      latencyMs: 0
    });

    db.saveDialogueMessage({
      sessionId,
      role: 'assistant',
      content: result.content,
      tierUsed: result.tierUsed,
      latencyMs: result.latencyMs
    });

    lastRoutingDecision = {
      timestamp: new Date().toISOString(),
      promptPreview: prompt.slice(0, 140),
      tierUsed: result.tierUsed,
      latencyMs: result.latencyMs,
      reason: result.reason,
      contextActivated: Boolean(contextEval.shouldInjectContext),
      contextReason: contextEval.reason || (contextEval.shouldInjectContext ? 'Open-world personal query' : 'Closed-world utility gate'),
      resourceMode: runtimeResourceMode,
      actionExecuted: result.actionExecuted?.type || null,
      agenticToolsCalled: result.agenticTrace?.toolCalls?.map(tc => tc.name) || []
    };

    res.json({
      reply: result.content,
      tierUsed: result.tierUsed,
      latencyMs: result.latencyMs,
      reason: result.reason,
      contextActivated: contextEval.shouldInjectContext,
      contextReason: lastRoutingDecision.contextReason,
      actionExecuted: result.actionExecuted || null,
      agenticTrace: result.agenticTrace || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Agentic Proxy Tools & Direct Action Execution ───────────────────────────
app.get('/api/companion/tools', (_req, res) => {
  res.json({
    engine: 'krusch-agentic-proxy-dual-engine',
    protocol: '<holodata> Cognitive Blueprint + Flat Tool Array',
    tools: COMPANION_TOOLS.map(t => ({
      name: t.name,
      category: t.category,
      description: t.description,
      parameters: t.parameters,
      required: t.required
    }))
  });
});

app.post('/api/companion/action', async (req, res) => {
  try {
    const { tool, arguments: toolArgs = {} } = req.body || {};
    if (!tool || typeof tool !== 'string') {
      return res.status(400).json({ error: 'Tool name is required' });
    }
    const result = await executeCompanionTool(tool, toolArgs);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/companion/departure-alerts', async (_req, res) => {
  try {
    const alerts = [];
    const baseUrl = (process.env.G_KRUSCH_URL || 'http://127.0.0.1:5446').replace(/\/+$/, '');

    // 1. Check upcoming Google Calendar events that have a location
    try {
      const calRes = await fetch(`${baseUrl}/api/calendar/events?limit=5`, {
        signal: AbortSignal.timeout(4000)
      });
      if (calRes.ok) {
        const calData = await calRes.json();
        for (const ev of (calData.events || [])) {
          if (ev.location) {
            const commute = await calculateCommuteAndDeparture({
              destination: ev.location,
              arrivalTime: ev.start
            });
            alerts.push({
              id: `cal-${ev.id}`,
              title: ev.summary || 'Calendar Event',
              source: 'Google Calendar',
              commute
            });
          }
        }
      }
    } catch {
      // Non-fatal if Calendar OAuth not linked
    }

    // 2. Check Today's Priority Board for Reservation Holds or location-tagged tasks
    const tasks = db.getTasksForDate(db.today()).filter(t => !t.completed);
    for (const t of tasks) {
      const resMatch = t.title.match(/^Reservation Hold:\s*(.+?)\s*\(Party of \d+\s*@\s*([^—)]+)/i);
      const bracketLoc = t.title.match(/\[([^\]]+)\]\s*$/);
      if (resMatch) {
        const venue = resMatch[1].trim();
        const rawTime = resMatch[2].trim();
        const commute = await calculateCommuteAndDeparture({
          destination: venue,
          arrivalTime: rawTime
        });
        alerts.push({
          id: `task-${t.id}`,
          title: t.title,
          source: 'Reservation Hold',
          commute
        });
      } else if (bracketLoc && !/^#?\d+$/.test(bracketLoc[1])) {
        const loc = bracketLoc[1].trim();
        const timeMatch = t.title.match(/@\s*([^)\]]+)/);
        const commute = await calculateCommuteAndDeparture({
          destination: loc,
          arrivalTime: timeMatch ? timeMatch[1].trim() : null
        });
        alerts.push({
          id: `task-${t.id}`,
          title: t.title,
          source: 'Priority Board',
          commute
        });
      }
    }

    const sentinelAlerts = getActiveSentinelAlerts(5);
    res.json({ count: alerts.length, alerts, sentinelAlerts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Proactive Sentinel Watchdog Daemon API ──────────────────────────────────
app.get('/api/sentinel/status', (_req, res) => {
  try {
    res.json(getSentinelStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sentinel/tick', async (req, res) => {
  try {
    const customEvents = Array.isArray(req.body?.events) ? req.body.events : null;
    const customEmails = Array.isArray(req.body?.emails) ? req.body.emails : null;
    const customCalendarEvents = Array.isArray(req.body?.calendarEvents) ? req.body.calendarEvents : null;
    const result = await runSentinelTick({ customEvents, customEmails, customCalendarEvents });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sentinel/ack/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    res.json(acknowledgeSentinelAlert(id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Thought Stream (Text & Audio) ──────────────────────────────────────────
const handleStreamProcessing = async (req, res) => {
  try {
    const { text, date, autoSaveTasks = true, autoSaveMemories = true } = req.body;
    if (!text) return res.status(400).json({ error: 'Text is required for Thought Stream' });

    const result = await processThoughtStream({
      text,
      date,
      autoSaveTasks,
      autoSaveMemories
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

app.post('/api/companion/stream', handleStreamProcessing);
app.post('/api/companion/dump', handleStreamProcessing);

app.post('/api/companion/voice', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'Audio file buffer is required' });
    }

    const transcribedText = await transcribeAudio(req.file.buffer, req.file.originalname || 'recording.webm');
    if (!transcribedText || transcribedText.trim().length === 0) {
      return res.status(422).json({ error: 'No audible speech detected in transcription' });
    }

    const streamResult = await processThoughtStream({
      text: transcribedText,
      autoSaveTasks: true,
      autoSaveMemories: true
    });

    res.json({
      transcription: transcribedText,
      ...streamResult
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Coach & Daily Focus ─────────────────────────────────────────────────────
app.get('/api/coach/focus', (req, res) => {
  try {
    const date = req.query.date || db.today();
    res.json(db.getDailyFocus(date) || { focus_text: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/coach/focus', async (req, res) => {
  try {
    const date = req.body.date || db.today();
    const result = await generateDailyFocus(date);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/coach/nudge', async (req, res) => {
  try {
    const date = req.body.date || db.today();
    const result = await generateNudge(date);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/coach/reflect', async (req, res) => {
  try {
    const date = req.body.date || db.today();
    const result = await generateDailyReflection(date);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sovereign Working Memory (KruschContext) ─────────────────────────────────
app.get('/api/context', (req, res) => {
  try {
    const category = req.query.category || null;
    const memories = getActiveMemories(category);
    const decayCandidates = getDecayCandidates(30);
    const briefing = compileStateBriefing();
    res.json({ memories, activeMemories: memories, decayCandidates, briefing });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(['/api/context', '/api/context/remember'], (req, res) => {
  try {
    const { category, content, key, confidence } = req.body;
    const memory = rememberMemory({ category, content, key, confidence });
    res.json(memory);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(['/api/context/:id/supersede', '/api/context/supersede'], (req, res) => {
  try {
    const targetId = parseInt(req.params.id || req.body.targetId, 10);
    const { newContent, content, reason } = req.body;
    const result = supersedeMemory({ targetId, newContent: newContent || content, reason });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/context/history', (_req, res) => {
  try {
    const active = getActiveMemories();
    const superseded = getSupersededMemories(50);
    const decay = getDecayCandidates(30);
    res.json({
      activeCount: active.length,
      supersededCount: superseded.length,
      decayCandidateCount: decay.length,
      active,
      superseded,
      supersededMemories: superseded,
      decayCandidates: decay
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/context/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    res.json(deleteMemory(id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/context/decay', (req, res) => {
  try {
    const days = parseInt(req.query.days || 30, 10);
    const candidates = getDecayCandidates(days);
    res.json({ days, count: candidates.length, candidates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Setup Doctor, Debug Inspector, Runtime Settings & Data Export ──────────
app.get('/api/doctor', async (_req, res) => {
  try {
    const report = await runDoctorChecks();
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug', (_req, res) => {
  try {
    const tierRows = db
      .getDb()
      .prepare(`
        SELECT tier_used, COUNT(*) as count, ROUND(AVG(latency_ms), 1) as avg_latency_ms
        FROM companion_dialogue
        WHERE role = 'assistant'
        GROUP BY tier_used
      `)
      .all();

    const totalTurns = tierRows.reduce((acc, r) => acc + Number(r.count || 0), 0);
    const tierDistribution = tierRows.map((r) => ({
      tier: r.tier_used,
      count: Number(r.count),
      percentage: totalTurns > 0 ? Number(((Number(r.count) / totalTurns) * 100).toFixed(1)) : 0,
      avgLatencyMs: Number(r.avg_latency_ms || 0)
    }));

    res.json({
      lastRoutingDecision,
      totalAssistantTurns: totalTurns,
      tierDistribution,
      agenticToolStats: getAgenticToolStats(),
      sentinelStatus: getSentinelStatus(),
      runtimeSettings: {
        resourceMode: runtimeResourceMode,
        dryRunMode: getAgenticDryRunMode(),
        provider: config.cascade.provider,
        edgeModel: config.cascade.edgeModel,
        openrouterZeroDataRetention: config.cascade.openrouterZeroDataRetention
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings/runtime', (req, res) => {
  try {
    const { resourceMode, dryRunMode } = req.body || {};
    if (resourceMode && ['minimal', 'balanced', 'quality'].includes(resourceMode)) {
      runtimeResourceMode = resourceMode;
    }
    if (typeof dryRunMode === 'boolean') {
      setAgenticDryRunMode(dryRunMode);
    }
    res.json({
      ok: true,
      resourceMode: runtimeResourceMode,
      dryRunMode: getAgenticDryRunMode()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/export', (req, res) => {
  try {
    const format = String(req.query.format || 'json').toLowerCase();
    const targetDate = req.query.date || db.today();
    const tasks = db.getTasksForDate(targetDate);
    const activeMemories = getActiveMemories();
    const supersededMemories = getSupersededMemories(50);
    const streak = db.getStreak();
    const focus = db.getDailyFocus(targetDate);

    if (format === 'markdown' || format === 'md') {
      const mdLines = [
        `# 🛡️ Krusch Companion — Sovereign Export (${targetDate})`,
        `> Exported at \`${new Date().toISOString()}\` · Streak: **${streak.streak} day(s)**`,
        ''
      ];
      if (focus?.focus_text) {
        mdLines.push('## ☀️ Morning Focus Briefing', focus.focus_text, '');
      }
      mdLines.push(`## 📋 Dual-Axis Priority Board (${tasks.filter(t => t.completed).length}/${tasks.length} Completed)`);
      for (const t of tasks) {
        mdLines.push(
          `- [${t.completed ? 'x' : ' '}] **[P${t.execution_priority}: ${t.execution_lane_short} ${t.execution_lane_emoji} | ${t.pillar_emoji} ${t.pillar}]** ${t.title}${t.notes ? ` — *${t.notes}*` : ''}`
        );
      }
      mdLines.push('', `## 🧠 Active Working Memory (${activeMemories.length})`);
      for (const m of activeMemories) {
        mdLines.push(`- **[${m.category.toUpperCase()}]** (#${m.id}${m.key ? ` · \`${m.key}\`` : ''}): ${m.content}`);
      }
      if (supersededMemories.length > 0) {
        mdLines.push('', `## 🔄 Superseded Memory Lineage (${supersededMemories.length})`);
        for (const s of supersededMemories) {
          mdLines.push(
            `- ~~#${s.id}: ${s.content}~~ → Superseded by #${s.superseded_by || 'retired'} (*${s.invalidation_reason || 'updated'}*)`
          );
        }
      }
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="krusch-companion-export-${targetDate}.md"`);
      return res.send(mdLines.join('\n') + '\n');
    }

    res.json({
      exportedAt: new Date().toISOString(),
      date: targetDate,
      streak: streak.streak,
      morningFocus: focus?.focus_text || null,
      tasks,
      activeMemories,
      supersededMemories
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sovereign Backup & Integrity ───────────────────────────────────────────
app.post('/api/backup', (_req, res) => {
  try {
    const backup = createDatabaseBackup();
    res.json({ success: true, ...backup });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/system/integrity', (_req, res) => {
  try {
    const check = db.getDb().prepare('PRAGMA integrity_check').all();
    res.json({ integrity: check });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Client-side fallback routing (SPA)
app.get('*', (_req, res) => {
  const indexHtml = path.join(clientDist, 'index.html');
  if (fs.existsSync(indexHtml)) {
    res.sendFile(indexHtml);
  } else {
    res.send('<h1>Krusch Companion API Active</h1><p>Client build pending in client/dist.</p>');
  }
});

const PORT = config.app.port;
const server = app.listen(PORT, config.app.host, () => {
  console.log(`🚀 Krusch Companion running at http://${config.app.host}:${PORT}`);
  console.log(`🛡️ Privacy: allowCloudEscalation = ${config.cascade.allowCloudEscalation}`);
  console.log(`🧠 Local Edge Model: ${config.cascade.edgeModel} (Ollama @ ${config.cascade.ollamaUrl})`);
});

export { app, server };
