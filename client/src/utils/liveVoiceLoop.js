/**
 * Client-side 2-Way Spoken Voice Loop & TTS Playback Utility (INV-EXT-04)
 *
 * Bridges `/api/companion/tts` neural audio synthesis with browser
 * `window.speechSynthesis` fallback for hands-free conversational mode.
 */

let activeAudioInstance = null;
let activeSpeechFinalizer = null;
let speechGeneration = 0;

export function cleanSpokenPreview(rawText = '') {
  let text = String(rawText || '');
  if (!text.trim()) return '';

  text = text.replace(/<holodata[\s\S]*?<\/holodata>/gi, ' ');
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/https?:\/\/\S+/gi, (url) => {
    const trailing = url.match(/[.,!?;:)]+$/);
    return trailing ? `link${trailing[0]}` : 'link';
  });
  text = text.replace(/^\s*#{1,6}\s+/gm, '');
  text = text.replace(/^\s*[-*•+▸▹►]\s+/gm, '');
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  text = text.replace(/[`*_~#]/g, '');
  text = text.replace(/\s+/g, ' ').trim();

  if (text.length > 900) {
    text = `${text.slice(0, 897).trim()}...`;
  }
  return text;
}

export function stopSpeaking() {
  speechGeneration += 1;

  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // Ignore cancellation errors on restricted audio contexts
    }
  }

  if (activeAudioInstance) {
    try {
      activeAudioInstance.pause();
      activeAudioInstance.currentTime = 0;
    } catch {
      // Ignore audio reset errors
    }
    activeAudioInstance = null;
  }

  if (typeof activeSpeechFinalizer === 'function') {
    const fn = activeSpeechFinalizer;
    activeSpeechFinalizer = null;
    try {
      fn(false);
    } catch {
      // Ignore finalizer errors
    }
  }
}

export async function speakReplyText(
  rawText,
  {
    voice = 'af_heart',
    speed = 1.0,
    onStart,
    onEnd,
    onError,
    fetchImpl = typeof fetch === 'function' ? fetch : null
  } = {}
) {
  const cleanedFallback = cleanSpokenPreview(rawText);
  if (!cleanedFallback) {
    if (typeof onEnd === 'function') onEnd();
    return { ok: false, spoken: false };
  }

  stopSpeaking();
  const currentGeneration = ++speechGeneration;

  let ttsPayload = null;
  if (typeof fetchImpl === 'function') {
    try {
      const response = await fetchImpl('/api/companion/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: rawText, voice, speed })
      });
      if (response && response.ok) {
        ttsPayload = await response.json();
      }
    } catch (err) {
      if (currentGeneration === speechGeneration && typeof onError === 'function') {
        onError(err);
      }
    }
  }

  // Guard against stopSpeaking() or a newer speakReplyText() call firing while fetchImpl was in flight
  if (currentGeneration !== speechGeneration) {
    if (typeof onEnd === 'function') onEnd();
    return { ok: false, spoken: false, cancelled: true };
  }

  const spokenText = (ttsPayload && ttsPayload.cleanSpokenText) || cleanedFallback;
  const shouldUseNeuralAudio =
    ttsPayload &&
    ttsPayload.ok &&
    ttsPayload.useBrowserSpeechSynthesis === false &&
    Boolean(ttsPayload.audioBase64);

  if (shouldUseNeuralAudio && typeof Audio !== 'undefined') {
    const mimeType = ttsPayload.mimeType || 'audio/wav';
    const audio = new Audio(`data:${mimeType};base64,${ttsPayload.audioBase64}`);
    activeAudioInstance = audio;

    if (typeof onStart === 'function') onStart();

    return new Promise((resolve) => {
      let settled = false;
      const finalize = (okStatus) => {
        if (settled) return;
        settled = true;
        if (activeAudioInstance === audio) {
          activeAudioInstance = null;
        }
        if (activeSpeechFinalizer === finalize) {
          activeSpeechFinalizer = null;
        }
        if (typeof onEnd === 'function') onEnd();
        resolve({ ok: okStatus, provider: ttsPayload.provider || 'local_neural_tts', spokenText });
      };

      activeSpeechFinalizer = finalize;

      audio.onended = () => finalize(true);
      audio.onerror = (err) => {
        if (typeof onError === 'function') onError(err);
        finalize(false);
      };

      const playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((err) => {
          if (typeof onError === 'function') onError(err);
          finalize(false);
        });
      }
    });
  }

  if (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof SpeechSynthesisUtterance !== 'undefined'
  ) {
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(spokenText);
      utterance.rate = Number.isFinite(Number(speed)) && Number(speed) > 0 ? Number(speed) : 1.0;

      if (typeof onStart === 'function') onStart();

      return await new Promise((resolve) => {
        let settled = false;
        const finish = (okStatus) => {
          if (settled) return;
          settled = true;
          if (activeSpeechFinalizer === finish) {
            activeSpeechFinalizer = null;
          }
          if (typeof onEnd === 'function') onEnd();
          resolve({
            ok: okStatus,
            provider: (ttsPayload && ttsPayload.provider) || 'browser_speech_synthesis',
            spokenText
          });
        };

        activeSpeechFinalizer = finish;

        utterance.onend = () => finish(true);
        utterance.onerror = (err) => {
          if (typeof onError === 'function') onError(err);
          finish(false);
        };

        window.speechSynthesis.speak(utterance);
      });
    } catch (err) {
      if (typeof onError === 'function') onError(err);
      if (typeof onEnd === 'function') onEnd();
      return { ok: false, provider: 'fallback_silent', spokenText };
    }
  }

  if (typeof onStart === 'function') onStart();
  if (typeof onEnd === 'function') onEnd();
  return {
    ok: true,
    provider: (ttsPayload && ttsPayload.provider) || 'headless_speech_noop',
    spokenText
  };
}

/**
 * Create a stateful Live Voice Controller for 2-way spoken hands-free loops (SPEC-05).
 */
export function createLiveVoiceController({
  voice = 'af_heart',
  speed = 1.0,
  onSpeakingChange,
  onError,
  fetchImpl = typeof fetch === 'function' ? fetch : null
} = {}) {
  let enabled = false;
  let speaking = false;
  let activeSpeakToken = 0;

  const setSpeakingState = (next) => {
    speaking = Boolean(next);
    if (typeof onSpeakingChange === 'function') {
      onSpeakingChange(speaking);
    }
  };

  return {
    isEnabled: () => enabled,
    isSpeaking: () => speaking,
    setEnabled(next) {
      enabled = Boolean(next);
      if (!enabled) {
        activeSpeakToken += 1;
        stopSpeaking();
        setSpeakingState(false);
      }
      return enabled;
    },
    toggle() {
      return this.setEnabled(!enabled);
    },
    stop() {
      activeSpeakToken += 1;
      stopSpeaking();
      setSpeakingState(false);
    },
    async speak(rawText, overrides = {}) {
      const token = ++activeSpeakToken;
      return speakReplyText(rawText, {
        voice: overrides.voice || voice,
        speed: overrides.speed || speed,
        fetchImpl: overrides.fetchImpl || fetchImpl,
        onStart: () => {
          if (token === activeSpeakToken) setSpeakingState(true);
          if (typeof overrides.onStart === 'function') overrides.onStart();
        },
        onEnd: () => {
          if (token === activeSpeakToken) setSpeakingState(false);
          if (typeof overrides.onEnd === 'function') overrides.onEnd();
        },
        onError: (err) => {
          if (token === activeSpeakToken) setSpeakingState(false);
          if (typeof onError === 'function') onError(err);
          if (typeof overrides.onError === 'function') overrides.onError(err);
        }
      });
    }
  };
}
