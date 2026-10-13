import http from 'http';
import config from '../config.js';

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
          resolve(result.text || '');
        } catch {
          resolve(data.trim());
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
