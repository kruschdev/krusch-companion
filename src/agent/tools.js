import fs from 'fs';
import os from 'os';
import path from 'path';
import config from '../config.js';
import {
  createTask,
  toggleTask,
  findTaskByQuery,
  getTasksForDate,
  getStreak,
  getDb,
  today
} from '../db/index.js';
import { rememberMemory, getActiveMemories } from '../context/memory-store.js';
import { inferPriorityTierFromText } from '../router/cascade-client.js';

/**
 * WMO Weather interpretation codes for Open-Meteo API
 */
const WMO_CODES = {
  0: 'Clear sky ☀️',
  1: 'Mainly clear 🌤️',
  2: 'Partly cloudy ⛅',
  3: 'Overcast ☁️',
  45: 'Foggy 🌫️',
  48: 'Depositing rime fog 🌫️',
  51: 'Light drizzle 🌦️',
  53: 'Moderate drizzle 🌦️',
  55: 'Dense drizzle 🌧️',
  61: 'Slight rain 🌧️',
  63: 'Moderate rain 🌧️',
  65: 'Heavy rain 🌧️',
  71: 'Slight snow 🌨️',
  73: 'Moderate snow 🌨️',
  75: 'Heavy snow ❄️',
  80: 'Rain showers 🌦️',
  81: 'Moderate rain showers 🌧️',
  82: 'Violent rain showers ⛈️',
  95: 'Thunderstorm ⛈️'
};

/**
 * Security: Block SSRF attempts against private, loopback, or link-local IP ranges
 * when fetching arbitrary external URLs.
 */
export function isSafePublicUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the sandboxed notes directory inside the companion data folder.
 */
export function getNotesDirectory() {
  const dataDir = path.dirname(config.db.path);
  const notesDir = path.join(dataDir, 'notes');
  if (!fs.existsSync(notesDir)) {
    fs.mkdirSync(notesDir, { recursive: true });
  }
  return notesDir;
}

/**
 * Sanitize a note title/filename into a safe slug within the notes directory.
 */
export function toSafeNoteFilename(titleOrSlug) {
  const base = String(titleOrSlug || 'note')
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'untitled-note';
  return `${base}.md`;
}

/**
 * Declarative Tool Registry for Krusch Companion's Agentic Proxy.
 * Uses flat parameter schemas specifically optimized for 7B/14B models
 * operating under the <holodata> Dual-Engine Cognitive Blueprint protocol.
 */
export const COMPANION_TOOLS = [
  {
    name: 'get_weather',
    category: 'weather',
    description: 'Fetch live current weather conditions and daily high/low forecast for any city or location.',
    parameters: {
      location: 'string (REQUIRED: City or location name, e.g. "Seattle", "Austin, TX", "London")'
    },
    required: ['location'],
    async execute(args, { fetchImpl = fetch } = {}) {
      const location = String(args?.location || '').trim();
      if (!location) {
        return { ok: false, tool: 'get_weather', summary: 'Missing required parameter: location' };
      }

      try {
        // 1. Geocode location via Open-Meteo
        const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
        const geoRes = await fetchImpl(geoUrl, { signal: AbortSignal.timeout(8000) });
        if (!geoRes.ok) throw new Error(`Geocoding HTTP ${geoRes.status}`);
        const geoData = await geoRes.json();
        const place = geoData?.results?.[0];

        if (!place) {
          return {
            ok: false,
            tool: 'get_weather',
            summary: `Could not find coordinates for location "${location}".`
          };
        }

        // 2. Fetch current weather + daily forecast
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=1`;
        const weatherRes = await fetchImpl(weatherUrl, { signal: AbortSignal.timeout(8000) });
        if (!weatherRes.ok) throw new Error(`Weather API HTTP ${weatherRes.status}`);
        const weatherData = await weatherRes.json();

        const current = weatherData.current || {};
        const daily = weatherData.daily || {};
        const condition = WMO_CODES[current.weather_code] || 'Clear / Partly Cloudy';
        const tempF = current.temperature_2m;
        const tempC = typeof tempF === 'number' ? Math.round(((tempF - 32) * 5) / 9) : null;
        const highF = daily.temperature_2m_max?.[0];
        const lowF = daily.temperature_2m_min?.[0];
        const precipProb = daily.precipitation_probability_max?.[0] ?? 0;

        const resolvedName = [place.name, place.admin1, place.country_code].filter(Boolean).join(', ');
        const summary = `🌤️ **Weather in ${resolvedName}**: **${tempF}°F** (${tempC}°C) — ${condition} | Feels like ${current.apparent_temperature}°F | High: ${highF}°F / Low: ${lowF}°F | Wind: ${current.wind_speed_10m} mph | Humidity: ${current.relative_humidity_2m}% | Precip chance: ${precipProb}%`;

        return {
          ok: true,
          tool: 'get_weather',
          actionType: 'api_weather',
          summary,
          data: {
            location: resolvedName,
            temperatureF: tempF,
            temperatureC: tempC,
            condition,
            highF,
            lowF,
            windMph: current.wind_speed_10m,
            humidity: current.relative_humidity_2m,
            precipitationProbability: precipProb
          }
        };
      } catch (err) {
        return {
          ok: false,
          tool: 'get_weather',
          summary: `Weather lookup failed for "${location}": ${err.message}`
        };
      }
    }
  },
  {
    name: 'web_research',
    category: 'web',
    description: 'Search encyclopedic and instant-answer web sources for facts, definitions, people, places, or technical topics.',
    parameters: {
      query: 'string (REQUIRED: The topic or question to research, e.g. "Pomodoro Technique", "Rust programming language")'
    },
    required: ['query'],
    async execute(args, { fetchImpl = fetch } = {}) {
      const query = String(args?.query || '').trim();
      if (!query) {
        return { ok: false, tool: 'web_research', summary: 'Missing required parameter: query' };
      }

      try {
        // 1. Try DuckDuckGo Instant Answer API
        const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
        const ddgRes = await fetchImpl(ddgUrl, { signal: AbortSignal.timeout(8000) });
        if (ddgRes.ok) {
          const ddg = await ddgRes.json();
          if (ddg.AbstractText) {
            return {
              ok: true,
              tool: 'web_research',
              actionType: 'api_web_research',
              summary: `🔎 **${ddg.Heading || query}**: ${ddg.AbstractText}${ddg.AbstractURL ? `\n🔗 Source: ${ddg.AbstractURL}` : ''}`,
              data: {
                title: ddg.Heading || query,
                extract: ddg.AbstractText,
                url: ddg.AbstractURL || null,
                source: ddg.AbstractSource || 'DuckDuckGo'
              }
            };
          }
        }

        // 2. Fallback to Wikipedia REST Search + Summary API
        const wikiSearchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=&format=json&srlimit=1`;
        const searchRes = await fetchImpl(wikiSearchUrl, {
          headers: { 'User-Agent': 'KruschCompanion/1.0 (https://krusch.dev)' },
          signal: AbortSignal.timeout(8000)
        });
        if (!searchRes.ok) throw new Error(`Wikipedia Search HTTP ${searchRes.status}`);
        const searchData = await searchRes.json();
        const topHit = searchData?.query?.search?.[0];

        if (!topHit) {
          return {
            ok: false,
            tool: 'web_research',
            summary: `No instant encyclopedia results found for "${query}".`
          };
        }

        const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topHit.title.replace(/ /g, '_'))}`;
        const sumRes = await fetchImpl(summaryUrl, {
          headers: { 'User-Agent': 'KruschCompanion/1.0 (https://krusch.dev)' },
          signal: AbortSignal.timeout(8000)
        });
        if (!sumRes.ok) throw new Error(`Wikipedia Summary HTTP ${sumRes.status}`);
        const sumData = await sumRes.json();

        const extract = sumData.extract || topHit.snippet?.replace(/<[^>]+>/g, '') || '';
        const pageUrl = sumData?.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(topHit.title)}`;

        return {
          ok: true,
          tool: 'web_research',
          actionType: 'api_web_research',
          summary: `🔎 **${sumData.title || topHit.title}**: ${extract}\n🔗 Source: ${pageUrl}`,
          data: {
            title: sumData.title || topHit.title,
            extract,
            url: pageUrl,
            source: 'Wikipedia'
          }
        };
      } catch (err) {
        return {
          ok: false,
          tool: 'web_research',
          summary: `Web research failed for "${query}": ${err.message}`
        };
      }
    }
  },
  {
    name: 'fetch_url_digest',
    category: 'web',
    description: 'Fetch a public URL (article, documentation page, or JSON endpoint) and extract a clean readable text digest.',
    parameters: {
      url: 'string (REQUIRED: Full https:// or http:// URL to read)'
    },
    required: ['url'],
    async execute(args, { fetchImpl = fetch } = {}) {
      const url = String(args?.url || '').trim();
      if (!isSafePublicUrl(url)) {
        return {
          ok: false,
          tool: 'fetch_url_digest',
          summary: `Blocked URL "${url}": only public http/https URLs are permitted (private/loopback ranges are blocked for SSRF protection).`
        };
      }

      try {
        const res = await fetchImpl(url, {
          headers: { 'User-Agent': 'KruschCompanion/1.0 (+https://krusch.dev)' },
          signal: AbortSignal.timeout(10000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.text();

        const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const pageTitle = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : url;

        const cleanText = raw
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 2200);

        return {
          ok: true,
          tool: 'fetch_url_digest',
          actionType: 'api_url_digest',
          summary: `📄 **Fetched [${pageTitle}](${url})**:\n> ${cleanText.slice(0, 600)}${cleanText.length > 600 ? '...' : ''}`,
          data: {
            url,
            title: pageTitle,
            digest: cleanText
          }
        };
      } catch (err) {
        return {
          ok: false,
          tool: 'fetch_url_digest',
          summary: `Failed to fetch URL "${url}": ${err.message}`
        };
      }
    }
  },
  {
    name: 'save_note',
    category: 'notes',
    description: 'Draft and save a Markdown note, checklist, meeting brief, or document into the user\'s sovereign local notes vault.',
    parameters: {
      title: 'string (REQUIRED: Title of the note or document)',
      content: 'string (REQUIRED: Full Markdown body content to save)'
    },
    required: ['title', 'content'],
    async execute(args) {
      const title = String(args?.title || '').trim();
      const content = String(args?.content || '').trim();
      if (!title || !content) {
        return { ok: false, tool: 'save_note', summary: 'Both title and content are required to save a note.' };
      }

      const notesDir = getNotesDirectory();
      const filename = toSafeNoteFilename(title);
      const filePath = path.join(notesDir, filename);
      const timestamp = new Date().toISOString();
      const markdown = `# ${title}\n*Saved by Krusch Companion on ${timestamp}*\n\n${content}\n`;

      fs.writeFileSync(filePath, markdown, 'utf-8');

      return {
        ok: true,
        tool: 'save_note',
        actionType: 'note_saved',
        summary: `📝 Saved sovereign note **${title}** (\`data/notes/${filename}\`):\n\n${content}`,
        data: {
          title,
          filename,
          filePath,
          bytes: Buffer.byteLength(markdown, 'utf-8')
        }
      };
    }
  },
  {
    name: 'list_notes',
    category: 'notes',
    description: 'List all saved Markdown notes in the user\'s sovereign local notes vault, or read a specific note by title.',
    parameters: {
      title: 'string (OPTIONAL: Specific note title or filename to read; omit or pass "" to list all saved notes)'
    },
    required: [],
    async execute(args) {
      const notesDir = getNotesDirectory();
      const queryTitle = String(args?.title || '').trim();

      const files = fs.readdirSync(notesDir).filter(f => f.endsWith('.md')).sort();
      if (queryTitle) {
        const targetSlug = toSafeNoteFilename(queryTitle);
        const matched = files.find(f => f === targetSlug || f.includes(targetSlug.replace(/\.md$/, '')));
        if (!matched) {
          return {
            ok: false,
            tool: 'list_notes',
            summary: `No saved note matching "${queryTitle}" found. Saved notes: ${files.join(', ') || 'none'}.`
          };
        }
        const content = fs.readFileSync(path.join(notesDir, matched), 'utf-8');
        return {
          ok: true,
          tool: 'list_notes',
          actionType: 'note_read',
          summary: `📂 **Note \`${matched}\`**:\n\n${content}`,
          data: { filename: matched, content }
        };
      }

      if (files.length === 0) {
        return {
          ok: true,
          tool: 'list_notes',
          actionType: 'note_read',
          summary: '📂 Your sovereign notes vault (`data/notes/`) is currently empty. Ask me to draft or save a note anytime!',
          data: { files: [] }
        };
      }

      return {
        ok: true,
        tool: 'list_notes',
        actionType: 'note_read',
        summary: `📂 **Saved Sovereign Notes (${files.length})**:\n${files.map(f => `- \`${f}\``).join('\n')}`,
        data: { files }
      };
    }
  },
  {
    name: 'send_notification',
    category: 'notify',
    description: 'Send a push notification or webhook alert to the user\'s devices via ntfy or configured webhook.',
    parameters: {
      title: 'string (REQUIRED: Short notification title)',
      message: 'string (REQUIRED: Notification body message)',
      topic: 'string (OPTIONAL: ntfy topic name; defaults to configured topic or "krusch-companion")'
    },
    required: ['title', 'message'],
    async execute(args, { fetchImpl = fetch } = {}) {
      const title = String(args?.title || 'Krusch Companion Alert').trim();
      const message = String(args?.message || '').trim();
      const topic = String(args?.topic || process.env.NTFY_TOPIC || 'krusch-companion').trim();

      if (!message) {
        return { ok: false, tool: 'send_notification', summary: 'Notification message is required.' };
      }

      const ntfyBase = (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/+$/, '');
      const targetUrl = `${ntfyBase}/${encodeURIComponent(topic)}`;

      try {
        const res = await fetchImpl(targetUrl, {
          method: 'POST',
          headers: {
            'Title': title,
            'Tags': 'robot,sparkles'
          },
          body: message,
          signal: AbortSignal.timeout(8000)
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        return {
          ok: true,
          tool: 'send_notification',
          actionType: 'notification_sent',
          summary: `🔔 Sent push notification to **${topic}**:\n> **${title}** — ${message}`,
          data: { topic, title, message, url: targetUrl }
        };
      } catch (err) {
        return {
          ok: false,
          tool: 'send_notification',
          summary: `Failed to dispatch notification to "${topic}": ${err.message}`
        };
      }
    }
  },
  {
    name: 'system_status',
    category: 'system',
    description: 'Check local host system telemetry (CPU load, RAM usage, uptime) and Sovereign Companion SQLite & AI health.',
    parameters: {},
    required: [],
    async execute() {
      const totalMemGb = (os.totalmem() / (1024 ** 3)).toFixed(1);
      const freeMemGb = (os.freemem() / (1024 ** 3)).toFixed(1);
      const usedMemPct = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);
      const loadAvg = os.loadavg().map(n => n.toFixed(2)).join(', ');
      const uptimeHours = (os.uptime() / 3600).toFixed(1);

      const tasks = getTasksForDate(today());
      const pendingCount = tasks.filter(t => !t.completed).length;
      const completedCount = tasks.filter(t => t.completed).length;
      const memories = getActiveMemories();
      const streak = getStreak();
      const integrityRow = getDb().prepare('PRAGMA integrity_check').get();
      const dbIntegrity = integrityRow?.integrity_check || 'ok';

      const summary = [
        `🖥️ **Sovereign System & Companion Telemetry**:`,
        `- **Host**: \`${os.hostname()}\` (${os.platform()} ${os.arch()}) — Uptime: **${uptimeHours}h**`,
        `- **CPU Load (1m/5m/15m)**: \`${loadAvg}\` across ${os.cpus().length} cores`,
        `- **Memory**: **${freeMemGb} GB free** / ${totalMemGb} GB total (${usedMemPct}% used)`,
        `- **SQLite WAL Vault**: Integrity \`${dbIntegrity}\` | **${memories.length}** active memories`,
        `- **Today's Priority Board**: **${completedCount}/${tasks.length}** completed (${pendingCount} pending) | 🔥 **${streak.streak}d** streak`,
        `- **Edge Model**: \`${config.cascade.edgeModel}\` (${config.cascade.provider})`
      ].join('\n');

      return {
        ok: true,
        tool: 'system_status',
        actionType: 'system_telemetry',
        summary,
        data: {
          hostname: os.hostname(),
          uptimeHours: parseFloat(uptimeHours),
          loadAvg: os.loadavg(),
          freeMemGb: parseFloat(freeMemGb),
          totalMemGb: parseFloat(totalMemGb),
          usedMemPct,
          dbIntegrity,
          activeMemories: memories.length,
          tasksTotal: tasks.length,
          tasksCompleted: completedCount,
          streak: streak.streak
        }
      };
    }
  },
  {
    name: 'sovereign_gateway_query',
    category: 'sovereign_law_biz',
    description: 'Query the local KruschLaw (:8085) legal statute engine or KruschBiz (:8086) contract intelligence API.',
    parameters: {
      domain: 'string (REQUIRED: "law" for legal statutes/tenant rights, or "biz" for corporate contracts/clauses)',
      query: 'string (REQUIRED: The legal or contract question to search)'
    },
    required: ['domain', 'query'],
    async execute(args, { fetchImpl = fetch } = {}) {
      const domain = String(args?.domain || 'law').toLowerCase().trim();
      const query = String(args?.query || '').trim();
      if (!query) {
        return { ok: false, tool: 'sovereign_gateway_query', summary: 'Query parameter is required.' };
      }

      const isBiz = domain.includes('biz') || domain.includes('contract');
      const baseUrl = isBiz
        ? (process.env.KRUSCH_BIZ_URL || 'http://127.0.0.1:8086')
        : (process.env.KRUSCH_LAW_URL || 'http://127.0.0.1:8085');
      const endpoint = isBiz ? `${baseUrl}/api/search` : `${baseUrl}/api/search`;

      try {
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, limit: 3 }),
          signal: AbortSignal.timeout(6000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const hits = data?.results || data?.items || [];
        const formatted = hits.length > 0
          ? hits.slice(0, 3).map((h, i) => `${i + 1}. **${h.title || h.citation || h.statute_code || 'Record'}**: ${(h.text || h.content || h.summary || '').slice(0, 260)}`).join('\n')
          : JSON.stringify(data).slice(0, 500);

        return {
          ok: true,
          tool: 'sovereign_gateway_query',
          actionType: 'sovereign_gateway',
          summary: `⚖️ **Sovereign ${isBiz ? 'KruschBiz' : 'KruschLaw'} Result for "${query}"**:\n${formatted}`,
          data
        };
      } catch (err) {
        return {
          ok: false,
          tool: 'sovereign_gateway_query',
          summary: `Sovereign ${isBiz ? 'KruschBiz (:8086)' : 'KruschLaw (:8085)'} service was unreachable (${err.message}).`
        };
      }
    }
  },
  {
    name: 'board_action',
    category: 'board',
    description: 'Create or complete a task on Today\'s Priority Board, or persist a fact into Sovereign Working Memory as part of a multi-step action.',
    parameters: {
      action: 'string (REQUIRED: "add_task" | "complete_task" | "remember")',
      title: 'string (REQUIRED: Task title to add/complete, or memory content to remember)',
      tier: 'number (OPTIONAL: 1=Values/Faith, 2=Partner, 3=Family/Kids, 4=Health/Fitness/Walk, 5=Work; omit to auto-classify)'
    },
    required: ['action', 'title'],
    async execute(args) {
      const action = String(args?.action || 'add_task').toLowerCase().trim();
      const title = String(args?.title || '').trim();
      if (!title) {
        return { ok: false, tool: 'board_action', summary: 'Parameter "title" is required for board_action.' };
      }

      if (action === 'complete_task' || action === 'complete') {
        const target = findTaskByQuery(title, today(), { onlyIncomplete: true }) || findTaskByQuery(title, today());
        if (!target) {
          return { ok: false, tool: 'board_action', summary: `Could not find task matching "${title}" on Today's Board.` };
        }
        const updated = target.completed ? target : toggleTask(target.id);
        return {
          ok: true,
          tool: 'board_action',
          actionType: 'task_completed',
          summary: `🎉 Completed task **[#${updated.id}] ${updated.title}** (*Tier ${updated.tier}: ${updated.priority_name}*).`,
          data: { task: updated }
        };
      }

      if (action === 'remember' || action === 'save_memory') {
        const saved = rememberMemory({ category: 'decision', content: title });
        return {
          ok: true,
          tool: 'board_action',
          actionType: 'memory_saved',
          summary: `🧠 Saved to Working Memory (#${saved.id}): "${saved.content}"`,
          data: { memory: saved }
        };
      }

      // Default: add_task — use keyword-based tier inference first; only use args.tier if keyword inference defaulted to 5
      const keywordInferred = inferPriorityTierFromText(title);
      const useExplicitTier = keywordInferred.tier === 5 && args?.tier >= 1 && args?.tier <= 5;
      const inferred = useExplicitTier ? inferPriorityTierFromText(`[Tier ${args.tier}] ${title}`) : keywordInferred;
      const created = createTask({
        title: inferred.cleanTitle,
        priority_id: inferred.priorityId,
        energy_level: 'medium',
        date: today()
      });

      return {
        ok: true,
        tool: 'board_action',
        actionType: 'task_created',
        summary: `✅ Added task **[#${created.id}] ${created.title}** to **Tier ${created.tier}: ${created.priority_name} ${created.priority_emoji}**.`,
        data: { task: created }
      };
    }
  }
];

/**
 * Look up a tool definition by name.
 */
export function getToolByName(name) {
  return COMPANION_TOOLS.find(t => t.name === name) || null;
}

/**
 * Execute a named tool safely and measure execution latency.
 */
export async function executeCompanionTool(name, args = {}, options = {}) {
  const start = Date.now();
  const tool = getToolByName(name);
  if (!tool) {
    return {
      ok: false,
      tool: name,
      summary: `Unknown tool "${name}". Available tools: ${COMPANION_TOOLS.map(t => t.name).join(', ')}`,
      latencyMs: Date.now() - start
    };
  }

  try {
    const result = await tool.execute(args || {}, options);
    return {
      ...result,
      latencyMs: Date.now() - start
    };
  } catch (err) {
    return {
      ok: false,
      tool: name,
      summary: `Tool "${name}" threw an unexpected error: ${err.message}`,
      latencyMs: Date.now() - start
    };
  }
}
