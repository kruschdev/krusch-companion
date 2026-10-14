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

const { initCompanionDb, getTasksForDate, createTask, rolloverUnfinishedTasks, today } = await import('../src/db/index.js');
const { safeEvaluateArithmetic, evaluateL0Heuristic, breakdownTaskIntoSubtasks, TIERS } = await import('../src/router/cascade-client.js');
const { rememberMemory, supersedeMemory, getActiveMemories, getSupersededMemories, deleteMemory, getDecayCandidates, createDatabaseBackup, compileStateBriefing } = await import('../src/context/memory-store.js');
const { evaluateCompanionContext } = await import('../src/context/boundary-gate.js');
const { processChaosDump } = await import('../src/services/chaos-dump.js');
const { executeCompanionTool, getAgenticToolStats, setAgenticDryRunMode } = await import('../src/agent/tools.js');
const { runDoctorChecks } = await import('../scripts/doctor.js');

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

test('Hardening: L0 Natural-Language Task & Memory Actions execute deterministically on SQLite', () => {
  // 1. Add task with automatic Tier inference (dentist -> Tier 4: Health & Self)
  const addRes = evaluateL0Heuristic('Add task: Schedule dentist cleaning at 2pm');
  assert.ok(addRes && addRes.handled);
  assert.strictEqual(addRes.actionExecuted.type, 'task_created');
  assert.strictEqual(addRes.actionExecuted.task.tier, 4);
  const createdId = addRes.actionExecuted.task.id;

  // 2. Show / List tasks via L0
  const listRes = evaluateL0Heuristic('Show my tasks for today');
  assert.ok(listRes && listRes.handled);
  assert.strictEqual(listRes.actionExecuted.type, 'tasks_listed');
  assert.ok(listRes.content.includes('Schedule dentist cleaning at 2pm'));

  // 3. Complete task via natural language substring match
  const completeRes = evaluateL0Heuristic('Complete task: dentist cleaning');
  assert.ok(completeRes && completeRes.handled);
  assert.strictEqual(completeRes.actionExecuted.type, 'task_completed');
  assert.strictEqual(completeRes.actionExecuted.task.id, createdId);
  assert.strictEqual(completeRes.actionExecuted.task.completed, 1);

  // 4. Delete task via ID
  const deleteRes = evaluateL0Heuristic(`Delete task #${createdId}`);
  assert.ok(deleteRes && deleteRes.handled);
  assert.strictEqual(deleteRes.actionExecuted.type, 'task_deleted');

  // 5. Semantic memory superseding ("Instead of X, remember that Y")
  rememberMemory({ category: 'decision', content: 'I drink espresso after lunch' });
  const supRes = evaluateL0Heuristic('Instead of espresso, remember that I switched to green tea after lunch');
  assert.ok(supRes && supRes.handled);
  assert.strictEqual(supRes.actionExecuted.type, 'memory_superseded');
});

test('Hardening: Live Daily Task Board & Streak State injected into Companion Context', () => {
  createTask({ title: 'Prepare quarterly strategy memo', priority_id: 5, date: today() });
  const briefing = compileStateBriefing({ date: today(), includeTasks: true });
  assert.ok(briefing.includes("Today's Live Priority Board"));
  assert.ok(briefing.includes('Prepare quarterly strategy memo'));
  assert.ok(briefing.includes('Current Streak'));

  const evalRes = evaluateCompanionContext('What should I tackle next today?');
  assert.strictEqual(evalRes.shouldInjectContext, true);
  assert.ok(evalRes.contextPrompt.includes('Prepare quarterly strategy memo'));
});

test('Hardening: Dual-Axis Priority Board ranks urgent life provision & deadlines above recurring habits while preserving Life Pillar tags', () => {
  // 1. Add a recurring habit (Core Values & Faith) and an urgent life provision bill (Provision & Finance)
  const billRes = evaluateL0Heuristic('Add task: Pay electric bill before 5pm');
  assert.ok(billRes && billRes.handled);
  const billTask = billRes.actionExecuted.task;
  assert.strictEqual(billTask.execution_priority, 1, 'Urgent bill deadline should auto-rank as Execution Priority 1 (Must Happen Today)');
  assert.strictEqual(billTask.pillar, 'Provision & Finance', 'Electric bill should carry the Provision & Finance Life Pillar tag');

  // 2. Verify Today Board orders Execution Priority 1 (Must Happen Today) BEFORE Execution Priority 3 (Daily Habits)
  const board = getTasksForDate(today());
  const billIndex = board.findIndex(t => t.id === billTask.id);
  const habitIndex = board.findIndex(t => t.recurring === 1 && !t.completed);
  assert.ok(billIndex !== -1 && habitIndex !== -1);
  assert.ok(billIndex < habitIndex, 'Must-Happen-Today provision task must appear above recurring daily habits on Today Board');

  // 3. Verify L0 promotion of an existing focus task to Priority 1 (Must Happen Today)
  const strategyTask = createTask({ title: 'Finalize client renewal proposal', priority_id: 5, date: today() });
  assert.strictEqual(strategyTask.execution_priority, 2);
  const promoteRes = evaluateL0Heuristic('Prioritize task: Finalize client renewal proposal');
  assert.ok(promoteRes && promoteRes.handled);
  assert.strictEqual(promoteRes.actionExecuted.type, 'task_prioritized');
  assert.strictEqual(promoteRes.actionExecuted.task.execution_priority, 1);
});

test('Hardening: Daily Task Lifecycle — Recurring Auto-Seed & Unfinished Task Rollover', () => {
  // 1. Recurring tasks auto-seed onto a future date
  const futureDate = '2026-12-31';
  const futureTasks = getTasksForDate(futureDate);
  assert.ok(futureTasks.length >= 4, 'Recurring habits auto-seeded onto new date');
  assert.ok(futureTasks.some(t => t.title === 'Morning gratitude & prayer' && t.recurring === 1));

  // 2. Incomplete non-recurring task on a past date rolls over to today
  const pastDate = '2026-01-01';
  const staleTask = createTask({
    title: 'File 2025 property tax exemption',
    priority_id: 5,
    recurring: 0,
    date: pastDate
  });
  assert.strictEqual(staleTask.date, pastDate);

  const rollover = rolloverUnfinishedTasks(today());
  assert.ok(rollover.rolledOverCount >= 1);
  assert.ok(rollover.tasks.some(t => t.title === 'File 2025 property tax exemption' && t.date === today()));
});

test('Hardening: Task Breakdown decomposes a task into concrete subtasks on Today Board', async () => {
  const parent = createTask({
    title: 'Launch sovereign backup verification pipeline',
    priority_id: 5,
    date: today()
  });

  const breakdown = await breakdownTaskIntoSubtasks({
    taskQuery: `#${parent.id}`,
    date: today()
  });

  assert.ok(breakdown);
  assert.strictEqual(breakdown.actionExecuted.type, 'task_breakdown');
  assert.ok(Array.isArray(breakdown.subtasks));
  assert.ok(breakdown.subtasks.length >= 3);
  const todayTasks = getTasksForDate(today());
  assert.ok(todayTasks.some(t => t.id === breakdown.subtasks[0].id));
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

test('Hardening: External Side-Effect Tool Dry-Run Gate & Telemetry', async () => {
  // Enable Dry-Run Confirmation Gate for external side-effect tools
  setAgenticDryRunMode(true);

  const gmailDryRun = await executeCompanionTool('gkrusch_gmail', {
    action: 'send',
    to: 'partner@example.com',
    subject: 'Dinner tonight',
    body: 'See you at 7pm!'
  });
  assert.strictEqual(gmailDryRun.ok, true);
  assert.strictEqual(gmailDryRun.dryRun, true);
  assert.strictEqual(gmailDryRun.confirmationRequired, true);
  assert.ok(gmailDryRun.summary.includes('Confirmation Gate'));

  const resvDryRun = await executeCompanionTool('concierge_reservation', {
    action: 'book',
    venueName: 'Canlis',
    partySize: 2,
    dateTime: '2026-10-14T19:00:00'
  });
  assert.strictEqual(resvDryRun.ok, true);
  assert.strictEqual(resvDryRun.dryRun, true);
  assert.strictEqual(resvDryRun.confirmationRequired, true);

  // Restore default live mode
  setAgenticDryRunMode(false);

  const stats = getAgenticToolStats();
  assert.ok(stats.totalCalls >= 2);
  assert.ok(stats.totalDryRuns >= 2);
  assert.ok(stats.perTool.gkrusch_gmail.dryRuns >= 1);
});

test('Hardening: Temporal Superseding Lineage History & Memory Deletion', () => {
  const oldMem = rememberMemory({
    category: 'lesson',
    content: 'Evening workout is at 5:30 PM'
  });
  const res = supersedeMemory({
    targetId: oldMem.id,
    category: 'lesson',
    content: 'Evening workout moved to 7:00 PM'
  });
  assert.ok(res.newMemory.id);

  const history = getSupersededMemories(20);
  assert.ok(history.some(h => h.id === oldMem.id && Number(h.superseded_by) === Number(res.newMemory.id)));

  const del = deleteMemory(res.newMemory.id);
  assert.strictEqual(del.deleted, true);
});

test('Hardening: Dual-Axis Task includes lane_reason ("Why this lane?") and Setup Doctor passes', async () => {
  const urgentTask = createTask({
    title: 'Pay electric bill before 5pm',
    priority_id: 5,
    execution_priority: 1,
    pillar: 'Provision & Finance',
    date: today()
  });
  assert.ok(urgentTask.lane_reason && urgentTask.lane_reason.includes('Urgent deadline or household provision'));

  const doc = await runDoctorChecks();
  assert.ok(doc && Array.isArray(doc.checks));
  assert.ok(doc.checks.some(c => c.id === 'node_version' && c.status === 'ok'));
  assert.ok(doc.checks.some(c => c.id === 'sqlite_wal' && c.status === 'ok'));
});

test('Hardening: Cleanup test artifacts', () => {
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
  if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
  if (fs.existsSync(testBackupDir)) fs.rmSync(testBackupDir, { recursive: true, force: true });
});
