/**
 * Sovereign 2-Way Spoken Voice Mode & Local TTS Engine (INV-EXT-04)
 *
 * Provides text sanitization for natural spoken output, local neural TTS
 * synthesis (Piper / Kokoro / OpenAI-compatible endpoints), and a deterministic
 * 16-bit mono RIFF/WAVE PCM fallback generator so `/api/companion/tts` always
 * returns a playable WAV payload alongside browser Web Speech metadata.
 */

export function cleanTextForSpeech(rawText = '', maxChars = 900) {
  let text = String(rawText || '');
  if (!text.trim()) return '';

  // 1. Strip <holodata>...</holodata> cognitive blueprint blocks
  text = text.replace(/<holodata[\s\S]*?<\/holodata>/gi, ' ');

  // 2. Strip fenced code blocks (```...```)
  text = text.replace(/```[\s\S]*?```/g, ' ');

  // 3. Replace URLs with spoken word 'link' (preserving trailing sentence punctuation)
  text = text.replace(/https?:\/\/\S+/gi, (url) => {
    const trailing = url.match(/[.,!?;:)]+$/);
    return trailing ? `link${trailing[0]}` : 'link';
  });

  // 4. Strip Markdown headings (#), blockquotes (>), and leading bullet markers
  text = text.replace(/^\s*#{1,6}\s+/gm, '');
  text = text.replace(/^\s*>\s+/gm, '');
  text = text.replace(/^\s*[-*•+▸▹►]\s+/gm, '');

  // 5. Convert Markdown links [label](url) -> label
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');

  // 6. Strip inline code backticks and bold/italic/strikethrough markers
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/`/g, '');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/~~([^~]+)~~/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/\b_([^_]+)_\b/g, '$1');
  text = text.replace(/[*_#]/g, '');

  // 7. Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();

  // 8. Truncate gracefully at sentence boundaries if exceeding maxChars
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 900;
  if (text.length > limit) {
    const slice = text.slice(0, limit);
    const minBoundaryIdx = Math.floor(limit * 0.4);
    const lastPeriod = Math.max(
      slice.lastIndexOf('. '),
      slice.lastIndexOf('! '),
      slice.lastIndexOf('? ')
    );
    if (lastPeriod >= minBoundaryIdx) {
      text = slice.slice(0, lastPeriod + 1).trim();
    } else {
      const lastSpace = slice.lastIndexOf(' ');
      text = (lastSpace >= minBoundaryIdx ? slice.slice(0, lastSpace) : slice).trim();
    }
  }

  return text;
}

export function buildFallbackWavBuffer(text = '', sampleRate = 16000) {
  const clean = String(text || '');
  const rate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? Math.floor(sampleRate) : 16000;

  // Duration between 150ms and 300ms proportional to text length
  const durationMs = Math.min(300, Math.max(150, 150 + Math.min(clean.length, 150)));
  const numSamples = Math.max(1, Math.floor((rate * durationMs) / 1000));
  const numChannels = 1;
  const bytesPerSample = 2; // 16-bit PCM
  const dataSize = numSamples * numChannels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  // 44-byte RIFF/WAVE PCM header
  buffer.write('RIFF', 0, 4, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 4, 'ascii');
  buffer.write('fmt ', 12, 4, 'ascii');
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * numChannels * bytesPerSample, 28); // ByteRate
  buffer.writeUInt16LE(numChannels * bytesPerSample, 32); // BlockAlign
  buffer.writeUInt16LE(16, 34); // BitsPerSample
  buffer.write('data', 36, 4, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  // Soft harmonic envelope tone so the WAV buffer is genuine, playable audio
  const freqPrimary = 528;
  const freqHarmonic = 660;
  for (let i = 0; i < numSamples; i++) {
    const t = i / rate;
    const progress = i / numSamples;
    const envelope = Math.sin(Math.PI * progress);
    const wave =
      0.7 * Math.sin(2 * Math.PI * freqPrimary * t) +
      0.3 * Math.sin(2 * Math.PI * freqHarmonic * t);
    const sample = Math.max(-32768, Math.min(32767, Math.round(envelope * wave * 4200)));
    buffer.writeInt16LE(sample, 44 + i * 2);
  }

  return buffer;
}

export async function synthesizeSpeech({
  text,
  voice = 'af_heart',
  speed = 1.0,
  fetchImpl = fetch
} = {}) {
  const cleanSpokenText = cleanTextForSpeech(text);
  if (!cleanSpokenText) {
    return {
      ok: false,
      error: 'Text is required for TTS synthesis'
    };
  }

  const normalizedSpeed = Number.isFinite(Number(speed)) && Number(speed) > 0 ? Number(speed) : 1.0;
  const wordCount = cleanSpokenText.split(/\s+/).filter(Boolean).length;
  const estimatedDurationMs = Math.max(400, Math.round(((wordCount / 2.6) * 1000) / normalizedSpeed));

  const ttsServerUrl = String(process.env.TTS_SERVER_URL || '').trim();
  if (ttsServerUrl && process.env.MOCK_LLM !== '1' && typeof fetchImpl === 'function') {
    try {
      const endpoint = ttsServerUrl.endsWith('/v1/audio/speech')
        ? ttsServerUrl
        : `${ttsServerUrl.replace(/\/+$/, '')}/v1/audio/speech`;

      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'tts-1',
          input: cleanSpokenText,
          voice,
          speed: normalizedSpeed,
          response_format: 'wav'
        }),
        signal: AbortSignal.timeout(8000)
      });

      if (response && response.ok) {
        const arrayBuf = await response.arrayBuffer();
        const audioBuf = Buffer.from(arrayBuf);
        if (audioBuf.length > 44) {
          return {
            ok: true,
            provider: 'local_neural_tts',
            voice,
            speed: normalizedSpeed,
            cleanSpokenText,
            audioBase64: audioBuf.toString('base64'),
            audioBuffer: audioBuf,
            mimeType: 'audio/wav',
            useBrowserSpeechSynthesis: false,
            estimatedDurationMs
          };
        }
      }
    } catch {
      // Fall through cleanly to sovereign WAV + Web Speech fallback (INV-EXT-04)
    }
  }

  const wavBuf = buildFallbackWavBuffer(cleanSpokenText);
  return {
    ok: true,
    provider: 'sovereign_wav_and_web_speech',
    voice,
    speed: normalizedSpeed,
    cleanSpokenText,
    audioBase64: wavBuf.toString('base64'),
    audioBuffer: wavBuf,
    mimeType: 'audio/wav',
    useBrowserSpeechSynthesis: true,
    estimatedDurationMs
  };
}
