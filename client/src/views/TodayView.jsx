import React, { useState, useEffect } from 'react';

export function TodayView({ onFocusTaskSelected }) {
  const [priorities, setPriorities] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [gamify, setGamify] = useState({ opted_in: false, points: 0, streak: 0 });
  const [newTitle, setNewTitle] = useState('');
  const [newTier, setNewTier] = useState(5);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [priRes, taskRes, gamifyRes] = await Promise.all([
        fetch('/api/priorities'),
        fetch('/api/tasks'),
        fetch('/api/gamify/today')
      ]);

      if (priRes.ok) setPriorities(await priRes.json());
      if (taskRes.ok) setTasks(await taskRes.json());
      if (gamifyRes.ok) setGamify(await gamifyRes.json());
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleToggle = async (id) => {
    try {
      const res = await fetch(`/api/tasks/${id}/complete`, { method: 'PATCH' });
      if (res.ok) {
        const updated = await res.json();
        setTasks(prev => prev.map(t => (t.id === id ? updated : t)));
        if (updated.gamify) {
          setGamify(prev => ({ ...prev, points: updated.gamify.points }));
        }
      }
    } catch (err) {
      alert(`Error toggling task: ${err.message}`);
    }
  };

  const handleDelete = async (id) => {
    try {
      const res = await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setTasks(prev => prev.filter(t => t.id !== id));
      }
    } catch (err) {
      alert(`Error deleting task: ${err.message}`);
    }
  };

  const handleAddTask = async (e) => {
    e.preventDefault();
    if (!newTitle.trim()) return;

    const matchedPriority = priorities.find(p => p.tier === Number(newTier)) || priorities[4];
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newTitle.trim(),
          priority_id: matchedPriority ? matchedPriority.id : 5
        })
      });

      if (res.ok) {
        const created = await res.json();
        setTasks(prev => [...prev, created]);
        setNewTitle('');
      }
    } catch (err) {
      alert(`Error adding task: ${err.message}`);
    }
  };

  const handleToggleGamify = async () => {
    try {
      const res = await fetch('/api/gamify/opt-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optedIn: !gamify.opted_in })
      });
      if (res.ok) {
        const updated = await res.json();
        setGamify(prev => ({ ...prev, opted_in: updated.opted_in }));
      }
    } catch (err) {
      alert(`Gamify toggle failed: ${err.message}`);
    }
  };

  const completedCount = tasks.filter(t => t.completed).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Top Banner: Progress & Gamify */}
      <div className="glass-panel" style={{ padding: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 14 }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 800, marginBottom: 4 }}>
            Today's Priorities ({completedCount}/{tasks.length} Completed)
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem' }}>
            Anchored to your 5-tier values framework. Highest tiers come first.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {gamify.opted_in && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255, 183, 0, 0.15)', padding: '6px 14px', borderRadius: 'var(--radius-full)', border: '1px solid rgba(255, 183, 0, 0.3)' }}>
              <span style={{ fontSize: '1.1rem' }}>⭐</span>
              <span style={{ fontWeight: 700, color: 'var(--accent-amber)' }}>{gamify.points} pts</span>
            </div>
          )}
          <button
            id="btn-toggle-gamify"
            className="btn-secondary"
            onClick={handleToggleGamify}
            style={{ fontSize: '0.8rem', padding: '6px 12px' }}
          >
            {gamify.opted_in ? '🎮 Gamify Active' : '🎮 Enable Gamify'}
          </button>
        </div>
      </div>

      {/* Add Task Form */}
      <form onSubmit={handleAddTask} className="glass-card" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <input
          id="input-new-task-title"
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Quick add a new task..."
          style={{ flex: 1, minWidth: 200 }}
        />
        <select
          id="select-new-task-tier"
          value={newTier}
          onChange={(e) => setNewTier(e.target.value)}
          style={{ width: 'auto', minWidth: 160 }}
        >
          {priorities.map(p => (
            <option key={p.id} value={p.tier}>
              Tier {p.tier}: {p.name}
            </option>
          ))}
        </select>
        <button id="btn-add-task" type="submit" className="btn-primary" disabled={!newTitle.trim()}>
          + Add
        </button>
      </form>

      {/* Priority Groups */}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-dim)' }}>
          Loading your sovereign task list...
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {priorities.map((priority) => {
            const tierTasks = tasks.filter(t => t.priority_id === priority.id || t.tier === priority.tier);
            return (
              <div key={priority.id} className="glass-panel" style={{ padding: 18, borderLeft: `4px solid ${priority.color}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: '1.25rem' }}>{priority.emoji}</span>
                    <h3 style={{ fontSize: '1.05rem', fontWeight: 700 }}>
                      Tier {priority.tier}: {priority.name}
                    </h3>
                  </div>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                    {tierTasks.filter(t => t.completed).length} / {tierTasks.length}
                  </span>
                </div>

                {tierTasks.length === 0 ? (
                  <p style={{ color: 'var(--text-dim)', fontSize: '0.88rem', fontStyle: 'italic', paddingLeft: 6 }}>
                    No tasks under this priority yet.
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {tierTasks.map((task) => (
                      <div
                        key={task.id}
                        className="glass-card"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '10px 14px',
                          opacity: task.completed ? 0.6 : 1,
                          background: task.completed ? 'rgba(10, 14, 22, 0.4)' : 'var(--bg-glass-card)'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
                          <input
                            type="checkbox"
                            checked={Boolean(task.completed)}
                            onChange={() => handleToggle(task.id)}
                            style={{
                              width: 20,
                              height: 20,
                              accentColor: priority.color,
                              cursor: 'pointer'
                            }}
                          />
                          <span
                            style={{
                              textDecoration: task.completed ? 'line-through' : 'none',
                              color: task.completed ? 'var(--text-dim)' : 'var(--text-main)',
                              fontWeight: task.completed ? 400 : 500,
                              fontSize: '0.95rem'
                            }}
                          >
                            {task.title}
                          </span>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {!task.completed && onFocusTaskSelected && (
                            <button
                              className="btn-secondary"
                              onClick={() => onFocusTaskSelected(task)}
                              style={{ padding: '4px 10px', fontSize: '0.75rem', borderColor: priority.color }}
                              title="Enter Single-Task Focus Mode"
                            >
                              🎯 Focus
                            </button>
                          )}
                          <button
                            onClick={() => handleDelete(task.id)}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: 'var(--text-dim)',
                              cursor: 'pointer',
                              fontSize: '1rem',
                              padding: 4
                            }}
                            title="Delete Task"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default TodayView;
