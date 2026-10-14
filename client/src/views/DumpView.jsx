import React, { useState } from 'react';
import AudioRecorder from '../components/AudioRecorder';
import TierBadge from '../components/TierBadge';

const SAMPLE_THOUGHT_STREAM =
  "I need to pay the electric bill before 5pm today, call the dentist before 3pm to reschedule my cleaning, pick up the prescription from CVS, and finish reviewing the Q4 architecture spec. Also remember that my daughter's teacher requested a parent meeting next Thursday at 4pm, and we decided to keep Friday evenings reserved for family pizza night.";

export function DumpView({ onTasksCreated }) {
  const [text, setText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState(null);

  const runTextDump = async (rawText) => {
    const clean = (rawText || text).trim();
    if (!clean || isProcessing) return;

    setIsProcessing(true);
    setResult(null);

    try {
      const res = await fetch('/api/companion/dump', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: clean,
          autoSaveTasks: true,
          autoSaveMemories: true
        })
      });

      if (!res.ok) throw new Error(`Server returned ${res.status}`);

      const data = await res.json();
      setResult(data);
      if (onTasksCreated) onTasksCreated();
    } catch (err) {
      alert(`Dump processing failed: ${err.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAudioReady = async (audioBlob, browserTranscript = '') => {
    setIsProcessing(true);
    setResult(null);

    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.webm');

    try {
      const res = await fetch('/api/companion/voice', {
        method: 'POST',
        body: formData
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Voice upload error: ${res.status}`);
      }

      const data = await res.json();
      setResult(data);
      if (data.transcription) {
        setText(data.transcription);
      }
      if (onTasksCreated) onTasksCreated();
    } catch (err) {
      if (browserTranscript && browserTranscript.trim().length > 0) {
        setText(browserTranscript.trim());
        setIsProcessing(false);
        await runTextDump(browserTranscript.trim());
        return;
      }
      alert(`Local Whisper STT unavailable (${err.message}). Tip: Use Chrome/Edge/Safari for zero-config Browser Web Speech API transcription, or click "Try Sample Thought Stream" below.`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleProcessText = async (e) => {
    e?.preventDefault();
    await runTextDump(text);
  };

  const handleTrySample = async () => {
    setText(SAMPLE_THOUGHT_STREAM);
    await runTextDump(SAMPLE_THOUGHT_STREAM);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Voice Recorder Header */}
      <div className="glass-panel" style={{ padding: 24, textAlign: 'center' }}>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 800, marginBottom: 8 }}>
          🌊 Thought Stream
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem', maxWidth: 600, margin: '0 auto 20px' }}>
          Speak or write your unfiltered thoughts freely. Rambling thoughts, deadlines, and life commitments are automatically triaged into Dual-Axis Execution Priority Lanes, Life Pillar badges, and durable working memory.
        </p>

        <AudioRecorder
          onAudioReady={handleAudioReady}
          onLiveTranscript={(live) => setText(live)}
          isProcessing={isProcessing}
        />
      </div>

      {/* Text Area Form */}
      <form onSubmit={handleProcessText} className="glass-panel" style={{ padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          <label style={{ fontWeight: 600, fontSize: '0.9rem' }}>
            Or Type / Paste Your Thoughts:
          </label>
          <button
            id="btn-try-sample-stream"
            type="button"
            className="btn-secondary"
            onClick={handleTrySample}
            disabled={isProcessing}
            style={{ fontSize: '0.78rem', padding: '4px 12px', borderColor: 'var(--accent-cyan)', color: 'var(--accent-cyan)' }}
          >
            ✨ Try Sample Thought Stream (1-Click Demo)
          </button>
        </div>
        <textarea
          id="textarea-thought-stream"
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              handleProcessText(e);
            }
          }}
          placeholder="e.g. Need to call plumber about kitchen sink leak before 3pm, buy milk, remember that Sophia has piano lesson on Wednesday at 5, and feeling exhausted from yesterday's meeting..."
          disabled={isProcessing}
          style={{ resize: 'vertical', marginBottom: 14 }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => { setText(''); setResult(null); }}
            disabled={isProcessing || !text}
          >
            Clear
          </button>
          <button
            id="btn-process-dump"
            type="submit"
            className="btn-primary"
            disabled={isProcessing || !text.trim()}
          >
            {isProcessing ? '⚡ Triage Engine Running...' : '✨ Triage onto Dual-Axis Board'}
          </button>
        </div>
      </form>

      {/* Extraction Results */}
      {result && (
        <div className="glass-panel animate-fade-in" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', paddingBottom: 12 }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--accent-cyan)' }}>
              🎯 Dual-Axis Triage Complete
            </h3>
            <TierBadge tier={result.tierUsed} latencyMs={result.latencyMs} />
          </div>

          {/* Empathetic Note */}
          {result.companionNotes && (
            <div style={{ padding: '14px 18px', background: 'rgba(0, 240, 255, 0.08)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(0, 240, 255, 0.2)', fontStyle: 'italic', color: '#e2e8f0' }}>
              "{result.companionNotes}"
            </div>
          )}

          {/* Extracted Tasks */}
          <div>
            <h4 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: 10, color: 'var(--text-muted)' }}>
              SAVED TASKS ({result.savedTasks?.length || 0})
            </h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {result.savedTasks?.map((task) => (
                <div
                  key={task.id}
                  className="glass-card"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 10,
                    padding: '12px 16px',
                    borderLeft: `3px solid ${task.execution_lane_color || task.priority_color || '#3b82f6'}`
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: '1.2rem' }}>{task.execution_lane_emoji || task.priority_emoji}</span>
                    <div>
                      <div style={{ fontWeight: 600 }}>{task.title}</div>
                      {task.notes && (
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>{task.notes}</div>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span
                      style={{
                        fontSize: '0.72rem',
                        fontWeight: 700,
                        padding: '3px 8px',
                        borderRadius: 999,
                        background: `${task.execution_lane_color || '#ef4444'}20`,
                        border: `1px solid ${task.execution_lane_color || '#ef4444'}55`,
                        color: task.execution_lane_color || '#ef4444'
                      }}
                    >
                      {task.execution_lane_emoji || '⚡'} {task.execution_lane_short || 'High-Impact Focus'}
                    </span>
                    <span
                      style={{
                        fontSize: '0.72rem',
                        fontWeight: 700,
                        padding: '3px 8px',
                        borderRadius: 999,
                        background: `${task.pillar_color || task.priority_color || '#3b82f6'}18`,
                        border: `1px solid ${task.pillar_color || task.priority_color || '#3b82f6'}55`,
                        color: task.pillar_color || task.priority_color || '#3b82f6'
                      }}
                    >
                      {task.pillar_emoji || task.priority_emoji} {task.pillar_name || task.priority_name}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Extracted Memories */}
          {result.savedMemories?.length > 0 && (
            <div>
              <h4 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: 10, color: 'var(--text-muted)' }}>
                SAVED LIFE MEMORIES ({result.savedMemories.length})
              </h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {result.savedMemories.map((m) => (
                  <div
                    key={m.id}
                    className="glass-card"
                    style={{
                      padding: '10px 14px',
                      borderLeft: '3px solid var(--accent-purple)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between'
                    }}
                  >
                    <span>{m.content}</span>
                    <span style={{ fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--accent-purple)', fontFamily: 'var(--font-mono)' }}>
                      [{m.category}]
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default DumpView;
