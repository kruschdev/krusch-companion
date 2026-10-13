import React, { useState, useRef, useEffect } from 'react';

export function AudioRecorder({ onAudioReady, isProcessing }) {
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const mediaRecorderRef = useRef(null);
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        // Stop stream tracks
        stream.getTracks().forEach(track => track.stop());
        if (onAudioReady) {
          onAudioReady(audioBlob);
        }
      };

      // Set up AudioContext for waveform
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
        setDuration(prev => prev + 1);
      }, 1000);

      drawWaveform();
    } catch (err) {
      alert(`Microphone access error: ${err.message}. Please allow microphone permissions.`);
    }
  };

  const stopRecording = () => {
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
        title={isRecording ? 'Click to stop & analyze' : 'Click to start voice dump'}
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

      <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem' }}>
        {isRecording
          ? 'Listening... Talk freely. Unload everything on your mind.'
          : isProcessing
          ? 'Processing with local Cascade Router...'
          : 'Tap the mic to start an ADHD Chaos Dump'}
      </p>
    </div>
  );
}

export default AudioRecorder;
