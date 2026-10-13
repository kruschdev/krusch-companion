import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import config from './config.js';
import * as db from './db/index.js';
import { rememberMemory, getActiveMemories, supersedeMemory, compileStateBriefing, createDatabaseBackup, getDecayCandidates } from './context/memory-store.js';
import { evaluateCompanionContext } from './context/boundary-gate.js';
import { dispatchCompanionChat, classifyCompanionPrompt, breakdownTaskIntoSubtasks } from './router/cascade-client.js';
import { processThoughtStream, processChaosDump } from './services/chaos-dump.js';
import { generateDailyFocus, generateDailyReflection, generateNudge } from './services/coach.js';
import { transcribeAudio } from './services/stt.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Initialize database
db.initCompanionDb();

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

// Serve static frontend assets if built
const clientDist = path.join(projectRoot, 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
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
    const { title, priority_id, notes, recurring, energy_level, date } = req.body;
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'Task title is required' });
    }
    const task = db.createTask({ title, priority_id, notes, recurring, energy_level, date });
    res.json(task);
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
      const pts = db.TIER_POINTS[task.tier] || 15;
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

    res.json({
      reply: result.content,
      tierUsed: result.tierUsed,
      latencyMs: result.latencyMs,
      reason: result.reason,
      contextActivated: contextEval.shouldInjectContext,
      actionExecuted: result.actionExecuted || null
    });
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
    const briefing = compileStateBriefing();
    res.json({ memories, briefing });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/context', (req, res) => {
  try {
    const { category, content, key, confidence } = req.body;
    const memory = rememberMemory({ category, content, key, confidence });
    res.json(memory);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/context/:id/supersede', (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const { newContent, reason } = req.body;
    const result = supersedeMemory({ targetId, newContent, reason });
    res.json(result);
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
