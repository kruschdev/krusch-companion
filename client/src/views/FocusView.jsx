import React, { useState, useEffect } from 'react';

export function FocusView({ task, onSelectTask, onTaskCompleted }) {
  const [timeLeft, setTimeLeft] = useState(25 * 60);
  const [isRunning, setIsRunning] = useState(false);
  const [pendingTasks, setPendingTasks] = useState([]);

  const loadPendingTasks = async () => {
    try {
      const res = await fetch('/api/tasks');
      if (res.ok) {
        const all = await res.json();
        const incomplete = (Array.isArray(all) ? all : []).filter(t => !t.completed);
        incomplete.sort((a, b) => {
          const epA = a.execution_priority || 3;
          const epB = b.execution_priority || 3;
          if (epA !== epB) return epA - epB;
          return (a.tier || 5) - (b.tier || 5);
        });
        setPendingTasks(incomplete);
        if ((!task || task.completed) && incomplete.length > 0 && onSelectTask) {
          onSelectTask(incomplete[0]);
        }
      }
    } catch {
      // Non-fatal
    }
  };

  useEffect(() => {
    let active = true;
    fetch('/api/tasks')
      .then((res) => (res.ok ? res.json() : null))
      .then((all) => {
        if (!active || !all) return;
        const incomplete = (Array.isArray(all) ? all : []).filter(t => !t.completed);
        incomplete.sort((a, b) => {
          const epA = a.execution_priority || 3;
          const epB = b.execution_priority || 3;
          if (epA !== epB) return epA - epB;
          return (a.tier || 5) - (b.tier || 5);
        });
        setPendingTasks(incomplete);
        if ((!task || task.completed) && incomplete.length > 0 && onSelectTask) {
          onSelectTask(incomplete[0]);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [task, onSelectTask]);

  useEffect(() => {
    if (!isRunning || timeLeft <= 0) return undefined;
    const timer = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          setIsRunning(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [isRunning, timeLeft]);

  const activeTask = task || pendingTasks[0] || null;

  const handleComplete = async () => {
    if (activeTask && onTaskCompleted) {
      await onTaskCompleted(activeTask.id);
      await loadPendingTasks();
    }
  };

  const minutes = Math.floor(timeLeft / 60);
  const seconds = timeLeft % 60;
  const timeFormatted = `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '65vh', gap: 20, textAlign: 'center' }}>
      {/* Focus Timer Circle */}
      <div
        style={{
          width: 210,
          height: 210,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(0, 240, 255, 0.08) 0%, transparent 70%)',
          border: '2px solid var(--accent-cyan)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6
        }}
      >
        <span style={{ fontSize: '2.9rem', fontWeight: 800, fontFamily: 'var(--font-mono)', color: '#f8fafc' }}>
          {timeFormatted}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
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

      {/* Current Focus Task */}
      <div className="glass-panel" style={{ padding: '22px 28px', maxWidth: 580, width: '100%' }}>
        <h2 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: 14 }}>
          {activeTask ? activeTask.title : 'No open tasks right now.'}
        </h2>

        {activeTask && (
          <button
            id="btn-complete-focus-task"
            className="btn-primary"
            onClick={handleComplete}
            style={{ padding: '12px 24px', fontSize: '0.98rem' }}
          >
            ✅ Mark Complete
          </button>
        )}
      </div>

      {/* Simple Up Next Switcher */}
      {pendingTasks.length > 1 && (
        <div className="glass-panel" style={{ padding: '14px 18px', maxWidth: 580, width: '100%', textAlign: 'left' }}>
          <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8 }}>
            Switch task:
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pendingTasks.map((pt) => {
              const isSelected = activeTask && pt.id === activeTask.id;
              return (
                <button
                  key={pt.id}
                  type="button"
                  onClick={() => onSelectTask && onSelectTask(pt)}
                  className="glass-card"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '8px 12px',
                    cursor: 'pointer',
                    textAlign: 'left',
                    border: isSelected ? '1px solid var(--accent-cyan)' : '1px solid var(--border-subtle)',
                    background: isSelected ? 'rgba(0, 240, 255, 0.10)' : 'rgba(255, 255, 255, 0.02)',
                    color: '#f8fafc',
                    fontSize: '0.86rem'
                  }}
                >
                  <span>{pt.title}</span>
                  {isSelected && <span style={{ fontSize: '0.75rem', color: 'var(--accent-cyan)' }}>Active</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default FocusView;
