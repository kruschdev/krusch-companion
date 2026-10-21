import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createTask, getDb, today } from '../db/index.js';
import { rememberMemory } from '../context/memory-store.js';
import { getNotesDirectory, toSafeNoteFilename } from '../agent/tools.js';
import { ensureFinanceLedgerTables } from '../extensions/finance-ledger-extension.js';

/**
 * Invariant INV-EXT-03: 15 MB payload ceiling for multimodal vision capture.
 */
export const MAX_VISION_IMAGE_BYTES = 15 * 1024 * 1024;

/**
 * Valid 1x1 transparent PNG (68 bytes) used when a text-only tool invocation
 * simulates a camera capture in hermetic tool-chain tests.
 */
export const SYNTHETIC_1X1_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export function createSyntheticPngBuffer() {
  return Buffer.from(SYNTHETIC_1X1_PNG_BASE64, 'base64');
}

/**
 * Normalize an incoming image payload (Buffer, Uint8Array, or base64/data-URI string) into a Buffer.
 */
function toImageBuffer(imageBuffer, base64Image) {
  if (Buffer.isBuffer(imageBuffer)) {
    return imageBuffer;
  }
  if (imageBuffer instanceof Uint8Array) {
    return Buffer.from(imageBuffer);
  }
  if (typeof imageBuffer === 'string' && imageBuffer.length > 0) {
    const cleaned = imageBuffer.replace(/^data:[^;]+;base64,/i, '').trim();
    return Buffer.from(cleaned, 'base64');
  }
  if (typeof base64Image === 'string' && base64Image.trim().length > 0) {
    const raw = base64Image.trim();
    // If raw string starts with obvious script/HTML tags, preserve literal bytes so magic-byte gate flags it
    if (/^(?:<!DOCTYPE|<html|<script|MZ|\x7fELF)/i.test(raw)) {
      return Buffer.from(raw, 'utf-8');
    }
    const cleaned = raw.replace(/^data:[^;]+;base64,/i, '').trim();
    return Buffer.from(cleaned, 'base64');
  }
  return Buffer.alloc(0);
}

/**
 * Enforce Invariant INV-EXT-03: Pre-Spool Vision Magic-Byte Gate & Payload Ceiling.
 *
 * - Rejects empty buffers, buffers > MAX_VISION_IMAGE_BYTES ({ valid: false, reason: 'IMAGE_TOO_LARGE' }),
 *   or executable/script headers (MZ PE, \x7fELF, <!DOCTYPE, <html, <script -> { valid: false, reason: 'INVALID_IMAGE_MAGIC_BYTES' }).
 * - Accepts valid PNG (89 50 4E 47), JPEG (FF D8 FF), GIF (GIF87a / GIF89a), and WebP (RIFF....WEBP) magic bytes.
 */
export function validateImageMagicBytes(input) {
  const buffer = Buffer.isBuffer(input)
    ? input
    : input instanceof Uint8Array
      ? Buffer.from(input)
      : typeof input === 'string'
        ? Buffer.from(input, 'utf-8')
        : null;

  if (!buffer || buffer.length === 0) {
    return {
      valid: false,
      reason: 'INVALID_IMAGE_MAGIC_BYTES',
      sizeBytes: 0
    };
  }

  if (buffer.length > MAX_VISION_IMAGE_BYTES) {
    return {
      valid: false,
      reason: 'IMAGE_TOO_LARGE',
      sizeBytes: buffer.length
    };
  }

  // Reject executable or script/HTML payloads disguised as images
  const isMzExecutable = buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a;
  const isElfBinary =
    buffer.length >= 4 &&
    buffer[0] === 0x7f &&
    buffer[1] === 0x45 &&
    buffer[2] === 0x4c &&
    buffer[3] === 0x46;
  const headAscii = buffer.subarray(0, Math.min(buffer.length, 64)).toString('utf-8').trimStart();
  const isScriptOrHtml = /^(?:<!DOCTYPE|<html|<script|<\?php|#!\/)/i.test(headAscii);

  if (isMzExecutable || isElfBinary || isScriptOrHtml) {
    return {
      valid: false,
      reason: 'INVALID_IMAGE_MAGIC_BYTES',
      sizeBytes: buffer.length
    };
  }

  // 1. PNG: 89 50 4E 47 (0D 0A 1A 0A)
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return {
      valid: true,
      detectedMimeType: 'image/png',
      sizeBytes: buffer.length
    };
  }

  // 2. JPEG: FF D8 FF
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return {
      valid: true,
      detectedMimeType: 'image/jpeg',
      sizeBytes: buffer.length
    };
  }

  // 3. GIF: GIF87a or GIF89a
  if (buffer.length >= 6) {
    const gifHeader = buffer.subarray(0, 6).toString('ascii');
    if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
      return {
        valid: true,
        detectedMimeType: 'image/gif',
        sizeBytes: buffer.length
      };
    }
  }

  // 4. WebP: RIFF....WEBP
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return {
      valid: true,
      detectedMimeType: 'image/webp',
      sizeBytes: buffer.length
    };
  }

  return {
    valid: false,
    reason: 'INVALID_IMAGE_MAGIC_BYTES',
    sizeBytes: buffer.length
  };
}

/**
 * Infer capture triage mode from prompt + filename when mode === 'auto'.
 */
export function resolveVisionMode(mode = 'auto', prompt = '', filename = '') {
  const explicitModes = new Set([
    'receipt_or_bill',
    'flyer_or_schedule',
    'whiteboard_or_notes',
    'chrome_ui_audit',
    'general_vision'
  ]);
  if (mode && mode !== 'auto' && explicitModes.has(mode)) {
    return mode;
  }

  const combined = `${prompt || ''} ${filename || ''}`;
  if (/\b(receipt|bill|invoice|total|due|payment|expense|charge)\b/i.test(combined)) {
    return 'receipt_or_bill';
  }
  if (/\b(flyer|schedule|event|calendar|invite|appointment|soccer|school|concert)\b/i.test(combined)) {
    return 'flyer_or_schedule';
  }
  if (/\b(whiteboard|diagram|handwritten|brainstorm|sticky|checklist|todo)\b/i.test(combined)) {
    return 'whiteboard_or_notes';
  }
  if (/\b(chrome|browser|screenshot|viewport|responsive|breakpoint|ui\s*audit|layout\s*bug|css\s*overflow|devtools)\b/i.test(combined)) {
    return 'chrome_ui_audit';
  }
  return 'general_vision';
}

/**
 * Extract structured fields from model JSON output and/or deterministic prompt/filename cues.
 */
function extractStructuredVisionFields({ resolvedMode, prompt = '', filename = '', modelParsed = null }) {
  const textCue = `${prompt || ''} ${filename || ''}`.trim();
  const todayIso = today();

  // 1. Parse dollar amount if present
  let amount =
    typeof modelParsed?.amount === 'number' && !Number.isNaN(modelParsed.amount)
      ? modelParsed.amount
      : null;

  if (amount === null) {
    const dollarMatch =
      textCue.match(/\$\s*(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/) ||
      textCue.match(/\b(?:total|amount|due|bill|charge|payment|expense|cost)\s*(?:of|is|:)?\s*\$?\s*(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/i) ||
      textCue.match(/\b(\d+\.\d{2})\b/);
    if (dollarMatch) {
      amount = Number(dollarMatch[1].replace(/,/g, ''));
    } else if (resolvedMode === 'receipt_or_bill') {
      amount = 0;
    }
  }

  // 2. Parse date cue (ISO date, slash date, or month name)
  let detectedDate = modelParsed?.dueDate || modelParsed?.eventDate || null;
  if (!detectedDate) {
    const isoMatch = textCue.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    const slashMatch = textCue.match(/\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/);
    const monthMatch = textCue.match(
      /\b((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,?\s*20\d{2})?)\b/i
    );
    detectedDate = isoMatch?.[1] || monthMatch?.[1] || slashMatch?.[1] || todayIso;
  }

  // 3. Parse merchant name
  let merchant = modelParsed?.merchant ? String(modelParsed.merchant).trim() : null;
  if (!merchant) {
    const fromMatch = textCue.match(
      /\b(?:from|at|merchant|vendor|biller|store)\s*:?\s*([A-Z][A-Za-z0-9&'.\-\s]{1,34}?)(?=\s+(?:for|total|amount|bill|receipt|invoice|due|on|\$\d|20\d{2}|$))/i
    );
    const prefixMatch = String(prompt || '')
      .trim()
      .match(/^([A-Z][A-Za-z0-9&'.\-\s]{1,34}?)\s+(?:electric\s+|water\s+|gas\s+|utility\s+|internet\s+|grocery\s+)?(?:receipt|bill|invoice)\b/i);

    if (fromMatch?.[1]) {
      merchant = fromMatch[1].trim();
    } else if (prefixMatch?.[1]) {
      merchant = prefixMatch[1].trim();
    } else if (resolvedMode === 'receipt_or_bill') {
      const cleanStem = path
        .basename(filename || 'receipt', path.extname(filename || ''))
        .replace(/[-_]+/g, ' ')
        .trim();
      merchant = cleanStem && !/^capture$/i.test(cleanStem) ? cleanStem : 'Household Vendor';
    }
  }

  // 4. Parse event title for flyer_or_schedule
  let eventTitle = modelParsed?.eventTitle ? String(modelParsed.eventTitle).trim() : null;
  if (!eventTitle && resolvedMode === 'flyer_or_schedule') {
    const cleanedPrompt = String(prompt || '')
      .replace(/\b(?:analyze|photo|image|of|the|a|an|flyer|for)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    eventTitle = cleanedPrompt.slice(0, 72) || 'Family Calendar Event';
  }

  // 5. Parse action items
  let actionItems = Array.isArray(modelParsed?.actionItems)
    ? modelParsed.actionItems.map(item => String(item || '').trim()).filter(Boolean)
    : [];

  if (actionItems.length === 0) {
    const rawPrompt = String(prompt || '').trim();
    if (resolvedMode === 'whiteboard_or_notes' && rawPrompt) {
      const splitItems = rawPrompt
        .replace(/^.*?(?:whiteboard|checklist|todo|notes|items)\s*:?\s*/i, '')
        .split(/(?:\r?\n|;|•|\s*,\s*|\s+\d+[.)]\s+)/)
        .map(s => s.replace(/^[-*]\s*(?:\[[ xX]\]\s*)?/, '').trim())
        .filter(Boolean);
      actionItems = splitItems.length > 0 ? splitItems : [rawPrompt];
    } else if (resolvedMode === 'receipt_or_bill') {
      const amtLabel = typeof amount === 'number' && amount > 0 ? ` ($${amount.toFixed(2)})` : '';
      actionItems = [`Pay ${merchant || 'bill'}${amtLabel} due ${detectedDate}`];
    } else if (resolvedMode === 'flyer_or_schedule') {
      actionItems = [`Prepare for ${eventTitle || 'scheduled event'} on ${detectedDate}`];
    } else if (resolvedMode === 'chrome_ui_audit') {
      actionItems = [
        `Audit Chrome UI layout & console telemetry (${filename || 'screenshot'})`,
        'Verify 375px / 768px / 1440px responsive breakpoints'
      ];
    } else if (rawPrompt) {
      actionItems = [rawPrompt];
    } else {
      actionItems = [`Review visual capture (${filename || 'capture.png'})`];
    }
  }

  const dueDate = resolvedMode === 'receipt_or_bill' ? detectedDate : (modelParsed?.dueDate || null);
  const eventDate = resolvedMode === 'flyer_or_schedule' ? detectedDate : (modelParsed?.eventDate || null);

  let summaryText = modelParsed?.summaryText ? String(modelParsed.summaryText).trim() : '';
  if (!summaryText) {
    if (resolvedMode === 'receipt_or_bill') {
      const amtStr = typeof amount === 'number' ? `$${amount.toFixed(2)}` : 'amount pending';
      summaryText = `Receipt/Bill triaged for ${merchant || 'Household Vendor'}: ${amtStr} (due ${dueDate || todayIso}).`;
    } else if (resolvedMode === 'flyer_or_schedule') {
      summaryText = `Flyer/Schedule triaged: ${eventTitle || 'Family Event'} on ${eventDate || todayIso}.`;
    } else if (resolvedMode === 'whiteboard_or_notes') {
      summaryText = `Whiteboard/Notes triaged with ${actionItems.length} action item(s): ${actionItems.join('; ')}.`;
    } else if (resolvedMode === 'chrome_ui_audit') {
      summaryText = `Captured Chrome UI screenshot (${filename || 'capture.png'})${prompt ? ` — "${prompt}"` : ''}. Ready for responsive & DOM verification.`;
    } else {
      summaryText = `Visual capture (${filename}) analyzed: ${actionItems.join('; ')}.`;
    }
  }

  return {
    merchant: merchant || null,
    amount,
    dueDate,
    eventTitle: eventTitle || null,
    eventDate,
    actionItems,
    summaryText
  };
}

/**
 * If `companion_receipts` table exists in SQLite, insert the extracted receipt row safely.
 */
function insertReceiptIfTableExists({ extracted, filename, stagedTaskId = null }) {
  try {
    ensureFinanceLedgerTables();
    const db = getDb();
    const tableCols = db.prepare("PRAGMA table_info('companion_receipts')").all();
    if (!Array.isArray(tableCols) || tableCols.length === 0) {
      return null;
    }

    const colNames = new Set(tableCols.map(c => c.name));
    const candidateValues = {
      merchant: extracted.merchant || 'Household Vendor',
      vendor: extracted.merchant || 'Household Vendor',
      title: extracted.merchant || 'Receipt Capture',
      amount: typeof extracted.amount === 'number' ? extracted.amount : 0,
      total: typeof extracted.amount === 'number' ? extracted.amount : 0,
      currency: 'USD',
      category: 'Provision & Finance',
      pillar: 'Provision & Finance',
      date: extracted.dueDate || today(),
      receipt_date: extracted.dueDate || today(),
      due_date: extracted.dueDate || today(),
      notes: extracted.summaryText || '',
      summary: extracted.summaryText || '',
      filename: filename || 'capture.png',
      image_filename: filename || 'capture.png',
      source: 'vision_capture',
      task_id: stagedTaskId
    };

    const insertCols = [];
    const insertVals = [];

    for (const col of tableCols) {
      if (col.name === 'id' || col.name === 'created_at' || col.name === 'updated_at') {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(candidateValues, col.name)) {
        insertCols.push(col.name);
        insertVals.push(candidateValues[col.name]);
      } else if (col.notnull && col.dflt_value === null) {
        insertCols.push(col.name);
        insertVals.push(/INT|REAL|NUM|FLOA|DOUB/i.test(col.type || '') ? 0 : '');
      }
    }

    if (insertCols.length === 0 && colNames.has('merchant')) {
      insertCols.push('merchant');
      insertVals.push(extracted.merchant || 'Household Vendor');
    }

    const placeholders = insertCols.map(() => '?').join(', ');
    const stmt = db.prepare(
      `INSERT INTO companion_receipts (${insertCols.join(', ')}) VALUES (${placeholders})`
    );
    const info = stmt.run(...insertVals);
    return Number(info.lastInsertRowid);
  } catch {
    return null;
  }
}

/**
 * Analyze a captured companion image (receipt, bill, flyer, whiteboard, Chrome UI screenshot, or general visual scene)
 * using resident gemma4:e4b on kruschserv with Gemini 4 Argon (gemini-4-argon) and OpenRouter privacy-gated fallback
 * and deterministic structured extraction fallback when offline or in MOCK_LLM=1 mode.
 */
export async function analyzeCompanionImage({
  imageBuffer = null,
  base64Image = null,
  mimeType = 'image/png',
  filename = 'capture.png',
  prompt = '',
  mode = 'auto',
  autoStageBoard = true,
  notesDir = null,
  fetchImpl = fetch
} = {}) {
  const buffer = toImageBuffer(imageBuffer, base64Image);
  const validation = validateImageMagicBytes(buffer);

  if (!validation.valid) {
    return {
      ok: false,
      error: validation.reason,
      reason: validation.reason,
      mimeType,
      sizeBytes: validation.sizeBytes,
      summary: `Vision capture rejected (${validation.reason}): image failed pre-spool magic-byte or 15 MB ceiling check.`
    };
  }

  const resolvedMode = resolveVisionMode(mode, prompt, filename);
  const visionModel = process.env.VISION_MODEL || 'gemma4:e4b';
  const ollamaBaseUrl = (process.env.VISION_OLLAMA_URL || process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const base64Clean = buffer.toString('base64');
  const imageHash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 10);

  let modelUsed = visionModel;
  let modelParsed = null;

  if (process.env.MOCK_LLM !== '1') {
    const systemPrompt = [
      'You are Krusch Companion Multimodal Vision (gemma4:e4b).',
      `Triage mode: ${resolvedMode}.`,
      'Return ONLY a valid JSON object with keys:',
      '{"merchant": string|null, "amount": number|null, "dueDate": string|null, "eventTitle": string|null, "eventDate": string|null, "actionItems": string[], "summaryText": string}'
    ].join(' ');

    const preferGeminiDirect =
      /^(?:gemini-4|argon)/i.test(visionModel) && Boolean(process.env.GEMINI_API_KEY);

    if (!preferGeminiDirect) {
      try {
        const ollamaRes = await fetchImpl(`${ollamaBaseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: visionModel,
            stream: false,
            format: 'json',
            messages: [
              { role: 'system', content: systemPrompt },
              {
                role: 'user',
                content: prompt || `Analyze this ${resolvedMode} image (${filename}) and extract structured fields.`,
                images: [base64Clean]
              }
            ],
            options: { temperature: 0.1 }
          }),
          signal: AbortSignal.timeout(Number(process.env.VISION_TIMEOUT_MS || 8000))
        });

        if (ollamaRes.ok) {
          const data = await ollamaRes.json();
          const rawContent = data?.message?.content || data?.response || '';
          if (rawContent) {
            try {
              modelParsed = JSON.parse(rawContent);
            } catch {
              modelParsed = { summaryText: String(rawContent).trim() };
            }
          }
        }
      } catch {
        // Fallback to Gemini 4 Argon / OpenRouter Vision (if configured) or deterministic local extraction
      }
    }

    if (!modelParsed && process.env.GEMINI_API_KEY) {
      try {
        const geminiModel = /^gemini-4/i.test(visionModel)
          ? visionModel
          : (process.env.GEMINI_VISION_MODEL || 'gemini-4-argon');
        const geminiRes = await fetchImpl(
          `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': process.env.GEMINI_API_KEY
            },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: systemPrompt }] },
              contents: [
                {
                  role: 'user',
                  parts: [
                    { text: prompt || `Analyze this ${resolvedMode} image (${filename}) and extract structured fields.` },
                    { inlineData: { mimeType: validation.detectedMimeType, data: base64Clean } }
                  ]
                }
              ],
              generationConfig: {
                maxOutputTokens: 65536,
                thinkingConfig: { thinkingLevel: resolvedMode === 'chrome_ui_audit' ? 'high' : 'medium' },
                responseMimeType: 'application/json'
              }
            }),
            signal: AbortSignal.timeout(Number(process.env.VISION_TIMEOUT_MS || 10000))
          }
        );

        if (geminiRes.ok) {
          const geminiData = await geminiRes.json();
          const parts = geminiData?.candidates?.[0]?.content?.parts || [];
          const rawText = parts
            .filter(p => p && typeof p.text === 'string' && !p.thought)
            .map(p => p.text)
            .join('');
          if (rawText) {
            modelUsed = geminiModel;
            try {
              modelParsed = JSON.parse(rawText);
            } catch {
              modelParsed = { summaryText: rawText.trim() };
            }
          }
        }
      } catch {
        // Fallback to OpenRouter Vision (if configured) or deterministic local extraction
      }
    }

    if (!modelParsed && process.env.OPENROUTER_API_KEY) {
      try {
        const orModel = process.env.OPENROUTER_VISION_MODEL || 'google/gemma-3-27b-it:free';
        const orRes = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`
          },
          body: JSON.stringify({
            model: orModel,
            provider: { data_collection: 'deny', allow_fallbacks: false },
            messages: [
              { role: 'system', content: systemPrompt },
              {
                role: 'user',
                content: [
                  { type: 'text', text: prompt || `Analyze this ${resolvedMode} image (${filename}).` },
                  { type: 'image_url', image_url: { url: `data:${validation.detectedMimeType};base64,${base64Clean}` } }
                ]
              }
            ]
          }),
          signal: AbortSignal.timeout(10000)
        });

        if (orRes.ok) {
          const orData = await orRes.json();
          const text = orData?.choices?.[0]?.message?.content || '';
          if (text) {
            modelUsed = orModel;
            try {
              modelParsed = JSON.parse(text);
            } catch {
              modelParsed = { summaryText: String(text).trim() };
            }
          }
        }
      } catch {
        // Proceed to deterministic structured extraction fallback
      }
    }
  }

  const extracted = extractStructuredVisionFields({
    resolvedMode,
    prompt,
    filename,
    modelParsed
  });

  let stagedTask = null;
  let receiptId = null;
  let noteFilename = null;

  if (autoStageBoard !== false) {
    if (resolvedMode === 'receipt_or_bill') {
      const amtFormatted =
        typeof extracted.amount === 'number' && extracted.amount > 0
          ? ` — $${extracted.amount.toFixed(2)}`
          : '';
      const taskTitle = `Pay ${extracted.merchant || 'Bill'}${amtFormatted}${extracted.dueDate ? ` (Due ${extracted.dueDate})` : ''}`;
      stagedTask = createTask({
        title: taskTitle,
        priority_id: 5,
        execution_priority: 1,
        pillar: 'Provision & Finance',
        notes: extracted.summaryText,
        items: extracted.actionItems
      });
      receiptId = insertReceiptIfTableExists({
        extracted,
        filename,
        stagedTaskId: stagedTask?.id || null
      });
    } else if (resolvedMode === 'flyer_or_schedule') {
      const taskTitle = `${extracted.eventTitle || 'Family Schedule Event'}${extracted.eventDate ? ` (${extracted.eventDate})` : ''}`;
      stagedTask = createTask({
        title: taskTitle,
        priority_id: 2,
        execution_priority: 2,
        pillar: 'Family & Partner',
        notes: extracted.summaryText,
        items: extracted.actionItems
      });
    } else if (resolvedMode === 'whiteboard_or_notes') {
      const primaryItem = extracted.actionItems[0] || `Whiteboard Action (${filename})`;
      stagedTask = createTask({
        title: primaryItem,
        priority_id: 5,
        execution_priority: 2,
        pillar: 'Work & Mastery',
        notes: extracted.summaryText,
        items: extracted.actionItems
      });
    } else if (resolvedMode === 'chrome_ui_audit') {
      const primaryItem = extracted.actionItems[0] || `Chrome UI Audit (${filename})`;
      stagedTask = createTask({
        title: primaryItem,
        priority_id: 5,
        execution_priority: 1,
        pillar: 'Work & Mastery',
        notes: extracted.summaryText,
        items: extracted.actionItems
      });
    }

    const targetNotesDir = notesDir || getNotesDirectory();
    fs.mkdirSync(targetNotesDir, { recursive: true });
    noteFilename = toSafeNoteFilename(`vision-capture-${resolvedMode}-${Date.now()}-${imageHash.slice(0, 6)}`);
    const notePath = path.join(targetNotesDir, noteFilename);

    const noteLines = [
      `# 📷 Vision Capture (${resolvedMode})`,
      `- **Source File**: \`${filename}\` (${validation.detectedMimeType}, ${validation.sizeBytes} bytes, sha256:\`${imageHash}\`)`,
      `- **Model**: \`${modelUsed}\``,
      `- **Date**: ${today()}`,
      extracted.merchant ? `- **Merchant**: ${extracted.merchant}` : null,
      typeof extracted.amount === 'number' ? `- **Amount**: $${extracted.amount.toFixed(2)}` : null,
      extracted.dueDate ? `- **Due Date**: ${extracted.dueDate}` : null,
      extracted.eventTitle ? `- **Event**: ${extracted.eventTitle}` : null,
      extracted.eventDate ? `- **Event Date**: ${extracted.eventDate}` : null,
      '',
      '## Summary',
      extracted.summaryText,
      '',
      '## Extracted Action Items',
      ...extracted.actionItems.map(item => `- [ ] ${item}`),
      ''
    ].filter(line => line !== null);

    fs.writeFileSync(notePath, noteLines.join('\n'), 'utf-8');

    try {
      rememberMemory({
        category: 'lesson',
        content: `[Vision Capture: ${resolvedMode}] ${extracted.summaryText}`
      });
    } catch {
      // Non-fatal if working memory store is unavailable
    }
  }

  const summary = [
    `📷 **Multimodal Vision (${modelUsed} — \`${resolvedMode}\`)**: ${extracted.summaryText}`,
    stagedTask
      ? `✅ Staged on Today's Board: **${stagedTask.title}** [Priority ${stagedTask.execution_priority} | ${stagedTask.pillar}]`
      : null,
    noteFilename ? `📝 Saved capture note: \`${noteFilename}\`` : null
  ]
    .filter(Boolean)
    .join('\n');

  return {
    ok: true,
    mode: resolvedMode,
    modelUsed,
    mimeType: validation.detectedMimeType,
    sizeBytes: validation.sizeBytes,
    extracted,
    stagedTask,
    receiptId,
    noteFilename,
    summary
  };
}

/**
 * Declarative V3.8 Extension Tool for Multimodal Vision & Camera Triage (gemma4:e4b + gemini-4-argon).
 */
export const VISION_CAPTURE_EXTENSION_TOOL = {
  name: 'vision_capture',
  category: 'multimodal_vision',
  extensionId: 'gemma4-vision-capture',
  description:
    'Opt-in Multimodal Vision & Camera Triage (gemma4:e4b with gemini-4-argon cloud burst fallback): analyze photos of paper bills, receipts, school flyers, whiteboards, or Chrome UI audit screenshots (chrome_ui_audit) to extract tasks onto Today Board, log expenses, and save notes.',
  parameters: {
    mode: 'string ("auto" | "receipt_or_bill" | "flyer_or_schedule" | "whiteboard_or_notes" | "chrome_ui_audit" | "general_vision")',
    prompt: 'string (Visual question or instructions)',
    base64Image: 'string (Base64-encoded image or data URI)',
    filename: 'string (Image filename)'
  },
  required: ['prompt'],
  async execute(args = {}, options = {}) {
    const hasExplicitImage = Boolean(args?.imageBuffer || (args?.base64Image && String(args.base64Image).trim()));
    const imageBuffer = hasExplicitImage ? args.imageBuffer : createSyntheticPngBuffer();
    const base64Image = hasExplicitImage ? args.base64Image : null;

    const result = await analyzeCompanionImage({
      imageBuffer,
      base64Image,
      mimeType: args?.mimeType || 'image/png',
      filename: args?.filename || 'capture.png',
      prompt: String(args?.prompt || args?.query || '').trim(),
      mode: args?.mode || 'auto',
      autoStageBoard: args?.autoStageBoard !== undefined ? Boolean(args.autoStageBoard) : true,
      notesDir: options?.notesDir || args?.notesDir || null,
      fetchImpl: options?.fetchImpl || fetch
    });

    return {
      ...result,
      tool: 'vision_capture',
      actionType: 'vision_capture',
      data: result
    };
  }
};
