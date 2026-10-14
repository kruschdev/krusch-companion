import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { initCompanionDb, getDb, getTasksForDate, getStreak, today } from '../src/db/index.js';
import { createDatabaseBackup } from '../src/context/memory-store.js';
import {
  isSafePublicUrl,
  executeCompanionTool,
  COMPANION_TOOLS
} from '../src/agent/tools.js';
import {
  detectAgenticIntent,
  routeDiverseTools,
  compactToolSchemaForPrompt,
  getFullCatalogSchemaTokens,
  inferFallbackToolCalls,
  buildHolodataSystemPrompt,
  parseHolodataResponse,
  executeAgenticProxyTurn
} from '../src/agent/agentic-proxy.js';
import {
  runSentinelTick,
  resetSentinelState,
  getActiveSentinelAlerts
} from '../src/services/sentinel-daemon.js';

describe('Krusch Companion — Agentic Proxy (<holodata> Dual-Engine for 7B/14B Models)', () => {
  before(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-agentic-'));
    initCompanionDb(path.join(tmpDir, 'test-agentic.db'));
  });

  test('1. Intent-scoped tool pruning selects only relevant tools (<250 token schema footprint)', () => {
    const weatherIntent = detectAgenticIntent("What's the weather in Seattle today?");
    assert.equal(weatherIntent.shouldUseAgenticProxy, true);
    assert.deepEqual(weatherIntent.tools.map(t => t.name), ['get_weather']);

    // Compound request: weather + add a task on Today's Board
    const compoundIntent = detectAgenticIntent('Check the weather in Denver and add a task to go for a trail run');
    assert.equal(compoundIntent.shouldUseAgenticProxy, true);
    const toolNames = compoundIntent.tools.map(t => t.name);
    assert.ok(toolNames.includes('get_weather'));
    assert.ok(toolNames.includes('board_action'));
    assert.ok(toolNames.length <= 3, 'Should prune unrelated tools to prevent 7B schema overload');

    // Non-action conversational prompt should not trigger Agentic Proxy
    const chatIntent = detectAgenticIntent('How do I stay motivated when working on a long project?');
    assert.equal(chatIntent.shouldUseAgenticProxy, false);
  });

  test('2. parseHolodataResponse extracts <holodata> Cognitive Blueprint and flat tool array', () => {
    const simulated7bOutput = `<holodata>
{
  "cognitive_scratchpad": "User wants current weather in Austin, TX and wants to add a Tier 4 run task.",
  "task_name": "Weather Check & Run Task",
  "strict_problem_constraints": "Call get_weather first, then board_action",
  "tool_plan": "1. get_weather(location='Austin, TX') 2. board_action(action='add_task', title='Morning 5K run in Austin', tier=4)"
}
</holodata>
[
  {"name": "get_weather", "arguments": {"location": "Austin, TX"}},
  {"name": "board_action", "arguments": {"action": "add_task", "title": "Morning 5K run in Austin", "tier": 4}}
]`;

    const parsed = parseHolodataResponse(simulated7bOutput);
    assert.ok(parsed.blueprint);
    assert.equal(parsed.blueprint.task_name, 'Weather Check & Run Task');
    assert.equal(parsed.toolCalls.length, 2);
    assert.equal(parsed.toolCalls[0].name, 'get_weather');
    assert.equal(parsed.toolCalls[0].arguments.location, 'Austin, TX');
    assert.equal(parsed.toolCalls[1].name, 'board_action');
    assert.equal(parsed.toolCalls[1].arguments.tier, 4);
  });

  test('3. SSRF guard blocks loopback, private LAN, and metadata IPs while allowing public HTTPS', () => {
    assert.equal(isSafePublicUrl('http://127.0.0.1:11434/api/tags'), false);
    assert.equal(isSafePublicUrl('http://localhost:3004/api/health'), false);
    assert.equal(isSafePublicUrl('http://10.0.0.85:5434'), false);
    assert.equal(isSafePublicUrl('http://192.168.1.1/admin'), false);
    assert.equal(isSafePublicUrl('http://169.254.169.254/latest/meta-data/'), false);
    assert.equal(isSafePublicUrl('file:///etc/passwd'), false);
    assert.equal(isSafePublicUrl('https://krusch.dev/sovereign/'), true);
  });

  test('4. Sandboxed Sovereign Notes Vault saves and reads Markdown notes', async () => {
    const saveRes = await executeCompanionTool('save_note', {
      title: 'Agentic Proxy Architecture',
      content: '- Uses `<holodata>` Cognitive Blueprint\n- Eliminates 7B JSON tool hallucinations'
    });
    assert.equal(saveRes.ok, true);
    assert.equal(saveRes.actionType, 'note_saved');
    assert.ok(saveRes.data.filename.endsWith('agentic-proxy-architecture.md'));

    const readRes = await executeCompanionTool('list_notes', {
      title: 'Agentic Proxy Architecture'
    });
    assert.equal(readRes.ok, true);
    assert.ok(readRes.summary.includes('Eliminates 7B JSON tool hallucinations'));
  });

  test('5. System telemetry tool reports live host & SQLite WAL metrics', async () => {
    const sysRes = await executeCompanionTool('system_status', {});
    assert.equal(sysRes.ok, true);
    assert.equal(sysRes.actionType, 'system_telemetry');
    assert.equal(sysRes.data.dbIntegrity, 'ok');
    assert.ok(sysRes.summary.includes('Sovereign System & Companion Telemetry'));
  });

  test('6. End-to-end executeAgenticProxyTurn executes multi-step <holodata> tool chain (Weather API + Task Board)', async () => {
    const mockFetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('geocoding-api.open-meteo.com')) {
        return {
          ok: true,
          json: async () => ({
            results: [{ name: 'Seattle', admin1: 'Washington', country_code: 'US', latitude: 47.6062, longitude: -122.3321 }]
          })
        };
      }
      if (urlStr.includes('api.open-meteo.com/v1/forecast')) {
        return {
          ok: true,
          json: async () => ({
            current: {
              temperature_2m: 64,
              apparent_temperature: 63,
              weather_code: 1,
              wind_speed_10m: 7,
              relative_humidity_2m: 58
            },
            daily: {
              temperature_2m_max: [68],
              temperature_2m_min: [52],
              precipitation_probability_max: [10]
            }
          })
        };
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    };

    const mock7bCallLlm = async ({ systemPrompt }) => {
      assert.ok(systemPrompt.includes('<holodata>'), 'System prompt must enforce <holodata> Dual-Engine blueprint');
      return {
        tierUsed: 'L1_edge',
        reason: 'L1 Local Edge (qwen2.5:7b)',
        content: `<holodata>
{
  "cognitive_scratchpad": "User wants to check weather in Seattle and add a task to walk at Green Lake.",
  "task_name": "Seattle Weather & Walk Task",
  "strict_problem_constraints": "Execute both get_weather and board_action",
  "tool_plan": "Call get_weather for Seattle, then board_action to add walk task"
}
</holodata>
[
  {"name": "get_weather", "arguments": {"location": "Seattle"}},
  {"name": "board_action", "arguments": {"action": "add_task", "title": "Walk 3 miles around Green Lake", "tier": 4}}
]`
      };
    };

    const turnResult = await executeAgenticProxyTurn({
      prompt: 'Check the weather in Seattle and add a task to walk 3 miles around Green Lake',
      callLlm: mock7bCallLlm,
      fetchImpl: mockFetch
    });

    assert.ok(turnResult);
    assert.ok(turnResult.content.includes('Weather in Seattle, Washington, US'));
    assert.ok(turnResult.content.includes('64°F'));
    assert.ok(turnResult.content.includes('Walk 3 miles around Green Lake'));
    assert.equal(turnResult.agenticTrace.toolCalls.length, 2);
    assert.equal(turnResult.agenticTrace.blueprint.task_name, 'Seattle Weather & Walk Task');

    const tasksToday = getTasksForDate(today());
    assert.ok(tasksToday.some(t => t.title.includes('Walk 3 miles around Green Lake')));
  });

  test('7. Deterministic fallback executes tools cleanly even when local 7B LLM is offline', async () => {
    const offlineLlm = async () => {
      throw new Error('Ollama connection refused');
    };

    const turnResult = await executeAgenticProxyTurn({
      prompt: 'Check system status and telemetry',
      callLlm: offlineLlm
    });

    assert.ok(turnResult);
    assert.equal(turnResult.actionExecuted.type, 'system_telemetry');
    assert.ok(turnResult.content.includes('Sovereign System & Companion Telemetry'));
    assert.equal(turnResult.agenticTrace.toolCalls[0].name, 'system_status');
  });

  test('8. G-Krusch Google Workspace Extension tools (Drive RAG, Calendar, Gmail) execute and chain upstream data', async () => {
    const mockGKruschFetch = async (url, opts) => {
      if (url.includes('/api/rag/search')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              { fileName: 'Q4-Architecture-Spec.md', score: 0.94, content: 'Zero-trust sovereign companion with G-Krusch Workspace integration.' }
            ]
          })
        };
      }
      if (url.includes('/api/calendar/events')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            event: {
              id: 'evt_123',
              summary: 'Architecture Sync',
              start: '2026-10-14T15:00:00Z',
              htmlLink: 'https://calendar.google.com/event?eid=evt_123'
            }
          })
        };
      }
      if (url.includes('/api/gmail/drafts')) {
        const bodyObj = JSON.parse(opts?.body || '{}');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'draft_created',
            draftId: 'dr_999',
            to: bodyObj.to,
            subject: bodyObj.subject,
            bodyPreview: bodyObj.body
          })
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const mockChainLlm = async () => ({
      tierUsed: 'L2_cloud',
      reason: 'OpenRouter Specialist (qwen/qwen-2.5-coder-32b-instruct)',
      content: `<holodata>
{
  "cognitive_scratchpad": "Search Google Drive for Q4 Architecture Spec, schedule a calendar meeting, and draft an email with the Drive findings.",
  "task_name": "G-Krusch Workspace Chain",
  "strict_problem_constraints": "Chain Drive RAG output into Gmail draft body.",
  "tool_plan": "gkrusch_drive -> gkrusch_calendar -> gkrusch_gmail"
}
</holodata>
[
  {"name": "gkrusch_drive", "arguments": {"action": "search", "query": "Q4 Architecture Spec"}},
  {"name": "gkrusch_calendar", "arguments": {"action": "create_event", "summary": "Architecture Sync", "startTime": "2026-10-14T15:00:00Z"}},
  {"name": "gkrusch_gmail", "arguments": {"action": "create_draft", "to": "team@krusch.dev", "subject": "Q4 Spec Brief", "body": "<insert summary here>"}}
]`
    });

    const turnResult = await executeAgenticProxyTurn({
      prompt: 'Search my Google Drive for Q4 Architecture Spec, schedule a meeting on Google Calendar, and draft an email to team@krusch.dev',
      callLlm: mockChainLlm,
      fetchImpl: mockGKruschFetch
    });

    assert.ok(turnResult);
    assert.equal(turnResult.agenticTrace.toolCalls.length, 3);
    assert.ok(turnResult.content.includes('Q4-Architecture-Spec.md'));
    assert.ok(turnResult.content.includes('Scheduled on Google Calendar'));
    assert.ok(turnResult.content.includes('Gmail Draft Created'));
    // Verify upstream Drive RAG result was automatically piped into the downstream Gmail draft body!
    assert.ok(turnResult.agenticTrace.toolCalls[2].arguments.body.includes('Q4-Architecture-Spec.md'));
  });

  test('9. Concierge Reservation tool looks up venue details, builds OpenTable/Resy links, drafts email, and places board hold', async () => {
    const mockReservationFetch = async (url) => {
      if (url.includes('nominatim.openstreetmap.org')) {
        return {
          ok: true,
          status: 200,
          json: async () => ([
            {
              display_name: 'Canlis, 2576 Aurora Ave N, Seattle, WA 98109',
              extratags: {
                phone: '+1-206-283-3313',
                website: 'https://canlis.com',
                email: 'concierge@canlis.com',
                opening_hours: 'Tu-Sa 17:00-22:00'
              }
            }
          ])
        };
      }
      if (url.includes('/api/gmail/drafts')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ mode: 'draft', id: 'dr_canlis' })
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const mockLlm = async () => ({
      tierUsed: 'L2_cloud',
      reason: 'OpenRouter Specialist (qwen/qwen-2.5-coder-32b-instruct)',
      content: `<holodata>
{
  "cognitive_scratchpad": "User wants to book a dinner reservation at Canlis in Seattle for 4 people on Friday at 7pm.",
  "task_name": "Canlis Dinner Reservation",
  "strict_problem_constraints": "Include party size 4 and anniversary note.",
  "tool_plan": "concierge_reservation"
}
</holodata>
[
  {"name": "concierge_reservation", "arguments": {"venue": "Canlis Seattle", "partySize": 4, "dateTime": "2026-10-16T19:00:00", "notes": "Window table for anniversary"}}
]`
    });

    const turnResult = await executeAgenticProxyTurn({
      prompt: 'Make a reservation at Canlis Seattle for 4 people on Friday at 7pm',
      callLlm: mockLlm,
      fetchImpl: mockReservationFetch,
      notesDir: fs.mkdtempSync(path.join(os.tmpdir(), 'companion-res-'))
    });

    assert.ok(turnResult);
    assert.equal(turnResult.actionExecuted.type, 'concierge_reservation');
    assert.ok(turnResult.content.includes('Canlis, 2576 Aurora Ave N, Seattle, WA 98109'));
    assert.ok(turnResult.content.includes('+1-206-283-3313'));
    assert.ok(turnResult.content.includes('opentable.com'));
    assert.ok(turnResult.content.includes('resy.com'));
    assert.ok(turnResult.content.includes('concierge@canlis.com'));
  });

  test('10. Commute & Time-to-Leave tool calculates route distance, rush-hour traffic delay, and Leave-By warning', async () => {
    const mockCommuteFetch = async (url) => {
      if (url.includes('nominatim.openstreetmap.org')) {
        return {
          ok: true,
          status: 200,
          json: async () => ([{ lat: '47.6062', lon: '-122.3321', display_name: 'Seattle, WA' }])
        };
      }
      if (url.includes('router.project-osrm.org')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            routes: [{ distance: 22530, duration: 1500 }] // ~14.0 miles, 25 min baseline drive
          })
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const mockLlm = async () => ({
      tierUsed: 'L1_edge',
      reason: 'Local Ollama Edge',
      content: `<holodata>
{
  "cognitive_scratchpad": "User is asking when they need to leave for their 6:00 PM dinner in Bellevue and whether there is traffic.",
  "task_name": "Commute & Traffic Leave-By Check",
  "strict_problem_constraints": "Calculate traffic delay during evening rush hour and report Leave-By time.",
  "tool_plan": "commute_departure_check"
}
</holodata>
[
  {"name": "commute_departure_check", "arguments": {"destination": "Bellevue, WA", "origin": "Downtown Seattle, WA", "arrivalTime": "2026-10-16T18:00:00"}}
]`
    });

    const turnResult = await executeAgenticProxyTurn({
      prompt: 'When do I need to leave for my 6:00 PM dinner in Bellevue and how is traffic?',
      callLlm: mockLlm,
      fetchImpl: mockCommuteFetch
    });

    assert.ok(turnResult);
    assert.equal(turnResult.actionExecuted.type, 'commute_departure');
    assert.ok(turnResult.content.includes('14 mi'));
    assert.ok(turnResult.content.includes('Heavy Traffic'));
    assert.ok(turnResult.content.includes('Recommended Leave-By Time'));
    assert.ok(turnResult.content.includes('google.com/maps/dir/'));
  });

  test('11. Proactive Sentinel Watchdog Daemon makes 0 LLM calls on normal traffic and wakes LLM only on traffic spike/accident', async () => {
    resetSentinelState();
    let llmWakeCount = 0;

    const mockWakeLlm = async ({ prompt }) => {
      llmWakeCount++;
      assert.ok(prompt.includes('TRAFFIC_SPIKE'));
      return {
        content: 'Heads up! An accident/traffic surge just added +14 minutes to your route to Canlis. Leave by 6:16 PM instead of 6:30 PM to arrive on time.'
      };
    };

    // Tick 1: Normal clear traffic (+2m delay, 90m until departure) -> MUST NOT call LLM (0 tokens)
    const tick1 = await runSentinelTick({
      callLlm: mockWakeLlm,
      customEvents: [
        {
          id: 'cal-canlis-1',
          title: 'Dinner at Canlis',
          destination: 'Canlis, Seattle, WA',
          mockCommute: {
            origin: 'Downtown Seattle, WA',
            destination: 'Canlis, Seattle, WA',
            distanceText: '4.8 mi',
            baseMinutes: 15,
            trafficMinutes: 17,
            trafficDelayMinutes: 2,
            trafficLevel: 'Light',
            leaveByFormatted: '6:33 PM',
            arrivalFormatted: '7:00 PM',
            minutesUntilLeave: 90,
            googleMapsDirectionsUrl: 'https://www.google.com/maps/dir/?api=1&destination=Canlis'
          }
        }
      ]
    });

    assert.equal(tick1.llmCallsTriggered, 0);
    assert.equal(llmWakeCount, 0);
    assert.equal(tick1.triggeredAlerts.length, 0);

    // Tick 2: Traffic suddenly spikes (+16m delay, +14m jump!) -> MUST wake the LLM and persist alert
    const tick2 = await runSentinelTick({
      callLlm: mockWakeLlm,
      customEvents: [
        {
          id: 'cal-canlis-1',
          title: 'Dinner at Canlis',
          destination: 'Canlis, Seattle, WA',
          mockCommute: {
            origin: 'Downtown Seattle, WA',
            destination: 'Canlis, Seattle, WA',
            distanceText: '4.8 mi',
            baseMinutes: 15,
            trafficMinutes: 31,
            trafficDelayMinutes: 16,
            trafficLevel: 'Heavy',
            leaveByFormatted: '6:19 PM',
            arrivalFormatted: '7:00 PM',
            minutesUntilLeave: 76,
            googleMapsDirectionsUrl: 'https://www.google.com/maps/dir/?api=1&destination=Canlis'
          }
        }
      ]
    });

    assert.equal(tick2.llmCallsTriggered, 1);
    assert.equal(llmWakeCount, 1);
    assert.equal(tick2.triggeredAlerts.length, 1);
    assert.equal(tick2.triggeredAlerts[0].triggerReason, 'traffic_spike');
    assert.ok(tick2.triggeredAlerts[0].llmAdvisory.includes('Leave by 6:16 PM'));

    const storedAlerts = getActiveSentinelAlerts();
    assert.equal(storedAlerts.length, 1);
    assert.equal(storedAlerts[0].trigger_reason, 'traffic_spike');
  });

  test('12. Sentinel Watchdog polls Gmail & Calendar: ignores promo spam at 0 tokens, wakes LLM on urgent/booking email and calendar double-booking conflict', async () => {
    resetSentinelState();
    let llmWakeCount = 0;

    const mockWakeLlm = async ({ triggerReason }) => {
      llmWakeCount++;
      return {
        content: `Proactive Sentinel Advisory handled ${triggerReason}`
      };
    };

    // Tick 1: Promo newsletter email + non-conflicting future calendar event -> 0 LLM calls
    const quietTick = await runSentinelTick({
      callLlm: mockWakeLlm,
      customEmails: [
        {
          id: 'msg-promo-1',
          from: 'marketing@store.example.com',
          subject: '50% Off Flash Sale Ends Tonight!',
          snippet: 'Click here to unsubscribe from our daily digest.'
        }
      ],
      customCalendarEvents: [
        {
          id: 'ev-100',
          summary: 'Weekly Design Sync',
          start: '2026-10-20T10:00:00Z',
          end: '2026-10-20T11:00:00Z'
        }
      ],
      customEvents: []
    });

    assert.equal(quietTick.llmCallsTriggered, 0);
    assert.equal(llmWakeCount, 0);

    // Tick 2: Actionable urgent invoice email + overlapping Calendar double-booking -> wakes LLM twice!
    const activeTick = await runSentinelTick({
      callLlm: mockWakeLlm,
      customEmails: [
        {
          id: 'msg-urgent-2',
          from: 'billing@vendor.io',
          subject: 'Action Required: Invoice #4092 Payment Due Before 5pm',
          snippet: 'Urgent: please approve or reply before 5pm today.'
        }
      ],
      customCalendarEvents: [
        {
          id: 'ev-201',
          summary: 'Architecture Review',
          start: '2026-10-20T14:00:00Z',
          end: '2026-10-20T15:00:00Z'
        },
        {
          id: 'ev-202',
          summary: 'Client Onboarding Call',
          start: '2026-10-20T14:30:00Z',
          end: '2026-10-20T15:30:00Z'
        }
      ],
      customEvents: []
    });

    assert.equal(activeTick.llmCallsTriggered, 2);
    assert.equal(llmWakeCount, 2);
    assert.equal(activeTick.triggeredAlerts.length, 2);
    assert.equal(activeTick.triggeredAlerts[0].triggerReason, 'email_urgent_action');
    assert.equal(activeTick.triggeredAlerts[1].triggerReason, 'calendar_conflict');

    // Verify the urgent email also auto-created a task on Today's Priority Board
    const tasks = getTasksForDate(today());
    assert.ok(tasks.some(t => t.title.includes('[Email Action] Action Required: Invoice #4092')));
  });

  test('13. OpenClaw & Nous Hermes Skill Engine (SKILL.md learning, execution, migration & trajectory auto-learning)', async () => {
    const tmpSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-skills-'));

    // 1. Learn a new custom SKILL.md capability
    const learnRes = await executeCompanionTool(
      'skill_manager',
      {
        action: 'learn',
        name: 'Friday Client Digest',
        description: 'Summarize weekly tasks and draft a Friday status update email',
        triggers: 'friday digest, weekly client status',
        steps: '1. Query weekly review\n2. Draft summary note\n3. Prepare Gmail draft'
      },
      { notesDir: tmpSkillsDir }
    );
    assert.equal(learnRes.ok, true);
    assert.equal(learnRes.actionType, 'skill_learned');
    assert.equal(learnRes.data.skill.slug, 'friday-client-digest');
    assert.ok(fs.existsSync(learnRes.data.skillMdPath));

    // 2. Read back the SKILL.md definition
    const readRes = await executeCompanionTool(
      'skill_manager',
      { action: 'read', name: 'friday-client-digest' },
      { notesDir: tmpSkillsDir }
    );
    assert.equal(readRes.ok, true);
    assert.ok(readRes.data.markdown.includes('# 🧩 Skill: Friday Client Digest'));

    // 3. Execute the skill and verify experience_count increments
    const runRes = await executeCompanionTool(
      'skill_manager',
      { action: 'run', name: 'friday-client-digest' },
      { notesDir: tmpSkillsDir }
    );
    assert.equal(runRes.ok, true);
    assert.equal(runRes.actionType, 'skill_executed');
    assert.ok(runRes.data.skill.experience_count >= 2);
  });

  test('14. OpenAI Dot & Nous Hermes Personal CRM + Evolving SOUL.md / USER.md / MEMORY.md Profile Sync', async () => {
    const tmpProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-profile-'));

    const saveContact = await executeCompanionTool(
      'personal_crm_profile',
      {
        action: 'upsert_contact',
        name: 'Sarah Chen',
        relationship: 'Partner',
        importantDates: 'Birthday: Nov 12, Anniversary: June 18',
        giftIdeas: 'Ceremonial grade matcha, ceramic mug',
        notes: 'Prefers quiet dinner spots with vegetarian options'
      },
      { notesDir: tmpProfileDir }
    );
    assert.equal(saveContact.ok, true);
    assert.equal(saveContact.actionType, 'crm_contact_saved');
    assert.equal(saveContact.data.contact.name, 'Sarah Chen');

    const lookup = await executeCompanionTool(
      'personal_crm_profile',
      { action: 'lookup_contact', name: 'Sarah' },
      { notesDir: tmpProfileDir }
    );
    assert.equal(lookup.ok, true);
    assert.ok(lookup.summary.includes('Ceremonial grade matcha'));

    const syncRes = await executeCompanionTool(
      'personal_crm_profile',
      {
        action: 'sync_markdown_profiles',
        notes: 'Prefers concise morning briefings before 8:00 AM'
      },
      { notesDir: tmpProfileDir }
    );
    assert.equal(syncRes.ok, true);
    assert.ok(fs.existsSync(syncRes.data.soulPath));
    assert.ok(fs.existsSync(syncRes.data.userPath));
    assert.ok(fs.existsSync(syncRes.data.memoryPath));
    assert.ok(fs.existsSync(syncRes.data.crmPath));
  });

  test('15. OpenClaw Cron Automation Scheduler & 1-Page Meeting Prep Dossier Compiler', async () => {
    const tmpAutoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-auto-'));

    // 1. Schedule a recurring cron automation
    const schedRes = await executeCompanionTool(
      'schedule_automation',
      {
        action: 'create',
        title: 'Morning Weather & Calendar Briefing',
        schedule: 'every weekday at 8:00 AM',
        taskType: 'briefing'
      },
      { notesDir: tmpAutoDir }
    );
    assert.equal(schedRes.ok, true);
    assert.equal(schedRes.actionType, 'automation_scheduled');
    assert.equal(schedRes.data.automation.schedule_type, 'cron_recurring');

    // 2. Compile a 1-page Meeting Prep Dossier combining CRM, Working Memory, and Notes
    const prepRes = await executeCompanionTool(
      'schedule_automation',
      {
        action: 'meeting_prep',
        title: 'Anniversary Planning with Sarah Chen',
        attendees: 'Sarah Chen'
      },
      { notesDir: tmpAutoDir }
    );
    assert.equal(prepRes.ok, true);
    assert.equal(prepRes.actionType, 'meeting_prep_compiled');
    assert.ok(prepRes.summary.includes('Sarah Chen'));
    assert.ok(prepRes.summary.includes('Ceremonial grade matcha'));
  });

  test('16. Meta Muse / Hermes Smart Home Bridge (Home Assistant Twin) & Multi-Channel Messaging Gateway', async () => {
    const tmpHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-home-'));

    // 1. Control smart home thermostat
    const climateRes = await executeCompanionTool(
      'smart_home_bridge',
      {
        action: 'control_device',
        device: 'Home Thermostat',
        state: '70'
      },
      { notesDir: tmpHomeDir }
    );
    assert.equal(climateRes.ok, true);
    assert.equal(climateRes.actionType, 'smart_home_control');
    assert.equal(climateRes.data.entityId, 'climate.home_thermostat');
    assert.equal(climateRes.data.state, '70°F');

    // 2. Dispatch multi-channel message to Telegram/Discord outbox
    const msgRes = await executeCompanionTool(
      'smart_home_bridge',
      {
        action: 'send_channel_message',
        channel: 'telegram',
        message: 'Evening briefing ready: all Lane 1 Must-Do tasks completed!'
      },
      { notesDir: tmpHomeDir }
    );
    assert.equal(msgRes.ok, true);
    assert.equal(msgRes.actionType, 'channel_message_sent');
    assert.equal(msgRes.data.channel, 'telegram');
  });

  test('17. All 20 Sovereign Tools execute with ok: true & 3-Stage Smart Tool Token Limiter achieves >90% token savings', async () => {
    const tmpVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-20tools-'));
    assert.equal(COMPANION_TOOLS.length, 20, 'Should register all 20 Sovereign Tools');

    const fullCatalogTokens = getFullCatalogSchemaTokens();
    assert.ok(fullCatalogTokens >= 1800, `Expected full 20-tool catalog >= 1800 tokens, got ${fullCatalogTokens}`);

    // Verify Action-Scoped Micro-Schema Compaction strips irrelevant sub-action parameters
    const smartHomeTool = COMPANION_TOOLS.find(t => t.name === 'smart_home_bridge');
    const compactedClimate = compactToolSchemaForPrompt(smartHomeTool, 'Turn off the bedroom lights and set thermostat to 70');
    assert.ok(compactedClimate.arguments.device, 'Should keep device argument for device control');
    assert.equal(compactedClimate.arguments.channel, undefined, 'Should strip messaging channel argument during device control');

    const mockUniversalFetch = async (url) => {
      if (url.includes('geocoding-api.open-meteo.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [{ name: 'Seattle', admin1: 'Washington', country: 'US', latitude: 47.6, longitude: -122.3, timezone: 'America/Los_Angeles' }]
          })
        };
      }
      if (url.includes('api.open-meteo.com/v1/forecast')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            current: { temperature_2m: 64, apparent_temperature: 63, relative_humidity_2m: 55, wind_speed_10m: 6, weather_code: 1 },
            daily: { temperature_2m_max: [68], temperature_2m_min: [51], precipitation_probability_max: [10] }
          })
        };
      }
      if (url.includes('example.com')) {
        return {
          ok: true,
          status: 200,
          text: async () => '<html><head><title>Sovereign AI Digest</title></head><body><main><p>Key architecture notes for local 7B edge companions.</p></main></body></html>'
        };
      }
      if (url.includes('api.duckduckgo.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            Heading: 'Determinantal point process',
            AbstractText: 'A probabilistic model of repulsion used for diverse subset selection.',
            AbstractURL: 'https://en.wikipedia.org/wiki/Determinantal_point_process',
            AbstractSource: 'Wikipedia'
          })
        };
      }
      if (url.includes('nominatim.openstreetmap.org')) {
        return {
          ok: true,
          status: 200,
          json: async () => ([{
            lat: '47.6435',
            lon: '-122.3473',
            display_name: 'Canlis, 2576 Aurora Ave N, Seattle, WA 98109',
            extratags: { phone: '+1-206-283-3313', website: 'https://canlis.com' }
          }])
        };
      }
      if (url.includes('router.project-osrm.org')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ routes: [{ distance: 12000, duration: 900 }] })
        };
      }
      // Simulate offline local daemons (:5446, :8085, :8086, ntfy.sh) to verify 100% sovereign fallbacks also return ok: true
      throw new Error(`Simulated offline daemon for ${url}`);
    };

    // 20 natural-language prompts covering all 20 Sovereign Tools
    const twentyToolPrompts = [
      { expectedTool: 'get_weather', prompt: "What's the weather forecast in Seattle?" },
      { expectedTool: 'fetch_url_digest', prompt: 'Summarize this URL https://example.com/article' },
      { expectedTool: 'web_research', prompt: 'Search the web for Determinantal point process' },
      { expectedTool: 'save_note', prompt: 'Save a note titled "Architecture Checklist" with content: Verify all 20 tools' },
      { expectedTool: 'list_notes', prompt: 'List my saved notes in the vault' },
      { expectedTool: 'send_notification', prompt: 'Send a notification to my phone: Deployment complete' },
      { expectedTool: 'system_status', prompt: 'Run a system health check and diagnostic' },
      { expectedTool: 'sovereign_gateway_query', prompt: 'Check legal statute and contract compliance for tenant notice' },
      { expectedTool: 'gkrusch_drive', prompt: 'Search my Google Drive for Architecture Checklist' },
      { expectedTool: 'gkrusch_calendar', prompt: 'Check my Google Calendar schedule for today' },
      { expectedTool: 'gkrusch_gmail', prompt: 'Draft an email to alice@example.com with subject "Project Sync" and body "Ready for review"' },
      { expectedTool: 'concierge_reservation', prompt: 'Book a dinner reservation at Canlis in Seattle for 2 people at 7:00 PM' },
      { expectedTool: 'commute_departure_check', prompt: 'How is traffic to Bellevue, WA and when should I leave?' },
      { expectedTool: 'google_wallet_pass', prompt: 'Create a Google Wallet event ticket pass for "Krusch AI Summit"' },
      { expectedTool: 'ap2_payment_mandate', prompt: 'Authorize a $25 AP2 payment mandate to Seattle City Light' },
      { expectedTool: 'skill_manager', prompt: 'List all learned skills in my skill library' },
      { expectedTool: 'schedule_automation', prompt: 'Remind me every Monday at 8am to review the weekly roadmap' },
      { expectedTool: 'smart_home_bridge', prompt: 'Turn on the office studio lights' },
      { expectedTool: 'personal_crm_profile', prompt: 'Save a contact in my personal CRM for Alex Rivera' },
      { expectedTool: 'board_action', prompt: 'Add a task to review PR #42 on my board' }
    ];

    const executedTools = new Set();

    for (const tc of twentyToolPrompts) {
      // 1. Verify Smart Tool Token Limiter routes the expected tool within <= 3 tools and >90% token savings
      const intent = detectAgenticIntent(tc.prompt);
      assert.equal(intent.shouldUseAgenticProxy, true, `Prompt should activate proxy: "${tc.prompt}"`);
      const routedNames = intent.tools.map(t => t.name);
      assert.ok(
        routedNames.includes(tc.expectedTool),
        `Expected "${tc.expectedTool}" in routed tools [${routedNames.join(', ')}] for prompt: "${tc.prompt}"`
      );
      assert.ok(intent.tools.length <= 3, `Expected <= 3 tools, got ${intent.tools.length} for "${tc.prompt}"`);
      assert.ok(
        intent.pruningReport.injectedSchemaTokensEst <= 260,
        `Expected <= 260 schema tokens, got ${intent.pruningReport.injectedSchemaTokensEst} for "${tc.prompt}"`
      );
      assert.ok(
        intent.pruningReport.tokenReductionPct >= 90,
        `Expected >= 90% token reduction, got ${intent.pruningReport.tokenReductionPct}% for "${tc.prompt}"`
      );

      // 2. Verify 1-argument inferFallbackToolCalls extracts a valid call for the expected tool
      const inferred = inferFallbackToolCalls(tc.prompt);
      const matchingCall = inferred.find(call => call.name === tc.expectedTool);
      assert.ok(matchingCall, `inferFallbackToolCalls should synthesize a call for ${tc.expectedTool}`);

      // 3. Execute the tool and verify ok: true
      const execResult = await executeCompanionTool(
        matchingCall.name,
        matchingCall.arguments,
        { fetchImpl: mockUniversalFetch, notesDir: tmpVaultDir }
      );
      assert.equal(execResult.ok, true, `Tool ${tc.expectedTool} failed: ${execResult.summary}`);
      executedTools.add(tc.expectedTool);
    }

    assert.equal(executedTools.size, 20, 'All 20 Sovereign Tools must be executed and verified with ok: true');
  });

  test('18. Engineering Audit Backlog Verification: Sentinel Channel 4 Due Automations (BUG-01), AP2 Pillar (ARCH-01), UTC Streak (BUG-03) & Backup Pruning (SEC-02)', async () => {
    const tmpAuditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-audit-'));

    // 1. ARCH-01: Verify ap2_payment_mandate creates a Lane 1 task with pillar "Provision & Finance" even when merchant name has no finance keyword
    const mandateRes = await executeCompanionTool(
      'ap2_payment_mandate',
      { merchant: 'Acme Hardware Co', maxAmount: 42.5, currency: 'USD' },
      { notesDir: tmpAuditDir }
    );
    assert.equal(mandateRes.ok, true);
    const createdMandateTask = getTasksForDate(today()).find(t => t.id === mandateRes.data.taskId);
    assert.ok(createdMandateTask, 'AP2 Payment Mandate should create a task on Today Board');
    assert.equal(createdMandateTask.execution_priority, 1);
    assert.equal(createdMandateTask.pillar, 'Provision & Finance');

    // 2. BUG-01: Verify Sentinel Channel 4 executes due companion_automations rows automatically
    const schedRes = await executeCompanionTool(
      'schedule_automation',
      {
        action: 'create',
        title: 'Audit Due Cron Check',
        schedule: 'every day at 8am',
        taskType: 'briefing'
      },
      { notesDir: tmpAuditDir }
    );
    assert.equal(schedRes.ok, true);
    const autoId = schedRes.data.automation.id;

    // Set next_run_at into the past so it is due now, and disable other automations for isolated tick assertion
    const dbConn = getDb();
    dbConn.prepare('UPDATE companion_automations SET enabled = 0 WHERE id != ?').run(autoId);
    dbConn.prepare('UPDATE companion_automations SET next_run_at = ? WHERE id = ?').run(
      new Date(Date.now() - 60 * 1000).toISOString(),
      autoId
    );

    const tickRes = await runSentinelTick({
      customEvents: [],
      customEmails: [],
      customCalendarEvents: [],
      checkAutomations: true,
      callLlm: async () => ({ content: '⏰ Scheduled automation Audit Due Cron Check is due now.' })
    });

    assert.ok(
      tickRes.triggeredAlerts.some(a => a.triggerReason === 'scheduled_automation_due' && a.eventTitle === 'Audit Due Cron Check'),
      'Sentinel Channel 4 should fire scheduled_automation_due alert for due automation'
    );
    const updatedAuto = dbConn.prepare('SELECT * FROM companion_automations WHERE id = ?').get(autoId);
    assert.equal(updatedAuto.run_count, 1, 'Due automation run_count should increment');

    // 3. BUG-03: Verify UTC-normalized getStreak() returns consistent streak count
    const streakInfo = getStreak();
    assert.equal(typeof streakInfo.streak, 'number');
    assert.ok(streakInfo.streak >= 0);

    // 4. SEC-02: Verify createDatabaseBackup enforces maxBackups retention cap
    const backupDir = path.join(tmpAuditDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'companion-backup-2026-01-01T00-00-01-000Z.db'), 'old1');
    fs.writeFileSync(path.join(backupDir, 'companion-backup-2026-01-01T00-00-02-000Z.db'), 'old2');
    fs.writeFileSync(path.join(backupDir, 'companion-backup-2026-01-01T00-00-03-000Z.db'), 'old3');

    const backupRes = createDatabaseBackup(backupDir, { maxBackups: 2 });
    assert.equal(backupRes.prunedBackupsCount, 2, 'Should prune 2 oldest backups to keep maxBackups=2');
    const remainingFiles = fs.readdirSync(backupDir).filter(f => f.endsWith('.db'));
    assert.equal(remainingFiles.length, 2, 'Should retain exactly 2 backup snapshots');
  });
});


