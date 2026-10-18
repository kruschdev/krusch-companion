import React, { useState, useEffect, useRef } from 'react';
import { attachSilenceDetector } from '../utils/voiceSilenceDetector';

const DEFAULT_EXECUTION_LANES = [
  {
    level: 1,
    key: 'must_do',
    name: 'Must Happen Today',
    shortName: 'Must Happen Today',
    emoji: '🚨',
    color: '#ef4444'
  },
  {
    level: 2,
    key: 'high_impact',
    name: 'High-Impact Focus',
    shortName: 'High-Impact Focus',
    emoji: '⚡',
    color: '#38bdf8'
  },
  {
    level: 3,
    key: 'daily_habits',
    name: 'Daily Habits & Anchors',
    shortName: 'Daily Habits',
    emoji: '🌱',
    color: '#2dd4bf'
  },
  {
    level: 4,
    key: 'backlog',
    name: 'Backlog',
    shortName: 'Backlog',
    emoji: '📥',
    color: '#94a3b8'
  }
];

const DEFAULT_LIFE_PILLARS = [
  { key: 'finance', name: 'Provision & Finance', emoji: '🏠', color: '#f59e0b', tier: 5 },
  { key: 'family', name: 'Family & Partner', emoji: '💕', color: '#e8587a', tier: 2 },
  { key: 'kids', name: 'Children & Loved Ones', emoji: '👧', color: '#a78bfa', tier: 3 },
  { key: 'health', name: 'Health & Self', emoji: '💪', color: '#2dd4bf', tier: 4 },
  { key: 'values', name: 'Core Values & Faith', emoji: '🙏', color: '#f0c040', tier: 1 },
  { key: 'work', name: 'Work & Mastery', emoji: '🔧', color: '#60a5fa', tier: 5 }
];

export function TodayView({ sessionId = 'default-session', onFocusTaskSelected }) {
  const [lanes, setLanes] = useState(DEFAULT_EXECUTION_LANES);
  const [pillars, setPillars] = useState(DEFAULT_LIFE_PILLARS);
  const [tasks, setTasks] = useState([]);
  const [companionInput, setCompanionInput] = useState('');
  const [companionReply, setCompanionReply] = useState(null);
  const [isSendingCompanion, setIsSendingCompanion] = useState(false);
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [isTranscribingVoice, setIsTranscribingVoice] = useState(false);
  const [viewMode, setViewMode] = useState('execution'); // 'execution' | 'pillar'
  const [isLoading, setIsLoading] = useState(true);
  const [addingListTaskId, setAddingListTaskId] = useState(null);
  const [newListItems, setNewListItems] = useState('');

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const speechRecRef = useRef(null);
  const silenceDetectorRef = useRef(null);
  const liveTranscriptRef = useRef('');

  const stopVoiceRecording = () => {
    setIsRecordingVoice(false);
    if (silenceDetectorRef.current) {
      silenceDetectorRef.current.stop();
      silenceDetectorRef.current = null;
    }
    if (speechRecRef.current) {
      try {
        speechRecRef.current.stop();
      } catch {
        // ignore
      }
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // ignore
      }
    }
  };

  const loadData = async (silent = false) => {
    if (!silent) setIsLoading(true);
    try {
      const [laneRes, taskRes] = await Promise.all([
        fetch('/api/execution-lanes'),
        fetch('/api/tasks')
      ]);

      if (laneRes.ok) {
        const laneData = await laneRes.json();
        if (Array.isArray(laneData.lanes) && laneData.lanes.length > 0) setLanes(laneData.lanes);
        if (Array.isArray(laneData.pillars) && laneData.pillars.length > 0) setPillars(laneData.pillars);
      }
      if (taskRes.ok) setTasks(await taskRes.json());
    } catch (err) {
      console.error('Failed to load tasks:', err);
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    Promise.all([fetch('/api/execution-lanes'), fetch('/api/tasks')])
      .then(async ([laneRes, taskRes]) => {
        if (!active) return;
        if (laneRes.ok) {
          const laneData = await laneRes.json();
          if (Array.isArray(laneData.lanes) && laneData.lanes.length > 0) setLanes(laneData.lanes);
          if (Array.isArray(laneData.pillars) && laneData.pillars.length > 0) setPillars(laneData.pillars);
        }
        if (taskRes.ok) setTasks(await taskRes.json());
      })
      .catch((err) => {
        console.error('Failed to load tasks:', err);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
      stopVoiceRecording();
    };
  }, []);

  const sendBoardCompanionPrompt = async (rawPrompt) => {
    const clean = String(rawPrompt || '').trim();
    if (!clean || isSendingCompanion) return;

    setCompanionInput('');
    setIsSendingCompanion(true);
    try {
      const res = await fetch('/api/companion/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: clean,
          sessionId: sessionId || 'default-session',
          boardContext: true,
          activeView: 'today_board'
        })
      });

      if (res.ok) {
        const data = await res.json();
        const cleanReply = String(data.reply || '')
          .replace(/\*\*/g, '')
          .replace(/^>\s*/gm, '');
        setCompanionReply(cleanReply || null);
        await loadData(true);
      }
    } catch (err) {
      setCompanionReply(`⚠️ Could not reach companion: ${err.message}`);
    } finally {
      setIsSendingCompanion(false);
    }
  };

  const handleCompanionSubmit = async (e) => {
    e?.preventDefault();
    await sendBoardCompanionPrompt(companionInput);
  };

  const handleToggleVoice = async () => {
    if (isRecordingVoice) {
      stopVoiceRecording();
      return;
    }

    liveTranscriptRef.current = companionInput ? `${companionInput.trim()} ` : '';

    const SpeechRecognition =
      typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (SpeechRecognition) {
      try {
        const rec = new SpeechRecognition();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = 'en-US';
        rec.onresult = (event) => {
          let finalChunk = '';
          let interimChunk = '';
          for (let i = 0; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
              finalChunk += `${transcript} `;
            } else {
              interimChunk += transcript;
            }
          }
          const combined = `${finalChunk}${interimChunk}`.trim();
          if (combined) {
            liveTranscriptRef.current = combined;
            setCompanionInput(combined);
            silenceDetectorRef.current?.markSpeechActivity();
          }
        };
        rec.onerror = () => {};
        rec.start();
        speechRecRef.current = rec;
      } catch {
        // Fallback to MediaRecorder Whisper STT
      }
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true
        }
      });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];

      silenceDetectorRef.current = attachSilenceDetector(stream, {
        silenceMs: 3200,
        noSpeechTimeoutMs: 12000,
        onSilenceStop: () => {
          stopVoiceRecording();
        }
      });

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        if (silenceDetectorRef.current) {
          silenceDetectorRef.current.stop();
          silenceDetectorRef.current = null;
        }
        stream.getTracks().forEach(t => t.stop());
        const browserText = liveTranscriptRef.current.trim();
        if (browserText.length > 0) {
          await sendBoardCompanionPrompt(browserText);
          return;
        }

        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        if (blob.size < 200) return;

        setIsTranscribingVoice(true);
        try {
          const formData = new FormData();
          formData.append('audio', blob, 'board-voice.webm');
          const res = await fetch('/api/companion/transcribe', {
            method: 'POST',
            body: formData
          });
          if (res.ok) {
            const data = await res.json();
            const cleanTranscript = String(data.transcription || '').trim();
            if (cleanTranscript) {
              await sendBoardCompanionPrompt(cleanTranscript);
            }
          }
        } catch (err) {
          setCompanionReply(`⚠️ Voice transcription unavailable (${err.message})`);
        } finally {
          setIsTranscribingVoice(false);
        }
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecordingVoice(true);
    } catch (err) {
      if (speechRecRef.current) {
        setIsRecordingVoice(true);
      } else {
        setCompanionReply(`⚠️ Microphone unavailable: ${err.message}`);
      }
    }
  };

  const handleToggle = async (id) => {
    try {
      const res = await fetch(`/api/tasks/${id}/complete`, { method: 'PATCH' });
      if (res.ok) {
        const updated = await res.json();
        setTasks(prev => prev.map(t => (t.id === id ? updated : t)));
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
      }
    } catch (err) {
      alert(`Failed to update priority: ${err.message}`);
    }
  };

  const handleAddListToTask = async (taskId) => {
    const clean = String(newListItems || '').trim();
    if (!clean) return;
    try {
      const res = await fetch('/api/companion/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: 'board_action',
          arguments: {
            action: 'add_list_to_task',
            title: `#${taskId}`,
            items: clean
          }
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.data?.task) {
          setTasks(prev => prev.map(t => (t.id === taskId ? data.data.task : t)));
        } else {
          await loadData(true);
        }
        setNewListItems('');
        setAddingListTaskId(null);
      }
    } catch (err) {
      alert(`Failed to add list to task: ${err.message}`);
    }
  };

  const handleToggleChecklistItem = async (taskId, index) => {
    try {
      const res = await fetch('/api/companion/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: 'board_action',
          arguments: {
            action: 'toggle_checklist_item',
            title: `#${taskId}`,
            index
          }
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.data?.task) {
          setTasks(prev => prev.map(t => (t.id === taskId ? data.data.task : t)));
        }
      }
    } catch (err) {
      alert(`Failed to toggle checklist item: ${err.message}`);
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

  const handleClearCompleted = async () => {
    try {
      const res = await fetch('/api/tasks/bulk-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear_completed' })
      });
      if (res.ok) {
        await loadData(true);
      }
    } catch (err) {
      alert(`Failed to clear completed tasks: ${err.message}`);
    }
  };

  const completedCount = tasks.filter(t => t.completed).length;

  const renderTaskCard = (task, accentColor) => {
    const pillarColor = task.pillar_color || '#f59e0b';
    const execColor = task.execution_lane_color || accentColor || '#38bdf8';

    return (
      <div
        key={task.id}
        className="glass-card"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          padding: '12px 14px',
          borderLeft: `3px solid ${pillarColor}`,
          opacity: task.completed ? 0.58 : 1,
          background: task.completed ? 'rgba(10, 14, 22, 0.38)' : 'var(--bg-glass-card)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flex: 1, minWidth: 220 }}>
          <input
            type="checkbox"
            checked={Boolean(task.completed)}
            onChange={() => handleToggle(task.id)}
            style={{
              width: 20,
              height: 20,
              marginTop: 2,
              accentColor: accentColor || pillarColor,
              cursor: 'pointer'
            }}
          />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span
                style={{
                  textDecoration: task.completed ? 'line-through' : 'none',
                  color: task.completed ? 'var(--text-dim)' : 'var(--text-main)',
                  fontWeight: task.completed ? 400 : 600,
                  fontSize: '0.96rem'
                }}
              >
                {task.title}
              </span>

              {/* Color-Coded Life Pillar Pill */}
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: '0.73rem',
                  fontWeight: 600,
                  padding: '2px 9px',
                  borderRadius: 999,
                  background: `${pillarColor}22`,
                  color: pillarColor,
                  border: `1px solid ${pillarColor}55`
                }}
              >
                <span>{task.pillar_emoji || task.priority_emoji}</span>
                <span>{task.pillar || task.priority_name}</span>
              </span>

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
                    background: `${execColor}22`,
                    color: execColor,
                    border: `1px solid ${execColor}55`
                  }}
                >
                  <span>{task.execution_lane_emoji}</span>
                  <span>{task.execution_lane_short}</span>
                </span>
              )}
            </div>

            {/* Interactive Checklist Sub-Items */}
            {Array.isArray(task.checklist) && task.checklist.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 2 }}>
                {task.checklist.map((item) => (
                  <label
                    key={item.index}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: '0.84rem',
                      color: item.checked ? 'var(--text-dim)' : 'var(--text-muted)',
                      textDecoration: item.checked ? 'line-through' : 'none',
                      cursor: 'pointer'
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(item.checked)}
                      onChange={() => handleToggleChecklistItem(task.id, item.index)}
                      style={{ width: 15, height: 15, accentColor: pillarColor, cursor: 'pointer' }}
                    />
                    <span>{item.text}</span>
                  </label>
                ))}
              </div>
            ) : (
              task.notes && (
                <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)', whiteSpace: 'pre-line' }}>
                  {task.notes}
                </span>
              )
            )}

            {/* Inline Quick-Add Checklist Input */}
            {addingListTaskId === task.id && (
              <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={newListItems}
                  onChange={(e) => setNewListItems(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddListToTask(task.id);
                    } else if (e.key === 'Escape') {
                      setAddingListTaskId(null);
                      setNewListItems('');
                    }
                  }}
                  placeholder="Items (comma-separated, e.g. Top rack, Bottom rack)..."
                  style={{ fontSize: '0.8rem', padding: '5px 10px', minWidth: 220, flex: 1 }}
                  autoFocus
                />
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => handleAddListToTask(task.id)}
                  style={{ padding: '5px 12px', fontSize: '0.76rem' }}
                >
                  Add
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setAddingListTaskId(null);
                    setNewListItems('');
                  }}
                  style={{ padding: '5px 10px', fontSize: '0.76rem' }}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Clean Action Buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {!task.completed && task.execution_priority !== 1 && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => handlePromotePriority(task, 1)}
              style={{
                padding: '4px 9px',
                fontSize: '0.74rem',
                borderColor: 'rgba(239, 68, 68, 0.45)',
                color: '#fca5a5'
              }}
              title="Pin to Priority 1: Must Happen Today"
            >
              🚨 Must-Do
            </button>
          )}
          {!task.completed && task.execution_priority === 1 && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => handlePromotePriority(task, 2)}
              style={{ padding: '4px 9px', fontSize: '0.74rem', borderColor: '#38bdf866', color: '#38bdf8' }}
              title="Move to High-Impact Focus"
            >
              ⚡ Focus
            </button>
          )}
          {!task.completed && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setAddingListTaskId(prev => (prev === task.id ? null : task.id));
                setNewListItems('');
              }}
              style={{ padding: '4px 9px', fontSize: '0.75rem' }}
              title="Add checklist items"
            >
              📋 + List
            </button>
          )}
          {!task.completed && onFocusTaskSelected && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => onFocusTaskSelected(task)}
              style={{ padding: '4px 10px', fontSize: '0.75rem', borderColor: `${accentColor || pillarColor}88` }}
              title="Start Focus Timer"
            >
              🎯 Timer
            </button>
          )}
          <button
            type="button"
            onClick={() => handleDelete(task.id)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-dim)',
              cursor: 'pointer',
              fontSize: '0.95rem',
              padding: '4px 6px'
            }}
            title="Delete Task"
          >
            ✕
          </button>
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Companion-Integrated Voice & Chat Bar (No Manual Priority/Pillar Dropdowns) */}
      <form
        onSubmit={handleCompanionSubmit}
        className="glass-panel"
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          padding: '12px 14px',
          borderLeft: '4px solid var(--accent-cyan)'
        }}
      >
        <button
          id="btn-board-voice"
          type="button"
          onClick={handleToggleVoice}
          disabled={isSendingCompanion || isTranscribingVoice}
          className={isRecordingVoice ? 'btn-danger' : 'btn-secondary'}
          style={{
            padding: '10px 14px',
            whiteSpace: 'nowrap',
            borderColor: isRecordingVoice ? '#ef4444' : 'var(--border-subtle)',
            background: isRecordingVoice ? 'rgba(239, 68, 68, 0.2)' : undefined,
            color: isRecordingVoice ? '#fca5a5' : 'var(--text-main)',
            fontWeight: 600
          }}
          title="Speak directly to your companion to add tasks, attach lists, or check items off"
        >
          {isTranscribingVoice ? '...' : isRecordingVoice ? '⏹️ Stop' : '🎙️ Speak'}
        </button>

        <input
          id="input-new-task-title"
          type="text"
          value={companionInput}
          onChange={(e) => setCompanionInput(e.target.value)}
          placeholder={
            isRecordingVoice
              ? 'Listening... tell your companion what to add or update...'
              : 'Tell your companion what to add or update (e.g. "Put away the dishes" or "Add a list: top rack, bottom rack")...'
          }
          disabled={isSendingCompanion}
          style={{ flex: 1, padding: '10px 14px' }}
        />

        <button
          id="btn-add-task"
          type="submit"
          className="btn-primary"
          disabled={isSendingCompanion || !companionInput.trim()}
          style={{ padding: '10px 20px', whiteSpace: 'nowrap' }}
        >
          {isSendingCompanion ? '...' : 'Send'}
        </button>
      </form>

      {/* Live Companion Activity / Reply Banner */}
      {companionReply && (
        <div
          className="glass-card animate-fade-in"
          style={{
            padding: '10px 16px',
            borderLeft: '3px solid var(--accent-cyan)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            fontSize: '0.88rem',
            lineHeight: 1.45,
            whiteSpace: 'pre-wrap'
          }}
        >
          <span>{companionReply}</span>
          <button
            type="button"
            onClick={() => setCompanionReply(null)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-dim)',
              cursor: 'pointer',
              fontSize: '0.9rem',
              padding: 4
            }}
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Colorful Life-Pillar Balance Strip + View Switcher */}
      <div
        className="glass-panel"
        style={{
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {pillars.map(p => {
            const pTasks = tasks.filter(t => (t.pillar || t.priority_name) === p.name);
            const pDone = pTasks.filter(t => t.completed).length;
            const active = pTasks.length > 0;
            return (
              <span
                key={p.key}
                style={{
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  padding: '3px 10px',
                  borderRadius: 999,
                  background: active ? `${p.color}22` : 'rgba(255,255,255,0.03)',
                  color: active ? p.color : 'var(--text-dim)',
                  border: `1px solid ${active ? `${p.color}66` : 'var(--border-subtle)'}`
                }}
              >
                {p.emoji} {p.name}: {pDone}/{pTasks.length}
              </span>
            );
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            id="btn-toggle-view-mode"
            type="button"
            className="btn-secondary"
            onClick={() => setViewMode(prev => (prev === 'execution' ? 'pillar' : 'execution'))}
            style={{ fontSize: '0.78rem', padding: '6px 12px', borderColor: 'rgba(0, 240, 255, 0.35)' }}
          >
            {viewMode === 'execution' ? '🧭 By Life Pillar' : '⚡ By Priority'}
          </button>
          {completedCount > 0 && (
            <button
              type="button"
              className="btn-secondary"
              onClick={handleClearCompleted}
              style={{ fontSize: '0.78rem', padding: '6px 12px' }}
            >
              🧹 Clear Done ({completedCount})
            </button>
          )}
        </div>
      </div>

      {/* Color-Coded Priority Lanes or Life Pillar Sections */}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 36, color: 'var(--text-dim)' }}>
          Loading your priority board...
        </div>
      ) : viewMode === 'execution' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {lanes.map((lane) => {
            const laneTasks = tasks.filter(t => (t.execution_priority || 2) === lane.level);
            if (laneTasks.length === 0 && lane.level === 4) return null;
            return (
              <div
                key={lane.level}
                className="glass-panel"
                style={{
                  padding: laneTasks.length > 0 ? 18 : '12px 18px',
                  borderLeft: `4px solid ${lane.color}`
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: laneTasks.length > 0 ? 12 : 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: '1.15rem' }}>{lane.emoji}</span>
                    <h3 style={{ fontSize: '1rem', fontWeight: 700, color: lane.color }}>
                      {lane.shortName || lane.name}
                    </h3>
                  </div>
                  <span
                    style={{
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      fontFamily: 'var(--font-mono)',
                      padding: '2px 9px',
                      borderRadius: 999,
                      background: `${lane.color}20`,
                      color: lane.color,
                      border: `1px solid ${lane.color}44`
                    }}
                  >
                    {laneTasks.filter(t => t.completed).length} / {laneTasks.length}
                  </span>
                </div>

                {laneTasks.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {laneTasks.map(task => renderTaskCard(task, lane.color))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {pillars.map((pillar) => {
            const pillarTasks = tasks.filter(t => (t.pillar || t.priority_name) === pillar.name);
            return (
              <div
                key={pillar.key}
                className="glass-panel"
                style={{
                  padding: pillarTasks.length > 0 ? 18 : '12px 18px',
                  borderLeft: `4px solid ${pillar.color}`
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: pillarTasks.length > 0 ? 12 : 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: '1.15rem' }}>{pillar.emoji}</span>
                    <h3 style={{ fontSize: '1rem', fontWeight: 700, color: pillar.color }}>
                      {pillar.name}
                    </h3>
                  </div>
                  <span
                    style={{
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      fontFamily: 'var(--font-mono)',
                      padding: '2px 9px',
                      borderRadius: 999,
                      background: `${pillar.color}20`,
                      color: pillar.color,
                      border: `1px solid ${pillar.color}44`
                    }}
                  >
                    {pillarTasks.filter(t => t.completed).length} / {pillarTasks.length}
                  </span>
                </div>

                {pillarTasks.length > 0 && (
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
