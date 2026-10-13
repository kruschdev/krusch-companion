import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.join(__dirname, 'test-hardening.db');
const testBackupDir = path.join(__dirname, 'test-backups');

if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
if (fs.existsSync(testBackupDir)) fs.rmSync(testBackupDir, { recursive: true, force: true });

const { initCompanionDb, getTasksForDate } = await import('../src/db/index.js');
const { safeEvaluateArithmetic, evaluateL0Heuristic, TIERS } = await import('../src/router/cascade-client.js');
const { rememberMemory, getActiveMemories, getDecayCandidates, createDatabaseBackup } = await import('../src/context/memory-store.js');
const { processChaosDump } = await import('../src/services/chaos-dump.js');

initCompanionDb(testDbPath);

test('Hardening: safeEvaluateArithmetic strictly executes math without eval/Function risks', () => {
  // 1. Valid expressions
  assert.strictEqual(safeEvaluateArithmetic('2 + 3 * 4'), 14);
  assert.strictEqual(safeEvaluateArithmetic('(10 - 2) * 5'), 40);
  assert.strictEqual(safeEvaluateArithmetic('2 ^ 8'), 256);
  assert.strictEqual(safeEvaluateArithmetic('100 / 4'), 25);
  assert.strictEqual(safeEvaluateArithmetic('15.5 + 4.5'), 20);

  // 2. Division by zero safety
  assert.strictEqual(safeEvaluateArithmetic('10 / 0'), null);
  assert.strictEqual(safeEvaluateArithmetic('10 % 0'), null);

  // 3. Rejection of malicious injection / code execution attempts
  assert.strictEqual(safeEvaluateArithmetic('Function("return process")()'), null);
  assert.strictEqual(safeEvaluateArithmetic('console.log(1)'), null);
  assert.strictEqual(safeEvaluateArithmetic('1; eval("2+2")'), null);
  assert.strictEqual(safeEvaluateArithmetic('__proto__'), null);
  assert.strictEqual(safeEvaluateArithmetic(''), null);
});

test('Hardening: L0 Heuristic rejects invalid/malicious strings and evaluates clean math', () => {
  const good = evaluateL0Heuristic('What is 45 * 2?');
  assert.ok(good);
  assert.strictEqual(good.tier, TIERS.L0_HEURISTIC);
  assert.ok(good.content.includes('90'));

  const bad = evaluateL0Heuristic('What is process.exit()?');
  assert.strictEqual(bad, null);
});

test('Hardening: Memory store prevents near-duplicate active memory inserts', () => {
  const mem1 = rememberMemory({
    category: 'invariant',
    content: 'Always drink 500ml water immediately upon waking'
  });

  const mem2 = rememberMemory({
    category: 'invariant',
    content: 'Always drink 500ml water immediately upon waking'
  });

  // Should return the existing record ID, not insert a duplicate row
  assert.strictEqual(mem1.id, mem2.id);

  const activeInvariants = getActiveMemories('invariant');
  const count = activeInvariants.filter(m => m.content === 'Always drink 500ml water immediately upon waking').length;
  assert.strictEqual(count, 1, 'Only one active copy of the invariant exists');
});

test('Hardening: Database backup via VACUUM INTO produces verified snapshot', () => {
  const backup = createDatabaseBackup(testBackupDir);
  assert.ok(backup.backupFile);
  assert.ok(fs.existsSync(backup.backupFile));
  assert.ok(backup.sizeBytes > 0);
  console.log(`💾 Verified sovereign backup: ${backup.backupFile} (${backup.sizeBytes} bytes)`);
});

test('Hardening: Decay candidates query executes without error', () => {
  const candidates = getDecayCandidates(30);
  assert.ok(Array.isArray(candidates));
});

test('Hardening: Cleanup test artifacts', () => {
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
  if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
  if (fs.existsSync(testBackupDir)) fs.rmSync(testBackupDir, { recursive: true, force: true });
});
