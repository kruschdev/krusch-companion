import React, { useState, useEffect } from 'react';
import AudioRecorder from '../components/AudioRecorder';

const DRAFT_STORAGE_KEY = 'krusch_thought_stream_draft_v2';
const RESULT_STORAGE_KEY = 'krusch_thought_stream_last_result_v2';

export function DumpView({ onTasksCreated, onFocusTaskSelected }) {
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(DRAFT_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState(() => {
    try {
      const saved = localStorage.getItem(RESULT_STORAGE_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_STORAGE_KEY, text || '');
    } catch {
      // Non-fatal
    }
  }, [text]);

  useEffect(() => {
    try {
      if (result) {
        localStorage.setItem(RESULT_STORAGE_KEY, JSON.stringify(result));
      } else {
        localStorage.removeItem(RESULT_STORAGE_KEY);
      }
    } catch {
      // Non-fatal
    }
  }, [result]);

  const runTextDump = async (rawText) => {
    const clean = (rawText || text).trim();
    if (!clean || isProcessing) return;

    setIsProcessing(true);

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
      if (onTasksCreated) onTasksCreated(data.savedTasks || []);
    } catch (err) {
      alert(`Processing failed: ${err.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAudioReady = async (audioBlob, browserTranscript = '') => {
    setIsProcessing(true);

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
      if (onTasksCreated) onTasksCreated(data.savedTasks || []);
    } catch (err) {
      if (browserTranscript && browserTranscript.trim().length > 0) {
        setText(browserTranscript.trim());
        setIsProcessing(false);
        await runTextDump(browserTranscript.trim());
        return;
      }
      alert(`Voice transcription unavailable (${err.message}).`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleProcessText = async (e) => {
    e?.preventDefault();
    await runTextDump(text);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Voice + Text Thought Stream Panel */}
      <form onSubmit={handleProcessText} className="glass-panel" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ textAlign: 'center' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: 6 }}>
            🌊 Thought Stream
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            Speak or write your thoughts freely—we&apos;ll organize them into color-coded tasks and notes.
          </p>
        </div>

        <AudioRecorder
          onAudioReady={handleAudioReady}
          onLiveTranscript={(live) => setText(live)}
          isProcessing={isProcessing}
        />

        <textarea
          id="textarea-thought-stream"
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              handleProcessText(e);
            }
          }}
          placeholder="Or type your thoughts here..."
          disabled={isProcessing}
          style={{ resize: 'vertical' }}
        />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          {(text || result) && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => { setText(''); setResult(null); }}
              disabled={isProcessing}
            >
              Clear
            </button>
          )}
          <button
            id="btn-process-dump"
            type="submit"
            className="btn-primary"
            disabled={isProcessing || !text.trim()}
          >
            {isProcessing ? '⚡ Organizing...' : '✨ Add to Board'}
          </button>
        </div>
      </form>

      {/* Extracted Tasks & Notes with Color */}
      {result && (
        <div className="glass-panel animate-fade-in" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <h3 style={{ fontSize: '1.02rem', fontWeight: 700, color: 'var(--accent-cyan)' }}>
              ✨ Added to Today&apos;s Board ({result.savedTasks?.length || 0})
            </h3>
            {result.savedTasks?.length > 0 && onFocusTaskSelected && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => onFocusTaskSelected(result.savedTasks[0])}
                style={{ fontSize: '0.8rem', padding: '6px 14px' }}
              >
                🎯 Focus Top Task
              </button>
            )}
          </div>

          {result.companionNotes && (
            <div style={{ padding: '12px 16px', background: 'rgba(0, 240, 255, 0.08)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(0, 240, 255, 0.2)', fontStyle: 'italic', color: '#e2e8f0', fontSize: '0.9rem' }}>
              &ldquo;{result.companionNotes}&rdquo;
            </div>
          )}

          {result.savedTasks?.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {result.savedTasks.map((task) => {
                const laneColor = task.execution_lane_color || '#38bdf8';
                const pillarColor = task.pillar_color || task.priority_color || '#60a5fa';
                return (
                  <div
                    key={task.id}
                    className="glass-card"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: 10,
                      padding: '10px 14px',
                      borderLeft: `3px solid ${laneColor}`
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600 }}>{task.title}</span>
                      <span
                        style={{
                          fontSize: '0.72rem',
                          fontWeight: 600,
                          padding: '2px 8px',
                          borderRadius: 999,
                          background: `${pillarColor}22`,
                          color: pillarColor,
                          border: `1px solid ${pillarColor}55`
                        }}
                      >
                        {task.pillar_emoji || task.priority_emoji} {task.pillar_name || task.pillar || task.priority_name}
                      </span>
                    </div>
                    {onFocusTaskSelected && (
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => onFocusTaskSelected(task)}
                        style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                      >
                        🎯 Focus
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {result.savedMemories?.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                Saved Notes ({result.savedMemories.length})
              </span>
              {result.savedMemories.map((m) => (
                <div key={m.id} className="glass-card" style={{ padding: '8px 12px', fontSize: '0.88rem', borderLeft: '3px solid var(--accent-purple)' }}>
                  {m.content}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default DumpView;
