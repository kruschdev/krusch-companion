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
 * Resolve the user's default starting location from env or Working Memory.
 */
export function resolveDefaultOrigin(explicitOrigin) {
  if (explicitOrigin && String(explicitOrigin).trim()) {
    return String(explicitOrigin).trim();
  }
  if (process.env.HOME_LOCATION && process.env.HOME_LOCATION.trim()) {
    return process.env.HOME_LOCATION.trim();
  }
  try {
    const memories = getActiveMemories();
    const locMem = memories.find(m => /\b(?:home address|home location|live in|lives in|based in)\b/i.test(m.content));
    if (locMem) {
      const m = locMem.content.match(/(?:home address|home location|live in|lives in|based in)\s*(?:is|:)?\s*([^.;\n]+)/i);
      if (m?.[1]) return m[1].trim();
    }
  } catch {
    // Non-fatal
  }
  return 'Downtown Seattle, WA';
}

/**
 * Parse an ISO timestamp or natural time string (e.g. "7:30 PM", "19:00") into a Date.
 */
export function parseArrivalDateTime(rawTime) {
  if (!rawTime) {
    return new Date(Date.now() + 90 * 60 * 1000);
  }
  const str = String(rawTime).trim();
  const direct = new Date(str);
  if (!isNaN(direct.getTime())) {
    return direct;
  }
  const timeMatch = str.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2] || '0', 10);
    const meridiem = (timeMatch[3] || '').toLowerCase();
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
    const target = new Date();
    target.setHours(hours, minutes, 0, 0);
    if (target.getTime() < Date.now() - 15 * 60 * 1000) {
      target.setDate(target.getDate() + 1);
    }
    return target;
  }
  return new Date(Date.now() + 90 * 60 * 1000);
}

/**
 * Calculate driving distance, live/estimated traffic delay, and "Time-to-Leave" departure alert.
 * Uses Google Maps Directions API (duration_in_traffic) when GOOGLE_MAPS_API_KEY is set,
 * and falls back to OpenStreetMap Nominatim + OSRM Driving Route + commute traffic curves.
 */
export async function calculateCommuteAndDeparture({
  origin = null,
  destination,
  arrivalTime = null,
  bufferMinutes = 10,
  fetchImpl = fetch
} = {}) {
  const resolvedOrigin = resolveDefaultOrigin(origin);
  const cleanDest = String(destination || '').trim();
  const arrivalDate = parseArrivalDateTime(arrivalTime);
  const safeBuffer = Math.min(Math.max(0, parseInt(bufferMinutes, 10) || 10), 60);

  let distanceMiles = 8.5;
  let distanceText = '8.5 mi';
  let baseMinutes = 18;
  let trafficMinutes = 24;
  let source = 'osrm_traffic_model';

  const googleApiKey = process.env.GOOGLE_MAPS_API_KEY || '';

  // Tier 1: Google Maps Directions API with live traffic (if GOOGLE_MAPS_API_KEY is configured)
  if (googleApiKey) {
    try {
      const gUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(resolvedOrigin)}&destination=${encodeURIComponent(cleanDest)}&departure_time=now&traffic_model=best_guess&key=${encodeURIComponent(googleApiKey)}`;
      const gRes = await fetchImpl(gUrl, { signal: AbortSignal.timeout(6000) });
      if (gRes.ok) {
        const gData = await gRes.json();
        const leg = gData?.routes?.[0]?.legs?.[0];
        if (leg) {
          distanceText = leg.distance?.text || distanceText;
          distanceMiles = Number(((leg.distance?.value || 13600) / 1609.34).toFixed(1));
          baseMinutes = Math.max(1, Math.round((leg.duration?.value || 1080) / 60));
          const trafficSec = leg.duration_in_traffic?.value || leg.duration?.value || 1080;
          trafficMinutes = Math.max(baseMinutes, Math.round(trafficSec / 60));
          source = 'google_maps_live_traffic';
        }
      }
    } catch {
      // Fall through to OSRM / OpenStreetMap routing
    }
  }

  // Tier 2: Zero-key OpenStreetMap Nominatim + OSRM Driving Route + Rush-Hour Traffic Curve
  if (source !== 'google_maps_live_traffic') {
    try {
      const geocodeOne = async (q) => {
        const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
        const r = await fetchImpl(u, {
          headers: { 'User-Agent': 'KruschCompanion/2.0 (https://krusch.dev)' },
          signal: AbortSignal.timeout(5000)
        });
        if (!r.ok) return null;
        const arr = await r.json();
        if (Array.isArray(arr) && arr[0]?.lat && arr[0]?.lon) {
          return { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon) };
        }
        return null;
      };

      const [origCoords, destCoords] = await Promise.all([
        geocodeOne(resolvedOrigin),
        geocodeOne(cleanDest)
      ]);

      if (origCoords && destCoords) {
        const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${origCoords.lon},${origCoords.lat};${destCoords.lon},${destCoords.lat}?overview=false`;
        const osrmRes = await fetchImpl(osrmUrl, { signal: AbortSignal.timeout(5000) });
        if (osrmRes.ok) {
          const osrmData = await osrmRes.json();
          const route = osrmData?.routes?.[0];
          if (route) {
            distanceMiles = Number(((route.distance || 13600) / 1609.34).toFixed(1));
            distanceText = `${distanceMiles} mi`;
            baseMinutes = Math.max(2, Math.round((route.duration || 1080) / 60));
          }
        }
      }
    } catch {
      // Keep baseline estimate if offline
    }

    // Apply time-of-day rush-hour traffic multiplier around departure window
    const approxDepartHour = new Date(arrivalDate.getTime() - baseMinutes * 60000).getHours();
    const isPeakCommute = (approxDepartHour >= 7 && approxDepartHour <= 9) || (approxDepartHour >= 16 && approxDepartHour <= 19);
    const isShoulder = (approxDepartHour >= 11 && approxDepartHour <= 13) || (approxDepartHour === 15) || (approxDepartHour === 20);
    const multiplier = isPeakCommute ? 1.35 : isShoulder ? 1.18 : 1.05;
    trafficMinutes = Math.max(baseMinutes + (isPeakCommute ? 5 : 1), Math.round(baseMinutes * multiplier));
  }

  const trafficDelayMinutes = Math.max(0, trafficMinutes - baseMinutes);
  const trafficLevel = trafficDelayMinutes >= 10 || trafficMinutes / Math.max(1, baseMinutes) >= 1.3
    ? 'Heavy'
    : trafficDelayMinutes >= 4
      ? 'Moderate'
      : 'Light';

  const totalLeadMinutes = trafficMinutes + safeBuffer;
  const leaveByDate = new Date(arrivalDate.getTime() - totalLeadMinutes * 60 * 1000);
  const minutesUntilLeave = Math.round((leaveByDate.getTime() - Date.now()) / 60000);

  const fmtTime = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const leaveByFormatted = fmtTime(leaveByDate);
  const arrivalFormatted = fmtTime(arrivalDate);
  const shouldLeaveEarly = trafficDelayMinutes >= 4;

  const earlyWarningText = shouldLeaveEarly
    ? `⚠️ **Traffic Alert (${trafficLevel} Traffic — +${trafficDelayMinutes} min delay)**: Drive is **${trafficMinutes} min** in traffic (normally ${baseMinutes} min over ${distanceText}). **Leave ${trafficDelayMinutes} min earlier by \`${leaveByFormatted}\`** (includes ${safeBuffer}m parking/arrival buffer) to arrive on time for \`${arrivalFormatted}\`.`
    : `🚗 **Time-to-Leave (\`${leaveByFormatted}\`)**: Route is clear (**${trafficMinutes} min** drive over ${distanceText}, ${trafficLevel.toLowerCase()} traffic). Leave by **\`${leaveByFormatted}\`** (includes ${safeBuffer}m arrival buffer) for your \`${arrivalFormatted}\` arrival.`;

  const googleMapsDirectionsUrl = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(resolvedOrigin)}&destination=${encodeURIComponent(cleanDest)}&travelmode=driving`;

  return {
    origin: resolvedOrigin,
    destination: cleanDest,
    distanceMiles,
    distanceText,
    baseMinutes,
    trafficMinutes,
    trafficDelayMinutes,
    trafficLevel,
    bufferMinutes: safeBuffer,
    totalLeadMinutes,
    arrivalIso: arrivalDate.toISOString(),
    leaveByIso: leaveByDate.toISOString(),
    leaveByFormatted,
    arrivalFormatted,
    minutesUntilLeave,
    shouldLeaveEarly,
    earlyWarningText,
    googleMapsDirectionsUrl,
    source
  };
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
  },
  {
    name: 'gkrusch_drive',
    category: 'google_drive',
    description: 'Interact with G-Krusch Google Drive & Google Docs Extension: search indexed Drive docs via hybrid RAG, read a Google Doc/file as Markdown, write/export a document to Drive, list the workspace, or fetch agent.md steering.',
    parameters: {
      action: 'string (REQUIRED: "search" | "read" | "write" | "list" | "steering")',
      query: 'string (Search query when action="search")',
      path: 'string (Workspace file path e.g. "output/report.md" or "context/spec.md" for read/write)',
      content: 'string (Markdown content to write when action="write")'
    },
    required: ['action'],
    async execute(args, { fetchImpl = fetch } = {}) {
      const action = String(args?.action || 'search').toLowerCase().trim();
      const baseUrl = (process.env.G_KRUSCH_URL || 'http://127.0.0.1:5446').replace(/\/+$/, '');

      try {
        if (action === 'search') {
          const query = String(args?.query || args?.path || '').trim();
          if (!query) {
            return { ok: false, tool: 'gkrusch_drive', summary: 'Parameter "query" is required for gkrusch_drive search.' };
          }
          const res = await fetchImpl(`${baseUrl}/api/rag/search?q=${encodeURIComponent(query)}&limit=5`, {
            signal: AbortSignal.timeout(8000)
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
          const hits = data?.results || [];
          if (hits.length === 0) {
            return {
              ok: true,
              tool: 'gkrusch_drive',
              actionType: 'google_drive',
              summary: `☁️ **G-Krusch Drive RAG Search ("${query}")**: No matching documents found in your indexed Google Drive workspace.`,
              data: { query, results: [] }
            };
          }
          const formatted = hits.slice(0, 4).map((h, i) => `${i + 1}. **${h.fileName || h.name || 'Drive Doc'}** *(score ${(h.score || 0).toFixed(2)})*: ${(h.content || h.text || '').slice(0, 240)}`).join('\n');
          return {
            ok: true,
            tool: 'gkrusch_drive',
            actionType: 'google_drive',
            summary: `☁️ **G-Krusch Drive RAG Results for "${query}"**:\n${formatted}`,
            data
          };
        }

        if (action === 'read') {
          const targetPath = String(args?.path || args?.query || '').trim();
          if (!targetPath) {
            return { ok: false, tool: 'gkrusch_drive', summary: 'Parameter "path" is required for gkrusch_drive read.' };
          }
          const res = await fetchImpl(`${baseUrl}/api/drive/read?path=${encodeURIComponent(targetPath)}`, {
            signal: AbortSignal.timeout(8000)
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
          return {
            ok: true,
            tool: 'gkrusch_drive',
            actionType: 'google_drive',
            summary: `📄 **G-Krusch Google Drive File \`${data.name || targetPath}\`**:\n\n${String(data.content || '').slice(0, 1500)}`,
            data
          };
        }

        if (action === 'write') {
          const rawPath = String(args?.path || 'output/companion-note.md').trim();
          const targetPath = rawPath.includes('/') ? rawPath : `output/${toSafeNoteFilename(rawPath)}`;
          const content = String(args?.content || '').trim();
          if (!content) {
            return { ok: false, tool: 'gkrusch_drive', summary: 'Parameter "content" is required for gkrusch_drive write.' };
          }

          // Always save a sovereign local mirror in data/notes/ as well
          const localFilename = toSafeNoteFilename(path.basename(targetPath));
          fs.writeFileSync(path.join(getNotesDirectory(), localFilename), content, 'utf-8');

          const res = await fetchImpl(`${baseUrl}/api/drive/write`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: targetPath, content, mimeType: 'text/markdown' }),
            signal: AbortSignal.timeout(10000)
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
          return {
            ok: true,
            tool: 'gkrusch_drive',
            actionType: 'google_drive',
            summary: `☁️ Saved document to **Google Drive (\`G-Krusch/${targetPath}\`)** and mirrored locally to \`data/notes/${localFilename}\`.`,
            data
          };
        }

        if (action === 'steering') {
          const res = await fetchImpl(`${baseUrl}/api/steering`, { signal: AbortSignal.timeout(8000) });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
          return {
            ok: true,
            tool: 'gkrusch_drive',
            actionType: 'google_drive',
            summary: `🧭 **G-Krusch Cloud Steering (\`agent.md\`)**:\n\n${String(data.content || data.raw || JSON.stringify(data)).slice(0, 1200)}`,
            data
          };
        }

        // Default: list workspace tree
        const res = await fetchImpl(`${baseUrl}/api/workspace/tree`, { signal: AbortSignal.timeout(8000) });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        return {
          ok: true,
          tool: 'gkrusch_drive',
          actionType: 'google_drive',
          summary: `☁️ **G-Krusch Google Drive Workspace**:\n\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 1000)}\n\`\`\``,
          data
        };
      } catch (err) {
        // If writing a file while Google Drive OAuth is disconnected, confirm the local vault mirror succeeded
        if (action === 'write' && args?.content) {
          const localFilename = toSafeNoteFilename(path.basename(String(args?.path || 'companion-note')));
          return {
            ok: true,
            tool: 'gkrusch_drive',
            actionType: 'google_drive',
            summary: `📝 Saved locally to \`data/notes/${localFilename}\` (G-Krusch Google Drive sync pending OAuth connection at \`${baseUrl}/auth/google\`: ${err.message}).`,
            data: { localFilename, driveError: err.message }
          };
        }
        return {
          ok: false,
          tool: 'gkrusch_drive',
          actionType: 'google_drive',
          summary: `☁️ G-Krusch Google Drive (${baseUrl}) returned: ${err.message}. Connect Google OAuth at \`${baseUrl}/auth/google\`.`
        };
      }
    }
  },
  {
    name: 'gkrusch_calendar',
    category: 'google_calendar',
    description: 'Interact with G-Krusch Google Calendar Extension: list upcoming calendar events or schedule/create a new calendar appointment (automatically calculates travel time, live traffic delay, and Leave-By departure alert when a location is present).',
    parameters: {
      action: 'string (REQUIRED: "list_events" | "create_event")',
      summary: 'string (Event title when action="create_event", or search filter when action="list_events")',
      startTime: 'string (ISO-8601 start timestamp when action="create_event", e.g. "2026-10-14T14:00:00")',
      endTime: 'string (OPTIONAL: ISO-8601 end timestamp when action="create_event")',
      location: 'string (OPTIONAL: Event address or venue location — triggers automatic traffic & Leave-By time calculation)',
      description: 'string (OPTIONAL: Event notes or agenda)'
    },
    required: ['action'],
    async execute(args, { fetchImpl = fetch } = {}) {
      const action = String(args?.action || 'list_events').toLowerCase().trim();
      const baseUrl = (process.env.G_KRUSCH_URL || 'http://127.0.0.1:5446').replace(/\/+$/, '');
      const eventLocation = String(args?.location || '').trim();

      let commuteInfo = null;
      if (eventLocation && (action.includes('create') || action.includes('schedule'))) {
        try {
          commuteInfo = await calculateCommuteAndDeparture({
            destination: eventLocation,
            arrivalTime: args?.startTime || null,
            fetchImpl
          });
        } catch {
          // Non-fatal
        }
      }

      try {
        if (action === 'create_event' || action === 'create' || action === 'schedule') {
          const summary = String(args?.summary || args?.title || 'Scheduled Event').trim();
          const startTime = args?.startTime || new Date(Date.now() + 3600 * 1000).toISOString();
          const res = await fetchImpl(`${baseUrl}/api/calendar/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              summary,
              startTime,
              endTime: args?.endTime || null,
              location: eventLocation,
              description: [
                args?.description || '',
                commuteInfo ? `Leave by ${commuteInfo.leaveByFormatted} (${commuteInfo.trafficMinutes}m drive in ${commuteInfo.trafficLevel} traffic)` : ''
              ].filter(Boolean).join('\n')
            }),
            signal: AbortSignal.timeout(8000)
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
          const ev = data.event || {};
          const commuteLines = commuteInfo
            ? `\n- ${commuteInfo.earlyWarningText}\n- 🗺️ [Google Maps Turn-by-Turn Directions](${commuteInfo.googleMapsDirectionsUrl})`
            : '';
          return {
            ok: true,
            tool: 'gkrusch_calendar',
            actionType: 'google_calendar',
            summary: `📅 **Scheduled on Google Calendar**: **${ev.summary || summary}** (${ev.start || startTime})${eventLocation ? ` @ *${eventLocation}*` : ''}${ev.htmlLink ? `\n🔗 [Open in Google Calendar](${ev.htmlLink})` : ''}${commuteLines}`,
            data: { ...ev, commute: commuteInfo }
          };
        }

        // Default: list_events
        const q = String(args?.summary || args?.query || '').trim();
        const url = `${baseUrl}/api/calendar/events?limit=8${q ? `&q=${encodeURIComponent(q)}` : ''}`;
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        const events = data.events || [];
        if (events.length === 0) {
          return {
            ok: true,
            tool: 'gkrusch_calendar',
            actionType: 'google_calendar',
            summary: '📅 **Google Calendar**: No upcoming events found for that window.',
            data: { events: [] }
          };
        }

        const lines = [];
        for (const e of events) {
          let line = `- **${e.summary}** — \`${e.start}\`${e.location ? ` (${e.location})` : ''}`;
          if (e.location) {
            try {
              const c = await calculateCommuteAndDeparture({
                destination: e.location,
                arrivalTime: e.start,
                fetchImpl
              });
              line += `\n  🚗 **Leave by \`${c.leaveByFormatted}\`** — ${c.trafficMinutes} min drive (${c.trafficLevel} traffic${c.trafficDelayMinutes > 0 ? `, +${c.trafficDelayMinutes}m traffic delay — leave early!` : ''})`;
              e.commute = c;
            } catch {
              // Non-fatal
            }
          }
          lines.push(line);
        }

        return {
          ok: true,
          tool: 'gkrusch_calendar',
          actionType: 'google_calendar',
          summary: `📅 **Upcoming Google Calendar Events (${events.length})**:\n${lines.join('\n')}`,
          data: { events }
        };
      } catch (err) {
        // Graceful fallback: if creating an event while Google Calendar OAuth is disconnected, add to Today's Priority Board
        if (action.includes('create') || action.includes('schedule')) {
          const summary = String(args?.summary || args?.title || 'Scheduled Event').trim();
          const inferred = inferPriorityTierFromText(summary);
          const created = createTask({
            title: `${inferred.cleanTitle}${args?.startTime ? ` (@ ${args.startTime})` : ''}${eventLocation ? ` [${eventLocation}]` : ''}`,
            priority_id: inferred.priorityId,
            notes: commuteInfo
              ? `Leave by ${commuteInfo.leaveByFormatted} (${commuteInfo.trafficMinutes}m in ${commuteInfo.trafficLevel} traffic) | Scheduled via G-Krusch Calendar fallback`
              : 'Scheduled via G-Krusch Calendar fallback',
            energy_level: 'medium',
            date: today()
          });
          const commuteLines = commuteInfo
            ? `\n- ${commuteInfo.earlyWarningText}\n- 🗺️ [Google Maps Turn-by-Turn Directions](${commuteInfo.googleMapsDirectionsUrl})`
            : '';
          return {
            ok: true,
            tool: 'gkrusch_calendar',
            actionType: 'google_calendar',
            summary: `📅 Added **[#${created.id}] ${created.title}** to **Today's Priority Board** (Google Calendar OAuth not yet connected at \`${baseUrl}/auth/google\`).${commuteLines}`,
            data: { fallbackTask: created, commute: commuteInfo, calendarError: err.message }
          };
        }
        return {
          ok: false,
          tool: 'gkrusch_calendar',
          actionType: 'google_calendar',
          summary: `📅 G-Krusch Google Calendar (${baseUrl}) returned: ${err.message}. Connect Google OAuth at \`${baseUrl}/auth/google\`.`
        };
      }
    }
  },
  {
    name: 'gkrusch_gmail',
    category: 'google_gmail',
    description: 'Interact with G-Krusch Gmail Extension: search recent emails in your inbox, create a Gmail draft, or send an email.',
    parameters: {
      action: 'string (REQUIRED: "search_emails" | "create_draft" | "send_email")',
      query: 'string (Gmail search query when action="search_emails", e.g. "from:alex invoice" or "is:unread")',
      to: 'string (Recipient email address when action="create_draft" or "send_email")',
      subject: 'string (Email subject line when composing)',
      body: 'string (Email body text when composing)'
    },
    required: ['action'],
    async execute(args, { fetchImpl = fetch } = {}) {
      const action = String(args?.action || 'search_emails').toLowerCase().trim();
      const baseUrl = (process.env.G_KRUSCH_URL || 'http://127.0.0.1:5446').replace(/\/+$/, '');

      try {
        if (action === 'create_draft' || action === 'send_email' || action === 'draft' || action === 'send') {
          const to = String(args?.to || 'recipient@example.com').trim();
          const subject = String(args?.subject || 'Note from Krusch Companion').trim();
          const body = String(args?.body || '').trim();
          const sendImmediately = action === 'send_email' || action === 'send';

          const res = await fetchImpl(`${baseUrl}/api/gmail/drafts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to, subject, body, sendImmediately }),
            signal: AbortSignal.timeout(8000)
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
          return {
            ok: true,
            tool: 'gkrusch_gmail',
            actionType: 'google_gmail',
            summary: `✉️ **Gmail ${sendImmediately ? 'Sent' : 'Draft Created'}**:\n- **To**: \`${to}\`\n- **Subject**: **${subject}**\n\n> ${body.slice(0, 400)}`,
            data
          };
        }

        // Default: search_emails
        const query = String(args?.query || 'is:inbox').trim();
        const res = await fetchImpl(`${baseUrl}/api/gmail/messages?q=${encodeURIComponent(query)}&limit=5`, {
          signal: AbortSignal.timeout(8000)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        const messages = data.messages || [];
        if (messages.length === 0) {
          return {
            ok: true,
            tool: 'gkrusch_gmail',
            actionType: 'google_gmail',
            summary: `✉️ **Gmail Search ("${query}")**: No matching emails found.`,
            data: { messages: [] }
          };
        }
        const lines = messages.map(m => `- **${m.subject || '(No Subject)'}** from \`${m.from}\` *(${m.date})*\n  > ${m.snippet}`);
        return {
          ok: true,
          tool: 'gkrusch_gmail',
          actionType: 'google_gmail',
          summary: `✉️ **Gmail Messages for "${query}" (${messages.length})**:\n${lines.join('\n')}`,
          data: { messages }
        };
      } catch (err) {
        // Graceful fallback: save drafted email into local Sovereign Notes Vault if Gmail OAuth is not connected yet
        if (action.includes('draft') || action.includes('send')) {
          const to = String(args?.to || 'recipient@example.com').trim();
          const subject = String(args?.subject || 'Email Draft').trim();
          const body = String(args?.body || '').trim();
          const filename = toSafeNoteFilename(`email-draft-${subject}`);
          const draftMd = `# Email Draft: ${subject}\n- **To**: ${to}\n- **Status**: Saved locally (connect G-Krusch OAuth at ${baseUrl}/auth/google to sync with Gmail)\n\n---\n\n${body}\n`;
          fs.writeFileSync(path.join(getNotesDirectory(), filename), draftMd, 'utf-8');
          return {
            ok: true,
            tool: 'gkrusch_gmail',
            actionType: 'google_gmail',
            summary: `✉️ Saved email draft **${subject}** (To: \`${to}\`) to local vault \`data/notes/${filename}\` (connect G-Krusch OAuth at \`${baseUrl}/auth/google\` for live Gmail sync):\n\n> ${body.slice(0, 400)}`,
            data: { localDraft: filename, gmailError: err.message }
          };
        }
        return {
          ok: false,
          tool: 'gkrusch_gmail',
          actionType: 'google_gmail',
          summary: `✉️ G-Krusch Gmail (${baseUrl}) returned: ${err.message}. Connect Google OAuth at \`${baseUrl}/auth/google\`.`
        };
      }
    }
  },
  {
    name: 'concierge_reservation',
    category: 'concierge',
    description: 'Make a restaurant, appointment, or venue reservation: looks up live venue details (address, phone, website, hours via OpenStreetMap), generates pre-filled OpenTable/Resy/Google Reserve booking links, drafts/sends a concierge reservation email via G-Krusch Gmail, calculates live traffic & Time-to-Leave alert, and places a hold on Google Calendar / Priority Board.',
    parameters: {
      venue: 'string (REQUIRED: Restaurant, venue, or business name and city, e.g. "Canlis Seattle" or "Sushi Kashiba in Seattle")',
      dateTime: 'string (OPTIONAL: Requested ISO-8601 date/time or natural time, e.g. "2026-10-16T19:00:00" or "Friday at 7pm")',
      partySize: 'number (OPTIONAL: Number of people, default 2)',
      email: 'string (OPTIONAL: Venue or concierge email address if known)',
      notes: 'string (OPTIONAL: Special requests, patio seating, anniversary, or dietary notes)'
    },
    required: ['venue'],
    async execute(args, { fetchImpl = fetch, notesDir } = {}) {
      const baseVenue = String(args?.venue || args?.venue_name || '').trim();
      const venueLocation = String(args?.location || '').trim();
      const venue = venueLocation && !baseVenue.toLowerCase().includes(venueLocation.toLowerCase())
        ? `${baseVenue}, ${venueLocation}`
        : baseVenue;
      if (!venue) {
        return { ok: false, tool: 'concierge_reservation', summary: 'Parameter "venue" is required for concierge_reservation.' };
      }

      const partySize = Math.min(Math.max(1, parseInt(args?.partySize || args?.party_size || '2', 10) || 2), 20);
      const rawDatePart = String(args?.date || '').trim();
      const rawTimePart = String(args?.time || '').trim();
      const combinedDateTime = rawDatePart && rawTimePart ? `${rawDatePart}T${rawTimePart}` : (rawDatePart || rawTimePart);
      const rawDateTime = String(args?.dateTime || args?.date_time || combinedDateTime || 'Tonight at 7:00 PM').trim();
      const specialNotes = String(args?.notes || args?.special_requests || '').trim();
      const parsedDate = parseArrivalDateTime(rawDateTime);
      const isoDateTime = parsedDate.toISOString();
      const isoDateOnly = isoDateTime.slice(0, 10);

      // 1. Live Venue Lookup via OpenStreetMap Nominatim (zero API key required)
      let placeInfo = {
        displayName: venue,
        phone: null,
        website: null,
        email: args?.email || null,
        openingHours: null
      };

      try {
        const osmUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&extratags=1&limit=1&q=${encodeURIComponent(venue)}`;
        const osmRes = await fetchImpl(osmUrl, {
          headers: { 'User-Agent': 'KruschCompanion/2.0 (https://krusch.dev)' },
          signal: AbortSignal.timeout(6000)
        });
        if (osmRes.ok) {
          const places = await osmRes.json();
          if (Array.isArray(places) && places.length > 0) {
            const p = places[0];
            const extra = p.extratags || {};
            placeInfo = {
              displayName: p.display_name || venue,
              phone: extra.phone || extra['contact:phone'] || null,
              website: extra.website || extra['contact:website'] || null,
              email: args?.email || extra.email || extra['contact:email'] || null,
              openingHours: extra.opening_hours || null
            };
          }
        }
      } catch {
        // Non-fatal if OSM lookup times out
      }

      // 2. Build Pre-Filled Deep Booking Links (OpenTable, Resy, Google Maps)
      const openTableUrl = `https://www.opentable.com/s?covers=${partySize}&dateTime=${encodeURIComponent(isoDateTime.slice(0, 19))}&term=${encodeURIComponent(venue)}`;
      const resyUrl = `https://resy.com/cities/search?query=${encodeURIComponent(venue)}&date=${isoDateOnly}&seats=${partySize}`;
      const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venue)}`;

      // 3. Calculate Driving Time, Traffic Delay & Recommended Leave-By Alert
      const commute = await calculateCommuteAndDeparture({
        destination: placeInfo.displayName || venue,
        arrivalTime: isoDateTime,
        bufferMinutes: 10,
        fetchImpl
      });

      // 4. Compose Concierge Reservation Email & Dispatch via G-Krusch Gmail (or save local draft)
      const targetEmail = placeInfo.email || 'reservations@venue.example.com';
      const emailSubject = `Reservation Request: ${venue} — Party of ${partySize} (${rawDateTime})`;
      const emailBody = [
        `Hello ${venue} Team,`,
        '',
        `I would like to request a reservation with the following details:`,
        `- Venue: ${venue}`,
        `- Party Size: ${partySize} guests`,
        `- Requested Date & Time: ${rawDateTime}`,
        ...(specialNotes ? [`- Special Requests / Notes: ${specialNotes}`] : []),
        '',
        `Please let me know if this time is available or if a nearby time slot works best.`,
        '',
        `Thank you!`
      ].join('\n');

      const baseUrl = (process.env.G_KRUSCH_URL || 'http://127.0.0.1:5446').replace(/\/+$/, '');
      let emailStatusLine = '';
      try {
        const gmailRes = await fetchImpl(`${baseUrl}/api/gmail/drafts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: targetEmail,
            subject: emailSubject,
            body: emailBody,
            sendImmediately: Boolean(args?.email)
          }),
          signal: AbortSignal.timeout(6000)
        });
        if (gmailRes.ok) {
          emailStatusLine = args?.email
            ? `✉️ **Concierge Email Sent via Gmail** to \`${targetEmail}\``
            : `✉️ **Gmail Reservation Draft Created** (To: \`${targetEmail}\`)`;
        } else {
          throw new Error(`HTTP ${gmailRes.status}`);
        }
      } catch {
        const filename = toSafeNoteFilename(`reservation-${venue}`);
        const md = `# Reservation Dossier: ${venue}\n- **Party Size**: ${partySize}\n- **Requested Time**: ${rawDateTime}\n- **Leave By**: ${commute.leaveByFormatted} (${commute.trafficMinutes}m drive in ${commute.trafficLevel} traffic)\n- **Address**: ${placeInfo.displayName}\n- **Phone**: ${placeInfo.phone || 'N/A'}\n- **Website**: ${placeInfo.website || 'N/A'}\n- **OpenTable**: ${openTableUrl}\n- **Resy**: ${resyUrl}\n\n## Concierge Email Draft (To: ${targetEmail})\n**Subject**: ${emailSubject}\n\n${emailBody}\n`;
        const targetDir = notesDir || getNotesDirectory();
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(path.join(targetDir, filename), md, 'utf-8');
        emailStatusLine = `📝 **Saved Reservation Dossier & Email Draft** to \`data/notes/${filename}\``;
      }

      // 5. Add Reservation Hold onto Google Calendar (if G-Krusch OAuth is linked) & Today's Priority Board
      let calendarHoldLine = '';
      let calendarEvent = null;
      try {
        const calRes = await fetchImpl(`${baseUrl}/api/calendar/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            summary: `[Reservation] ${venue} (Party of ${partySize})`,
            startTime: isoDateTime,
            location: placeInfo.displayName,
            description: `Leave by ${commute.leaveByFormatted} (${commute.trafficMinutes}m drive in ${commute.trafficLevel} traffic)\nParty of ${partySize}${specialNotes ? ` | Notes: ${specialNotes}` : ''}\nPhone: ${placeInfo.phone || 'N/A'}\nOpenTable: ${openTableUrl}\nResy: ${resyUrl}`
          }),
          signal: AbortSignal.timeout(5000)
        });
        if (calRes.ok) {
          const calData = await calRes.json();
          calendarEvent = calData.event || null;
          calendarHoldLine = `📅 **Google Calendar Hold Created**: **${calendarEvent?.summary || venue}** (${calendarEvent?.start || isoDateTime})`;
        }
      } catch {
        // Non-fatal if Google Calendar OAuth is not currently linked
      }

      const holdTask = createTask({
        title: `Reservation Hold: ${venue} (Party of ${partySize} @ ${rawDateTime} — Leave by ${commute.leaveByFormatted})`,
        priority_id: 2,
        notes: `Leave by ${commute.leaveByFormatted} (${commute.trafficMinutes}m in ${commute.trafficLevel} traffic) | OpenTable: ${openTableUrl} | Phone: ${placeInfo.phone || 'N/A'}`,
        energy_level: 'low',
        date: today()
      });

      const summaryLines = [
        `🍽️ **Concierge Reservation Prepared for ${venue}** *(Party of ${partySize} • ${rawDateTime})*:`,
        `- **Location**: ${placeInfo.displayName}`,
        ...(placeInfo.phone ? [`- **Phone**: \`${placeInfo.phone}\``] : []),
        ...(placeInfo.website ? [`- **Website**: ${placeInfo.website}`] : []),
        ...(placeInfo.openingHours ? [`- **Hours**: \`${placeInfo.openingHours}\``] : []),
        `- ${commute.earlyWarningText}`,
        `- **Instant 1-Click Booking & Navigation Links**:`,
        `  • [Book on OpenTable (Party of ${partySize})](${openTableUrl})`,
        `  • [Book on Resy (Party of ${partySize})](${resyUrl})`,
        `  • [Turn-by-Turn Google Maps Directions (${commute.distanceText})](${commute.googleMapsDirectionsUrl})`,
        `- ${emailStatusLine}`,
        ...(calendarHoldLine ? [`- ${calendarHoldLine}`] : []),
        `- 📋 **Board Hold Added**: **[#${holdTask.id}] ${holdTask.title}**`
      ];

      return {
        ok: true,
        tool: 'concierge_reservation',
        actionType: 'concierge_reservation',
        summary: summaryLines.join('\n'),
        data: {
          venue,
          partySize,
          dateTime: rawDateTime,
          placeInfo,
          commute,
          links: { openTableUrl, resyUrl, googleMapsUrl, directionsUrl: commute.googleMapsDirectionsUrl },
          calendarEvent,
          holdTaskId: holdTask.id
        }
      };
    }
  },
  {
    name: 'commute_departure_check',
    category: 'commute',
    description: 'Calculate driving distance, live/estimated traffic conditions, and exact "Time-to-Leave" departure notification for any calendar event, appointment, or destination.',
    parameters: {
      destination: 'string (REQUIRED: Event location, venue name, or street address, e.g. "Sea-Tac Airport" or "Canlis, Seattle")',
      origin: 'string (OPTIONAL: Starting location; defaults to HOME_LOCATION or saved home address)',
      arrivalTime: 'string (OPTIONAL: Target arrival time in ISO-8601 or natural format like "7:00 PM")',
      bufferMinutes: 'number (OPTIONAL: Extra parking/walking buffer in minutes, default 10)'
    },
    required: ['destination'],
    async execute(args, { fetchImpl = fetch } = {}) {
      const destination = String(args?.destination || args?.location || '').trim();
      if (!destination) {
        return { ok: false, tool: 'commute_departure_check', summary: 'Parameter "destination" is required for commute_departure_check.' };
      }

      const commute = await calculateCommuteAndDeparture({
        origin: args?.origin || null,
        destination,
        arrivalTime: args?.arrivalTime || args?.startTime || args?.event_time || null,
        bufferMinutes: args?.bufferMinutes ?? 10,
        fetchImpl
      });

      // If traffic is Moderate/Heavy, also dispatch a departure push notification if NTFY_TOPIC / WEBHOOK_URL is set
      const ntfyTopic = process.env.NTFY_TOPIC || '';
      let notifiedPush = false;
      if (commute.shouldLeaveEarly && ntfyTopic) {
        try {
          await fetchImpl(`https://ntfy.sh/${encodeURIComponent(ntfyTopic)}`, {
            method: 'POST',
            headers: {
              Title: `Leave Early (${commute.leaveByFormatted}): ${destination}`,
              Priority: commute.trafficLevel === 'Heavy' ? '4' : '3'
            },
            body: `${commute.trafficLevel} traffic (+${commute.trafficDelayMinutes}m delay). Drive is ${commute.trafficMinutes}m. Leave by ${commute.leaveByFormatted} to arrive by ${commute.arrivalFormatted}.`,
            signal: AbortSignal.timeout(4000)
          });
          notifiedPush = true;
        } catch {
          // Non-fatal
        }
      }

      const lines = [
        `🚗 **Time-to-Leave & Traffic Departure Advisory**:`,
        `- **Route**: \`${commute.origin}\` → **${commute.destination}** (${commute.distanceText})`,
        `- **Target Arrival**: \`${commute.arrivalFormatted}\` *(includes ${commute.bufferMinutes}m parking/arrival buffer)*`,
        `- **Normal Drive Time**: ${commute.baseMinutes} min`,
        `- **Traffic-Adjusted Drive Time**: **${commute.trafficMinutes} min** *(${commute.trafficLevel} Traffic${commute.trafficDelayMinutes > 0 ? `, +${commute.trafficDelayMinutes} min delay` : ''})*`,
        `- **⏰ Recommended Leave-By Time**: **\`${commute.leaveByFormatted}\`**`,
        `- ${commute.earlyWarningText}`,
        ...(notifiedPush ? [`- 🔔 **Push Notification Sent** via ntfy (\`${ntfyTopic}\`)`] : []),
        `- 🗺️ [Open Turn-by-Turn Google Maps Directions](${commute.googleMapsDirectionsUrl})`
      ];

      return {
        ok: true,
        tool: 'commute_departure_check',
        actionType: 'commute_departure',
        summary: lines.join('\n'),
        data: commute
      };
    }
  }
];

let runtimeDryRunMode = process.env.AGENTIC_DRY_RUN === 'true';

const TOOL_RESULT_CACHE = new Map();
const CACHEABLE_READ_TOOLS = new Set(['get_weather', 'system_status', 'commute_departure_check']);
const CACHE_TTL_MS = 60_000;

const AGENTIC_TOOL_STATS = {
  totalCalls: 0,
  succeeded: 0,
  failed: 0,
  dryRuns: 0,
  cacheHits: 0,
  byTool: {},
  recentEvents: [],
  failedEvents: []
};

export function setAgenticDryRunMode(enabled) {
  runtimeDryRunMode = Boolean(enabled);
  return runtimeDryRunMode;
}

export function getAgenticDryRunMode() {
  return runtimeDryRunMode;
}

export function clearAgenticToolCache() {
  TOOL_RESULT_CACHE.clear();
}

export function getFailedToolCallLogs() {
  return AGENTIC_TOOL_STATS.failedEvents;
}

export function recordLowConfidenceOrFailedParse({ prompt, reason, confidence, rawSnippet }) {
  AGENTIC_TOOL_STATS.failedEvents.unshift({
    timestamp: new Date().toISOString(),
    type: 'low_confidence_or_fallback',
    promptPreview: String(prompt || '').slice(0, 120),
    reason,
    confidence,
    rawSnippet: String(rawSnippet || '').slice(0, 160)
  });
  if (AGENTIC_TOOL_STATS.failedEvents.length > 25) {
    AGENTIC_TOOL_STATS.failedEvents.pop();
  }
}

export function getAgenticToolStats() {
  return {
    dryRunMode: runtimeDryRunMode,
    ...AGENTIC_TOOL_STATS,
    totalDryRuns: AGENTIC_TOOL_STATS.dryRuns,
    totalSuccess: AGENTIC_TOOL_STATS.succeeded,
    totalFailures: AGENTIC_TOOL_STATS.failed,
    totalCacheHits: AGENTIC_TOOL_STATS.cacheHits,
    perTool: AGENTIC_TOOL_STATS.byTool,
    successRate: AGENTIC_TOOL_STATS.totalCalls > 0
      ? Number((((AGENTIC_TOOL_STATS.succeeded + AGENTIC_TOOL_STATS.dryRuns) / AGENTIC_TOOL_STATS.totalCalls) * 100).toFixed(1))
      : 100
  };
}

/**
 * Determine whether a tool call performs an external side-effect mutation
 * (sending email, creating a calendar event, pushing a notification, or writing to Drive).
 */
export function isExternalSideEffectCall(name, args = {}) {
  const action = String(args?.action || '').toLowerCase();
  if (name === 'send_notification') return true;
  if (name === 'concierge_reservation') return true;
  if (name === 'gkrusch_gmail' && (action === 'send' || action === 'send_email' || action === 'draft' || action === 'create_draft')) return true;
  if (name === 'gkrusch_calendar' && (action.includes('create') || action.includes('schedule'))) return true;
  if (name === 'gkrusch_drive' && action === 'write') return true;
  return false;
}

function recordToolStat(name, { ok, dryRun = false, cached = false, latencyMs = 0, error = null, args = null }) {
  AGENTIC_TOOL_STATS.totalCalls++;
  if (cached) AGENTIC_TOOL_STATS.cacheHits++;
  if (dryRun) AGENTIC_TOOL_STATS.dryRuns++;
  else if (ok) AGENTIC_TOOL_STATS.succeeded++;
  else AGENTIC_TOOL_STATS.failed++;

  if (!AGENTIC_TOOL_STATS.byTool[name]) {
    AGENTIC_TOOL_STATS.byTool[name] = {
      calls: 0,
      succeeded: 0,
      success: 0,
      failed: 0,
      failures: 0,
      dryRuns: 0,
      cacheHits: 0,
      totalLatencyMs: 0,
      avgLatencyMs: 0,
      lastLatencyMs: 0
    };
  }
  const entry = AGENTIC_TOOL_STATS.byTool[name];
  entry.calls++;
  if (cached) entry.cacheHits++;
  if (dryRun) {
    entry.dryRuns++;
  } else if (ok) {
    entry.succeeded++;
    entry.success++;
  } else {
    entry.failed++;
    entry.failures++;
  }
  entry.lastLatencyMs = latencyMs;
  entry.totalLatencyMs += latencyMs;
  entry.avgLatencyMs = Math.round(entry.totalLatencyMs / entry.calls);

  const eventRecord = {
    timestamp: new Date().toISOString(),
    tool: name,
    ok: Boolean(ok),
    dryRun: Boolean(dryRun),
    cached: Boolean(cached),
    latencyMs,
    ...(error ? { error } : {})
  };
  AGENTIC_TOOL_STATS.recentEvents.unshift(eventRecord);
  if (AGENTIC_TOOL_STATS.recentEvents.length > 20) {
    AGENTIC_TOOL_STATS.recentEvents.pop();
  }

  if (!ok) {
    AGENTIC_TOOL_STATS.failedEvents.unshift({
      ...eventRecord,
      type: 'tool_execution_error',
      arguments: args
    });
    if (AGENTIC_TOOL_STATS.failedEvents.length > 25) {
      AGENTIC_TOOL_STATS.failedEvents.pop();
    }
  }
}

/**
 * Look up a tool definition by name.
 */
export function getToolByName(name) {
  return COMPANION_TOOLS.find(t => t.name === name) || null;
}

/**
 * Execute a named tool safely, enforcing dry-run confirmation gates on side-effect tools,
 * serving cached results for idempotent read tools, and recording execution telemetry.
 */
export async function executeCompanionTool(name, args = {}, options = {}) {
  const start = Date.now();
  const tool = getToolByName(name);
  if (!tool) {
    const latencyMs = Date.now() - start;
    recordToolStat(name, { ok: false, latencyMs, error: 'Unknown tool', args });
    return {
      ok: false,
      tool: name,
      summary: `Unknown tool "${name}". Available tools: ${COMPANION_TOOLS.map(t => t.name).join(', ')}`,
      latencyMs
    };
  }

  const shouldDryRun =
    args?.dryRun === true ||
    options?.dryRun === true ||
    (runtimeDryRunMode && args?.dryRun !== false && options?.dryRun !== false && isExternalSideEffectCall(name, args));

  if (shouldDryRun && isExternalSideEffectCall(name, args)) {
    const latencyMs = Date.now() - start;
    recordToolStat(name, { ok: true, dryRun: true, latencyMs, args });
    return {
      ok: true,
      dryRun: true,
      requiresConfirmation: true,
      confirmationRequired: true,
      tool: name,
      actionType: tool.category,
      summary: `🛡️ **[Dry-Run / Confirmation Gate]** Previewed side-effect tool \`${name}\` without executing external mutation:\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\`\n*(Click **Confirm & Execute** below or pass \`"dryRun": false\` to execute live.)*`,
      preview: {
        tool: name,
        category: tool.category,
        arguments: args,
        sideEffectProtected: true
      },
      latencyMs
    };
  }

  // Check TTL cache for idempotent read tools when default fetch is used
  const canUseCache =
    CACHEABLE_READ_TOOLS.has(name) &&
    options?.useCache !== false &&
    (!options?.fetchImpl || options.fetchImpl === fetch);
  const cacheKey = canUseCache ? `${name}:${JSON.stringify(args || {})}` : null;
  if (cacheKey && TOOL_RESULT_CACHE.has(cacheKey)) {
    const entry = TOOL_RESULT_CACHE.get(cacheKey);
    if (Date.now() - entry.timestamp < CACHE_TTL_MS) {
      const latencyMs = Date.now() - start;
      recordToolStat(name, { ok: true, cached: true, latencyMs, args });
      return {
        ...entry.value,
        cached: true,
        latencyMs
      };
    }
    TOOL_RESULT_CACHE.delete(cacheKey);
  }

  try {
    const result = await tool.execute(args || {}, options);
    const latencyMs = Date.now() - start;
    const isOk = result?.ok !== false;
    recordToolStat(name, { ok: isOk, latencyMs, error: !isOk ? result?.summary : null, args });
    if (cacheKey && isOk) {
      TOOL_RESULT_CACHE.set(cacheKey, { timestamp: Date.now(), value: result });
    }
    return {
      ...result,
      cached: false,
      latencyMs
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    recordToolStat(name, { ok: false, latencyMs, error: err.message, args });
    return {
      ok: false,
      tool: name,
      summary: `Tool "${name}" threw an unexpected error: ${err.message}`,
      latencyMs
    };
  }
}
