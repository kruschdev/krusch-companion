import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { initCompanionDb, getTasksForDate, today } from '../src/db/index.js';
import {
  isSafePublicUrl,
  executeCompanionTool,
  COMPANION_TOOLS
} from '../src/agent/tools.js';
import {
  detectAgenticIntent,
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
      fetchImpl: mockReservationFetch
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
});


