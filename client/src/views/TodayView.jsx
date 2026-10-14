import React, { useState, useEffect } from 'react';

const DEFAULT_EXECUTION_LANES = [
  {
    level: 1,
    key: 'must_do',
    name: 'Must Happen Today — Deadlines & Provision',
    shortName: 'Must Happen Today',
    emoji: '🚨',
    color: '#ef4444',
    description: 'Urgent life necessities, bills/invoices, hard deadlines, appointments & family provision.'
  },
  {
    level: 2,
    key: 'high_impact',
    name: 'High-Impact Focus — Move the Needle',
    shortName: 'High-Impact Focus',
    emoji: '⚡',
    color: '#38bdf8',
    description: 'Key daily deliverables, projects, family commitments & health goals.'
  },
  {
    level: 3,
    key: 'daily_habits',
    name: 'Daily Habits & Anchors',
    shortName: 'Daily Habits',
    emoji: '🌱',
    color: '#2dd4bf',
    description: 'Recurring daily grounding routines — never buries urgent deadlines or provision.'
  },
  {
    level: 4,
    key: 'backlog',
    name: 'Backlog — When Time Permits',
    shortName: 'Backlog',
    emoji: '📥',
    color: '#94a3b8',
    description: 'Low-urgency errands, ideas, and tasks that can wait.'
  }
];

const DEFAULT_LIFE_PILLARS = [
  { key: 'finance', name: 'Provision & Finance', emoji: '🏠', color: '#f59e0b', tier: 5 },
  { key: 'work', name: 'Work & Mastery', emoji: '🔧', color: '#60a5fa', tier: 5 },
  { key: 'family', name: 'Family & Partner', emoji: '💕', color: '#e8587a', tier: 2 },
  { key: 'kids', name: 'Children & Loved Ones', emoji: '👧', color: '#a78bfa', tier: 3 },
  { key: 'health', name: 'Health & Self', emoji: '💪', color: '#2dd4bf', tier: 4 },
  { key: 'values', name: 'Core Values & Faith', emoji: '🙏', color: '#f0c040', tier: 1 }
];

export function TodayView({ onFocusTaskSelected }) {
  const [priorities, setPriorities] = useState([]);
  const [lanes, setLanes] = useState(DEFAULT_EXECUTION_LANES);
  const [pillars, setPillars] = useState(DEFAULT_LIFE_PILLARS);
  const [tasks, setTasks] = useState([]);
  const [gamify, setGamify] = useState({ opted_in: false, points: 0, streak: 0 });
  const [newTitle, setNewTitle] = useState('');
  const [newExecPriority, setNewExecPriority] = useState(2);
  const [newPillar, setNewPillar] = useState('Work & Mastery');
  const [viewMode, setViewMode] = useState('execution'); // 'execution' | 'pillar'
  const [isLoading, setIsLoading] = useState(true);
  const [statusBanner, setStatusBanner] = useState(null);
  const [breakingDownId, setBreakingDownId] = useState(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [priRes, laneRes, taskRes, gamifyRes] = await Promise.all([
        fetch('/api/priorities'),
        fetch('/api/execution-lanes'),
        fetch('/api/tasks'),
        fetch('/api/gamify/today')
      ]);

      if (priRes.ok) setPriorities(await priRes.json());
      if (laneRes.ok) {
        const laneData = await laneRes.json();
        if (Array.isArray(laneData.lanes) && laneData.lanes.length > 0) setLanes(laneData.lanes);
        if (Array.isArray(laneData.pillars) && laneData.pillars.length > 0) setPillars(laneData.pillars);
      }
      if (taskRes.ok) setTasks(await taskRes.json());
      if (gamifyRes.ok) setGamify(await gamifyRes.json());
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRollover = async () => {
    try {
      const res = await fetch('/api/tasks/rollover', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data.rolledOverCount > 0) {
          setStatusBanner(`🔄 Rolled over ${data.rolledOverCount} unfinished task(s) from prior days.`);
          await loadData();
        } else {
          setStatusBanner('✨ No unfinished tasks from prior days to roll over.');
        }
        setTimeout(() => setStatusBanner(null), 4000);
      }
    } catch (err) {
      alert(`Rollover failed: ${err.message}`);
    }
  };

  const handleBreakdown = async (task) => {
    setBreakingDownId(task.id);
    try {
      const res = await fetch(`/api/tasks/${task.id}/breakdown`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.subtasks) && data.subtasks.length > 0) {
          setTasks(prev => [...prev, ...data.subtasks]);
          setStatusBanner(`🧩 Added ${data.subtasks.length} bite-sized steps for "${task.title}".`);
          setTimeout(() => setStatusBanner(null), 4500);
        }
      }
    } catch (err) {
      alert(`Breakdown failed: ${err.message}`);
    } finally {
      setBreakingDownId(null);
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

  const handlePromotePriority = async (task, targetExecLevel) => {
    try {
      const res = await fetch(`/api/tasks/${task.id}/priority`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ execution_priority: targetExecLevel })
      });
      if (res.ok) {
        const updated = await res.json();
        setTasks(prev => prev.map(t => (t.id === task.id ? updated : t)));
        setStatusBanner(
          targetExecLevel === 1
            ? `🚨 Promoted "${updated.title}" to Priority 1: Must Happen Today!`
            : `⚡ Moved "${updated.title}" to ${updated.execution_lane_short}.`
        );
        setTimeout(() => setStatusBanner(null), 3500);
      }
    } catch (err) {
      alert(`Failed to update priority: ${err.message}`);
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

    const selectedPillarMeta = pillars.find(p => p.name === newPillar) || DEFAULT_LIFE_PILLARS[1];
    const matchedPriority = priorities.find(p => p.tier === selectedPillarMeta.tier) || priorities[4];

    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newTitle.trim(),
          priority_id: matchedPriority ? matchedPriority.id : 5,
          execution_priority: Number(newExecPriority),
          pillar: selectedPillarMeta.name
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

  const renderTaskCard = (task, accentColor) => (
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
        opacity: task.completed ? 0.6 : 1,
        background: task.completed ? 'rgba(10, 14, 22, 0.4)' : 'var(--bg-glass-card)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 220 }}>
        <input
          type="checkbox"
          checked={Boolean(task.completed)}
          onChange={() => handleToggle(task.id)}
          style={{
            width: 20,
            height: 20,
            accentColor,
            cursor: 'pointer'
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span
              style={{
                textDecoration: task.completed ? 'line-through' : 'none',
                color: task.completed ? 'var(--text-dim)' : 'var(--text-main)',
                fontWeight: task.completed ? 400 : 600,
                fontSize: '0.95rem'
              }}
            >
              {task.title}
            </span>

            {/* Color-Coded Life Pillar Tag */}
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: '0.72rem',
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 999,
                background: `${task.pillar_color || '#60a5fa'}22`,
                color: task.pillar_color || '#60a5fa',
                border: `1px solid ${task.pillar_color || '#60a5fa'}55`
              }}
              title={`Life Pillar: ${task.pillar || task.priority_name}`}
            >
              <span>{task.pillar_emoji || task.priority_emoji}</span>
              <span>{task.pillar || task.priority_name}</span>
            </span>

            {/* Show Execution Priority badge when viewing by Life Pillar */}
            {viewMode === 'pillar' && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: '0.72rem',
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: `${task.execution_lane_color || '#38bdf8'}22`,
                  color: task.execution_lane_color || '#38bdf8',
                  border: `1px solid ${task.execution_lane_color || '#38bdf8'}55`
                }}
              >
                <span>{task.execution_lane_emoji}</span>
                <span>{task.execution_lane_short}</span>
              </span>
            )}
          </div>
          {task.notes && (
            <span style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
              {task.notes}
            </span>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {!task.completed && task.execution_priority !== 1 && (
          <button
            className="btn-secondary"
            onClick={() => handlePromotePriority(task, 1)}
            style={{
              padding: '4px 9px',
              fontSize: '0.73rem',
              borderColor: 'rgba(239, 68, 68, 0.45)',
              color: '#fca5a5'
            }}
            title="Pin to Priority 1: Must Happen Today (Deadlines & Provision)"
          >
            🚨 Must-Do
          </button>
        )}
        {!task.completed && task.execution_priority === 1 && (
          <button
            className="btn-secondary"
            onClick={() => handlePromotePriority(task, 2)}
            style={{ padding: '4px 9px', fontSize: '0.73rem' }}
            title="Move to Priority 2: High-Impact Focus"
          >
            ⚡ Focus
          </button>
        )}
        {!task.completed && (
          <button
            className="btn-secondary"
            onClick={() => handleBreakdown(task)}
            disabled={breakingDownId === task.id}
            style={{ padding: '4px 10px', fontSize: '0.75rem' }}
            title="Break down into 3 bite-sized steps"
          >
            {breakingDownId === task.id ? '⚡...' : '🧩 Steps'}
          </button>
        )}
        {!task.completed && onFocusTaskSelected && (
          <button
            className="btn-secondary"
            onClick={() => onFocusTaskSelected(task)}
            style={{ padding: '4px 10px', fontSize: '0.75rem', borderColor: accentColor }}
            title="Enter Single-Task Focus Mode"
          >
            🎯 Timer
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
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Top Banner: Progress, View Mode Switcher & Gamify */}
      <div className="glass-panel" style={{ padding: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 14 }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 800, marginBottom: 4 }}>
            Today's Priority Board ({completedCount}/{tasks.length} Completed)
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem' }}>
            Ranked by <strong>Execution Priority</strong> (Deadlines & Life Provision first) with color-coded <strong>Life Pillar</strong> tags.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {gamify.opted_in && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255, 183, 0, 0.15)', padding: '6px 14px', borderRadius: 'var(--radius-full)', border: '1px solid rgba(255, 183, 0, 0.3)' }}>
              <span style={{ fontSize: '1.1rem' }}>⭐</span>
              <span style={{ fontWeight: 700, color: 'var(--accent-amber)' }}>{gamify.points} pts</span>
            </div>
          )}
          <button
            id="btn-toggle-view-mode"
            className="btn-secondary"
            onClick={() => setViewMode(prev => (prev === 'execution' ? 'pillar' : 'execution'))}
            style={{ fontSize: '0.8rem', padding: '6px 12px' }}
            title="Switch between Execution Priority lanes and Life Pillar sections"
          >
            {viewMode === 'execution' ? '🧭 Group by Life Pillar' : '⚡ Group by Execution Priority'}
          </button>
          <button
            id="btn-rollover-tasks"
            className="btn-secondary"
            onClick={handleRollover}
            style={{ fontSize: '0.8rem', padding: '6px 12px' }}
            title="Move incomplete tasks from previous days onto today's board"
          >
            ↻ Roll Over Unfinished
          </button>
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

      {statusBanner && (
        <div
          className="glass-card"
          style={{
            padding: '10px 16px',
            borderLeft: '4px solid var(--accent-cyan)',
            color: 'var(--text-main)',
            fontSize: '0.88rem'
          }}
        >
          {statusBanner}
        </div>
      )}

      {/* Dual-Axis Add Task Form */}
      <form onSubmit={handleAddTask} className="glass-card" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <input
          id="input-new-task-title"
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Add a task (e.g., Pay electric bill before 5pm, Finish client proposal)..."
          style={{ flex: 1, minWidth: 220 }}
        />
        <select
          id="select-new-task-exec"
          value={newExecPriority}
          onChange={(e) => setNewExecPriority(e.target.value)}
          style={{ width: 'auto', minWidth: 195 }}
          title="Execution Priority (When it must happen today)"
        >
          {lanes.map(lane => (
            <option key={lane.level} value={lane.level}>
              {lane.emoji} P{lane.level}: {lane.shortName}
            </option>
          ))}
        </select>
        <select
          id="select-new-task-pillar"
          value={newPillar}
          onChange={(e) => setNewPillar(e.target.value)}
          style={{ width: 'auto', minWidth: 175 }}
          title="Life Pillar Tag (What domain of life it serves)"
        >
          {pillars.map(p => (
            <option key={p.key} value={p.name}>
              {p.emoji} {p.name}
            </option>
          ))}
        </select>
        <button id="btn-add-task" type="submit" className="btn-primary" disabled={!newTitle.trim()}>
          + Add
        </button>
      </form>

      {/* Priority Groups (Execution Priority View vs Life Pillar View) */}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-dim)' }}>
          Loading your sovereign priority board...
        </div>
      ) : viewMode === 'execution' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {lanes.map((lane) => {
            const laneTasks = tasks.filter(t => (t.execution_priority || 2) === lane.level);
            return (
              <div key={lane.level} className="glass-panel" style={{ padding: 18, borderLeft: `4px solid ${lane.color}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: '1.25rem' }}>{lane.emoji}</span>
                    <h3 style={{ fontSize: '1.05rem', fontWeight: 700 }}>
                      Priority {lane.level}: {lane.name}
                    </h3>
                  </div>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                    {laneTasks.filter(t => t.completed).length} / {laneTasks.length}
                  </span>
                </div>
                <p style={{ color: 'var(--text-dim)', fontSize: '0.8rem', marginBottom: 12 }}>
                  {lane.description}
                </p>

                {laneTasks.length === 0 ? (
                  <p style={{ color: 'var(--text-dim)', fontSize: '0.86rem', fontStyle: 'italic', paddingLeft: 6 }}>
                    {lane.level === 1
                      ? 'No urgent deadlines or provision items right now — click "🚨 Must-Do" on any task to pin it here.'
                      : 'No tasks in this lane yet.'}
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {laneTasks.map(task => renderTaskCard(task, lane.color))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {pillars.map((pillar) => {
            const pillarTasks = tasks.filter(t => (t.pillar || t.priority_name) === pillar.name);
            return (
              <div key={pillar.key} className="glass-panel" style={{ padding: 18, borderLeft: `4px solid ${pillar.color}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: '1.25rem' }}>{pillar.emoji}</span>
                    <h3 style={{ fontSize: '1.05rem', fontWeight: 700 }}>
                      {pillar.name}
                    </h3>
                  </div>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                    {pillarTasks.filter(t => t.completed).length} / {pillarTasks.length}
                  </span>
                </div>

                {pillarTasks.length === 0 ? (
                  <p style={{ color: 'var(--text-dim)', fontSize: '0.88rem', fontStyle: 'italic', paddingLeft: 6 }}>
                    No tasks tagged under this Life Pillar today.
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {pillarTasks.map(task => renderTaskCard(task, pillar.color))}
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
