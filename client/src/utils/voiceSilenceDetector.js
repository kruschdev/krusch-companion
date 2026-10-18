import { logClientBoundaryWarning } from './companionClient';

export function resolveAudioContextConstructor() {
  if (typeof window === 'undefined') return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

/**
 * Attaches an Adaptive Web Audio API Voice Activity & Silence Detector (VAD) to a MediaStream.
 * Uses percentile noise-floor tracking + gentle continuation hysteresis so natural mid-sentence
 * thinking pauses (2-3 seconds) or softer trailing words never cut the speaker off early.
 *
 * @param {MediaStream} stream - Active microphone MediaStream
 * @param {Object} options
 * @param {number} [options.silenceMs=3200] - Milliseconds of continuous silence after speech before auto-stopping
 * @param {number} [options.noSpeechTimeoutMs=12000] - Auto-stop if no speech detected within this window
 * @param {number} [options.maxDurationMs=60000] - Safety cap so recording never hangs indefinitely
 * @param {Function} options.onSilenceStop - Callback invoked when silence threshold is reached
 * @returns {{ markSpeechActivity: () => void, stop: () => void }}
 */
export function attachSilenceDetector(
  stream,
  {
    silenceMs = 3200,
    noSpeechTimeoutMs = 12000,
    maxDurationMs = 60000,
    onSilenceStop
  } = {}
) {
  let audioCtx = null;
  let intervalId = null;
  let stopped = false;
  let hasSpoken = false;
  let activeFrames = 0;
  const startTime = Date.now();
  let lastSpeechTime = startTime;

  const rmsHistory = [];
  let noiseFloor = 0.035;
  let peakSpeechRms = 0;

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (audioCtx && audioCtx.state !== 'closed') {
      audioCtx.close().catch((err) => {
        logClientBoundaryWarning('voiceSilenceDetector.close', err);
      });
    }
  };

  const triggerStop = () => {
    if (stopped) return;
    cleanup();
    if (typeof onSilenceStop === 'function') {
      onSilenceStop();
    }
  };

  try {
    const AudioContextClass = resolveAudioContextConstructor();
    if (!AudioContextClass) {
      return { markSpeechActivity: () => {}, stop: cleanup };
    }

    audioCtx = new AudioContextClass();
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch((err) => {
        logClientBoundaryWarning('voiceSilenceDetector.resume', err);
      });
    }

    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.fftSize);

    intervalId = setInterval(() => {
      if (stopped) return;
      analyser.getByteTimeDomainData(dataArray);

      let sumSquares = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const norm = (dataArray[i] - 128) / 128;
        sumSquares += norm * norm;
      }
      const rms = Math.sqrt(sumSquares / dataArray.length);
      const now = Date.now();

      rmsHistory.push(rms);
      if (rmsHistory.length > 50) {
        rmsHistory.shift();
      }

      // Compute 20th-percentile RMS as ambient noise floor
      const sorted = [...rmsHistory].sort((a, b) => a - b);
      const p20Index = Math.max(0, Math.floor(sorted.length * 0.2));
      noiseFloor = Math.max(0.008, Math.min(0.12, sorted[p20Index]));

      const peakDelta = Math.max(0, peakSpeechRms - noiseFloor);
      // Once speaking has started, use a forgiving continuation threshold (18% of peak delta)
      // so quieter words or mid-thought murmurs ("um", "uh") keep extending the window.
      const speechThreshold = hasSpoken
        ? Math.max(noiseFloor * 1.4, noiseFloor + 0.015, noiseFloor + peakDelta * 0.18)
        : Math.max(noiseFloor * 1.6, noiseFloor + 0.02);

      if (now - startTime >= 250 && rms >= speechThreshold) {
        activeFrames += 1;
        lastSpeechTime = now;
        if (rms > peakSpeechRms) {
          peakSpeechRms = rms;
        }
        if (activeFrames >= 2) {
          hasSpoken = true;
        }
      } else {
        activeFrames = Math.max(0, activeFrames - 1);
      }

      if (hasSpoken && now - lastSpeechTime >= silenceMs) {
        triggerStop();
      } else if (!hasSpoken && now - startTime >= noSpeechTimeoutMs) {
        triggerStop();
      } else if (now - startTime >= maxDurationMs) {
        triggerStop();
      }
    }, 100);
  } catch (err) {
    logClientBoundaryWarning('voiceSilenceDetector.init', err);
  }

  return {
    markSpeechActivity: () => {
      hasSpoken = true;
      lastSpeechTime = Date.now();
    },
    stop: cleanup
  };
}
