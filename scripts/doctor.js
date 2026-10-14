#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../src/config.js';
import * as db from '../src/db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

export async function runDoctorChecks() {
  const checks = [];

  // 1. Node.js Version
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  checks.push({
    id: 'node_version',
    name: 'Node.js Runtime (>=22.0.0)',
    status: nodeMajor >= 22 ? 'ok' : 'error',
    detail: `v${process.versions.node}`,
    remediation: nodeMajor >= 22 ? null : 'Install Node.js v22.0.0 or newer.'
  });

  // 2. SQLite WAL Database & Integrity
  try {
    db.initCompanionDb();
    const row = db.getDb().prepare('PRAGMA integrity_check').get();
    const ok = row?.integrity_check === 'ok';
    checks.push({
      id: 'sqlite_wal',
      name: 'SQLite WAL Database & Integrity',
      status: ok ? 'ok' : 'error',
      detail: `Path: ${config.db.path} (integrity: ${row?.integrity_check || 'unknown'})`,
      remediation: ok ? null : 'Database integrity check failed; restore from data/backups/.'
    });
  } catch (err) {
    checks.push({
      id: 'sqlite_wal',
      name: 'SQLite WAL Database & Integrity',
      status: 'error',
      detail: err.message,
      remediation: 'Run `npm install` to ensure better-sqlite3 is compiled for your platform.'
    });
  }

  // 3. Frontend Production Bundle
  const distIndex = path.join(projectRoot, 'client', 'dist', 'index.html');
  const hasBuild = fs.existsSync(distIndex);
  checks.push({
    id: 'client_bundle',
    name: 'React 19 PWA Frontend Build',
    status: hasBuild ? 'ok' : 'warn',
    detail: hasBuild ? 'client/dist/index.html present' : 'client/dist/ not built yet',
    remediation: hasBuild ? null : 'Run `npm --prefix client install && npm --prefix client run build`'
  });

  // 4. Local Ollama Runtime & Model
  let ollamaReachable = false;
  let edgeModelPresent = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${config.cascade.ollamaUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      ollamaReachable = true;
      const data = await res.json();
      const models = (data.models || []).map((m) => m.name);
      edgeModelPresent = models.some(
        (m) => m === config.cascade.edgeModel || m.startsWith(config.cascade.edgeModel.split(':')[0])
      );
    }
  } catch {
    ollamaReachable = false;
  }

  const openrouterReady = Boolean(config.cascade.openrouterApiKey);
  const mockMode = process.env.MOCK_LLM === '1';

  checks.push({
    id: 'ollama_runtime',
    name: `Local Ollama (${config.cascade.ollamaUrl})`,
    status: ollamaReachable ? (edgeModelPresent ? 'ok' : 'warn') : openrouterReady || mockMode ? 'optional' : 'warn',
    detail: ollamaReachable
      ? edgeModelPresent
        ? `Connected · Model '${config.cascade.edgeModel}' ready`
        : `Connected · Model '${config.cascade.edgeModel}' not pulled yet`
      : 'Offline (use Ollama, OpenRouter ZDR mode, or MOCK_LLM=1)',
    remediation: !ollamaReachable
      ? 'Start Ollama (`ollama serve`), or set OPENROUTER_API_KEY, or run with MOCK_LLM=1'
      : !edgeModelPresent
      ? `Run \`ollama pull ${config.cascade.edgeModel}\``
      : null
  });

  // 5. OpenRouter Zero-GPU Cloud Mode
  checks.push({
    id: 'openrouter_zdr',
    name: 'OpenRouter Zero-GPU Connector (ZDR)',
    status: openrouterReady ? 'ok' : 'optional',
    detail: openrouterReady
      ? `API key configured · Zero Data Retention=${config.cascade.openrouterZeroDataRetention}`
      : 'Not configured (optional zero-GPU cloud mode)',
    remediation: openrouterReady ? null : 'Optional: set OPENROUTER_API_KEY and LLM_PROVIDER="openrouter" for zero-GPU mode.'
  });

  // 6. Optional G-Krusch Google Workspace Bridge
  const gkruschUrl = process.env.G_KRUSCH_URL || 'http://127.0.0.1:5446';
  let gkruschOnline = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${gkruschUrl}/api/status`, { signal: controller.signal });
    clearTimeout(timer);
    gkruschOnline = res.ok;
  } catch {
    gkruschOnline = false;
  }

  checks.push({
    id: 'gkrusch_workspace',
    name: `G-Krusch Google Workspace Bridge (${gkruschUrl})`,
    status: gkruschOnline ? 'ok' : 'optional',
    detail: gkruschOnline
      ? 'Connected (Live Drive Hybrid RAG, Calendar, Gmail active)'
      : 'Offline (graceful local fallback to data/notes/ & Today Board active)',
    remediation: null
  });

  const hasReadyLlm = (ollamaReachable && edgeModelPresent) || openrouterReady || mockMode;
  return {
    ready: nodeMajor >= 22 && hasReadyLlm,
    activeMode: mockMode
      ? 'hermetic_mock'
      : config.cascade.provider === 'openrouter' && openrouterReady
      ? 'openrouter_zdr'
      : ollamaReachable
      ? 'local_ollama'
      : 'l0_cpu_and_fallback_only',
    checks
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await runDoctorChecks();
  console.log('\n🩺 Krusch Companion — Setup & Environment Doctor\n' + '═'.repeat(56));
  for (const c of report.checks) {
    const icon = c.status === 'ok' ? '✅' : c.status === 'optional' ? 'ℹ️ ' : c.status === 'warn' ? '⚠️ ' : '❌';
    console.log(`${icon} ${c.name.padEnd(42)} ${c.detail}`);
    if (c.remediation) {
      console.log(`   ↳ Fix: ${c.remediation}`);
    }
  }
  console.log('═'.repeat(56));
  console.log(`Active Runtime Mode: ${report.activeMode.toUpperCase()} | Ready: ${report.ready ? 'YES ✅' : 'NEEDS LLM OR MOCK_LLM=1 ⚠️'}\n`);
}
