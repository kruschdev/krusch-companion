import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.join(__dirname, 'test-dump.db');

if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);

const { initCompanionDb, getTasksForDate } = await import('../src/db/index.js');
const { processThoughtStream, processChaosDump } = await import('../src/services/chaos-dump.js');
const { getActiveMemories } = await import('../src/context/memory-store.js');

initCompanionDb(testDbPath);

test('Thought Stream Service: parses unformatted stream into structured tasks and memories', async (t) => {
  const rawDump = `
    I feel super overwhelmed today. I have to call the dentist before 3pm to reschedule,
    pick up prescription from CVS, make sure to drink at least 2 liters of water today.
    Also, remember that my daughter's teacher requested a meeting next Thursday.
    We decided to only have pizza on Fridays from now on.
  `;

  console.log('🧠 Processing test Chaos Dump through local Cascade Router...');
  const result = await processChaosDump({
    text: rawDump,
    date: '2026-10-13',
    autoSaveTasks: true,
    autoSaveMemories: true
  });

  assert.ok(result);
  assert.ok(result.rawTasks.length > 0, 'Extracted at least one task');
  assert.ok(result.savedTasks.length > 0, 'Saved tasks to SQLite');
  assert.ok(result.companionNotes, 'Provided companion coaching notes');
  console.log(`✅ Extracted ${result.savedTasks.length} tasks and ${result.savedMemories.length} memories in ${result.latencyMs}ms`);
  console.log(`📝 Companion notes: "${result.companionNotes}"`);

  // Verify SQLite tasks
  const tasksInDb = getTasksForDate('2026-10-13');
  assert.ok(tasksInDb.length >= result.savedTasks.length);

  // Verify memory persistence
  const memories = getActiveMemories();
  console.log(`🧠 Active memories in DB: ${memories.length}`);
});

test('Cleanup test DB', () => {
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
  if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
});
