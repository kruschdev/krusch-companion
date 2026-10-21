/**
 * Krusch Companion V3.8 Personal AI Ecosystem & Opt-In Extension Pack Test Suite
 *
 * Verifies Invariants INV-EXT-01 through INV-EXT-08:
 *  - INV-EXT-01: Opt-In Extension Registry & 20-Tool Baseline Preservation
 *  - INV-EXT-02: KruschFS 3-Zone Privacy Shield (path traversal, SSH key block, .env secret redaction, page tree & page memories)
 *  - INV-EXT-03: Pre-Spool Vision Magic-Byte Gate & gemma4:e4b Multimodal Triage
 *  - INV-EXT-04: Offline-Resilient 2-Way Spoken TTS & Valid RIFF/WAVE Generation
 *  - INV-EXT-05: 2-Way Interactive Telegram/Discord/Shortcut Bot & Callback Confirmation Gate
 *  - INV-EXT-06: Subscriptions, Bills & Receipt Ledger + Zero-Token Sentinel Channel 5 Renewal Watchdog
 *  - INV-EXT-07: Biometric Energy Readiness Board Adaptation & Jellyfin Media Controller Twin
 *  - INV-EXT-08: V3.8 REST API Endpoints (/api/extensions, /api/companion/vision, /api/companion/tts, /api/finance, /api/health-sync, /api/media, /api/companion/shortcut)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-companion-v38-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test-v38-companion.db');
process.env.COMPANION_NOTES_DIR = path.join(tmpDir, 'notes');
process.env.MOCK_LLM = '1';
process.env.DISABLE_SENTINEL_DAEMON = 'true';
process.env.KRUSCH_NO_LISTEN = '1';

const { initCompanionDb, createTask, getTasksForDate, today } = await import('../src/db/index.js');
const { COMPANION_TOOLS, isSafePublicUrl } = await import('../src/agent/tools.js');
const { detectAgenticIntent, executeAgenticProxyTurn } = await import('../src/agent/agentic-proxy.js');
const {
  ensureAllExtensionsLoaded,
  listExtensions,
  setExtensionEnabled,
  getEnabledExtensionTools
} = await import('../src/extensions/extension-registry.js');
const {
  isPathProtectedOrTraversed,
  redactEnvSecrets,
  readFileTextSafely,
  MAX_FILE_BYTES,
  KRUSCH_FS_EXTENSION_TOOL
} = await import('../src/extensions/krusch-fs-extension.js');
const {
  validateImageMagicBytes,
  analyzeCompanionImage
} = await import('../src/services/vision.js');
const {
  cleanTextForSpeech,
  buildFallbackWavBuffer,
  synthesizeSpeech
} = await import('../src/services/tts.js');
const {
  handleInboundChannelBotTurn,
  handleBotCallbackAction,
  generateMobileShortcutManifest
} = await import('../src/services/channel-bot.js');
const {
  upsertSubscription,
  evaluateSubscriptionRenewalAnomalies,
  getMonthlyFinanceSummary
} = await import('../src/extensions/finance-ledger-extension.js');
const {
  recordHealthMetrics,
  adaptBoardToEnergyReadiness
} = await import('../src/extensions/health-media-extension.js');
const { runSentinelTick } = await import('../src/services/sentinel-daemon.js');
const { speakReplyText, stopSpeaking, createLiveVoiceController } = await import('../client/src/utils/liveVoiceLoop.js');
const { app } = await import('../src/server.js');

const VALID_1X1_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('Krusch Companion V3.8 — Personal AI Ecosystem & Opt-In Extension Pack', () => {
  let serverInstance = null;
  let baseUrl = '';

  before(async () => {
    initCompanionDb();
    await ensureAllExtensionsLoaded();
    await new Promise((resolve) => {
      serverInstance = app.listen(0, '127.0.0.1', () => {
        const addr = serverInstance.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (serverInstance) {
      await new Promise((resolve) => serverInstance.close(resolve));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. INV-EXT-01 & SPEC-01: Preserves 20 core Sovereign Tools while routing enabled extensions through Agentic Proxy', async () => {
    assert.equal(COMPANION_TOOLS.length, 20, 'Core COMPANION_TOOLS must remain strictly 20');
    const extensions = listExtensions();
    assert.ok(extensions.length >= 6, 'Should register at least 6 opt-in extensions in catalog');

    const toggleRes = setExtensionEnabled('krusch-fs-bridge', true);
    assert.equal(toggleRes.extensionId, 'krusch-fs-bridge');
    assert.equal(toggleRes.enabled, true);

    const enabledTools = getEnabledExtensionTools();
    assert.ok(
      enabledTools.some((t) => t.name === 'krusch_fs_explorer' || t.name === 'krusch_fs_extension'),
      'Enabled extension tool should appear in getEnabledExtensionTools()'
    );

    const intent = detectAgenticIntent('Please search my local documents for the lease agreement');
    assert.equal(intent.shouldUseAgenticProxy, true);
    assert.ok(intent.matchedCategories.includes('filesystem_bridge'));
    assert.ok(intent.tools.some((t) => t.name === 'krusch_fs_explorer' || t.name === 'krusch_fs_extension'));

    const proxyTurn = await executeAgenticProxyTurn({
      prompt: 'Please search my local documents for the lease agreement',
      callLlm: async () => ({ content: '' })
    });
    assert.ok(proxyTurn, 'executeAgenticProxyTurn should execute enabled extension tool via fallback');
    assert.ok(
      proxyTurn.agenticTrace.toolCalls.some(
        (tc) => tc.name === 'krusch_fs_explorer' || tc.name === 'krusch_fs_extension'
      )
    );
  });

  it('2. INV-EXT-02, SEC-01 & SPEC-03: KruschFS Explorer enforces 3-Zone Privacy Shield, blocks outside paths/symlinks, enforces 2MB ceiling, and redacts .env secrets', async () => {
    const traversalCheck = isPathProtectedOrTraversed('../../etc/shadow');
    assert.equal(traversalCheck.blocked, true);

    const sshKeyCheck = isPathProtectedOrTraversed('/home/user/.ssh/id_ed25519');
    assert.equal(sshKeyCheck.blocked, true);
    assert.equal(sshKeyCheck.reason, 'VAULT_LOCKED');

    const rawEnv = 'PORT=3004\nOPENROUTER_API_KEY=sk-or-v1-secret999\nPOSTGRES_PASSWORD=supersecret';
    const redacted = redactEnvSecrets(rawEnv);
    assert.ok(redacted.includes('PORT=3004'), 'Non-secret key should remain visible');
    assert.ok(redacted.includes('OPENROUTER_API_KEY=[REDACTED]'), 'API key must be redacted');
    assert.ok(!redacted.includes('sk-or-v1-secret999'), 'Secret value must not leak');

    // Create a sample document in notesDir and test page_tree + remember_on_page + read_page
    fs.mkdirSync(process.env.COMPANION_NOTES_DIR, { recursive: true });
    const sampleDoc = path.join(process.env.COMPANION_NOTES_DIR, 'lease-agreement.md');
    fs.writeFileSync(
      sampleDoc,
      '# Residential Lease Agreement\nTenant Notice Period: 30 days prior to renewal.\nOPENAI_API_KEY=sk-live-12345\n',
      'utf8'
    );

    // SEC-01: Arbitrary path outside candidateDirs must be rejected
    const outsideFile = path.join(tmpDir, 'outside-secret.md');
    fs.writeFileSync(outsideFile, 'TOP SECRET OUTSIDE SAFE ROOTS', 'utf8');
    const outsideTreeRes = await KRUSCH_FS_EXTENSION_TOOL.execute(
      { action: 'page_tree', filePath: outsideFile },
      { searchDirs: [process.env.COMPANION_NOTES_DIR] }
    );
    assert.equal(outsideTreeRes.ok, false, 'Path outside candidateDirs must be blocked');

    // SEC-01: Symlink inside candidateDirs pointing outside candidateDirs must be rejected
    const symlinkPath = path.join(process.env.COMPANION_NOTES_DIR, 'evil-symlink.md');
    try {
      fs.symlinkSync(outsideFile, symlinkPath);
      const symlinkRead = await KRUSCH_FS_EXTENSION_TOOL.execute(
        { action: 'read_page', filePath: symlinkPath, pageNumber: 1 },
        { searchDirs: [process.env.COMPANION_NOTES_DIR] }
      );
      assert.equal(symlinkRead.ok, false, 'Symlink pointing outside candidateDirs must be blocked');
    } finally {
      fs.rmSync(symlinkPath, { force: true });
    }

    // SPEC-03: File larger than MAX_FILE_BYTES (2 MB) must be rejected by readFileTextSafely and page_tree
    const oversizedDoc = path.join(process.env.COMPANION_NOTES_DIR, 'oversized.md');
    fs.writeFileSync(oversizedDoc, Buffer.alloc(MAX_FILE_BYTES + 1024, 0x41));
    try {
      assert.throws(
        () => readFileTextSafely(oversizedDoc, [process.env.COMPANION_NOTES_DIR]),
        /exceeds maximum allowed limit/,
        'Files exceeding MAX_FILE_BYTES must throw before reading into memory'
      );
      const oversizedTreeRes = await KRUSCH_FS_EXTENSION_TOOL.execute(
        { action: 'page_tree', filePath: oversizedDoc },
        { searchDirs: [process.env.COMPANION_NOTES_DIR] }
      );
      assert.equal(oversizedTreeRes.ok, false, 'page_tree on file > 2MB must fail safely');
    } finally {
      fs.rmSync(oversizedDoc, { force: true });
    }

    const treeRes = await KRUSCH_FS_EXTENSION_TOOL.execute(
      { action: 'page_tree', filePath: sampleDoc },
      { searchDirs: [process.env.COMPANION_NOTES_DIR] }
    );
    assert.equal(treeRes.ok, true);
    assert.equal(treeRes.data.totalPages, 1);

    const rememberRes = await KRUSCH_FS_EXTENSION_TOOL.execute(
      {
        action: 'remember_on_page',
        filePath: sampleDoc,
        pageNumber: 1,
        note: 'Verify 30-day notice requirement before October renewal.'
      },
      { searchDirs: [process.env.COMPANION_NOTES_DIR] }
    );
    assert.equal(rememberRes.ok, true);

    const readRes = await KRUSCH_FS_EXTENSION_TOOL.execute(
      { action: 'read_page', filePath: sampleDoc, pageNumber: 1 },
      { searchDirs: [process.env.COMPANION_NOTES_DIR] }
    );
    assert.equal(readRes.ok, true);
    assert.ok(readRes.data.pageText.includes('OPENAI_API_KEY=[REDACTED]'));
    assert.equal(readRes.data.pageMemories.length, 1);
    assert.equal(readRes.data.pageMemories[0].driftStatus, 'VALID');
  });

  it('3. INV-EXT-03 & SPEC-02: Multimodal Vision validates magic bytes, initializes companion_receipts, and stages receipt/bill tasks onto Today Board', async () => {
    const elfBuf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
    const badCheck = validateImageMagicBytes(elfBuf);
    assert.equal(badCheck.valid, false);
    assert.equal(badCheck.reason, 'INVALID_IMAGE_MAGIC_BYTES');

    const pngBuf = Buffer.from(VALID_1X1_PNG_BASE64, 'base64');
    const goodCheck = validateImageMagicBytes(pngBuf);
    assert.equal(goodCheck.valid, true);
    assert.equal(goodCheck.detectedMimeType, 'image/png');

    const analysis = await analyzeCompanionImage({
      imageBuffer: pngBuf,
      filename: 'seattle-city-light-bill.png',
      prompt: 'Receipt from Seattle City Light for $142.50 due 2026-10-25',
      mode: 'receipt_or_bill',
      autoStageBoard: true
    });
    assert.equal(analysis.ok, true);
    assert.equal(analysis.mode, 'receipt_or_bill');
    assert.ok(analysis.stagedTask?.id, 'Should stage a Priority 1 task on Today Board');
    assert.ok(analysis.receiptId, 'SPEC-02: Should initialize companion_receipts and return non-null receiptId');

    const chromeAudit = await analyzeCompanionImage({
      imageBuffer: pngBuf,
      filename: 'chrome-viewport-375px.png',
      prompt: 'Audit Chrome responsive breakpoint layout for horizontal overflow',
      mode: 'auto',
      autoStageBoard: true
    });
    assert.equal(chromeAudit.ok, true);
    assert.equal(chromeAudit.mode, 'chrome_ui_audit');
    assert.equal(chromeAudit.stagedTask?.pillar, 'Work & Mastery');
  });

  it('4. INV-EXT-04, UI-03 & SPEC-05: Local TTS Engine and client liveVoiceLoop controller settle promises cleanly on stopSpeaking()', async () => {
    const dirty = '<holodata>{"thought":"test"}</holodata>\n# Morning Briefing\nCheck **Seattle City Light** at https://example.com!';
    const cleaned = cleanTextForSpeech(dirty);
    assert.ok(!cleaned.includes('<holodata>'));
    assert.ok(!cleaned.includes('**'));

    const wav = buildFallbackWavBuffer('Hello from Krusch Companion');
    assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');

    const ttsOut = await synthesizeSpeech({ text: dirty, voice: 'af_heart', speed: 1.0 });
    assert.equal(ttsOut.ok, true);
    assert.equal(ttsOut.mimeType, 'audio/wav');
    assert.ok(ttsOut.audioBase64.length > 60);

    // SPEC-05 & UI-03: Verify createLiveVoiceController and stopSpeaking() settling in-flight audio
    const controller = createLiveVoiceController({
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          useBrowserSpeechSynthesis: true,
          cleanSpokenText: 'Testing live voice controller'
        })
      })
    });
    assert.equal(controller.isEnabled(), false);
    assert.equal(controller.toggle(), true);
    const speakRes = await controller.speak('Testing live voice controller');
    assert.equal(speakRes.ok, true);
    stopSpeaking();

    // Verify stopSpeaking() during an in-flight TTS fetch cancels stale playback (Jean SRE Review #6)
    let resolveDelayedFetch;
    const delayedController = createLiveVoiceController({
      fetchImpl: () =>
        new Promise((resolve) => {
          resolveDelayedFetch = () =>
            resolve({
              ok: true,
              json: async () => ({
                ok: true,
                useBrowserSpeechSynthesis: true,
                cleanSpokenText: 'Delayed speech'
              })
            });
        })
    });
    const inFlightPromise = delayedController.speak('Delayed speech');
    delayedController.stop();
    resolveDelayedFetch();
    const cancelledRes = await inFlightPromise;
    assert.equal(cancelledRes.ok, false);
    assert.equal(cancelledRes.cancelled, true);
    assert.equal(delayedController.isSpeaking(), false);
  });

  it('5. INV-EXT-05, SEC-02, DB-01 & SPEC-04: 2-Way Bot blocks SSRF replyWebhookUrl, prevents double-tap callback races, and accepts string body.message', async () => {
    // SEC-02: Verify IPv6 loopback, IPv4-mapped IPv6, and Tailscale CGNAT are blocked by isSafePublicUrl
    assert.equal(isSafePublicUrl('http://[::1]:3004/api/status'), false);
    assert.equal(isSafePublicUrl('http://[::ffff:127.0.0.1]:3004/api/status'), false);
    assert.equal(isSafePublicUrl('http://100.65.159.15:11434/api/tags'), false);
    assert.equal(isSafePublicUrl('https://api.github.com'), true);

    let webhookFetched = false;
    const addTurn = await handleInboundChannelBotTurn({
      platform: 'telegram',
      payload: {
        replyWebhookUrl: 'http://100.65.159.15:11434/ssrf-test',
        message: {
          chat: { id: 778899 },
          from: { first_name: 'Krusch' },
          text: '/add Call CPA about Q4 tax estimate'
        }
      },
      fetchImpl: async () => {
        webhookFetched = true;
        return { ok: true };
      }
    });
    assert.equal(addTurn.ok, true);
    assert.equal(addTurn.tierUsed, 'L0_bot');
    assert.equal(webhookFetched, false, 'SEC-02: Private/Tailscale replyWebhookUrl must never be fetched');
    assert.ok(addTurn.reply.includes('Call CPA about Q4 tax estimate'));

    // SPEC-04: Verify string body.message payload (sent by ExtensionsView.jsx) is parsed properly
    const stringMsgTurn = await handleInboundChannelBotTurn({
      platform: 'telegram',
      payload: {
        message: '/today'
      }
    });
    assert.equal(stringMsgTurn.ok, true);
    assert.ok(stringMsgTurn.reply.includes('Call CPA about Q4 tax estimate'));

    // Simulate a natural-language turn that returns a pending side-effect confirmation
    const gatedTurn = await handleInboundChannelBotTurn({
      platform: 'discord',
      payload: {
        channel_id: 'disc-99',
        author: { username: 'krusch' },
        content: 'Send an email to landlord'
      },
      dispatchChat: async () => ({
        content: 'I staged a draft email to your landlord. Please confirm.',
        tierUsed: 'L1_edge_7b',
        agenticTrace: {
          toolCalls: [
            {
              name: 'create_task',
              arguments: { title: 'Confirmed via Bot Callback Button', execution_priority: 1 },
              requiresConfirmation: true,
              dryRun: true
            }
          ]
        }
      })
    });
    assert.equal(gatedTurn.ok, true);
    assert.equal(gatedTurn.pendingConfirmations.length, 1);
    assert.ok(gatedTurn.inlineKeyboard?.inline_keyboard);

    const callbackId = gatedTurn.pendingConfirmations[0].callbackId;
    const confirmed = await handleBotCallbackAction({ callbackId });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.tool, 'create_task');

    // DB-01: Second tap on same callbackId must return alreadyExecuted: true without re-running tool
    let secondExecCount = 0;
    const secondTap = await handleBotCallbackAction({
      callbackId,
      executeTool: async () => {
        secondExecCount += 1;
        return { ok: true };
      }
    });
    assert.equal(secondTap.ok, true);
    assert.equal(secondTap.alreadyExecuted, true);
    assert.equal(secondExecCount, 0, 'DB-01: Atomic claim must prevent duplicate callback execution');

    const manifest = generateMobileShortcutManifest({ baseUrl: 'http://localhost:3004' });
    assert.ok(manifest.iosShortcuts.length >= 3);
  });

  it('6. INV-EXT-06 & UI-01: Finance Subscription Ledger & Sentinel Channel 5 Auto-Renewal Watchdog', async () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const sub = upsertSubscription({
      name: 'Adobe Creative Cloud',
      amount: 59.99,
      billingCycle: 'monthly',
      nextRenewalDate: tomorrow,
      autoRenew: true,
      cancelUrl: 'https://account.adobe.com'
    });
    assert.ok(sub.id, 'Should return upserted subscription row with id');
    assert.equal(sub.name, 'Adobe Creative Cloud');

    const summary = getMonthlyFinanceSummary();
    assert.ok(summary.monthlyRecurringTotal >= 59.99);
    assert.equal(summary.monthlyTotal, summary.monthlyRecurringTotal, 'UI-01: monthlyTotal alias must match monthlyRecurringTotal');

    const tick = await runSentinelTick({
      customEvents: [],
      customEmails: [],
      customCalendarEvents: [],
      checkSubscriptions: true
    });
    assert.ok(tick.llmCallsTriggered >= 1);
    assert.ok(
      tick.triggeredAlerts.some(
        (a) => a.triggerReason === 'subscription_renewal_imminent' && a.headline.includes('Adobe Creative Cloud')
      ),
      'Sentinel Channel 5 should trigger a subscription_renewal_imminent alert for imminent auto-renewal'
    );

    // Second tick should not duplicate the same renewal cycle notification
    const secondAnomalies = evaluateSubscriptionRenewalAnomalies({ daysAhead: 3 });
    assert.ok(
      !secondAnomalies.some((a) => a.name === 'Adobe Creative Cloud'),
      'last_notified_renewal should prevent duplicate alerts for the same renewal cycle'
    );
  });

  it('7. INV-EXT-07 & DB-03: Biometric Energy Readiness adapts Today Board idempotently without demoting Lane 1 tasks', async () => {
    const p1Task = createTask({
      title: 'Pay property tax installment',
      execution_priority: 1,
      pillar: 'Provision & Finance',
      energy_level: 'high',
      date: today()
    });
    const p2HighEnergyTask = createTask({
      title: 'Refactor garage storage racks',
      execution_priority: 2,
      pillar: 'Household & Operations',
      energy_level: 'high',
      date: today()
    });

    const recorded = recordHealthMetrics({
      date: today(),
      sleepHours: 4.8,
      sleepScore: 52,
      hrvMs: 32,
      readinessScore: 48,
      source: 'oura'
    });
    assert.equal(recorded.energyBand, 'low_recovery');

    const adapted = adaptBoardToEnergyReadiness({ date: today() });
    assert.equal(adapted.ok, true);
    assert.equal(adapted.energyBand, 'low_recovery');
    assert.ok(
      adapted.adaptedTaskIds.includes(p2HighEnergyTask.id),
      'Lane 2 high-energy task should be adapted to Lane 4 on low_recovery days'
    );
    assert.ok(
      !adapted.adaptedTaskIds.includes(p1Task.id),
      'Lane 1 Must-Happen-Today task must NEVER be demoted'
    );

    // DB-03 / SPEC-06: Second invocation on the same board must not re-demote tasks already in Lane 4
    const secondAdapted = adaptBoardToEnergyReadiness({ date: today() });
    assert.equal(
      secondAdapted.adaptedTaskIds.length,
      0,
      'DB-03: Tasks already in Lane 4 must not be repeatedly re-demoted'
    );

    const updatedTasks = getTasksForDate(today());
    const checkP1 = updatedTasks.find((t) => t.id === p1Task.id);
    const checkP2 = updatedTasks.find((t) => t.id === p2HighEnergyTask.id);
    assert.equal(checkP1.execution_priority, 1);
    assert.equal(checkP2.execution_priority, 4);
  });

  it('8. INV-EXT-08, UI-01, UI-02 & UI-04: End-to-End V3.8 HTTP REST Endpoints respond with aligned contracts', async () => {
    const extRes = await fetch(`${baseUrl}/api/extensions`);
    assert.equal(extRes.status, 200);
    const extJson = await extRes.json();
    assert.equal(extJson.ok, true);
    assert.ok(Array.isArray(extJson.extensions));

    const ttsRes = await fetch(`${baseUrl}/api/companion/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Good morning! You have 3 tasks on your board.' })
    });
    assert.equal(ttsRes.status, 200);
    const ttsJson = await ttsRes.json();
    assert.equal(ttsJson.ok, true);
    assert.ok(ttsJson.audioBase64);

    const visionRes = await fetch(`${baseUrl}/api/companion/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: VALID_1X1_PNG_BASE64,
        filename: 'soccer-schedule-flyer.png',
        prompt: 'Kids soccer practice flyer on Saturday at 10am'
      })
    });
    assert.equal(visionRes.status, 200);
    const visionJson = await visionRes.json();
    assert.equal(visionJson.ok, true);

    const finRes = await fetch(`${baseUrl}/api/finance`);
    assert.equal(finRes.status, 200);
    const finJson = await finRes.json();
    assert.equal(finJson.ok, true);
    assert.equal(typeof finJson.monthlyTotal, 'number');
    assert.equal(finJson.monthlyTotal, finJson.monthlyRecurringTotal);

    const healthRes = await fetch(`${baseUrl}/api/health-sync`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.ok, true);
    assert.ok(healthJson.current?.sleep_hours !== undefined);
    assert.ok(healthJson.latest?.sleep_hours !== undefined);

    // SPEC-04 / UI-04: Verify /api/companion/bot/webhook route
    const webhookRes = await fetch(`${baseUrl}/api/companion/bot/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'telegram', message: '/today' })
    });
    assert.equal(webhookRes.status, 200);
    const webhookJson = await webhookRes.json();
    assert.equal(webhookJson.ok, true);

    const mediaRes = await fetch(`${baseUrl}/api/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'play', query: 'focus_brown_noise' })
    });
    assert.equal(mediaRes.status, 200);
    const mediaJson = await mediaRes.json();
    assert.equal(mediaJson.ok, true);

    const actionRes = await fetch(`${baseUrl}/api/companion/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'krusch_fs_explorer',
        args: { action: 'search', query: 'Lease' }
      })
    });
    assert.equal(actionRes.status, 200);
    const actionJson = await actionRes.json();
    assert.equal(actionJson.ok, true);

    // Proposal Redlines -> Reference-Backed Skill Distiller (POST & GET /api/companion/distill-skill)
    const distillRes = await fetch(`${baseUrl}/api/companion/distill-skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Enterprise Proposal Playbook',
        corrections: [
          'Lead Page 1 with 3-sentence problem framing and fixed-scope deliverable matrix',
          'Replace hourly rate tables with milestone-gated fixed-fee stages'
        ],
        referenceFilePath: 'lease-agreement.md'
      })
    });
    assert.equal(distillRes.status, 200);
    const distillJson = await distillRes.json();
    assert.equal(distillJson.ok, true);
    assert.equal(distillJson.actionType, 'krusch_fs_distill_skill');
    assert.ok(distillJson.data.playbookContent.includes('Learned Redline Guardrails'));
    assert.ok(distillJson.data.playbookContent.includes('Human Judgment Checkpoints'));

    const listDistillRes = await fetch(`${baseUrl}/api/companion/distill-skill`);
    assert.equal(listDistillRes.status, 200);
    const listDistillJson = await listDistillRes.json();
    assert.equal(listDistillJson.ok, true);
    assert.ok(listDistillJson.count >= 1);
  });

  it('9. Jean SRE Audit Remediation: companionClient.js validates VALID_COMPANION_TABS (including extensions) and sanitizes session IDs', async () => {
    const {
      VALID_COMPANION_TABS,
      sanitizeSessionId,
      readInitialActiveTab
    } = await import('../client/src/utils/companionClient.js');

    assert.ok(VALID_COMPANION_TABS.includes('extensions'), 'VALID_COMPANION_TABS must include extensions tab');
    assert.equal(sanitizeSessionId('  session-01<script>alert(1)</script>  '), 'session-01scriptalert1script');
    assert.equal(sanitizeSessionId('   ', 'fallback-id'), 'fallback-id');
    assert.equal(readInitialActiveTab(), 'companion');
  });

  it('10. Chrome Browser Navigator Extension (chrome-browser-navigator / browser_navigate) & Gemini 4 Argon UI Audit', async () => {
    const {
      validateBrowserTargetUrl,
      navigateCompanionBrowser
    } = await import('../src/extensions/browser-navigator-extension.js');

    assert.equal(COMPANION_TOOLS.length, 20, 'Core COMPANION_TOOLS must remain strictly 20');
    const extensions = listExtensions();
    assert.ok(
      extensions.some((e) => e.extensionId === 'chrome-browser-navigator' && e.toolName === 'browser_navigate'),
      'chrome-browser-navigator must be registered in EXTENSION_CATALOG'
    );

    // SSRF guard must block internal Tailscale / loopback URLs by default
    const ssrfCheck = validateBrowserTargetUrl('http://100.65.159.15:11434/api/tags');
    assert.equal(ssrfCheck.allowed, false);
    assert.equal(ssrfCheck.reason, 'SSRF_BLOCKED');

    const ssrfRes = await fetch(`${baseUrl}/api/companion/browser`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'navigate',
        url: 'http://100.65.159.15:11434/api/tags'
      })
    });
    assert.equal(ssrfRes.status, 403);
    const ssrfJson = await ssrfRes.json();
    assert.equal(ssrfJson.blocked, true);
    assert.equal(ssrfJson.reason, 'SSRF_BLOCKED');

    // Enable chrome-browser-navigator and verify intent routing + execution
    const enabled = setExtensionEnabled('chrome-browser-navigator', true);
    assert.equal(enabled.enabled, true);

    const navIntent = detectAgenticIntent('Navigate in Chrome to https://example.com and inspect the page');
    assert.equal(navIntent.shouldUseAgenticProxy, true);
    assert.ok(navIntent.matchedCategories.includes('browser_navigation'));
    assert.ok(navIntent.tools.some((t) => t.name === 'browser_navigate'));

    const interactOut = await navigateCompanionBrowser({
      action: 'interact',
      url: 'https://example.com/login',
      steps: 'click:#open-modal; type:#email=user@example.com'
    });
    assert.equal(interactOut.ok, true);
    assert.equal(interactOut.actionType, 'browser_interact');
    assert.equal(interactOut.data.stepsExecuted.length, 2);

    const auditRes = await fetch(`${baseUrl}/api/companion/browser`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'audit',
        url: 'https://example.com',
        autoStageBoard: true
      })
    });
    assert.equal(auditRes.status, 200);
    const auditJson = await auditRes.json();
    assert.equal(auditJson.ok, true);
    assert.equal(auditJson.actionType, 'browser_audit');
    assert.equal(auditJson.data.breakpoints.length, 3);
    assert.ok(auditJson.data.stagedTask?.id, 'Should stage Chrome UI audit task onto Today Board when autoStageBoard=true');
  });
});


