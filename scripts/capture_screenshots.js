import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PORT = 3094;
const tmpDbPath = path.join('/tmp', `companion-screenshots-${Date.now()}.db`);

console.log('Starting Krusch Companion server for screenshot capture...');
const serverProc = spawn('node', ['src/server.js'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: tmpDbPath,
    MOCK_LLM: '1',
    DISABLE_SENTINEL_DAEMON: 'true'
  },
  stdio: 'inherit'
});

await new Promise((r) => setTimeout(r, 2000));

async function seedDemoState() {
  const baseUrl = `http://127.0.0.1:${PORT}`;
  // 1. Trigger initial get tasks to seed recurring habits (which land in Lane 3: Daily Habits & Anchors)
  await fetch(`${baseUrl}/api/tasks`);

  // 2. Seed Dual-Axis tasks across Lanes 1, 2, and 4 with diverse Life Pillars
  const demoTasks = [
    {
      title: 'Pay electric bill & sign Q4 contract invoice before 5pm',
      execution_priority: 1,
      pillar: 'Provision & Finance',
      notes: 'Due today by 5:00 PM — household & client provision'
    },
    {
      title: 'Pick up prescription & confirm pediatric dentist appointment',
      execution_priority: 1,
      pillar: 'Children & Loved Ones',
      notes: 'Call clinic before 3:30 PM'
    },
    {
      title: 'Ship Dual-Axis Priority Board & Sentinel Watchdog release',
      execution_priority: 2,
      pillar: 'Work & Mastery',
      notes: '39/39 hermetic tests verified'
    },
    {
      title: 'Evening walk & dinner reservation with partner at 6:30 PM',
      execution_priority: 2,
      pillar: 'Family & Partner',
      notes: '[Reservation Hold] Canlis Seattle — Leave by 5:50 PM'
    },
    {
      title: 'Organize garage tool bench when time permits',
      execution_priority: 4,
      pillar: 'Provision & Finance',
      notes: 'Weekend backlog'
    }
  ];

  for (const t of demoTasks) {
    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(t)
    });
  }

  // 3. Generate Morning Focus briefing
  await fetch(`${baseUrl}/api/coach/focus`, { method: 'POST' });

  // 4. Trigger a Sentinel Watchdog alert so CompanionView displays the proactive alert banner
  await fetch(`${baseUrl}/api/sentinel/tick`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      emails: [
        {
          id: 'demo-urgent-email-1',
          from: 'Alex Rivera <alex@client-corp.com>',
          subject: 'URGENT: Action required on Q4 Contract Invoice before 5pm',
          snippet: 'Please review and countersign the Q4 invoice before 5:00 PM today.'
        }
      ]
    })
  });
}

const views = [
  { tab: 'companion', file: 'docs/screenshots/companion-view.png', height: 860 },
  { tab: 'stream', file: 'docs/screenshots/thought-stream.png', height: 820 },
  { tab: 'stream', file: 'docs/screenshots/chaos-dump.png', height: 820 },
  { tab: 'today', file: 'docs/screenshots/today-board.png', height: 1240 },
  { tab: 'focus', file: 'docs/screenshots/focus-mode.png', height: 820 }
];

try {
  await seedDemoState();
  for (const v of views) {
    const outPath = path.join(projectRoot, v.file);
    const url = `http://127.0.0.1:${PORT}/?tab=${v.tab}`;
    const tmpProfile = path.join('/tmp', `chrome-profile-${Date.now()}`);
    console.log(`Capturing ${v.tab} -> ${v.file}...`);
    execSync(
      `google-chrome --headless --disable-gpu --no-sandbox --hide-scrollbars --incognito --user-data-dir="${tmpProfile}" --window-size=1240,${v.height} --virtual-time-budget=3500 --screenshot="${outPath}" "${url}"`,
      { stdio: 'inherit' }
    );
    try {
      fs.rmSync(tmpProfile, { recursive: true, force: true });
    } catch {}
  }
  console.log('✅ All screenshots captured successfully.');
} catch (err) {
  console.error('Failed capturing screenshots:', err);
} finally {
  serverProc.kill();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${tmpDbPath}${suffix}`, { force: true });
    } catch {}
  }
  process.exit(0);
}
