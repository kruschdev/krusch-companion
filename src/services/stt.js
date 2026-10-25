import http from 'http';
import config from '../config.js';

export function normalizeSpokenTranscript(rawText = '') {
  let text = String(rawText || '').trim();
  if (!text) return '';

  // 1. Fix spoken 4-digit street numbers split by Whisper: "11.6 to 1" or "11 6 to 1" -> "1161"
  text = text.replace(/\b(\d{1,2})[.\s]+(\d)\s+to\s+(\d)\b/gi, '$1$2$3');
  text = text.replace(
    /\b(\d{2})\.(\d{2})(?=\s+(?:North|South|East|West|N\b|S\b|E\b|W\b|[A-Z][a-z]+\s+(?:St|Street|Ave|Avenue|Dr|Drive|Blvd|Boulevard|Rd|Road|Way|Ln|Lane)))/g,
    '$1$2'
  );

  // 2. Apply optional custom phonetic replacements from STT_PHONETIC_REPLACEMENTS ("regex=>Replacement;regex2=>Replacement2")
  const rawRules = String(process.env.STT_PHONETIC_REPLACEMENTS || '').trim();
  if (rawRules) {
    for (const pair of rawRules.split(';')) {
      const idx = pair.indexOf('=>');
      if (idx <= 0) continue;
      const pattern = pair.slice(0, idx).trim();
      const replacement = pair.slice(idx + 2).trim();
      if (!pattern) continue;
      try {
        text = text.replace(new RegExp(pattern, 'gi'), replacement);
      } catch {
        // Ignore malformed user regex rule
      }
    }
  }

  // 3. Fix spoken / period time formatting ("at 3.30" -> "at 3:30", "at three thirty" -> "at 3:30")
  text = text.replace(/\b(at|by|around|before|after)\s+(\d{1,2})\.(\d{2})\b/gi, '$1 $2:$3');
  const wordHours = {
    one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
    seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12'
  };
  const wordMins = {
    'fifteen': '15', 'thirty': '30', 'forty-five': '45', 'forty five': '45',
    'ten': '10', 'twenty': '20', 'forty': '40', 'fifty': '50'
  };
  text = text.replace(
    /\b(at|by|around|for)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(fifteen|thirty|forty-five|forty five|ten|twenty|forty|fifty)\b/gi,
    (_m, prep, hr, mn) => `${prep} ${wordHours[hr.toLowerCase()]}:${wordMins[mn.toLowerCase()]}`
  );

  return text;
}

export async function transcribeAudio(audioBuffer, filename = 'audio.webm') {
  if (!config.whisper.enabled) {
    throw new Error('Local Whisper service is disabled in config');
  }

  return new Promise((resolve, reject) => {
    const boundary = '----KruschCompanionBoundary' + Date.now();
    const ext = (filename.split('.').pop() || 'webm').toLowerCase();
    const mimeTypes = {
      webm: 'audio/webm',
      m4a: 'audio/mp4',
      mp4: 'audio/mp4',
      wav: 'audio/wav',
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg'
    };
    const mimeType = mimeTypes[ext] || 'application/octet-stream';

    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="audio_file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, audioBuffer, footer]);

    const options = {
      hostname: config.whisper.host,
      port: config.whisper.port,
      path: '/asr?task=transcribe&language=en&output=json',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      },
      timeout: 30000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(normalizeSpokenTranscript(result.text || ''));
        } catch {
          resolve(normalizeSpokenTranscript(data.trim()));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Whisper STT service error: ${err.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Whisper STT service timeout (30s)'));
    });

    req.write(body);
    req.end();
  });
}
