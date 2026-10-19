import crypto from 'crypto';
import {
  getDb,
  createTask,
  getTasksForDate,
  toggleTask,
  getStreak,
  today
} from '../db/index.js';
import { compileStateBriefing } from '../context/memory-store.js';
import { dispatchCompanionChat } from '../router/cascade-client.js';
import { executeCompanionTool, isSafePublicUrl } from '../agent/tools.js';

const LANE_HEADERS = {
  1: '🚨 **Lane 1: Must Happen Today — Deadlines & Provision**',
  2: '⚡ **Lane 2: High-Impact Focus — Move the Needle**',
  3: '🌱 **Lane 3: Daily Habits & Anchors**',
  4: '📥 **Lane 4: Backlog — When Time Permits**'
};

/**
 * Invariant INV-EXT-05: Ensure SQLite persistence tables exist for 2-way interactive
 * Telegram / Discord / Mobile Shortcut bot messages and callback confirmation gates.
 */
export function ensureChannelBotTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS companion_bot_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender_name TEXT DEFAULT 'user',
      direction TEXT NOT NULL,
      message_text TEXT NOT NULL,
      tier_used TEXT DEFAULT 'L0_bot',
      pending_confirmation_json TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS companion_bot_callbacks (
      callback_id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_args_json TEXT NOT NULL,
      executed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Persist an inbound or outbound message in companion_bot_messages.
 */
function recordBotMessage({
  platform,
  chatId,
  sender = 'user',
  direction,
  text,
  tierUsed = 'L0_bot',
  pendingConfirmations = null
}) {
  ensureChannelBotTables();
  const db = getDb();
  const pendingJson =
    Array.isArray(pendingConfirmations) && pendingConfirmations.length > 0
      ? JSON.stringify(pendingConfirmations)
      : null;

  const stmt = db.prepare(`
    INSERT INTO companion_bot_messages (
      platform,
      chat_id,
      sender_name,
      direction,
      message_text,
      tier_used,
      pending_confirmation_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    String(platform || 'webhook'),
    String(chatId || 'default'),
    String(sender || 'user'),
    String(direction || 'inbound'),
    String(text || ''),
    String(tierUsed || 'L0_bot'),
    pendingJson
  );
  return Number(info.lastInsertRowid);
}

/**
 * Normalize inbound webhook payloads across Telegram, Discord, and Mobile Shortcuts / Generic webhooks.
 */
export function parseInboundPlatformPayload(rawBody = {}, explicitPlatform = null) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
  const hasTelegramMessageObject = Boolean(
    body.message && typeof body.message === 'object' && !Array.isArray(body.message)
  );

  // 1. Telegram (message object or callback_query)
  if (
    body.callback_query ||
    hasTelegramMessageObject ||
    explicitPlatform === 'telegram' ||
    body.platform === 'telegram'
  ) {
    if (body.callback_query) {
      const cq = body.callback_query;
      const msg = cq.message || {};
      const dataStr = String(cq.data || body.callbackData || '').trim();
      const extractedCallbackId = dataStr.startsWith('confirm:')
        ? dataStr.slice('confirm:'.length).trim()
        : String(body.callbackId || cq.id || '').trim();

      return {
        platform: 'telegram',
        chatId: String(msg.chat?.id ?? cq.from?.id ?? body.chatId ?? 'telegram_default'),
        sender:
          cq.from?.first_name ||
          cq.from?.username ||
          msg.from?.first_name ||
          msg.from?.username ||
          body.sender ||
          'telegram_user',
        text: dataStr || String(msg.text || ''),
        callbackId: extractedCallbackId || null,
        callbackData: dataStr || null,
        telegramCallbackQueryId: cq.id ? String(cq.id) : null,
        voiceMode: false
      };
    }

    const msg = hasTelegramMessageObject ? body.message : body;
    const rawCallbackData = String(body.callbackData || body.callback_data || '').trim();
    const rawCallbackId = rawCallbackData.startsWith('confirm:')
      ? rawCallbackData.slice('confirm:'.length).trim()
      : String(body.callbackId || body.callback_id || '').trim();

    return {
      platform: 'telegram',
      chatId: String(msg.chat?.id ?? body.chatId ?? body.chat_id ?? 'telegram_default'),
      sender:
        msg.from?.first_name ||
        msg.from?.username ||
        body.sender ||
        'telegram_user',
      text: String(
        (hasTelegramMessageObject ? msg.text : null) ??
          body.text ??
          body.prompt ??
          (typeof body.message === 'string' ? body.message : '')
      ).trim(),
      callbackId: rawCallbackId || null,
      callbackData: rawCallbackData || (rawCallbackId ? `confirm:${rawCallbackId}` : null),
      voiceMode: Boolean(body.voiceMode || msg.voice)
    };
  }

  // 2. Discord (content, slash command data.options, or button interaction data.custom_id)
  if (
    explicitPlatform === 'discord' ||
    body.platform === 'discord' ||
    typeof body.content === 'string' ||
    Array.isArray(body.data?.options) ||
    typeof body.data?.custom_id === 'string'
  ) {
    let text = '';
    if (typeof body.content === 'string') {
      text = body.content.trim();
    } else if (Array.isArray(body.data?.options)) {
      const optValues = body.data.options
        .map(o => (o && o.value !== undefined ? String(o.value) : ''))
        .filter(Boolean)
        .join(' ')
        .trim();
      text = body.data?.name
        ? `/${body.data.name}${optValues ? ` ${optValues}` : ''}`
        : optValues;
    } else if (typeof body.text === 'string' || typeof body.prompt === 'string') {
      text = String(body.text || body.prompt).trim();
    }

    const customId = String(body.data?.custom_id || body.callbackData || '').trim();
    const callbackId = customId.startsWith('confirm:')
      ? customId.slice('confirm:'.length).trim()
      : String(body.callbackId || body.callback_id || '').trim();

    return {
      platform: 'discord',
      chatId: String(body.channel_id || body.chatId || body.chat_id || 'discord_default'),
      sender:
        body.author?.username ||
        body.member?.user?.username ||
        body.sender ||
        'discord_user',
      text,
      callbackId: callbackId || null,
      callbackData: customId || (callbackId ? `confirm:${callbackId}` : null),
      voiceMode: Boolean(body.voiceMode)
    };
  }

  // 3. Mobile Shortcut / Generic ('ios_shortcut' | 'android_shortcut' | 'slack' | 'webhook')
  const resolvedPlatform = String(
    explicitPlatform || body.platform || 'ios_shortcut'
  ).toLowerCase().trim();

  const rawCallbackData = String(body.callbackData || body.callback_data || '').trim();
  const rawCallbackId = rawCallbackData.startsWith('confirm:')
    ? rawCallbackData.slice('confirm:'.length).trim()
    : String(body.callbackId || body.callback_id || '').trim();

  return {
    platform: resolvedPlatform,
    chatId: String(body.chatId || body.chat_id || body.channel_id || body.channel || `${resolvedPlatform}_default`),
    sender: String(body.sender || body.user_name || body.username || 'mobile_user'),
    text: String(
      body.prompt ??
        body.text ??
        body.command ??
        (typeof body.message === 'string' ? body.message : '')
    ).trim(),
    callbackId: rawCallbackId || null,
    callbackData: rawCallbackData || (rawCallbackId ? `confirm:${rawCallbackId}` : null),
    voiceMode: Boolean(body.voiceMode)
  };
}

/**
 * Find a matching incomplete task on Today's Board for `/done <query>`.
 */
function findIncompleteTaskOnBoard(rawQuery) {
  const tasks = getTasksForDate(today());
  const incomplete = tasks.filter(t => !t.completed);
  const query = String(rawQuery || '').trim();
  if (!query) return incomplete[0] || null;

  const idMatch = query.match(/^#?(\d+)$/);
  if (idMatch) {
    const id = parseInt(idMatch[1], 10);
    return incomplete.find(t => t.id === id) || tasks.find(t => t.id === id) || null;
  }

  const lower = query.toLowerCase();
  const exact = incomplete.find(t => t.title.toLowerCase().trim() === lower);
  if (exact) return exact;

  const sub = incomplete.find(
    t => t.title.toLowerCase().includes(lower) || (lower.length >= 4 && lower.includes(t.title.toLowerCase()))
  );
  if (sub) return sub;

  const words = lower.split(/\s+/).filter(w => w.length >= 3);
  if (words.length > 0) {
    let best = null;
    let bestHits = 0;
    for (const t of incomplete) {
      const titleLower = t.title.toLowerCase();
      const hits = words.filter(w => titleLower.includes(w)).length;
      if (hits > bestHits) {
        bestHits = hits;
        best = t;
      }
    }
    if (bestHits > 0) return best;
  }

  return null;
}

/**
 * Format Today's Priority Board tasks grouped by Execution Priority Lanes 1–4 + streak.
 */
function formatTodayBoardReply() {
  const dateStr = today();
  const tasks = getTasksForDate(dateStr);
  const streakInfo = getStreak();
  const pending = tasks.filter(t => !t.completed);
  const completed = tasks.filter(t => t.completed);

  const lines = [
    `📋 **Today's Priority Board (${dateStr})**`,
    `🔥 **Streak**: ${streakInfo.streak} day(s) | **Progress**: ${completed.length}/${tasks.length} completed (${pending.length} remaining)`
  ];

  for (const laneLevel of [1, 2, 3, 4]) {
    const laneTasks = pending.filter(t => (t.execution_priority || 2) === laneLevel);
    if (laneTasks.length > 0) {
      lines.push(`\n${LANE_HEADERS[laneLevel]}`);
      for (const t of laneTasks) {
        lines.push(`- **[#${t.id}]** ${t.title} *(${t.pillar_emoji || '🔧'} ${t.pillar || t.priority_name})*`);
      }
    }
  }

  if (pending.length === 0) {
    lines.push('\n🎉 **All tasks on Today\'s Priority Board are completed!**');
  }

  if (completed.length > 0) {
    lines.push(`\n✅ **Completed Today (${completed.length})**:`);
    for (const t of completed) {
      lines.push(`- ~~[#${t.id}] ${t.title}~~`);
    }
  }

  return {
    reply: lines.join('\n'),
    actionExecuted: {
      type: 'tasks_listed',
      date: dateStr,
      totalTasks: tasks.length,
      pendingCount: pending.length,
      completedCount: completed.length,
      streak: streakInfo.streak
    }
  };
}

/**
 * Execute a confirmed callback action from Telegram / Discord inline confirmation buttons.
 */
export async function handleBotCallbackAction({
  callbackId,
  executeTool = executeCompanionTool
} = {}) {
  ensureChannelBotTables();
  const db = getDb();
  const cleanId = String(callbackId || '').replace(/^confirm:/i, '').trim();

  if (!cleanId) {
    return {
      ok: false,
      callbackId: null,
      error: 'Missing callbackId'
    };
  }

  const row = db
    .prepare('SELECT * FROM companion_bot_callbacks WHERE callback_id = ?')
    .get(cleanId);

  if (!row) {
    return {
      ok: false,
      callbackId: cleanId,
      error: `Callback "${cleanId}" not found`
    };
  }

  let parsedArgs = {};
  try {
    parsedArgs = JSON.parse(row.tool_args_json || '{}');
  } catch {
    parsedArgs = {};
  }

  // Atomically claim the callback row BEFORE awaiting executeTool to prevent TOCTOU double-tap execution (DB-01)
  const claimRes = db
    .prepare('UPDATE companion_bot_callbacks SET executed = 1 WHERE callback_id = ? AND executed = 0')
    .run(cleanId);

  if (row.executed || claimRes.changes !== 1) {
    const alreadyReply = `✅ Callback \`${cleanId}\` for \`${row.tool_name}\` was already confirmed and executed.`;
    return {
      ok: true,
      alreadyExecuted: true,
      callbackId: cleanId,
      platform: row.platform,
      chatId: row.chat_id,
      tool: row.tool_name,
      reply: alreadyReply,
      tierUsed: 'L0_bot',
      executionResult: {
        ok: true,
        tool: row.tool_name,
        summary: alreadyReply
      }
    };
  }

  const executionResult = await executeTool(row.tool_name, {
    ...parsedArgs,
    dryRun: false
  });

  const confirmationText =
    executionResult?.summary ||
    `✅ Confirmed & executed \`${row.tool_name}\` (callback \`${cleanId}\`).`;

  recordBotMessage({
    platform: row.platform,
    chatId: row.chat_id,
    sender: 'companion_bot',
    direction: 'outbound',
    text: confirmationText,
    tierUsed: 'L0_bot'
  });

  return {
    ok: true,
    callbackId: cleanId,
    platform: row.platform,
    chatId: row.chat_id,
    tool: row.tool_name,
    reply: confirmationText,
    tierUsed: 'L0_bot',
    actionExecuted: {
      type: 'callback_confirmed',
      callbackId: cleanId,
      tool: row.tool_name,
      executionResult
    },
    executionResult
  };
}

/**
 * Handle an inbound turn from Telegram, Discord, or Mobile Shortcuts.
 * Enforces <1ms $0.00 slash commands and INV-EXT-05 callback confirmation gates.
 */
export async function handleInboundChannelBotTurn({
  platform = null,
  payload = {},
  dispatchChat = dispatchCompanionChat,
  executeTool = executeCompanionTool,
  fetchImpl = fetch
} = {}) {
  ensureChannelBotTables();
  const parsed = parseInboundPlatformPayload(payload, platform);

  // Check if this inbound turn is a callback confirmation gate trigger
  const isCallbackAction =
    payload?.action === 'confirm_callback' ||
    (typeof parsed.callbackData === 'string' && parsed.callbackData.startsWith('confirm:')) ||
    Boolean(payload?.callback_query);

  if (isCallbackAction && (parsed.callbackId || payload?.callbackId)) {
    const cbId = parsed.callbackId || String(payload.callbackId).replace(/^confirm:/i, '').trim();
    return await handleBotCallbackAction({
      callbackId: cbId,
      executeTool
    });
  }

  const text = String(parsed.text || '').trim();
  const resolvedPlatform = parsed.platform || platform || 'webhook';
  const chatId = parsed.chatId || 'default';
  const sender = parsed.sender || 'user';

  // Persist inbound user message
  recordBotMessage({
    platform: resolvedPlatform,
    chatId,
    sender,
    direction: 'inbound',
    text: text || '[empty]',
    tierUsed: 'L0_bot'
  });

  let reply = '';
  let tierUsed = 'L0_bot';
  let actionExecuted = null;
  const pendingConfirmations = [];
  let inlineKeyboard = null;

  // ── Fast-Path Slash Commands (<1ms, $0.00 token cost) ──────────────────────
  if (/^\/(?:today|list)(?:@\S+)?$/i.test(text)) {
    const boardOut = formatTodayBoardReply();
    reply = boardOut.reply;
    actionExecuted = boardOut.actionExecuted;
  } else if (/^\/add(?:@\S+)?(?:\s+([\s\S]+))?$/i.test(text)) {
    const addMatch = text.match(/^\/add(?:@\S+)?(?:\s+([\s\S]+))?$/i);
    const rawTitle = (addMatch?.[1] || '').trim();
    if (!rawTitle) {
      reply = '⚠️ Usage: `/add <task title>` — e.g., `/add Pay electric bill before 5pm`';
      actionExecuted = { type: 'slash_error', command: '/add' };
    } else {
      const created = createTask({
        title: rawTitle,
        date: today()
      });
      reply = [
        `✅ **Added Task [#${created.id}]**: ${created.title}`,
        `- **Execution Priority Lane**: ${created.execution_lane_emoji} **Lane ${created.execution_priority}: ${created.execution_lane_short}**`,
        `- **Life Pillar**: ${created.pillar_emoji} **${created.pillar}**`
      ].join('\n');
      actionExecuted = {
        type: 'task_created',
        task: created
      };
    }
  } else if (/^\/done(?:@\S+)?(?:\s+([\s\S]+))?$/i.test(text)) {
    const doneMatch = text.match(/^\/done(?:@\S+)?(?:\s+([\s\S]+))?$/i);
    const query = (doneMatch?.[1] || '').trim();
    const target = findIncompleteTaskOnBoard(query);
    if (!target) {
      reply = query
        ? `⚠️ Could not find an incomplete task matching **"${query}"** on Today's Priority Board.`
        : `🎉 No incomplete tasks remaining on Today's Priority Board!`;
      actionExecuted = { type: 'task_not_found', query };
    } else {
      const updated = target.completed ? target : toggleTask(target.id);
      const streakInfo = getStreak();
      reply = [
        `🎉 **Completed Task [#${updated.id}]**: ~~${updated.title}~~`,
        `- **Lane**: ${updated.execution_lane_emoji} ${updated.execution_lane_short} | **Pillar**: ${updated.pillar_emoji} ${updated.pillar}`,
        `- **Current Streak**: 🔥 ${streakInfo.streak} day(s)`
      ].join('\n');
      actionExecuted = {
        type: 'task_completed',
        task: updated,
        streak: streakInfo.streak
      };
    }
  } else if (/^\/status(?:@\S+)?$/i.test(text)) {
    const tasks = getTasksForDate(today());
    const incompleteCount = tasks.filter(t => !t.completed).length;
    const completedCount = tasks.filter(t => t.completed).length;
    const streakInfo = getStreak();
    reply = [
      `🤖 **Krusch Companion Channel Bot Status**: **ONLINE (Healthy)**`,
      `- **Current Streak**: 🔥 **${streakInfo.streak} day(s)** (${streakInfo.totalCompletedDays} total active days)`,
      `- **Today's Board (${today()})**: **${incompleteCount} incomplete** / **${completedCount} completed** (${tasks.length} total)`,
      `- **Channel**: \`${resolvedPlatform}\` (chat \`${chatId}\`)`
    ].join('\n');
    actionExecuted = {
      type: 'bot_status',
      healthy: true,
      streak: streakInfo.streak,
      incompleteCount,
      completedCount,
      totalTasks: tasks.length
    };
  } else {
    // ── Natural-Language Turn via Krusch Cascade Router ───────────────────────
    const briefing = compileStateBriefing();
    const chatRes = await dispatchChat({
      prompt: text,
      history: [],
      contextBriefing: briefing
    });

    reply = String(chatRes?.content || chatRes?.reply || '').trim() || 'Done.';
    tierUsed = chatRes?.tierUsed || 'L1_edge';
    actionExecuted = chatRes?.actionExecuted || null;

    // Inspect for side-effect tool calls requiring confirmation (INV-EXT-05)
    const toolCalls =
      chatRes?.agenticTrace?.toolCalls ||
      chatRes?.actionExecuted?.results ||
      [];

    const db = getDb();
    const insertCallbackStmt = db.prepare(`
      INSERT INTO companion_bot_callbacks (
        callback_id,
        platform,
        chat_id,
        tool_name,
        tool_args_json,
        executed
      )
      VALUES (?, ?, ?, ?, ?, 0)
    `);

    for (const tc of toolCalls) {
      if (tc && (tc.requiresConfirmation || tc.dryRun)) {
        const callbackId = `cb_${crypto.randomBytes(6).toString('hex')}`;
        const toolName = tc.name || tc.tool || 'unknown_tool';
        const toolArgs = tc.arguments || tc.args || {};

        insertCallbackStmt.run(
          callbackId,
          resolvedPlatform,
          chatId,
          toolName,
          JSON.stringify(toolArgs)
        );

        pendingConfirmations.push({
          callbackId,
          callbackData: `confirm:${callbackId}`,
          tool: toolName,
          arguments: toolArgs,
          summary: tc.summary || `Confirm execution of ${toolName}`
        });
      }
    }

    if (pendingConfirmations.length > 0) {
      inlineKeyboard = {
        reply_markup: {
          inline_keyboard: pendingConfirmations.map(pc => [
            {
              text: `✅ Confirm & Execute (${pc.tool})`,
              callback_data: `confirm:${pc.callbackId}`
            }
          ])
        },
        inline_keyboard: pendingConfirmations.map(pc => [
          {
            text: `✅ Confirm & Execute (${pc.tool})`,
            callback_data: `confirm:${pc.callbackId}`
          }
        ]),
        components: [
          {
            type: 1,
            components: pendingConfirmations.map(pc => ({
              type: 2,
              style: 3,
              label: `✅ Confirm & Execute (${pc.tool})`,
              custom_id: `confirm:${pc.callbackId}`
            }))
          }
        ]
      };
    }
  }

  // Persist outbound assistant reply
  recordBotMessage({
    platform: resolvedPlatform,
    chatId,
    sender: 'companion_bot',
    direction: 'outbound',
    text: reply,
    tierUsed,
    pendingConfirmations
  });

  // Deliver live reply if platform credentials or webhook URLs are configured
  let deliveredLive = false;
  try {
    if (resolvedPlatform === 'telegram' && process.env.TELEGRAM_BOT_TOKEN && typeof fetchImpl === 'function') {
      const tgUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
      const tgBody = {
        chat_id: chatId,
        text: reply,
        ...(inlineKeyboard ? { reply_markup: inlineKeyboard.reply_markup } : {})
      };
      const res = await fetchImpl(tgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tgBody),
        signal: AbortSignal.timeout(6000)
      });
      deliveredLive = Boolean(res && res.ok);
    } else if (
      (payload?.replyWebhookUrl || (resolvedPlatform === 'discord' && process.env.DISCORD_WEBHOOK_URL)) &&
      typeof fetchImpl === 'function'
    ) {
      const candidateWebhookUrl = payload?.replyWebhookUrl
        ? (isSafePublicUrl(payload.replyWebhookUrl) ? payload.replyWebhookUrl : null)
        : process.env.DISCORD_WEBHOOK_URL;
      if (candidateWebhookUrl && isSafePublicUrl(candidateWebhookUrl)) {
        const dcBody = {
          content: reply,
          ...(inlineKeyboard ? { components: inlineKeyboard.components } : {})
        };
        const res = await fetchImpl(candidateWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dcBody),
          signal: AbortSignal.timeout(6000)
        });
        deliveredLive = Boolean(res && res.ok);
      }
    }
  } catch {
    deliveredLive = false;
  }

  return {
    ok: true,
    platform: resolvedPlatform,
    chatId,
    sender,
    inboundText: text,
    reply,
    tierUsed,
    actionExecuted,
    pendingConfirmations,
    inlineKeyboard,
    deliveredLive
  };
}

/**
 * Retrieve recent bot conversation history from companion_bot_messages.
 */
export function getBotMessageHistory(limit = 30) {
  ensureChannelBotTables();
  const db = getDb();
  const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 30), 200);
  const rows = db
    .prepare(`
      SELECT *
      FROM companion_bot_messages
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(safeLimit);

  return rows.map(r => {
    let pendingConfirmations = null;
    if (r.pending_confirmation_json) {
      try {
        pendingConfirmations = JSON.parse(r.pending_confirmation_json);
      } catch {
        pendingConfirmations = null;
      }
    }
    return {
      ...r,
      pendingConfirmations
    };
  });
}

/**
 * Generate ready-to-import iOS Action Button / Apple Shortcut & Android HTTP Shortcut
 * JSON templates for 1-tap Voice/Text Thought Stream, Quick Chat, and Vision Capture.
 */
export function generateMobileShortcutManifest({
  baseUrl = 'http://localhost:3004'
} = {}) {
  const cleanBase = String(baseUrl || 'http://localhost:3004').replace(/\/+$/, '');

  const iosShortcuts = [
    {
      id: 'ios_thought_stream',
      name: 'Krusch 1-Tap Voice/Text Thought Stream',
      trigger: 'iOS Action Button / Siri ("Krusch Thought Stream")',
      method: 'POST',
      url: `${cleanBase}/api/companion/dump`,
      headers: {
        'Content-Type': 'application/json'
      },
      bodyTemplate: {
        text: '{{DictatedText}}',
        source: 'ios_action_button',
        voiceMode: true
      },
      responseSpeakField: 'companionNotes'
    },
    {
      id: 'ios_quick_chat',
      name: 'Krusch Quick Chat & Priority Bot',
      trigger: 'iOS Action Button / Back Tap ("Ask Krusch")',
      method: 'POST',
      url: `${cleanBase}/api/companion/bot/webhook`,
      headers: {
        'Content-Type': 'application/json'
      },
      bodyTemplate: {
        platform: 'ios_shortcut',
        chatId: 'iphone_action_button',
        sender: 'iOS Shortcut',
        prompt: '{{ShortcutInput}}',
        voiceMode: true
      },
      responseSpeakField: 'reply'
    },
    {
      id: 'ios_vision_capture',
      name: 'Krusch Vision Capture (Receipt / Whiteboard / Flyer)',
      trigger: 'iOS Share Sheet / Camera Shortcut ("Scan to Krusch")',
      method: 'POST',
      url: `${cleanBase}/api/companion/vision`,
      headers: {
        'Content-Type': 'application/json'
      },
      bodyTemplate: {
        imageBase64: '{{Base64EncodedPhoto}}',
        mode: 'auto',
        applyActions: true
      },
      responseSpeakField: 'summary'
    }
  ];

  const androidHttpShortcuts = {
    version: 1,
    title: 'Krusch Companion Sovereign Shortcuts',
    shortcuts: [
      {
        id: 'android_thought_stream',
        name: '1-Tap Thought Stream',
        description: 'Dictate or type a brain dump into Today\'s Priority Board',
        method: 'POST',
        url: `${cleanBase}/api/companion/dump`,
        headers: [{ key: 'Content-Type', value: 'application/json' }],
        bodyContent: JSON.stringify({
          text: '{prompt}',
          source: 'android_shortcut',
          voiceMode: true
        })
      },
      {
        id: 'android_quick_chat',
        name: 'Krusch Quick Chat',
        description: '2-way voice/text chat or /today, /add, /done slash commands',
        method: 'POST',
        url: `${cleanBase}/api/companion/bot/webhook`,
        headers: [{ key: 'Content-Type', value: 'application/json' }],
        bodyContent: JSON.stringify({
          platform: 'android_shortcut',
          chatId: 'android_home_widget',
          sender: 'Android Shortcut',
          prompt: '{prompt}',
          voiceMode: true
        })
      },
      {
        id: 'android_vision_capture',
        name: 'Krusch Vision Capture',
        description: 'Snap a receipt, bill, or whiteboard into Today\'s Priority Board',
        method: 'POST',
        url: `${cleanBase}/api/companion/vision`,
        headers: [{ key: 'Content-Type', value: 'application/json' }],
        bodyContent: JSON.stringify({
          imageBase64: '{image_base64}',
          mode: 'auto',
          applyActions: true
        })
      }
    ]
  };

  return {
    ok: true,
    baseUrl: cleanBase,
    generatedAt: new Date().toISOString(),
    endpoints: {
      botWebhook: `${cleanBase}/api/companion/bot/webhook`,
      botCallback: `${cleanBase}/api/companion/bot/callback`,
      thoughtStream: `${cleanBase}/api/companion/dump`,
      visionCapture: `${cleanBase}/api/companion/vision`
    },
    iosShortcuts,
    androidHttpShortcuts
  };
}
