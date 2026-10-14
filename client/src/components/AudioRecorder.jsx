import React, { useState, useRef, useEffect } from 'react';

export function AudioRecorder({ onAudioReady, onLiveTranscript, isProcessing }) {
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [liveTranscript, setLiveTranscript] = useState('');
  const mediaRecorderRef = useRef(null);
  const recognitionRef = useRef(null);
  const transcriptBufferRef = useRef('');
  const audioChunksRef = useRef([]);
  const canvasRef = useRef(null);
  const animationFrameRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    return () => {
      stopRecording();
      if (timerRef.current) clearInterval(timerRef.current);
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
      }
    };
  }, []);

  const startRecording = async () => {
    try {
      audioChunksRef.current = [];
      transcriptBufferRef.current = '';
      setLiveTranscript('');

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      // Start Browser-Native Web Speech API in parallel as a zero-dependency STT fallback
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRecognition) {
        try {
          const recognition = new SpeechRecognition();
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.lang = 'en-US';
          recognition.onresult = (event) => {
            let combined = '';
            for (let i = 0; i < event.results.length; i++) {
              combined += event.results[i][0].transcript + ' ';
            }
            const clean = combined.trim();
            transcriptBufferRef.current = clean;
            setLiveTranscript(clean);
            if (onLiveTranscript) onLiveTranscript(clean);
          };
          recognition.start();
          recognitionRef.current = recognition;
        } catch {
          // Non-fatal if browser blocks SpeechRecognition
        }
      }

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType || 'audio/webm' });
        stream.getTracks().forEach((track) => track.stop());
        if (recognitionRef.current) {
          try {
            recognitionRef.current.stop();
          } catch {}
        }
        if (onAudioReady) {
          onAudioReady(audioBlob, transcriptBufferRef.current);
        }
      };

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = audioCtx.createAnalyser();
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);
      analyser.fftSize = 64;

      audioContextRef.current = audioCtx;
      analyserRef.current = analyser;

      mediaRecorder.start(250);
      setIsRecording(true);
      setDuration(0);

      timerRef.current = setInterval(() => {
        setDuration((prev) => prev + 1);
      }, 1000);

      drawWaveform();
    } catch (err) {
      alert(`Microphone access error: ${err.message}. Please allow microphone permissions or type directly below.`);
    }
  };

  const stopRecording = () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
    }
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (timerRef.current) clearInterval(timerRef.current);
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    }
  };

  const drawWaveform = () => {
    if (!canvasRef.current || !analyserRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const bufferLength = analyserRef.current.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const render = () => {
      analyserRef.current.getByteFrequencyData(dataArray);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 2;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * canvas.height;
        ctx.fillStyle = `rgba(0, 240, 255, ${0.4 + (dataArray[i] / 255) * 0.6})`;
        ctx.fillRect(x, canvas.height - barHeight, barWidth - 2, barHeight);
        x += barWidth;
      }

      animationFrameRef.current = requestAnimationFrame(render);
    };

    render();
  };

  const formatTime = (secs) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
      <button
        id="btn-voice-toggle"
        className={`btn-mic ${isRecording ? 'recording' : ''}`}
        onClick={isRecording ? stopRecording : startRecording}
        disabled={isProcessing}
        title={isRecording ? 'Click to stop & analyze' : 'Click to speak your thoughts'}
      >
        {isRecording ? '⏹️' : '🎙️'}
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <canvas
          ref={canvasRef}
          width={180}
          height={32}
          style={{
            display: isRecording ? 'block' : 'none',
            borderRadius: 6,
            background: 'rgba(0, 0, 0, 0.2)'
          }}
        />
        {isRecording && (
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-rose)', fontWeight: 600 }}>
            REC {formatTime(duration)}
          </span>
        )}
      </div>

      {liveTranscript && isRecording && (
        <div style={{ fontSize: '0.82rem', color: 'var(--accent-cyan)', maxWidth: 520, fontStyle: 'italic' }}>
          “{liveTranscript}”
        </div>
      )}

      <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem' }}>
        {isRecording
          ? 'Listening (Whisper STT + Browser Web Speech API fallback active)...'
          : isProcessing
          ? 'Processing with Cascade Router...'
          : 'Tap the mic to speak your Thought Stream (works with local Whisper or Browser Web Speech API)'}
      </p>
    </div>
  );
}

export default AudioRecorder;
