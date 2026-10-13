import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.join(__dirname, 'test-companion.db');

// Ensure clean slate
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);

// Import modules
const { initCompanionDb, getPriorities, createTask, toggleTask, getTasksForDate } = await import('../src/db/index.js');
const { rememberMemory, getActiveMemories, supersedeMemory, compileStateBriefing } = await import('../src/context/memory-store.js');
const { evaluateCompanionContext } = await import('../src/context/boundary-gate.js');

test('Companion Database: initializes and seeds default priorities', (t) => {
  initCompanionDb(testDbPath);
  const priorities = getPriorities();
  assert.strictEqual(priorities.length, 5);
  assert.strictEqual(priorities[0].tier, 1);
  assert.strictEqual(priorities[0].name, 'Core Values & Faith');
});

test('Companion Database: creates, lists, and toggles tasks', (t) => {
  const task = createTask({
    title: 'Walk the dog and get sunlight',
    priority_id: 4,
    notes: '20 minutes outdoors',
    date: '2026-10-13'
  });

  assert.ok(task.id);
  assert.strictEqual(task.completed, 0);
  assert.strictEqual(task.priority_name, 'Health & Self');

  const toggled = toggleTask(task.id);
  assert.strictEqual(toggled.completed, 1);
  assert.ok(toggled.completed_at);

  const tasks = getTasksForDate('2026-10-13');
  const found = tasks.find(x => x.id === task.id);
  assert.ok(found);
  assert.strictEqual(found.completed, 1);
});

test('KruschContext: persists memories and compiles state briefing', (t) => {
  const mem1 = rememberMemory({
    category: 'decision',
    content: 'Stop drinking caffeine after 2:00 PM for deep sleep recovery',
    key: 'diet:caffeine_cutoff'
  });

  assert.ok(mem1.id);
  assert.strictEqual(mem1.category, 'decision');

  const active = getActiveMemories('decision');
  assert.ok(active.some(m => m.id === mem1.id));

  const briefing = compileStateBriefing();
  assert.ok(briefing.includes('Stop drinking caffeine after 2:00 PM'));
});

test('KruschContext: cleanly supersedes old facts with lineage', (t) => {
  const initial = rememberMemory({
    category: 'invariant',
    content: 'Morning workout starts at 6:30 AM',
    key: 'routine:workout_time'
  });

  const superseded = supersedeMemory({
    targetId: initial.id,
    newContent: 'Morning workout shifted to 7:00 AM after sunrise',
    reason: 'Winter daylight adjustment'
  });

  assert.strictEqual(superseded.invalidatedId, initial.id);
  assert.ok(superseded.newId);

  const activeInvariants = getActiveMemories('invariant');
  const oldActive = activeInvariants.find(m => m.id === initial.id);
  const newActive = activeInvariants.find(m => m.id === superseded.newId);

  assert.strictEqual(oldActive, undefined); // Old one is deactivated
  assert.ok(newActive);                     // New one is active
  assert.ok(newActive.content.includes('7:00 AM'));
});

test('Knowledge Boundary Gate: correctly bypasses memory on closed-world utility tasks', (t) => {
  const calcResult = evaluateCompanionContext('Calculate 450 * 12');
  assert.strictEqual(calcResult.shouldInjectContext, false);
  assert.strictEqual(calcResult.contextPrompt, '');

  const scheduleResult = evaluateCompanionContext('What does my routine look like today with my partner?');
  assert.strictEqual(scheduleResult.shouldInjectContext, true);
  assert.ok(scheduleResult.contextPrompt.includes('Krusch Companion Active Working Memory'));
});

// Cleanup test db
test('Cleanup test DB', () => {
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
  if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
});
