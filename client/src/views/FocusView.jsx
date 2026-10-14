import React, { useState, useEffect } from 'react';

export function FocusView({ task, onTaskCompleted, onExitFocus }) {
  const [timeLeft, setTimeLeft] = useState(25 * 60);
  const [isRunning, setIsRunning] = useState(false);
  const [nudge, setNudge] = useState('');
  const [isNudgeLoading, setIsNudgeLoading] = useState(false);

  useEffect(() => {
    let timer = null;
    if (isRunning && timeLeft > 0) {
      timer = setInterval(() => setTimeLeft(prev => prev - 1), 1000);
    } else if (timeLeft === 0) {
      setIsRunning(false);
    }
    return () => clearInterval(timer);
  }, [isRunning, timeLeft]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        setIsRunning(prev => !prev);
      } else if (e.key === 'Escape') {
        if (onExitFocus) onExitFocus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onExitFocus]);

  const handleGetNudge = async () => {
    setIsNudgeLoading(true);
    try {
      const res = await fetch('/api/coach/nudge', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setNudge(data.nudge);
      }
    } catch (err) {
      setNudge('Just take a deep breath and start with 3 minutes.');
    } finally {
      setIsNudgeLoading(false);
    }
  };

  const handleComplete = async () => {
    if (task && onTaskCompleted) {
      await onTaskCompleted(task.id);
    }
    if (onExitFocus) onExitFocus();
  };

  const minutes = Math.floor(timeLeft / 60);
  const seconds = timeLeft % 60;
  const timeFormatted = `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '65vh', gap: 28, textAlign: 'center' }}>
      {/* Return button */}
      <div style={{ width: '100%', display: 'flex', justifyContent: 'flex-start' }}>
        <button className="btn-secondary" onClick={onExitFocus} style={{ fontSize: '0.85rem' }}>
          ← Back to Board
        </button>
      </div>

      {/* Focus Ring & Timer */}
      <div
        style={{
          width: 240,
          height: 240,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(0, 240, 255, 0.1) 0%, rgba(121, 40, 202, 0.05) 70%, transparent 100%)',
          border: '2px solid var(--accent-cyan)',
          boxShadow: '0 0 40px rgba(0, 240, 255, 0.35)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6
        }}
      >
        <span style={{ fontSize: '0.75rem', letterSpacing: '0.1em', color: 'var(--accent-cyan)', textTransform: 'uppercase', fontWeight: 700 }}>
          {isRunning ? 'FOCUS FLOW ACTIVE' : 'FOCUS TIMER'}
        </span>
        <span style={{ fontSize: '3.2rem', fontWeight: 800, fontFamily: 'var(--font-mono)', color: '#f8fafc' }}>
          {timeFormatted}
        </span>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button
            className="btn-secondary"
            onClick={() => setIsRunning(!isRunning)}
            style={{ padding: '4px 12px', fontSize: '0.8rem' }}
          >
            {isRunning ? 'Pause' : 'Start'}
          </button>
          <button
            className="btn-secondary"
            onClick={() => { setIsRunning(false); setTimeLeft(25 * 60); }}
            style={{ padding: '4px 10px', fontSize: '0.8rem' }}
          >
            Reset
          </button>
        </div>
      </div>

      {/* Target Task */}
      <div className="glass-panel" style={{ padding: '24px 32px', maxWidth: 620, width: '100%' }}>
        <span style={{ fontSize: '0.8rem', color: 'var(--accent-amber)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          CURRENT SINGLE-TASK MISSION
        </span>
        {task && (task.execution_lane_short || task.pillar_name) && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            {task.execution_lane_short && (
              <span
                style={{
                  fontSize: '0.74rem',
                  fontWeight: 700,
                  padding: '3px 10px',
                  borderRadius: 999,
                  background: `${task.execution_lane_color || '#ef4444'}22`,
                  border: `1px solid ${task.execution_lane_color || '#ef4444'}66`,
                  color: task.execution_lane_color || '#ef4444'
                }}
              >
                {task.execution_lane_emoji || '🚨'} {task.execution_lane_short}
              </span>
            )}
            {task.pillar_name && (
              <span
                style={{
                  fontSize: '0.74rem',
                  fontWeight: 700,
                  padding: '3px 10px',
                  borderRadius: 999,
                  background: `${task.pillar_color || '#f97316'}22`,
                  border: `1px solid ${task.pillar_color || '#f97316'}66`,
                  color: task.pillar_color || '#f97316'
                }}
              >
                {task.pillar_emoji || '🏠'} {task.pillar_name}
              </span>
            )}
          </div>
        )}
        <h2 style={{ fontSize: '1.5rem', fontWeight: 800, margin: '10px 0 16px' }}>
          {task ? task.title : 'Pick a task from Today to enter focus flow'}
        </h2>
        {task?.notes && (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: 16 }}>
            {task.notes}
          </p>
        )}

        <div style={{ display: 'flex', justifyContent: 'center', gap: 14 }}>
          <button
            id="btn-complete-focus-task"
            className="btn-primary"
            onClick={handleComplete}
            disabled={!task}
            style={{ padding: '14px 28px', fontSize: '1.05rem' }}
          >
            ✅ Complete Mission
          </button>
          <button
            id="btn-get-nudge"
            className="btn-secondary"
            onClick={handleGetNudge}
            disabled={isNudgeLoading}
            style={{ fontSize: '0.9rem' }}
          >
            {isNudgeLoading ? '✨ Coaching...' : '💡 Micro-Nudge'}
          </button>
        </div>
      </div>

      {/* Micro-Nudge Banner */}
      {nudge && (
        <div className="glass-card animate-fade-in" style={{ maxWidth: 540, width: '100%', borderLeft: '3px solid var(--accent-cyan)', fontStyle: 'italic', color: '#cbd5e1' }}>
          "{nudge}"
        </div>
      )}
    </div>
  );
}

export default FocusView;
