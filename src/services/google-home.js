/**
 * Sovereign Google Home / Google Cast & Home Assistant Media Player Bridge
 *
 * Connects Google Home / Nest speakers to Krusch Companion via:
 * 1. Outbound LAN Audio Cast / Home Assistant `media_player.play_media` & `tts.speak`
 *    streaming from `GET /api/companion/tts.wav?text=...`
 * 2. Inbound 2-way voice/routine webhook (`POST /api/companion/google-home`) compatible
 *    with Home Assistant Assist (`rest_command` / `conversation`), Google Assistant
 *    Routines, Dialogflow fulfillment, and Android/iOS voice shortcuts.
 * 3. Sovereign Local Device Twin in `companion_devices` (`media_player.google_home`).
 */
import { getDb } from '../db/index.js';
import { cleanTextForSpeech, synthesizeSpeech } from './tts.js';
import { handleInboundChannelBotTurn } from './channel-bot.js';
import { ensureExtendedCompanionTables } from '../agent/tools.js';

export const DEFAULT_GOOGLE_HOME_ENTITY = 'media_player.google_home';

/**
 * Resolve the LAN-reachable base URL for Krusch Companion so Google Home / Home Assistant
 * on the local network can fetch `/api/companion/tts.wav`.
 */
export function resolveCompanionLanBaseUrl(explicitBaseUrl = null) {
  const candidate = String(
    explicitBaseUrl ||
      process.env.COMPANION_LAN_URL ||
      process.env.PUBLIC_COMPANION_URL ||
      'http://127.0.0.1:3004'
  )
    .trim()
    .replace(/\/+$/, '');
  return candidate || 'http://127.0.0.1:3004';
}

/**
 * Build a GET-able WAV stream URL for Google Cast / Home Assistant `media_player.play_media`.
 */
export function buildCompanionTtsStreamUrl({
  text,
  voice = 'af_heart',
  speed = 1.0,
  baseUrl = null
} = {}) {
  const clean = cleanTextForSpeech(text || '');
  const resolvedBase = resolveCompanionLanBaseUrl(baseUrl);
  const params = new URLSearchParams({
    text: clean || 'Krusch Companion ready.',
    voice: String(voice || 'af_heart'),
    speed: String(Number.isFinite(Number(speed)) && Number(speed) > 0 ? Number(speed) : 1.0)
  });
  return `${resolvedBase}/api/companion/tts.wav?${params.toString()}`;
}

/**
 * Broadcast / cast a spoken message to a Google Home speaker via Home Assistant
 * (`media_player.play_media` or `tts.speak`), optional LAN Cast webhook, and update
 * the sovereign local device twin in SQLite (`companion_devices`).
 */
export async function broadcastToGoogleHome({
  text,
  entityId = null,
  room = null,
  voice = 'af_heart',
  speed = 1.0,
  baseUrl = null,
  fetchImpl = fetch
} = {}) {
  ensureExtendedCompanionTables();
  const cleanSpokenText = cleanTextForSpeech(text || '');
  if (!cleanSpokenText) {
    return {
      ok: false,
      error: 'Spoken text is required to broadcast to Google Home'
    };
  }

  const targetEntity = String(
    entityId ||
      process.env.GOOGLE_HOME_ENTITY_ID ||
      (room
        ? `media_player.${String(room).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}_speaker`
        : DEFAULT_GOOGLE_HOME_ENTITY)
  ).trim();

  const friendlyName = room
    ? `Google Home (${room})`
    : targetEntity === DEFAULT_GOOGLE_HOME_ENTITY
      ? 'Google Home Speaker'
      : `Google Home (${targetEntity})`;

  const audioStreamUrl = buildCompanionTtsStreamUrl({
    text: cleanSpokenText,
    voice,
    speed,
    baseUrl
  });

  // Synthesize locally so we also have accurate duration & fallback verification
  const ttsResult = await synthesizeSpeech({
    text: cleanSpokenText,
    voice,
    speed,
    fetchImpl
  });

  let haDispatched = false;
  let castWebhookDispatched = false;
  let transportUsed = 'sovereign_local_twin_and_wav_stream';

  // 1. Dispatch via Home Assistant `media_player.play_media` (plays Companion's WAV stream on the Google Home Cast device)
  if (
    process.env.HOME_ASSISTANT_URL &&
    process.env.HOME_ASSISTANT_TOKEN &&
    typeof fetchImpl === 'function'
  ) {
    try {
      const haBase = process.env.HOME_ASSISTANT_URL.replace(/\/+$/, '');
      const res = await fetchImpl(`${haBase}/api/services/media_player/play_media`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.HOME_ASSISTANT_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          entity_id: targetEntity,
          media_content_id: audioStreamUrl,
          media_content_type: 'music',
          announce: true,
          extra: {
            title: 'Krusch Companion',
            metadata: {
              title: 'Krusch Companion',
              subtitle: cleanSpokenText.slice(0, 80)
            }
          }
        }),
        signal: AbortSignal.timeout(5000)
      });
      if (res && res.ok) {
        haDispatched = true;
        transportUsed = 'home_assistant_media_player_cast';
      }
    } catch {
      haDispatched = false;
    }
  }

  // 2. Optional direct LAN Google Cast daemon webhook (`GOOGLE_HOME_CAST_WEBHOOK_URL`)
  if (
    !haDispatched &&
    process.env.GOOGLE_HOME_CAST_WEBHOOK_URL &&
    typeof fetchImpl === 'function'
  ) {
    try {
      const res = await fetchImpl(process.env.GOOGLE_HOME_CAST_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityId: targetEntity,
          text: cleanSpokenText,
          audioStreamUrl,
          mimeType: 'audio/wav'
        }),
        signal: AbortSignal.timeout(5000)
      });
      if (res && res.ok) {
        castWebhookDispatched = true;
        transportUsed = 'google_cast_lan_webhook';
      }
    } catch {
      castWebhookDispatched = false;
    }
  }

  // 3. Persist state in sovereign `companion_devices` table
  const db = getDb();
  const attributes = {
    lastSpokenText: cleanSpokenText,
    audioStreamUrl,
    voice,
    speed,
    provider: ttsResult.provider,
    estimatedDurationMs: ttsResult.estimatedDurationMs,
    haDispatched,
    castWebhookDispatched,
    transportUsed,
    spokenAt: new Date().toISOString()
  };

  db.prepare(`
    INSERT INTO companion_devices (entity_id, friendly_name, domain, state, attributes_json, updated_at)
    VALUES (?, ?, 'media_player', 'speaking', ?, datetime('now'))
    ON CONFLICT(entity_id) DO UPDATE SET
      friendly_name = excluded.friendly_name,
      state = 'speaking',
      attributes_json = excluded.attributes_json,
      updated_at = datetime('now')
  `).run(targetEntity, friendlyName, JSON.stringify(attributes));

  return {
    ok: true,
    entityId: targetEntity,
    friendlyName,
    cleanSpokenText,
    audioStreamUrl,
    mimeType: 'audio/wav',
    estimatedDurationMs: ttsResult.estimatedDurationMs,
    provider: ttsResult.provider,
    haDispatched,
    castWebhookDispatched,
    transportUsed
  };
}

/**
 * Handle a 2-way voice/routine turn from Google Home, Home Assistant Assist,
 * Dialogflow, or Google Assistant Routine.
 */
export async function handleGoogleHomeTurn({
  payload = {},
  baseUrl = null,
  dispatchChat,
  executeTool,
  fetchImpl = fetch
} = {}) {
  const body = payload && typeof payload === 'object' ? payload : {};

  // Extract voice prompt from Google Assistant / Dialogflow / Home Assistant / generic JSON
  const rawPrompt = String(
    body.prompt ??
      body.text ??
      body.command ??
      body.query ??
      body.queryResult?.queryText ??
      body.inputs?.[0]?.rawInputs?.[0]?.query ??
      (typeof body.message === 'string' ? body.message : body.message?.text) ??
      ''
  ).trim();

  if (!rawPrompt) {
    return {
      ok: false,
      error: 'Voice prompt or text is required for Google Home turn'
    };
  }

  const room = body.room || body.area || null;
  const entityId = body.entityId || body.entity_id || null;
  const sender = body.sender || body.speaker || (room ? `google_home_${room}` : 'google_home_voice');
  const chatId = body.chatId || body.sessionId || body.session || (entityId || 'google_home_main');
  const castReply = body.castReply !== false && body.cast_reply !== false;
  const voice = body.voice || 'af_heart';
  const speed = body.speed || 1.0;

  const botOut = await handleInboundChannelBotTurn({
    platform: 'google_home',
    payload: {
      ...body,
      platform: 'google_home',
      chatId,
      sender,
      prompt: rawPrompt,
      voiceMode: true
    },
    ...(dispatchChat ? { dispatchChat } : {}),
    ...(executeTool ? { executeTool } : {}),
    fetchImpl
  });

  const cleanSpokenReply = cleanTextForSpeech(botOut.reply || '');
  const audioStreamUrl = buildCompanionTtsStreamUrl({
    text: cleanSpokenReply,
    voice,
    speed,
    baseUrl
  });

  let castResult = null;
  if (castReply && cleanSpokenReply) {
    castResult = await broadcastToGoogleHome({
      text: cleanSpokenReply,
      entityId,
      room,
      voice,
      speed,
      baseUrl,
      fetchImpl
    });
  }

  return {
    ok: true,
    platform: 'google_home',
    chatId,
    sender,
    inboundText: rawPrompt,
    reply: botOut.reply,
    cleanSpokenReply,
    // Standard fields for Google Assistant / Dialogflow / Home Assistant Assist webhooks
    speech: cleanSpokenReply,
    fulfillmentText: cleanSpokenReply,
    displayText: botOut.reply,
    audioStreamUrl,
    castResult,
    tierUsed: botOut.tierUsed,
    actionExecuted: botOut.actionExecuted,
    pendingConfirmations: botOut.pendingConfirmations || []
  };
}

/**
 * Return current Google Home device twin state and ready-to-paste Home Assistant &
 * Google Home Routine configuration snippets.
 */
export function getGoogleHomeSetupGuide({ baseUrl = null } = {}) {
  ensureExtendedCompanionTables();
  const resolvedBase = resolveCompanionLanBaseUrl(baseUrl);
  const db = getDb();
  const speakers = db
    .prepare("SELECT * FROM companion_devices WHERE domain = 'media_player' OR entity_id LIKE 'media_player.%' ORDER BY updated_at DESC")
    .all()
    .map(row => {
      let attributes = {};
      try {
        attributes = JSON.parse(row.attributes_json || '{}');
      } catch {
        attributes = {};
      }
      return {
        ...row,
        attributes
      };
    });

  const homeAssistantYaml = [
    '# 1. Add to Home Assistant configuration.yaml:',
    'rest_command:',
    '  krusch_companion_voice:',
    `    url: "${resolvedBase}/api/companion/google-home"`,
    '    method: POST',
    '    content_type: "application/json"',
    '    payload: \'{"prompt": "{{ prompt }}", "entityId": "{{ entity_id | default(\\"media_player.google_home\\") }}", "castReply": true}\'',
    '',
    '# 2. Expose a Script to Google Home ("Hey Google, activate Ask Krusch"):',
    'script:',
    '  ask_krusch_morning_briefing:',
    '    alias: "Ask Krusch Morning Briefing"',
    '    sequence:',
    '      - service: rest_command.krusch_companion_voice',
    '        data:',
    '          prompt: "/today"',
    '          entity_id: "media_player.google_home"'
  ].join('\n');

  return {
    ok: true,
    baseUrl: resolvedBase,
    defaultEntityId: process.env.GOOGLE_HOME_ENTITY_ID || DEFAULT_GOOGLE_HOME_ENTITY,
    homeAssistantConfigured: Boolean(process.env.HOME_ASSISTANT_URL && process.env.HOME_ASSISTANT_TOKEN),
    endpoints: {
      voiceTurnWebhook: `${resolvedBase}/api/companion/google-home`,
      announceEndpoint: `${resolvedBase}/api/companion/google-home/announce`,
      ttsWavStream: `${resolvedBase}/api/companion/tts.wav?text=Hello+from+Krusch+Companion`
    },
    speakers,
    homeAssistantYaml
  };
}
