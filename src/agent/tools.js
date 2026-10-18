import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import config from '../config.js';
import {
  createTask,
  addListToTask,
  toggleTaskChecklistItem,
  deleteTask,
  normalizeChecklistItems,
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
    const locMem =
      memories.find(m => m.key === 'home_location') ||
      memories.find(m => /\b(?:home address|home location|live in|lives in|based in)\b/i.test(m.content));
    if (locMem) {
      const m = locMem.content.match(/(?:home address|home location|live in|lives in|based in)\s*(?:is|:)?\s*([^.;(\n]+)/i);
      if (m?.[1]) return m[1].trim();
      const cleaned = locMem.content.replace(/\s*\([^)]*\)\s*/g, '').replace(/\.$/, '').trim();
      if (cleaned) return cleaned;
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

  let turnByTurnSteps = [];

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
          return {
            lat: parseFloat(arr[0].lat),
            lon: parseFloat(arr[0].lon),
            displayName: arr[0].display_name || q
          };
        }
        return null;
      };

      let [origCoords, destCoords] = await Promise.all([
        geocodeOne(resolvedOrigin),
        geocodeOne(cleanDest)
      ]);

      // If origin is a short street address (e.g. "1161 North Citrus") that didn't resolve alone, retry with Drive / destination city
      if (!origCoords && /^\d+\s+[A-Za-z\s]+$/.test(resolvedOrigin)) {
        origCoords =
          (await geocodeOne(`${resolvedOrigin} Drive, La Habra, CA`)) ||
          (await geocodeOne(`${resolvedOrigin}, La Habra, CA`));
      }

      if (origCoords && destCoords) {
        const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${origCoords.lon},${origCoords.lat};${destCoords.lon},${destCoords.lat}?overview=false&steps=true`;
        const osrmRes = await fetchImpl(osrmUrl, { signal: AbortSignal.timeout(5000) });
        if (osrmRes.ok) {
          const osrmData = await osrmRes.json();
          const route = osrmData?.routes?.[0];
          if (route) {
            distanceMiles = Number(((route.distance || 13600) / 1609.34).toFixed(1));
            distanceText = `${distanceMiles} mi`;
            baseMinutes = Math.max(2, Math.round((route.duration || 1080) / 60));
            const rawSteps = route.legs?.[0]?.steps || [];
            turnByTurnSteps = rawSteps
              .filter(s => s && s.name && (s.distance || 0) >= 25 && s.maneuver?.type !== 'arrive')
              .map((s, idx) => {
                const mi = Math.max(0.1, Number(((s.distance || 0) / 1609.34).toFixed(1)));
                const mod = s.maneuver?.modifier ? ` ${s.maneuver.modifier}` : '';
                const action =
                  idx === 0 || s.maneuver?.type === 'depart'
                    ? `Start on **${s.name}**`
                    : `Turn${mod} onto **${s.name}**`;
                return `${idx + 1}. ${action} *(${mi} mi)*`;
              });
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
    turnByTurnSteps,
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
        try {
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
        } catch {
          // Fall through to Wikipedia REST Search + Summary API
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
    async execute(args, { notesDir: customNotesDir } = {}) {
      const title = String(args?.title || '').trim();
      const content = String(args?.content || '').trim();
      if (!title || !content) {
        return { ok: false, tool: 'save_note', summary: 'Both title and content are required to save a note.' };
      }

      const notesDir = customNotesDir || getNotesDirectory();
      fs.mkdirSync(notesDir, { recursive: true });
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
    async execute(args, { notesDir: customNotesDir } = {}) {
      const notesDir = customNotesDir || getNotesDirectory();
      fs.mkdirSync(notesDir, { recursive: true });
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
    async execute(args, { fetchImpl = fetch, notesDir } = {}) {
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
          data: { topic, title, message, url: targetUrl, deliveredLive: true }
        };
      } catch (err) {
        const targetDir = notesDir || getNotesDirectory();
        fs.mkdirSync(targetDir, { recursive: true });
        const filename = toSafeNoteFilename(`notification-${topic}-${Date.now()}`);
        fs.writeFileSync(
          path.join(targetDir, filename),
          `# 🔔 Sovereign Notification Outbox (${topic})\n- **Title**: ${title}\n- **Status**: Queued in local outbox (${err.message})\n\n${message}\n`,
          'utf-8'
        );
        return {
          ok: true,
          tool: 'send_notification',
          actionType: 'notification_sent',
          summary: `🔔 Notification queued to **${topic}** *(local sovereign outbox \`data/notes/${filename}\`)*:\n> **${title}** — ${message}`,
          data: { topic, title, message, url: targetUrl, deliveredLive: false, localOutbox: filename }
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
    async execute(args, { fetchImpl = fetch, notesDir } = {}) {
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
        // Graceful local fallback: search Sovereign Working Memory & local Notes Vault
        const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const matchingMemories = getActiveMemories().filter(m =>
          keywords.length === 0 || keywords.some(k => String(m.content || '').toLowerCase().includes(k))
        ).slice(0, 3);
        const targetDir = notesDir || getNotesDirectory();
        const noteHits = [];
        if (fs.existsSync(targetDir)) {
          for (const f of fs.readdirSync(targetDir).filter(f => f.endsWith('.md')).slice(0, 10)) {
            const text = fs.readFileSync(path.join(targetDir, f), 'utf-8');
            if (keywords.some(k => text.toLowerCase().includes(k))) {
              noteHits.push({ file: f, snippet: text.replace(/\s+/g, ' ').slice(0, 220) });
            }
          }
        }
        const fallbackLines = [
          ...matchingMemories.map(m => `- **[Working Memory #${m.id} | ${m.category.toUpperCase()}]**: ${m.content}`),
          ...noteHits.map(n => `- **[Local Vault \`${n.file}\`]**: ${n.snippet}`)
        ];
        return {
          ok: true,
          tool: 'sovereign_gateway_query',
          actionType: 'sovereign_gateway',
          summary: `⚖️ **Sovereign ${isBiz ? 'KruschBiz' : 'KruschLaw'} Query ("${query}")** *(Local Vault Fallback — ${isBiz ? ':8086' : ':8085'} offline)*:\n${fallbackLines.length > 0 ? fallbackLines.join('\n') : `- Indexed query "${query}" in local Sovereign Vault (start \`krusch-${isBiz ? 'biz' : 'law'}\` on ${baseUrl} for full pgvector statutory/contract graph).`}`,
          data: {
            mode: 'local_sovereign_fallback',
            domain: isBiz ? 'biz' : 'law',
            query,
            matchingMemories,
            noteHits,
            upstreamOfflineReason: err.message
          }
        };
      }
    }
  },
  {
    name: 'board_action',
    category: 'board',
    description: 'Create/complete a task or attach a checklist/list of items to a task on Today\'s Priority Board, or persist a fact into Sovereign Working Memory.',
    parameters: {
      action: 'string (REQUIRED: "add_task" | "add_list_to_task" | "complete_task" | "remember")',
      title: 'string (REQUIRED: Task title to add/update/complete, or memory content to remember)',
      items: 'string (OPTIONAL: Comma-separated checklist items/steps to attach to the task)',
      tier: 'number (OPTIONAL: 1=Values/Faith, 2=Partner, 3=Family/Kids, 4=Health/Fitness/Walk, 5=Work; omit to auto-classify)'
    },
    required: ['action', 'title'],
    async execute(args) {
      const action = String(args?.action || 'add_task').toLowerCase().trim();
      const title = String(args?.title || args?.task || '').trim();
      const rawItems = args?.items ?? args?.list ?? args?.checklist ?? args?.notes ?? null;

      if (action === 'list_tasks' || action === 'list') {
        const tasks = getTasksForDate(today());
        const pending = tasks.filter(t => !t.completed);
        return {
          ok: true,
          tool: 'board_action',
          actionType: 'tasks_listed',
          summary: `📋 **Today's Priority Board (${pending.length} pending / ${tasks.length} total)**:\n${pending.map(t => `- **[#${t.id}]** ${t.title}${t.notes ? `\n  ${t.notes.split('\n').join('\n  ')}` : ''}`).join('\n') || '- All tasks completed!'}`,
          data: { tasks }
        };
      }

      if (!title) {
        return { ok: false, tool: 'board_action', summary: 'Parameter "title" is required for board_action.' };
      }

      if (action === 'toggle_checklist_item') {
        const target = findTaskByQuery(title, today());
        if (!target) {
          return { ok: false, tool: 'board_action', summary: `Could not find task matching "${title}" on Today's Board.` };
        }
        const updated = toggleTaskChecklistItem(target.id, args?.index ?? 0);
        if (!updated) {
          return { ok: false, tool: 'board_action', summary: `Could not toggle checklist item on task #[${target.id}].` };
        }
        return {
          ok: true,
          tool: 'board_action',
          actionType: 'task_created',
          summary: `☑️ Updated checklist on **[#${updated.id}] ${updated.title}**:\n${updated.notes}`,
          data: { task: updated }
        };
      }

      if (action === 'delete_task' || action === 'delete' || action === 'remove_task') {
        const target = findTaskByQuery(title, today());
        if (!target) {
          return { ok: false, tool: 'board_action', summary: `Could not find task matching "${title}" on Today's Board.` };
        }
        deleteTask(target.id);
        return {
          ok: true,
          tool: 'board_action',
          actionType: 'task_deleted',
          summary: `🗑️ Removed task **[#${target.id}] ${target.title}** from Today's Priority Board.`,
          data: { task: target }
        };
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

      if (
        action === 'add_list_to_task' ||
        action === 'add_checklist' ||
        action === 'append_list' ||
        action === 'update_task' ||
        (rawItems && normalizeChecklistItems(rawItems).length > 0 && findTaskByQuery(title, today(), { onlyIncomplete: true }))
      ) {
        const existing = findTaskByQuery(title, today(), { onlyIncomplete: true }) || findTaskByQuery(title, today());
        if (existing && rawItems) {
          const updated = addListToTask(existing.id, { items: rawItems, append: true });
          const itemLines = normalizeChecklistItems(rawItems);
          return {
            ok: true,
            tool: 'board_action',
            actionType: 'task_created',
            summary: `📝 Added **${itemLines.length} checklist item(s)** to **[#${updated.id}] ${updated.title}** (*${updated.execution_lane_emoji} ${updated.execution_lane_short} • ${updated.pillar_emoji} ${updated.pillar}*):\n${updated.notes}`,
            data: { task: updated, itemsAdded: itemLines }
          };
        }
      }

      // Default: add_task (creates new task, attaching checklist items if provided)
      const keywordInferred = inferPriorityTierFromText(title);
      const useExplicitTier = keywordInferred.tier === 5 && args?.tier >= 1 && args?.tier <= 5;
      const inferred = useExplicitTier ? inferPriorityTierFromText(`[Tier ${args.tier}] ${title}`) : keywordInferred;
      const created = createTask({
        title: inferred.cleanTitle,
        priority_id: inferred.priorityId,
        items: rawItems,
        energy_level: 'medium',
        date: today()
      });

      const checklistSuffix = created.notes ? `\n📋 **Checklist attached:**\n${created.notes}` : '';
      return {
        ok: true,
        tool: 'board_action',
        actionType: 'task_created',
        summary: `✅ Added task **[#${created.id}] ${created.title}** to **Tier ${created.tier}: ${created.priority_name} ${created.priority_emoji}**.${checklistSuffix}`,
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
    async execute(args, { fetchImpl = fetch, notesDir } = {}) {
      const action = String(args?.action || 'search').toLowerCase().trim();
      const baseUrl = (process.env.G_KRUSCH_URL || 'http://127.0.0.1:5446').replace(/\/+$/, '');
      const targetNotesDir = notesDir || getNotesDirectory();
      fs.mkdirSync(targetNotesDir, { recursive: true });

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
          fs.writeFileSync(path.join(targetNotesDir, localFilename), content, 'utf-8');

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
        // Graceful fallback to local Sovereign Notes & Profile Vault when Google Drive OAuth daemon is offline
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
        const localFiles = fs.readdirSync(targetNotesDir).filter(f => f.endsWith('.md')).sort();
        if (action === 'steering') {
          const synced = syncMarkdownProfileFiles({ notesDir: targetNotesDir });
          const soulContent = fs.readFileSync(synced.soulPath, 'utf-8');
          return {
            ok: true,
            tool: 'gkrusch_drive',
            actionType: 'google_drive',
            summary: `🧭 **Sovereign Local Steering (\`SOUL.md\`)**:\n\n${soulContent.slice(0, 1000)}`,
            data: { mode: 'local_vault_fallback', content: soulContent }
          };
        }
        if (action === 'read') {
          const q = toSafeNoteFilename(String(args?.path || args?.query || ''));
          const matched = localFiles.find(f => f === q || f.includes(q.replace(/\.md$/, '')));
          const content = matched ? fs.readFileSync(path.join(targetNotesDir, matched), 'utf-8') : 'No matching local mirror found.';
          return {
            ok: true,
            tool: 'gkrusch_drive',
            actionType: 'google_drive',
            summary: `📄 **Sovereign Local Drive Mirror (\`${matched || q}\`)**:\n\n${content.slice(0, 1000)}`,
            data: { mode: 'local_vault_fallback', filename: matched || q, content }
          };
        }
        if (action === 'search') {
          const q = String(args?.query || '').toLowerCase();
          const hits = localFiles
            .map(f => ({ fileName: f, content: fs.readFileSync(path.join(targetNotesDir, f), 'utf-8') }))
            .filter(item => !q || item.fileName.toLowerCase().includes(q) || item.content.toLowerCase().includes(q))
            .slice(0, 4);
          return {
            ok: true,
            tool: 'gkrusch_drive',
            actionType: 'google_drive',
            summary: `☁️ **Sovereign Local Drive Vault Search ("${args?.query || '*'}")** *(${hits.length} local mirror doc(s))*: \n${hits.map((h, i) => `${i + 1}. **\`${h.fileName}\`**: ${h.content.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n') || 'No matching local vault documents.'}`,
            data: { mode: 'local_vault_fallback', results: hits }
          };
        }
        return {
          ok: true,
          tool: 'gkrusch_drive',
          actionType: 'google_drive',
          summary: `☁️ **Sovereign Local Drive Mirror (${localFiles.length} files)**:\n${localFiles.map(f => `- \`data/notes/${f}\``).join('\n') || '- Vault empty'}`,
          data: { mode: 'local_vault_fallback', files: localFiles }
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
        // Fallback for list_events: show today's Priority Board schedule & active automations
        const localTasks = getTasksForDate(today()).filter(t => !t.completed);
        return {
          ok: true,
          tool: 'gkrusch_calendar',
          actionType: 'google_calendar',
          summary: `📅 **Sovereign Local Schedule (${today()} — ${localTasks.length} active item(s))**:\n${localTasks.slice(0, 6).map(t => `- **[#${t.id}]** ${t.title}`).join('\n') || '- No pending events today.'}`,
          data: { mode: 'local_schedule_fallback', events: localTasks, calendarError: err.message }
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
    async execute(args, { fetchImpl = fetch, notesDir } = {}) {
      const action = String(args?.action || 'search_emails').toLowerCase().trim();
      const baseUrl = (process.env.G_KRUSCH_URL || 'http://127.0.0.1:5446').replace(/\/+$/, '');
      const targetNotesDir = notesDir || getNotesDirectory();
      fs.mkdirSync(targetNotesDir, { recursive: true });

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
          fs.writeFileSync(path.join(targetNotesDir, filename), draftMd, 'utf-8');
          return {
            ok: true,
            tool: 'gkrusch_gmail',
            actionType: 'google_gmail',
            summary: `✉️ Saved email draft **${subject}** (To: \`${to}\`) to local vault \`data/notes/${filename}\` (connect G-Krusch OAuth at \`${baseUrl}/auth/google\` for live Gmail sync):\n\n> ${body.slice(0, 400)}`,
            data: { localDraft: filename, gmailError: err.message }
          };
        }
        // Fallback for search_emails: search local email drafts in data/notes/
        const draftFiles = fs.readdirSync(targetNotesDir).filter(f => f.includes('email') || f.includes('reservation') || f.endsWith('.md')).slice(0, 5);
        return {
          ok: true,
          tool: 'gkrusch_gmail',
          actionType: 'google_gmail',
          summary: `✉️ **Sovereign Local Mail & Drafts Vault ("${args?.query || 'is:inbox'}")**:\n${draftFiles.map(f => `- \`data/notes/${f}\``).join('\n') || '- No local email drafts stored yet.'}`,
          data: { mode: 'local_mail_fallback', messages: draftFiles, gmailError: err.message }
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

      // 2. Build Pre-Filled Deep Booking Links (OpenTable, Resy, SevenRooms, Google Maps)
      const openTableUrl = `https://www.opentable.com/s?covers=${partySize}&dateTime=${encodeURIComponent(isoDateTime.slice(0, 19))}&term=${encodeURIComponent(venue)}`;
      const resyUrl = `https://resy.com/cities/search?query=${encodeURIComponent(venue)}&date=${isoDateOnly}&seats=${partySize}`;
      const sevenRoomsUrl = `https://www.sevenrooms.com/reservations?party_size=${partySize}&date=${isoDateOnly}&query=${encodeURIComponent(venue)}`;
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

      // 6. Generate a Google Wallet Generic Pass / Mobile Pass for the Reservation
      const walletPass = buildGoogleWalletPassResult({
        title: `${venue} (Party of ${partySize})`,
        subtitle: `Leave by ${commute.leaveByFormatted} • ${rawDateTime}`,
        category: 'Reservation Pass',
        location: placeInfo.displayName,
        startTime: isoDateTime,
        leaveBy: commute.leaveByFormatted,
        openTableUrl,
        directionsUrl: commute.googleMapsDirectionsUrl,
        notes: specialNotes || `Party of ${partySize}`,
        notesDir
      });

      const summaryLines = [
        `🍽️ **Concierge Reservation Prepared for ${venue}** *(Party of ${partySize} • ${rawDateTime})*:`,
        `- **Location**: ${placeInfo.displayName}`,
        ...(placeInfo.phone ? [`- **Phone**: \`${placeInfo.phone}\``] : []),
        ...(placeInfo.website ? [`- **Website**: ${placeInfo.website}`] : []),
        ...(placeInfo.openingHours ? [`- **Hours**: \`${placeInfo.openingHours}\``] : []),
        `- ${commute.earlyWarningText}`,
        `- **Instant 1-Click Booking, Wallet Pass & Navigation Links**:`,
        `  • [Book on OpenTable (Party of ${partySize})](${openTableUrl})`,
        `  • [Book on Resy (Party of ${partySize})](${resyUrl})`,
        `  • [Book on SevenRooms (Party of ${partySize})](${sevenRoomsUrl})`,
        `  • [📲 Add Reservation Pass to Google Wallet (${walletPass.mode === 'google_wallet_jwt' ? 'Signed RS256 Pass' : 'Mobile Pass & Calendar Card'})](${walletPass.saveUrl})`,
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
          links: {
            openTableUrl,
            resyUrl,
            sevenRoomsUrl,
            googleMapsUrl,
            directionsUrl: commute.googleMapsDirectionsUrl,
            googleWalletPassUrl: walletPass.saveUrl
          },
          walletPass,
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
        ...(Array.isArray(commute.turnByTurnSteps) && commute.turnByTurnSteps.length > 0
          ? [
              `- **🧭 Turn-by-Turn Driving Directions**:`,
              ...commute.turnByTurnSteps.map(step => `  ${step}`)
            ]
          : []),
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
  },
  {
    name: 'google_wallet_pass',
    category: 'google_wallet',
    description: 'Create and sign a Google Wallet Generic Pass (for a reservation, flight/event ticket, appointment, or urgent priority card with Leave-By departure time) that can be saved to the user\'s phone.',
    parameters: {
      title: 'string (REQUIRED: Pass title, e.g. "Canlis Dinner Reservation" or "2:00 PM Downtown Client Meeting")',
      subtitle: 'string (OPTIONAL: Subtitle or Leave-By time, e.g. "Party of 2 • Leave by 6:20 PM")',
      location: 'string (OPTIONAL: Physical venue address or destination)',
      startTime: 'string (OPTIONAL: Event ISO-8601 or natural start time)',
      notes: 'string (OPTIONAL: Confirmation number, gate, table preference, or checklist notes)'
    },
    required: ['title'],
    async execute(args, { notesDir } = {}) {
      const title = String(args?.title || args?.venue || '').trim();
      if (!title) {
        return { ok: false, tool: 'google_wallet_pass', summary: 'Parameter "title" is required for google_wallet_pass.' };
      }

      const passResult = buildGoogleWalletPassResult({
        title,
        subtitle: args?.subtitle || (args?.startTime ? `Scheduled: ${args.startTime}` : 'Sovereign Companion Pass'),
        category: args?.category || 'Krusch Companion Pass',
        location: args?.location || '',
        startTime: args?.startTime || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        leaveBy: args?.leaveBy || '',
        notes: args?.notes || '',
        notesDir
      });

      const lines = [
        `📲 **Google Wallet Pass Prepared**: **${title}**`,
        `- **Pass ID**: \`${passResult.passId}\` *(${passResult.mode === 'google_wallet_jwt' ? 'Signed Google Cloud RS256 JWT' : 'Signed Sovereign Pass + Mobile Calendar/Wallet Link'})*`,
        ...(args?.subtitle ? [`- **Subtitle**: ${args.subtitle}`] : []),
        ...(args?.location ? [`- **Location**: ${args.location}`] : []),
        `- **1-Click Phone Save Link**: [📲 Save Pass to Google Wallet / Mobile](${passResult.saveUrl})`,
        `- **Local Pass Vault**: \`data/notes/${passResult.filename}\``
      ];

      return {
        ok: true,
        tool: 'google_wallet_pass',
        actionType: 'google_wallet_pass',
        summary: lines.join('\n'),
        data: passResult
      };
    }
  },
  {
    name: 'ap2_payment_mandate',
    category: 'payments',
    description: 'Issue a cryptographically signed Google Agent Payments Protocol (AP2) Mandate (IntentMandate + CartMandate + PaymentMandate) with a hard spend ceiling, Google Pay Agentic Checkout token payload, and optional single-use spend-capped virtual card (Privacy.com / Stripe Issuing).',
    parameters: {
      merchant: 'string (REQUIRED: Merchant, payee, or utility name, e.g. "Seattle City Light" or "Canlis Seattle")',
      maxAmount: 'number (REQUIRED: Hard spend ceiling in USD, e.g. 65.00)',
      description: 'string (OPTIONAL: Itemized purpose or constraint for the payment mandate)',
      currency: 'string (OPTIONAL: ISO currency code, default "USD")',
      expiresHours: 'number (OPTIONAL: Hours until the mandate automatically expires, default 24)'
    },
    required: ['merchant', 'maxAmount'],
    async execute(args, { fetchImpl = fetch, notesDir } = {}) {
      const merchant = String(args?.merchant || args?.payee || '').trim();
      const rawAmount = parseFloat(String(args?.maxAmount ?? args?.amount ?? '0').replace(/[^0-9.]/g, ''));
      if (!merchant) {
        return { ok: false, tool: 'ap2_payment_mandate', summary: 'Parameter "merchant" is required for ap2_payment_mandate.' };
      }
      if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
        return { ok: false, tool: 'ap2_payment_mandate', summary: 'Parameter "maxAmount" must be a positive number (e.g. 50.00).' };
      }

      const maxAmount = Math.min(Number(rawAmount.toFixed(2)), 10000);
      const currency = String(args?.currency || 'USD').toUpperCase().trim();
      const description = String(args?.description || args?.purpose || `Authorized agentic payment to ${merchant}`).trim();
      const expiresHours = Math.min(Math.max(1, parseInt(args?.expiresHours || '24', 10) || 24), 168);

      const mandateBundle = await createAp2PaymentMandateBundle({
        merchant,
        maxAmount,
        currency,
        description,
        expiresHours,
        fetchImpl,
        notesDir
      });

      const task = createTask({
        title: `💳 AP2 Payment Mandate: ${merchant} (Up to $${maxAmount.toFixed(2)} ${currency})`,
        priority_id: 1,
        execution_priority: 1,
        pillar: 'Provision & Finance',
        lane_reason: `Urgent financial/payment mandate (${mandateBundle.mandateId}) capped at $${maxAmount.toFixed(2)} ${currency}`,
        notes: `Mandate ID: ${mandateBundle.mandateId} | Signature: ${mandateBundle.signature.slice(0, 16)}... | Vault: data/notes/${mandateBundle.filename}`,
        energy_level: 'low',
        date: today()
      });

      const lines = [
        `💳 **Google AP2 Payment Mandate Issued**: **${merchant}** *(Hard Ceiling: **$${maxAmount.toFixed(2)} ${currency}**)*`,
        `- **Mandate ID**: \`${mandateBundle.mandateId}\``,
        `- **Cryptographic Signature (HMAC-SHA256)**: \`${mandateBundle.signature.slice(0, 24)}…\``,
        `- **Constraints**: Single-Use • Merchant-Locked (\`${merchant}\`) • Expires \`${mandateBundle.expiresAt}\``,
        `- **Google Pay Agentic Checkout**: Ready (\`apiVersion: 2.0\`, \`totalPriceStatus: FINAL\`)`,
        ...(mandateBundle.virtualCard
          ? [`- **Spend-Capped Virtual Card (${mandateBundle.virtualCard.provider})**: Ending in \`${mandateBundle.virtualCard.last4}\` (Hard Cap: \`$${maxAmount.toFixed(2)}\`)`]
          : [`- **Virtual Card Rail**: Sovereign AP2 Mandate Mode *(set \`PRIVACY_API_KEY\` in \`.env\` to auto-mint live single-use virtual cards)*`]),
        `- **Mandate Receipt Vault**: \`data/notes/${mandateBundle.filename}\``,
        `- 📋 **Added to Lane 1 (🚨 Must Happen Today)**: **[#${task.id}] ${task.title}**`
      ];

      return {
        ok: true,
        tool: 'ap2_payment_mandate',
        actionType: 'ap2_payment_mandate',
        summary: lines.join('\n'),
        data: {
          ...mandateBundle,
          taskId: task.id
        }
      };
    }
  },
  {
    name: 'skill_manager',
    category: 'skills',
    description: 'OpenClaw & Nous Hermes Self-Improving Skill Engine (SKILL.md): learn/save a new reusable procedural skill from instructions or experience, list installed skills, read a SKILL.md definition, run a skill workflow, or import/migrate an OpenClaw/Hermes workspace.',
    parameters: {
      action: 'string (REQUIRED: "learn" | "list" | "read" | "run" | "import_openclaw")',
      name: 'string (Skill name or slug, e.g. "morning-briefing-digest" or "client-invoice-followup")',
      description: 'string (OPTIONAL: Short description of when this skill should be triggered)',
      triggers: 'string (OPTIONAL: Comma-separated natural language trigger phrases)',
      steps: 'string (OPTIONAL: Markdown procedural steps or tool sequence for the skill)',
      workspacePath: 'string (OPTIONAL: Path to OpenClaw/Hermes directory when action="import_openclaw")'
    },
    required: ['action'],
    async execute(args, { notesDir } = {}) {
      ensureExtendedCompanionTables();
      const action = String(args?.action || 'list').toLowerCase().trim();
      const skillsDir = getSkillsDirectory(notesDir);
      const database = getDb();

      if (action === 'learn' || action === 'create' || action === 'save') {
        const rawName = String(args?.name || args?.title || 'custom-skill').trim();
        const slug = toSafeNoteFilename(rawName).replace(/\.md$/, '');
        const description = String(args?.description || `Reusable procedural skill for ${rawName}`).trim();
        const triggers = String(args?.triggers || rawName.toLowerCase()).trim();
        const steps = String(args?.steps || args?.content || `1. Analyze user request for ${rawName}\n2. Execute appropriate Companion tools\n3. Verify outcome and log to Working Memory`).trim();
        const toolsUsed = String(args?.tools_used || args?.toolsUsed || 'save_note, board_action').trim();

        const skillSubdir = path.join(skillsDir, slug);
        fs.mkdirSync(skillSubdir, { recursive: true });
        const skillMdPath = path.join(skillSubdir, 'SKILL.md');
        const skillMd = [
          '---',
          `name: ${slug}`,
          `title: "${rawName.replace(/"/g, '\\"')}"`,
          `description: "${description.replace(/"/g, '\\"')}"`,
          `triggers: "${triggers.replace(/"/g, '\\"')}"`,
          `tools_used: "${toolsUsed.replace(/"/g, '\\"')}"`,
          `updated_at: "${new Date().toISOString()}"`,
          '---',
          '',
          `# 🧩 Skill: ${rawName}`,
          '',
          `> ${description}`,
          '',
          '## Trigger Phrases',
          ...triggers.split(',').map(t => `- \`${t.trim()}\``),
          '',
          '## Procedural Execution Steps',
          steps,
          ''
        ].join('\n');
        fs.writeFileSync(skillMdPath, skillMd, 'utf-8');

        const existing = database.prepare('SELECT * FROM companion_skills WHERE slug = ?').get(slug);
        if (existing) {
          database.prepare(`
            UPDATE companion_skills
            SET name = ?, description = ?, triggers = ?, steps = ?, tools_used = ?, updated_at = datetime('now')
            WHERE slug = ?
          `).run(rawName, description, triggers, steps, toolsUsed, slug);
        } else {
          database.prepare(`
            INSERT INTO companion_skills (slug, name, description, triggers, steps, tools_used, source, experience_count)
            VALUES (?, ?, ?, ?, ?, ?, 'user_or_agent', 1)
          `).run(slug, rawName, description, triggers, steps, toolsUsed);
        }

        const savedSkill = database.prepare('SELECT * FROM companion_skills WHERE slug = ?').get(slug);
        return {
          ok: true,
          tool: 'skill_manager',
          actionType: 'skill_learned',
          summary: `🧩 **Learned & Persisted Reusable Skill \`${slug}\`** (\`data/skills/${slug}/SKILL.md\`):\n- **Description**: ${description}\n- **Triggers**: \`${triggers}\`\n- **Procedural Steps**:\n${steps}`,
          data: {
            skill: savedSkill,
            skillMdPath
          }
        };
      }

      if (action === 'read') {
        const querySlug = toSafeNoteFilename(args?.name || '').replace(/\.md$/, '');
        const row = database.prepare('SELECT * FROM companion_skills WHERE slug = ? OR name LIKE ?').get(querySlug, `%${args?.name || ''}%`);
        if (!row) {
          return { ok: false, tool: 'skill_manager', summary: `Skill "${args?.name || querySlug}" not found.` };
        }
        const skillMdPath = path.join(skillsDir, row.slug, 'SKILL.md');
        const rawMd = fs.existsSync(skillMdPath) ? fs.readFileSync(skillMdPath, 'utf-8') : row.steps;
        return {
          ok: true,
          tool: 'skill_manager',
          actionType: 'skill_read',
          summary: `📖 **Skill \`${row.slug}\` (\`SKILL.md\`)**:\n\n${rawMd}`,
          data: { skill: row, markdown: rawMd }
        };
      }

      if (action === 'run' || action === 'execute') {
        const querySlug = toSafeNoteFilename(args?.name || '').replace(/\.md$/, '');
        const row = database.prepare('SELECT * FROM companion_skills WHERE slug = ? OR name LIKE ?').get(querySlug, `%${args?.name || ''}%`);
        if (!row) {
          return { ok: false, tool: 'skill_manager', summary: `Could not find skill "${args?.name || querySlug}" to execute.` };
        }
        database.prepare(`
          UPDATE companion_skills
          SET experience_count = experience_count + 1, updated_at = datetime('now')
          WHERE id = ?
        `).run(row.id);

        const task = createTask({
          title: `🧩 [Skill Run] ${row.name}`,
          priority_id: 2,
          execution_priority: 2,
          pillar: 'Work & Mastery',
          notes: `Skill: ${row.slug} | Steps: ${row.steps.slice(0, 180)}`,
          energy_level: 'medium',
          date: today()
        });

        return {
          ok: true,
          tool: 'skill_manager',
          actionType: 'skill_executed',
          summary: `⚡ **Executed Skill \`${row.slug}\` (${row.name})** *(Experience Count: ${row.experience_count + 1})*:\n- **Procedure**: ${row.steps}\n- 📋 **Staged Execution Card on Today's Board**: **[#${task.id}] ${task.title}**`,
          data: { skill: { ...row, experience_count: row.experience_count + 1 }, taskId: task.id }
        };
      }

      if (action === 'import_openclaw' || action === 'migrate') {
        const wsPath = String(args?.workspacePath || args?.path || '').trim();
        const imported = { soul: false, user: false, memories: 0, skills: 0 };

        if (wsPath && fs.existsSync(wsPath)) {
          const soulFile = path.join(wsPath, 'SOUL.md');
          if (fs.existsSync(soulFile)) {
            const soulText = fs.readFileSync(soulFile, 'utf-8').trim();
            rememberMemory({ category: 'invariant', content: `[Imported SOUL.md] ${soulText.slice(0, 300)}`, key: 'soul_persona' });
            imported.soul = true;
          }
          const userFile = path.join(wsPath, 'USER.md');
          if (fs.existsSync(userFile)) {
            const userText = fs.readFileSync(userFile, 'utf-8').trim();
            rememberMemory({ category: 'decision', content: `[Imported USER.md] ${userText.slice(0, 300)}`, key: 'user_profile' });
            imported.user = true;
          }
          const memFile = path.join(wsPath, 'MEMORY.md');
          if (fs.existsSync(memFile)) {
            const lines = fs.readFileSync(memFile, 'utf-8').split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(l => l.length > 8 && !l.startsWith('#'));
            for (const line of lines.slice(0, 20)) {
              rememberMemory({ category: 'lesson', content: line });
              imported.memories++;
            }
          }
          const extSkillsDir = path.join(wsPath, 'skills');
          if (fs.existsSync(extSkillsDir)) {
            for (const entry of fs.readdirSync(extSkillsDir)) {
              const candidateMd = path.join(extSkillsDir, entry, 'SKILL.md');
              if (fs.existsSync(candidateMd)) {
                const body = fs.readFileSync(candidateMd, 'utf-8');
                const slug = toSafeNoteFilename(entry).replace(/\.md$/, '');
                database.prepare(`
                  INSERT OR REPLACE INTO companion_skills (slug, name, description, triggers, steps, tools_used, source, experience_count)
                  VALUES (?, ?, ?, ?, ?, 'imported', 'openclaw_migration', 1)
                `).run(slug, entry, `Migrated from OpenClaw/Hermes (${entry})`, slug, body.slice(0, 1200));
                imported.skills++;
              }
            }
          }
        }

        const profileSync = syncMarkdownProfileFiles({ notesDir });
        return {
          ok: true,
          tool: 'skill_manager',
          actionType: 'openclaw_migrated',
          summary: `🔄 **OpenClaw / Nous Hermes Workspace Migration Complete**:\n- **Imported**: \`SOUL.md\` (${imported.soul ? 'Yes' : 'Default'}), \`USER.md\` (${imported.user ? 'Yes' : 'Default'}), **${imported.memories}** memory entries, **${imported.skills}** \`SKILL.md\` packages\n- **Synced Sovereign Markdown Files**: \`SOUL.md\`, \`USER.md\`, \`MEMORY.md\``,
          data: { imported, profileSync }
        };
      }

      // Default: list skills
      const skills = database.prepare('SELECT * FROM companion_skills ORDER BY experience_count DESC, id DESC').all();
      const lines = skills.map(s => `- **\`${s.slug}\`** (*${s.name}* — ${s.source}, ran ${s.experience_count}x): ${s.description}`);
      return {
        ok: true,
        tool: 'skill_manager',
        actionType: 'skills_listed',
        summary: `🧩 **Installed & Learned Companion Skills (${skills.length})**:\n${lines.join('\n')}`,
        data: { count: skills.length, skills }
      };
    }
  },
  {
    name: 'schedule_automation',
    category: 'automation',
    description: 'OpenClaw & Hermes Cron Scheduler, Timed Reminders & Automated Meeting Prep Dossier: schedule recurring cron jobs or timed reminders, list/delete scheduled automations, or compile a 1-page Meeting Prep Dossier combining Calendar, CRM contacts, Notes, and Working Memory.',
    parameters: {
      action: 'string (REQUIRED: "create" | "list" | "run_now" | "meeting_prep" | "delete")',
      title: 'string (Automation title, reminder text, or meeting topic/attendee name)',
      schedule: 'string (OPTIONAL: Cron expression like "0 8 * * 1-5" or natural time like "every morning at 8am", "in 30 minutes", "at 4:30 PM")',
      taskType: 'string (OPTIONAL: "reminder" | "briefing" | "meeting_prep" | "board_task")',
      attendees: 'string (OPTIONAL: Comma-separated attendee names for action="meeting_prep")'
    },
    required: ['action'],
    async execute(args, { notesDir } = {}) {
      ensureExtendedCompanionTables();
      const action = String(args?.action || 'list').toLowerCase().trim();
      const database = getDb();

      if (action === 'meeting_prep' || args?.taskType === 'meeting_prep') {
        const topic = String(args?.title || args?.topic || args?.query || 'Upcoming Strategy Sync').trim();
        const rawAttendees = String(args?.attendees || '').split(',').map(s => s.trim()).filter(Boolean);

        // 1. Pull matching contacts from Personal CRM
        const allContacts = database.prepare('SELECT * FROM companion_contacts ORDER BY updated_at DESC').all();
        const matchedContacts = allContacts.filter(c =>
          topic.toLowerCase().includes(c.name.toLowerCase()) ||
          rawAttendees.some(a => c.name.toLowerCase().includes(a.toLowerCase()))
        );

        // 2. Pull relevant Working Memory nuggets
        const memories = getActiveMemories().slice(0, 6);

        // 3. Pull matching local Markdown notes
        const targetNotesDir = notesDir || getNotesDirectory();
        const noteFiles = fs.existsSync(targetNotesDir)
          ? fs.readdirSync(targetNotesDir).filter(f => f.endsWith('.md')).slice(0, 5)
          : [];

        const filename = toSafeNoteFilename(`meeting-prep-${topic}`);
        const dossierLines = [
          `# 📋 Meeting Prep Dossier: ${topic}`,
          `*Compiled by Krusch Companion on ${new Date().toISOString()}*`,
          '',
          '## 👥 Attendee & Relationship CRM Context',
          ...(matchedContacts.length > 0
            ? matchedContacts.map(c => `- **${c.name}** (*${c.relationship}*): ${c.notes || c.preferences || 'No special notes'}${c.important_dates ? ` | Dates: ${c.important_dates}` : ''}${c.gift_ideas ? ` | Gift/Interests: ${c.gift_ideas}` : ''}`)
            : [`- Attendees: ${rawAttendees.length > 0 ? rawAttendees.join(', ') : 'General / Team Sync'}`]),
          '',
          '## 🧠 Active Working Memory & Decisions',
          ...(memories.length > 0
            ? memories.map(m => `- **[${m.category.toUpperCase()}]**: ${m.content}`)
            : ['- No active memory constraints recorded.']),
          '',
          '## 📂 Related Local Vault Notes',
          ...(noteFiles.length > 0 ? noteFiles.map(f => `- \`data/notes/${f}\``) : ['- None']),
          '',
          '## ✅ Recommended Talking Points & Pre-Flight Checklist',
          `1. Confirm core objective and decision owners for **${topic}**`,
          '2. Review open action items on Today\'s Dual-Axis Priority Board',
          '3. Capture post-meeting commitments via Voice Thought Stream (`🎙️ Speak`)'
        ];

        fs.mkdirSync(targetNotesDir, { recursive: true });
        fs.writeFileSync(path.join(targetNotesDir, filename), dossierLines.join('\n') + '\n', 'utf-8');

        return {
          ok: true,
          tool: 'schedule_automation',
          actionType: 'meeting_prep_compiled',
          summary: `📋 **Compiled 1-Page Meeting Prep Dossier for "${topic}"** (\`data/notes/${filename}\`):\n${dossierLines.slice(2).join('\n')}`,
          data: {
            topic,
            filename,
            matchedContacts,
            memoriesIncluded: memories.length
          }
        };
      }

      if (action === 'create' || action === 'schedule' || action === 'remind') {
        const title = String(args?.title || args?.prompt || 'Scheduled Companion Check-In').trim();
        const scheduleExpr = String(args?.schedule || args?.cron || '0 8 * * *').trim();
        const isRecurring = /\b(?:every|daily|weekly|weekday|morning|cron)\b|[*\/]/.test(scheduleExpr);
        const scheduleType = isRecurring ? 'cron_recurring' : 'one_shot_reminder';
        const actionType = String(args?.taskType || (isRecurring ? 'briefing' : 'reminder')).trim();

        let nextRunMs = Date.now() + 30 * 60 * 1000;
        const inMinMatch = scheduleExpr.match(/in\s+(\d+)\s*(?:min|minute)/i);
        if (inMinMatch) {
          nextRunMs = Date.now() + parseInt(inMinMatch[1], 10) * 60 * 1000;
        } else {
          const parsed = parseArrivalDateTime(scheduleExpr);
          if (!isNaN(parsed.getTime())) nextRunMs = parsed.getTime();
        }
        const nextRunIso = new Date(nextRunMs).toISOString();

        const info = database.prepare(`
          INSERT INTO companion_automations (title, schedule_expr, schedule_type, action_type, payload, enabled, next_run_at)
          VALUES (?, ?, ?, ?, ?, 1, ?)
        `).run(title, scheduleExpr, scheduleType, actionType, JSON.stringify(args || {}), nextRunIso);

        const created = database.prepare('SELECT * FROM companion_automations WHERE id = ?').get(info.lastInsertRowid);
        return {
          ok: true,
          tool: 'schedule_automation',
          actionType: 'automation_scheduled',
          summary: `⏰ **Scheduled ${scheduleType === 'cron_recurring' ? 'Recurring Cron Automation' : 'Timed Reminder'} [#${created.id}]**:\n- **Task**: **${title}**\n- **Schedule**: \`${scheduleExpr}\` *(Next execution: \`${nextRunIso}\`)*\n- **Mode**: Zero-Token Sentinel Watchdog Trigger`,
          data: { automation: created }
        };
      }

      if (action === 'run_now' || action === 'trigger') {
        const id = parseInt(args?.id || '0', 10);
        const row = id
          ? database.prepare('SELECT * FROM companion_automations WHERE id = ?').get(id)
          : database.prepare('SELECT * FROM companion_automations WHERE title LIKE ? ORDER BY id DESC').get(`%${args?.title || ''}%`);
        if (!row) {
          return { ok: false, tool: 'schedule_automation', summary: 'Scheduled automation not found.' };
        }
        database.prepare(`
          UPDATE companion_automations
          SET last_run_at = datetime('now'), run_count = run_count + 1
          WHERE id = ?
        `).run(row.id);

        const task = createTask({
          title: `⏰ [Automated] ${row.title}`,
          priority_id: 1,
          execution_priority: 1,
          pillar: 'Work & Mastery',
          notes: `Triggered by Scheduled Automation #${row.id} (${row.schedule_expr})`,
          energy_level: 'low',
          date: today()
        });

        return {
          ok: true,
          tool: 'schedule_automation',
          actionType: 'automation_executed',
          summary: `⚡ **Triggered Scheduled Automation [#${row.id}] ${row.title}** -> Added **[#${task.id}] ${task.title}** to Today's Priority Board.`,
          data: { automationId: row.id, taskId: task.id }
        };
      }

      if (action === 'delete' || action === 'cancel') {
        const id = parseInt(args?.id || '0', 10);
        if (id) {
          database.prepare('DELETE FROM companion_automations WHERE id = ?').run(id);
        } else if (args?.title) {
          database.prepare('DELETE FROM companion_automations WHERE title LIKE ?').run(`%${args.title}%`);
        }
        return {
          ok: true,
          tool: 'schedule_automation',
          actionType: 'automation_deleted',
          summary: `🗑️ Cancelled scheduled automation ${id ? `#${id}` : `"${args?.title || ''}"`}.`,
          data: { deleted: true }
        };
      }

      // Default: list automations
      const automations = database.prepare('SELECT * FROM companion_automations ORDER BY id DESC').all();
      const lines = automations.length > 0
        ? automations.map(a => `- **[#${a.id}] ${a.title}** — \`${a.schedule_expr}\` (${a.schedule_type}, runs: ${a.run_count})`)
        : ['- No active cron automations or timed reminders scheduled.'];
      return {
        ok: true,
        tool: 'schedule_automation',
        actionType: 'automations_listed',
        summary: `⏰ **Scheduled Cron Automations & Reminders (${automations.length})**:\n${lines.join('\n')}`,
        data: { count: automations.length, automations }
      };
    }
  },
  {
    name: 'smart_home_bridge',
    category: 'smart_home',
    description: 'Meta Muse / Hermes Smart Home (Home Assistant) & Multi-Channel Messaging Gateway: control smart home lights, thermostat/climate, locks, and scenes via Home Assistant (with local sovereign state twin), or send messages to Telegram, Discord, Slack, and webhooks.',
    parameters: {
      action: 'string (REQUIRED: "control_device" | "home_status" | "send_channel_message")',
      device: 'string (Target device or entity when controlling smart home, e.g. "office lights", "thermostat", "front door lock", "goodnight scene")',
      state: 'string (Desired state or value, e.g. "on", "off", "68", "locked", "activated")',
      channel: 'string (Messaging platform when action="send_channel_message": "telegram" | "discord" | "slack" | "webhook")',
      message: 'string (Message text to dispatch to Telegram, Discord, Slack, or webhook)'
    },
    required: ['action'],
    async execute(args, { fetchImpl = fetch, notesDir } = {}) {
      ensureExtendedCompanionTables();
      const action = String(args?.action || 'home_status').toLowerCase().trim();
      const database = getDb();

      if (action === 'send_channel_message' || ['telegram', 'discord', 'slack', 'webhook'].includes(action)) {
        const channel = String(args?.channel || (['telegram', 'discord', 'slack', 'webhook'].includes(action) ? action : 'telegram')).toLowerCase().trim();
        const message = String(args?.message || args?.text || args?.content || '').trim();
        if (!message) {
          return { ok: false, tool: 'smart_home_bridge', summary: 'Parameter "message" is required for send_channel_message.' };
        }

        let deliveredLive = false;
        let endpointUsed = `sovereign_local_outbox (${channel})`;

        try {
          if (channel === 'telegram' && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
            const tgUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
            const r = await fetchImpl(tgUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: message, parse_mode: 'Markdown' }),
              signal: AbortSignal.timeout(6000)
            });
            if (r.ok) {
              deliveredLive = true;
              endpointUsed = 'Telegram Bot API';
            }
          } else if (channel === 'discord' && process.env.DISCORD_WEBHOOK_URL) {
            const r = await fetchImpl(process.env.DISCORD_WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: message }),
              signal: AbortSignal.timeout(6000)
            });
            if (r.ok) {
              deliveredLive = true;
              endpointUsed = 'Discord Webhook';
            }
          } else if (channel === 'slack' && process.env.SLACK_WEBHOOK_URL) {
            const r = await fetchImpl(process.env.SLACK_WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: message }),
              signal: AbortSignal.timeout(6000)
            });
            if (r.ok) {
              deliveredLive = true;
              endpointUsed = 'Slack Webhook';
            }
          } else if (args?.webhookUrl && isSafePublicUrl(args.webhookUrl)) {
            const r = await fetchImpl(args.webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ channel, message, source: 'krusch-companion' }),
              signal: AbortSignal.timeout(6000)
            });
            if (r.ok) {
              deliveredLive = true;
              endpointUsed = args.webhookUrl;
            }
          }
        } catch {
          // Graceful fallback to local outbox mirror
        }

        const filename = toSafeNoteFilename(`channel-outbox-${channel}-${Date.now()}`);
        const targetDir = notesDir || getNotesDirectory();
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(
          path.join(targetDir, filename),
          `# 📡 Multi-Channel Outbox (${channel.toUpperCase()})\n- **Delivered Live**: ${deliveredLive}\n- **Endpoint**: ${endpointUsed}\n- **Timestamp**: ${new Date().toISOString()}\n\n${message}\n`,
          'utf-8'
        );

        return {
          ok: true,
          tool: 'smart_home_bridge',
          actionType: 'channel_message_sent',
          summary: `📡 **Dispatched Multi-Channel Message via ${channel.toUpperCase()}** (${endpointUsed}):\n> ${message}`,
          data: { channel, message, deliveredLive, endpointUsed, filename }
        };
      }

      if (action === 'control_device' || ['light', 'lights', 'thermostat', 'climate', 'lock', 'scene'].includes(action)) {
        const rawDevice = String(args?.device || args?.entity || 'office lights').trim();
        const rawState = String(args?.state || args?.value || 'on').trim();

        const lowerDev = rawDevice.toLowerCase();
        let entityId = 'light.office_lights';
        let domain = 'light';
        let friendlyName = rawDevice;

        if (lowerDev.includes('thermostat') || lowerDev.includes('temp') || lowerDev.includes('climate') || /^\d+$/.test(rawState)) {
          entityId = 'climate.home_thermostat';
          domain = 'climate';
          friendlyName = 'Home Thermostat';
        } else if (lowerDev.includes('lock') || lowerDev.includes('door')) {
          entityId = 'lock.front_door';
          domain = 'lock';
          friendlyName = 'Front Door Deadbolt';
        } else if (lowerDev.includes('scene') || lowerDev.includes('goodnight') || lowerDev.includes('focus')) {
          entityId = `scene.${toSafeNoteFilename(rawDevice).replace(/\.md$/, '').replace(/-/g, '_')}`;
          domain = 'scene';
          friendlyName = rawDevice;
        } else if (lowerDev.includes('living')) {
          entityId = 'light.living_room';
          domain = 'light';
          friendlyName = 'Living Room Lights';
        }

        const normalizedState = domain === 'climate' && /\d+/.test(rawState)
          ? `${rawState.replace(/[^0-9]/g, '')}°F`
          : rawState.toLowerCase();

        // Optional live Home Assistant REST API call if HOME_ASSISTANT_URL & HOME_ASSISTANT_TOKEN are set
        let haSynced = false;
        if (process.env.HOME_ASSISTANT_URL && process.env.HOME_ASSISTANT_TOKEN) {
          try {
            const haBase = process.env.HOME_ASSISTANT_URL.replace(/\/+$/, '');
            const service = domain === 'climate'
              ? 'set_temperature'
              : domain === 'lock'
                ? (normalizedState.includes('unlock') ? 'unlock' : 'lock')
                : normalizedState === 'off'
                  ? 'turn_off'
                  : 'turn_on';
            const r = await fetchImpl(`${haBase}/api/services/${domain}/${service}`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${process.env.HOME_ASSISTANT_TOKEN}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                entity_id: entityId,
                ...(domain === 'climate' ? { temperature: parseInt(rawState.replace(/[^0-9]/g, ''), 10) || 68 } : {})
              }),
              signal: AbortSignal.timeout(5000)
            });
            haSynced = r.ok;
          } catch {
            // Keep local state twin updated
          }
        }

        database.prepare(`
          INSERT INTO companion_devices (entity_id, friendly_name, domain, state, attributes_json, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(entity_id) DO UPDATE SET
            state = excluded.state,
            attributes_json = excluded.attributes_json,
            updated_at = datetime('now')
        `).run(entityId, friendlyName, domain, normalizedState, JSON.stringify({ haSynced, rawDevice }));

        return {
          ok: true,
          tool: 'smart_home_bridge',
          actionType: 'smart_home_control',
          summary: `🏠 **Smart Home Updated**: **${friendlyName}** (\`${entityId}\`) ➔ **\`${normalizedState.toUpperCase()}\`** ${haSynced ? '*(Synced with Home Assistant)*' : '*(Sovereign Local Device Twin)*'}`,
          data: { entityId, friendlyName, domain, state: normalizedState, haSynced }
        };
      }

      // Default: home_status
      const devices = database.prepare('SELECT * FROM companion_devices ORDER BY domain, entity_id').all();
      const lines = devices.map(d => `- **${d.friendly_name}** (\`${d.entity_id}\`): **\`${String(d.state).toUpperCase()}\`**`);
      return {
        ok: true,
        tool: 'smart_home_bridge',
        actionType: 'smart_home_status',
        summary: `🏠 **Sovereign Smart Home Status (${devices.length} devices)**:\n${lines.join('\n')}`,
        data: { devices }
      };
    }
  },
  {
    name: 'personal_crm_profile',
    category: 'personal_crm',
    description: 'OpenAI Dot Relationship CRM & Nous Hermes Evolving Persona Engine (SOUL.md, USER.md, MEMORY.md): save or look up people, relationships, birthdays/anniversaries, and gift ideas in your Personal CRM, or update and sync your portable SOUL.md / USER.md / MEMORY.md profile files.',
    parameters: {
      action: 'string (REQUIRED: "upsert_contact" | "lookup_contact" | "list_contacts" | "update_soul" | "update_user_profile" | "sync_markdown_profiles")',
      name: 'string (Person\'s name when managing CRM contacts, e.g. "Sarah" or "Alex Rivera")',
      relationship: 'string (OPTIONAL: Relationship type, e.g. "partner", "child", "family", "friend", "client", "colleague")',
      importantDates: 'string (OPTIONAL: Birthday, anniversary, or key dates, e.g. "Birthday: Nov 12, Anniversary: June 18")',
      giftIdeas: 'string (OPTIONAL: Gift ideas, favorite coffee/food, or interests, e.g. "Ceremonial matcha, fountain pens")',
      notes: 'string (OPTIONAL: Personal notes, persona directive for SOUL.md, or user trait for USER.md)'
    },
    required: ['action'],
    async execute(args, { notesDir } = {}) {
      ensureExtendedCompanionTables();
      const action = String(args?.action || 'list_contacts').toLowerCase().trim();
      const database = getDb();

      if (action === 'upsert_contact' || action === 'save_contact' || action === 'remember_person') {
        const name = String(args?.name || '').trim();
        if (!name) {
          return { ok: false, tool: 'personal_crm_profile', summary: 'Parameter "name" is required to save a contact in Personal CRM.' };
        }
        const relationship = String(args?.relationship || 'connection').trim();
        const importantDates = String(args?.importantDates || args?.dates || '').trim();
        const giftIdeas = String(args?.giftIdeas || args?.gifts || args?.preferences || '').trim();
        const notes = String(args?.notes || '').trim();

        const existing = database.prepare('SELECT * FROM companion_contacts WHERE LOWER(name) = LOWER(?)').get(name);
        if (existing) {
          database.prepare(`
            UPDATE companion_contacts
            SET relationship = COALESCE(NULLIF(?, ''), relationship),
                important_dates = COALESCE(NULLIF(?, ''), important_dates),
                gift_ideas = COALESCE(NULLIF(?, ''), gift_ideas),
                notes = COALESCE(NULLIF(?, ''), notes),
                last_contacted = date('now'),
                updated_at = datetime('now')
            WHERE id = ?
          `).run(relationship, importantDates, giftIdeas, notes, existing.id);
        } else {
          database.prepare(`
            INSERT INTO companion_contacts (name, relationship, important_dates, gift_ideas, notes, last_contacted)
            VALUES (?, ?, ?, ?, ?, date('now'))
          `).run(name, relationship, importantDates, giftIdeas, notes);
        }

        const contact = database.prepare('SELECT * FROM companion_contacts WHERE LOWER(name) = LOWER(?)').get(name);
        syncMarkdownProfileFiles({ notesDir });

        return {
          ok: true,
          tool: 'personal_crm_profile',
          actionType: 'crm_contact_saved',
          summary: `💝 **Saved to Personal Relationship CRM**: **${contact.name}** (*${contact.relationship}*)\n${contact.important_dates ? `- **Important Dates**: ${contact.important_dates}\n` : ''}${contact.gift_ideas ? `- **Gift Ideas & Preferences**: ${contact.gift_ideas}\n` : ''}${contact.notes ? `- **Notes**: ${contact.notes}` : ''}`.trim(),
          data: { contact }
        };
      }

      if (action === 'lookup_contact') {
        const q = String(args?.name || args?.query || '').trim();
        const rows = database.prepare(`
          SELECT * FROM companion_contacts
          WHERE name LIKE ? OR relationship LIKE ? OR gift_ideas LIKE ? OR notes LIKE ?
          ORDER BY updated_at DESC
        `).all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
        if (rows.length === 0) {
          return {
            ok: true,
            tool: 'personal_crm_profile',
            actionType: 'crm_lookup',
            summary: `💝 No contact matching "${q}" found in your Personal CRM.`,
            data: { contacts: [] }
          };
        }
        const lines = rows.map(c => `- **${c.name}** (*${c.relationship}*)${c.important_dates ? ` • 📅 ${c.important_dates}` : ''}${c.gift_ideas ? ` • 🎁 ${c.gift_ideas}` : ''}${c.notes ? ` — ${c.notes}` : ''}`);
        return {
          ok: true,
          tool: 'personal_crm_profile',
          actionType: 'crm_lookup',
          summary: `💝 **Personal Relationship CRM Match (${rows.length})**:\n${lines.join('\n')}`,
          data: { contacts: rows }
        };
      }

      if (action === 'update_soul' || action === 'update_user_profile' || action === 'sync_markdown_profiles') {
        const traitNote = String(args?.notes || args?.content || '').trim();
        if (traitNote) {
          rememberMemory({
            category: action === 'update_soul' ? 'invariant' : 'decision',
            content: `[${action === 'update_soul' ? 'SOUL.md Persona' : 'USER.md Profile'}] ${traitNote}`,
            key: action === 'update_soul' ? `soul_${Date.now()}` : `user_${Date.now()}`
          });
        }
        const synced = syncMarkdownProfileFiles({ notesDir });
        return {
          ok: true,
          tool: 'personal_crm_profile',
          actionType: 'markdown_profiles_synced',
          summary: `🧬 **Synced Evolving Persona & User Model Files** (\`SOUL.md\`, \`USER.md\`, \`MEMORY.md\`, \`CRM.md\`):\n- **SOUL.md**: \`${synced.soulPath}\`\n- **USER.md**: \`${synced.userPath}\`\n- **MEMORY.md**: \`${synced.memoryPath}\` (${synced.memoriesCount} active memories)\n- **CRM.md**: \`${synced.crmPath}\` (${synced.contactsCount} people)`,
          data: synced
        };
      }

      // Default: list_contacts
      const contacts = database.prepare('SELECT * FROM companion_contacts ORDER BY name ASC').all();
      const lines = contacts.length > 0
        ? contacts.map(c => `- **${c.name}** (*${c.relationship}*)${c.important_dates ? ` • 📅 ${c.important_dates}` : ''}${c.gift_ideas ? ` • 🎁 ${c.gift_ideas}` : ''}`)
        : ['- Your Personal CRM is currently empty. Tell me about important people, birthdays, or gift ideas anytime!'];
      return {
        ok: true,
        tool: 'personal_crm_profile',
        actionType: 'crm_listed',
        summary: `💝 **Personal Relationship CRM (${contacts.length} people)**:\n${lines.join('\n')}`,
        data: { count: contacts.length, contacts }
      };
    }
  }
];

/**
 * Opt-in Skylight Calendar 2 Connector Tool Plugin (`@krusch/companion-skylight-connector`).
 * Appended to COMPANION_TOOLS only when `ENABLE_SKYLIGHT_CONNECTOR=1` (preserving the default
 * 20-tool catalog token invariant), and always callable on demand via `executeCompanionTool('skylight_calendar', args)`
 * or `/api/skylight`.
 */
export const SKYLIGHT_CALENDAR_TOOL = {
  name: 'skylight_calendar',
  category: 'skylight_calendar',
  description:
    "Opt-in Skylight Calendar 2 Connector: sync Today's Priority Board tasks with Skylight Chores, push grocery/checklist items to Skylight Lists, schedule or pull Skylight Calendar events, manage Meal Plans, or send a Magic Import digest.",
  parameters: {
    action:
      'string (REQUIRED: "status" | "sync_tasks" | "pull_chores" | "push_list_items" | "plan_meal" | "list_meals" | "list_events" | "create_event" | "magic_import")',
    title: 'string (OPTIONAL: Event, chore, meal, or list item title)',
    items: 'array|string (OPTIONAL: Array or comma-separated list of grocery/checklist items for push_list_items)',
    listId: 'string (OPTIONAL: Skylight list ID or name, default: "grocery")',
    mealType: 'string (OPTIONAL: "breakfast" | "lunch" | "dinner" | "snack")',
    startTime: 'string (OPTIONAL: ISO-8601 start timestamp for create_event)',
    location: 'string (OPTIONAL: Event location for create_event)',
    date: 'string (OPTIONAL: Target YYYY-MM-DD date, defaults to today)',
    dryRun: 'boolean (OPTIONAL: Simulate sync without mutating remote Skylight cloud)'
  },
  required: ['action'],
  async execute(args = {}, context = {}) {
    try {
      const connectorModuleUrl = new URL(
        '../../../krusch-companion-skylight-connector/src/index.js',
        import.meta.url
      );
      const { createCompanionToolPlugin } = await import(connectorModuleUrl.href);
      const plugin = createCompanionToolPlugin({
        companionDbPath: config.db.path
      });
      return await plugin.execute(args, context);
    } catch (err) {
      return {
        ok: false,
        tool: 'skylight_calendar',
        summary: `Skylight Calendar 2 Connector unavailable: ${err.message}`
      };
    }
  }
};

if (process.env.ENABLE_SKYLIGHT_CONNECTOR === '1') {
  COMPANION_TOOLS.push(SKYLIGHT_CALENDAR_TOOL);
}


/**
 * Resolve the sandboxed skills directory (`data/skills/`) inside the companion data folder.
 */
export function getSkillsDirectory(customBaseDir = null) {
  const dataDir = customBaseDir || path.dirname(config.db.path);
  const skillsDir = path.join(dataDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }
  return skillsDir;
}

/**
 * Ensure SQLite tables for OpenClaw/Hermes Skills, Cron Automations, Smart Home State Twin,
 * and Personal Relationship CRM exist and are seeded with baseline defaults.
 */
export function ensureExtendedCompanionTables() {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS companion_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      triggers TEXT DEFAULT '',
      steps TEXT NOT NULL,
      tools_used TEXT DEFAULT '',
      source TEXT DEFAULT 'built_in',
      experience_count INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS companion_automations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      schedule_expr TEXT NOT NULL,
      schedule_type TEXT DEFAULT 'cron_recurring',
      action_type TEXT DEFAULT 'reminder',
      payload TEXT DEFAULT '{}',
      enabled INTEGER DEFAULT 1,
      last_run_at TEXT,
      next_run_at TEXT,
      run_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS companion_devices (
      entity_id TEXT PRIMARY KEY,
      friendly_name TEXT NOT NULL,
      domain TEXT NOT NULL,
      state TEXT NOT NULL,
      attributes_json TEXT DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS companion_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      relationship TEXT DEFAULT 'connection',
      email TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      important_dates TEXT DEFAULT '',
      gift_ideas TEXT DEFAULT '',
      preferences TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      last_contacted TEXT DEFAULT (date('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const skillCount = database.prepare('SELECT COUNT(*) as c FROM companion_skills').get()?.c || 0;
  if (skillCount === 0) {
    const seedSkills = [
      {
        slug: 'morning-executive-briefing',
        name: 'Morning Executive Briefing',
        description: 'Aggregates local weather, Google Calendar schedule, commute Leave-By alerts, and Lane 1 Must-Do tasks.',
        triggers: 'morning briefing, daily executive digest, start my day',
        steps: '1. Call get_weather for user home city\n2. Call gkrusch_calendar(list_events)\n3. Synthesize top Lane 1 Must-Happen-Today tasks',
        tools_used: 'get_weather, gkrusch_calendar, board_action'
      },
      {
        slug: 'vip-meeting-dossier',
        name: 'VIP Meeting Dossier Compiler',
        description: 'Compiles a 1-page pre-meeting brief combining Personal CRM notes, Google Drive RAG, and active Working Memory.',
        triggers: 'prepare for meeting, meeting prep dossier, client call brief',
        steps: '1. Look up attendees in personal_crm_profile\n2. Search related docs in gkrusch_drive or list_notes\n3. Save 1-page dossier via schedule_automation(action="meeting_prep")',
        tools_used: 'personal_crm_profile, gkrusch_drive, schedule_automation'
      }
    ];
    const insertSkill = database.prepare(`
      INSERT OR IGNORE INTO companion_skills (slug, name, description, triggers, steps, tools_used, source, experience_count)
      VALUES (?, ?, ?, ?, ?, ?, 'built_in', 1)
    `);
    for (const s of seedSkills) {
      insertSkill.run(s.slug, s.name, s.description, s.triggers, s.steps, s.tools_used);
    }
  }

  const deviceCount = database.prepare('SELECT COUNT(*) as c FROM companion_devices').get()?.c || 0;
  if (deviceCount === 0) {
    const seedDevices = [
      ['light.office_lights', 'Office Desk & Key Lights', 'light', 'on'],
      ['light.living_room', 'Living Room Ambient Lights', 'light', 'off'],
      ['climate.home_thermostat', 'Home Thermostat', 'climate', '68°F'],
      ['lock.front_door', 'Front Door Deadbolt', 'lock', 'locked'],
      ['scene.focus_mode', 'Deep Work Focus Scene', 'scene', 'ready'],
      ['scene.goodnight', 'Goodnight Lockdown Scene', 'scene', 'ready']
    ];
    const insertDev = database.prepare(`
      INSERT OR IGNORE INTO companion_devices (entity_id, friendly_name, domain, state)
      VALUES (?, ?, ?, ?)
    `);
    for (const [id, name, domain, state] of seedDevices) {
      insertDev.run(id, name, domain, state);
    }
  }
}

/**
 * Nous Hermes Self-Improving Learning Loop (Observe -> Plan -> Act -> Learn):
 * Automatically records or increments a procedural skill when a multi-step tool trajectory succeeds.
 */
export function recordLearnedTrajectorySkill({ prompt, blueprint, toolCalls = [], notesDir } = {}) {
  try {
    if (!Array.isArray(toolCalls) || toolCalls.length < 2) return null;
    ensureExtendedCompanionTables();
    const database = getDb();
    const toolChainSig = toolCalls.map(tc => tc.name).join(' -> ');
    const taskName = blueprint?.task_name || `Multi-Step ${toolCalls.map(t => t.name).join(' + ')}`;
    const slug = toSafeNoteFilename(`auto-${ toolCalls.map(t => t.name).join('-') }`).replace(/\.md$/, '');
    const description = `Auto-learned Hermes trajectory skill executing [${toolChainSig}]`;
    const steps = toolCalls.map((tc, i) => `${i + 1}. Execute \`${tc.name}\` with parameters \`${JSON.stringify(tc.arguments || {})}\``).join('\n');

    const existing = database.prepare('SELECT * FROM companion_skills WHERE slug = ?').get(slug);
    if (existing) {
      database.prepare(`
        UPDATE companion_skills
        SET experience_count = experience_count + 1, updated_at = datetime('now')
        WHERE slug = ?
      `).run(slug);
    } else {
      database.prepare(`
        INSERT INTO companion_skills (slug, name, description, triggers, steps, tools_used, source, experience_count)
        VALUES (?, ?, ?, ?, ?, ?, 'hermes_learning_loop', 1)
      `).run(slug, taskName, description, String(prompt || '').slice(0, 120), steps, toolChainSig);
    }

    const skillsDir = getSkillsDirectory(notesDir);
    const skillSubdir = path.join(skillsDir, slug);
    fs.mkdirSync(skillSubdir, { recursive: true });
    fs.writeFileSync(
      path.join(skillSubdir, 'SKILL.md'),
      `---\nname: ${slug}\ntitle: "${taskName.replace(/"/g, '\\"')}"\nsource: hermes_learning_loop\ntools_used: "${toolChainSig}"\n---\n\n# 🧠 Auto-Learned Trajectory Skill: ${taskName}\n\n${steps}\n`,
      'utf-8'
    );

    return database.prepare('SELECT * FROM companion_skills WHERE slug = ?').get(slug);
  } catch {
    return null;
  }
}

/**
 * Synchronize OpenClaw / Nous Hermes human-readable Markdown profile files:
 * `SOUL.md` (Assistant Persona), `USER.md` (Deepening User Model), `MEMORY.md`, and `CRM.md`.
 */
export function syncMarkdownProfileFiles({ notesDir } = {}) {
  ensureExtendedCompanionTables();
  const database = getDb();
  const targetDir = notesDir || getNotesDirectory();
  fs.mkdirSync(targetDir, { recursive: true });

  const memories = getActiveMemories();
  const contacts = database.prepare('SELECT * FROM companion_contacts ORDER BY name ASC').all();
  const skills = database.prepare('SELECT * FROM companion_skills ORDER BY experience_count DESC').all();
  const streak = getStreak();

  const soulEntries = memories.filter(m => m.category === 'invariant' || String(m.content).includes('SOUL.md'));
  const userEntries = memories.filter(m => m.category === 'decision' || m.category === 'lesson' || String(m.content).includes('USER.md'));

  const soulMd = [
    '# 🛡️ SOUL.md — Krusch Companion Sovereign Persona',
    '',
    '## Core Identity & Philosophy',
    '- **Role**: 100% private, local-first personal AI companion, executive chief-of-staff, and daily focus coach.',
    '- **Tone**: Warm, concise, action-oriented, zero-fluff, empathetic when cognitive load is high.',
    '- **Sovereignty Invariant**: Never leak personal thoughts, medical notes, or financial schedules to unauthorized cloud telemetry.',
    '',
    '## Active Persona Directives & Invariants',
    ...(soulEntries.length > 0 ? soulEntries.map(m => `- ${m.content}`) : ['- Prioritize Lane 1 (Must Happen Today — Deadlines & Provision) before non-urgent habits.'])
  ].join('\n') + '\n';

  const userMd = [
    '# 👤 USER.md — Evolving User Model (Nous Hermes / Dot Parity)',
    `*Updated: ${new Date().toISOString()} • Active Completion Streak: ${streak.streak} day(s)*`,
    '',
    '## Learned Preferences, Routines & Decisions',
    ...(userEntries.length > 0 ? userEntries.map(m => `- **[${m.category.toUpperCase()}]** ${m.content}`) : ['- Building daily momentum with Dual-Axis Priority Board.']),
    '',
    `## Key Relationships (${contacts.length})`,
    ...(contacts.length > 0 ? contacts.map(c => `- **${c.name}** (*${c.relationship}*)${c.important_dates ? ` — ${c.important_dates}` : ''}`) : ['- None recorded yet.']),
    '',
    `## Learned Procedural Skills (${skills.length})`,
    ...skills.slice(0, 8).map(s => `- \`${s.slug}\`: ${s.description} *(used ${s.experience_count}x)*`)
  ].join('\n') + '\n';

  const memoryMd = [
    '# 🧠 MEMORY.md — Portable Working Memory Mirror',
    `*Total Active Memories: ${memories.length}*`,
    '',
    ...memories.map(m => `- **[#${m.id} | ${m.category.toUpperCase()}]** ${m.content}`)
  ].join('\n') + '\n';

  const crmMd = [
    '# 💝 CRM.md — Personal Relationship & Gift Registry',
    '',
    ...(contacts.length > 0
      ? contacts.map(c => `## ${c.name} (${c.relationship})\n- **Dates**: ${c.important_dates || 'N/A'}\n- **Gift Ideas / Preferences**: ${c.gift_ideas || 'N/A'}\n- **Notes**: ${c.notes || 'N/A'}\n`)
      : ['No contacts saved yet.'])
  ].join('\n') + '\n';

  const soulPath = path.join(targetDir, 'SOUL.md');
  const userPath = path.join(targetDir, 'USER.md');
  const memoryPath = path.join(targetDir, 'MEMORY.md');
  const crmPath = path.join(targetDir, 'CRM.md');

  fs.writeFileSync(soulPath, soulMd, 'utf-8');
  fs.writeFileSync(userPath, userMd, 'utf-8');
  fs.writeFileSync(memoryPath, memoryMd, 'utf-8');
  fs.writeFileSync(crmPath, crmMd, 'utf-8');

  return {
    soulPath,
    userPath,
    memoryPath,
    crmPath,
    memoriesCount: memories.length,
    contactsCount: contacts.length,
    skillsCount: skills.length
  };
}

/**
 * Build a standards-compliant Google Wallet Generic Pass object + signed JWT (when GOOGLE_WALLET_ISSUER_ID
 * and GOOGLE_WALLET_PRIVATE_KEY are configured) or a zero-key Sovereign Mobile Pass fallback.
 */
export function buildGoogleWalletPassResult({
  title,
  subtitle = '',
  category = 'Krusch Companion Pass',
  location = '',
  startTime = '',
  leaveBy = '',
  openTableUrl = '',
  directionsUrl = '',
  notes = '',
  notesDir
}) {
  const issuerId = process.env.GOOGLE_WALLET_ISSUER_ID || '3388000000022999999';
  const objectSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const passId = `${issuerId}.krusch-companion-${objectSuffix}`;
  const classId = `${issuerId}.krusch_companion_generic_v1`;

  const genericObject = {
    id: passId,
    classId,
    genericType: 'GENERIC_TYPE_UNSPECIFIED',
    hexBackgroundColor: '#0b0c10',
    cardTitle: {
      defaultValue: { language: 'en-US', value: category }
    },
    subheader: {
      defaultValue: { language: 'en-US', value: subtitle || 'Sovereign Personal Companion' }
    },
    header: {
      defaultValue: { language: 'en-US', value: title }
    },
    textModulesData: [
      ...(leaveBy ? [{ id: 'leave_by', header: 'LEAVE BY', body: leaveBy }] : []),
      ...(location ? [{ id: 'location', header: 'LOCATION', body: location }] : []),
      ...(notes ? [{ id: 'notes', header: 'NOTES', body: notes }] : [])
    ],
    linksModuleData: {
      uris: [
        ...(openTableUrl ? [{ uri: openTableUrl, description: 'OpenTable Reservation', id: 'opentable' }] : []),
        ...(directionsUrl ? [{ uri: directionsUrl, description: 'Google Maps Directions', id: 'directions' }] : [])
      ]
    },
    barcode: {
      type: 'QR_CODE',
      value: `krusch://pass/${objectSuffix}`,
      alternateText: objectSuffix.toUpperCase()
    }
  };

  const claims = {
    iss: process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL || 'companion@krusch-sovereign.iam.gserviceaccount.com',
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    origins: ['http://localhost:3004', 'https://krusch.dev'],
    payload: {
      genericObjects: [genericObject]
    }
  };

  let mode = 'sovereign_pass_preview';
  let saveUrl = '';
  let signedJwt = '';

  const privateKeyPem = process.env.GOOGLE_WALLET_PRIVATE_KEY
    ? process.env.GOOGLE_WALLET_PRIVATE_KEY.replace(/\\n/g, '\n')
    : null;

  if (process.env.GOOGLE_WALLET_ISSUER_ID && privateKeyPem && privateKeyPem.includes('PRIVATE KEY')) {
    try {
      const b64Header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const b64Payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(`${b64Header}.${b64Payload}`);
      const sig = signer.sign(privateKeyPem, 'base64url');
      signedJwt = `${b64Header}.${b64Payload}.${sig}`;
      saveUrl = `https://pay.google.com/gp/v/save/${signedJwt}`;
      mode = 'google_wallet_jwt';
    } catch {
      // Fallback below if key is invalid
    }
  }

  if (!saveUrl) {
    const secret = process.env.AP2_SIGNING_SECRET || 'krusch-companion-local-wallet-secret';
    const b64Header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const b64Payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(`${b64Header}.${b64Payload}`).digest('base64url');
    signedJwt = `${b64Header}.${b64Payload}.${sig}`;
    // Provide a 1-click Google Calendar / Mobile Pass add link that works on every Android/iOS phone with zero setup
    const details = [subtitle, leaveBy ? `Leave By: ${leaveBy}` : '', openTableUrl ? `Booking: ${openTableUrl}` : '', notes].filter(Boolean).join('\n');
    saveUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(`📲 [Wallet Pass] ${title}`)}&location=${encodeURIComponent(location)}&details=${encodeURIComponent(details)}`;
  }

  const filename = toSafeNoteFilename(`wallet-pass-${title}`);
  const targetDir = notesDir || getNotesDirectory();
  fs.mkdirSync(targetDir, { recursive: true });
  const md = [
    `# 📲 Google Wallet Pass: ${title}`,
    `- **Pass ID**: \`${passId}\``,
    `- **Mode**: \`${mode}\``,
    `- **Subtitle**: ${subtitle || 'N/A'}`,
    ...(location ? [`- **Location**: ${location}`] : []),
    ...(leaveBy ? [`- **Leave By**: ${leaveBy}`] : []),
    `- **Save Link**: ${saveUrl}`,
    '',
    `## Google Wallet \`genericObjects\` Payload`,
    '```json',
    JSON.stringify(genericObject, null, 2),
    '```'
  ].join('\n');
  fs.writeFileSync(path.join(targetDir, filename), md, 'utf-8');

  return {
    passId,
    classId,
    mode,
    saveUrl,
    signedJwt,
    genericObject,
    filename
  };
}

/**
 * Create a cryptographically signed Google Agent Payments Protocol (AP2) Mandate bundle
 * (IntentMandate + CartMandate + PaymentMandate) and optionally mint a single-use virtual card.
 */
export async function createAp2PaymentMandateBundle({
  merchant,
  maxAmount,
  currency = 'USD',
  description = '',
  expiresHours = 24,
  fetchImpl = fetch,
  notesDir
}) {
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + expiresHours * 3600 * 1000).toISOString();
  const mandateId = `ap2_mandate_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  const intentMandate = {
    protocol: 'google-agentic-commerce/AP2',
    version: '0.1.0',
    type: 'AP2.IntentMandate',
    mandateId,
    issuer: 'krusch-companion-sovereign-wallet',
    issuedAt,
    expiresAt,
    constraints: {
      merchantName: merchant,
      merchantLocked: true,
      singleUse: true,
      maxAmount: Number(maxAmount.toFixed(2)),
      currency
    },
    userIntentDescription: description
  };

  const cartMandate = {
    type: 'AP2.CartMandate',
    mandateId,
    merchantName: merchant,
    lineItems: [
      {
        label: description || `Authorized purchase at ${merchant}`,
        maxPrice: Number(maxAmount.toFixed(2)),
        currency
      }
    ],
    totalCeiling: Number(maxAmount.toFixed(2)),
    currency
  };

  const paymentMandate = {
    type: 'AP2.PaymentMandate',
    mandateId,
    rail: process.env.PRIVACY_API_KEY ? 'privacy_single_use_virtual_card' : 'google_pay_agentic_checkout',
    googlePayPaymentDataRequest: {
      apiVersion: 2,
      apiVersionMinor: 0,
      allowedPaymentMethods: [
        {
          type: 'CARD',
          parameters: {
            allowedAuthMethods: ['PAN_ONLY', 'CRYPTOGRAM_3DS'],
            allowedCardNetworks: ['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER']
          },
          tokenizationSpecification: {
            type: 'PAYMENT_GATEWAY',
            parameters: {
              gateway: process.env.GOOGLE_PAY_GATEWAY || 'stripe',
              gatewayMerchantId: process.env.GOOGLE_PAY_MERCHANT_ID || 'krusch_companion_ap2'
            }
          }
        }
      ],
      merchantInfo: {
        merchantName: merchant
      },
      transactionInfo: {
        totalPriceStatus: 'FINAL',
        totalPrice: maxAmount.toFixed(2),
        currencyCode: currency
      }
    }
  };

  const signingSecret = process.env.AP2_SIGNING_SECRET || 'krusch-companion-ap2-sovereign-key';
  const canonicalString = JSON.stringify({ intentMandate, cartMandate, paymentMandate });
  const signature = crypto.createHmac('sha256', signingSecret).update(canonicalString).digest('hex');

  // Optional live integration with Privacy.com API if PRIVACY_API_KEY is configured
  let virtualCard = null;
  if (process.env.PRIVACY_API_KEY) {
    try {
      const res = await fetchImpl('https://api.privacy.com/v1/card', {
        method: 'POST',
        headers: {
          Authorization: `api-key ${process.env.PRIVACY_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type: 'SINGLE_USE',
          memo: `AP2: ${merchant}`.slice(0, 36),
          spend_limit: Math.round(maxAmount * 100),
          spend_limit_duration: 'TRANSACTION',
          state: 'OPEN'
        }),
        signal: AbortSignal.timeout(6000)
      });
      if (res.ok) {
        const cardData = await res.json();
        virtualCard = {
          provider: 'Privacy.com',
          token: cardData.token,
          last4: cardData.last_four || '4242',
          state: cardData.state || 'OPEN',
          spendLimitCents: Math.round(maxAmount * 100)
        };
      }
    } catch {
      // Non-fatal fallback to sovereign AP2 mandate receipt
    }
  }

  const filename = toSafeNoteFilename(`ap2-mandate-${merchant}-${mandateId.slice(-6)}`);
  const targetDir = notesDir || getNotesDirectory();
  fs.mkdirSync(targetDir, { recursive: true });
  const md = [
    `# 💳 Google AP2 Cryptographic Payment Mandate: ${merchant}`,
    `- **Mandate ID**: \`${mandateId}\``,
    `- **Hard Spend Ceiling**: **$${maxAmount.toFixed(2)} ${currency}** *(Single-Use, Merchant-Locked)*`,
    `- **Purpose**: ${description}`,
    `- **Issued At**: \`${issuedAt}\``,
    `- **Expires At**: \`${expiresAt}\``,
    `- **HMAC-SHA256 Signature**: \`${signature}\``,
    '',
    `## Verifiable AP2 Mandate Bundle (\`IntentMandate\` + \`CartMandate\` + \`PaymentMandate\`)`,
    '```json',
    JSON.stringify({ intentMandate, cartMandate, paymentMandate, signature, virtualCard }, null, 2),
    '```'
  ].join('\n');
  fs.writeFileSync(path.join(targetDir, filename), md, 'utf-8');

  return {
    mandateId,
    merchant,
    maxAmount,
    currency,
    description,
    issuedAt,
    expiresAt,
    signature,
    intentMandate,
    cartMandate,
    paymentMandate,
    virtualCard,
    filename
  };
}

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
 * (sending email, creating a calendar event, issuing a payment mandate, pushing a notification, or writing to Drive).
 */
export function isExternalSideEffectCall(name, args = {}) {
  const action = String(args?.action || '').toLowerCase();
  if (name === 'send_notification') return true;
  if (name === 'concierge_reservation') return true;
  if (name === 'ap2_payment_mandate') return true;
  if (name === 'gkrusch_gmail' && (action === 'send' || action === 'send_email' || action === 'draft' || action === 'create_draft')) return true;
  if (name === 'gkrusch_calendar' && (action.includes('create') || action.includes('schedule'))) return true;
  if (name === 'gkrusch_drive' && action === 'write') return true;
  if (name === 'smart_home_bridge' && (action === 'send_channel_message' || ['telegram', 'discord', 'slack', 'webhook'].includes(action) || String(args?.state || '').toLowerCase().includes('unlock'))) return true;
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
  if (name === 'skylight_calendar') {
    return COMPANION_TOOLS.find(t => t.name === 'skylight_calendar') || SKYLIGHT_CALENDAR_TOOL;
  }
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
