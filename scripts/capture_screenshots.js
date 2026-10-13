import { spawn } from 'child_process';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

console.log('Starting Krusch Companion server for screenshot capture...');
const serverProc = spawn('node', ['src/server.js'], {
  cwd: projectRoot,
  stdio: 'inherit'
});

// Wait 2 seconds for server to be up
await new Promise((r) => setTimeout(r, 2000));

const views = [
  { tab: 'companion', file: 'docs/screenshots/companion-view.png' },
  { tab: 'stream', file: 'docs/screenshots/thought-stream.png' },
  { tab: 'stream', file: 'docs/screenshots/chaos-dump.png' },
  { tab: 'today', file: 'docs/screenshots/today-board.png' },
  { tab: 'focus', file: 'docs/screenshots/focus-mode.png' }
];

try {
  for (const v of views) {
    const outPath = path.join(projectRoot, v.file);
    const url = `http://localhost:3004/?tab=${v.tab}`;
    const tmpProfile = path.join('/tmp', `chrome-profile-${Date.now()}`);
    console.log(`Capturing ${v.tab} -> ${v.file}...`);
    execSync(`google-chrome --headless --disable-gpu --no-sandbox --hide-scrollbars --incognito --user-data-dir="${tmpProfile}" --window-size=1200,800 --virtual-time-budget=3000 --screenshot="${outPath}" "${url}"`, {
      stdio: 'inherit'
    });
    try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {}
  }
  console.log('✅ All screenshots captured successfully.');
} catch (err) {
  console.error('Failed capturing screenshots:', err);
} finally {
  serverProc.kill();
  process.exit(0);
}
