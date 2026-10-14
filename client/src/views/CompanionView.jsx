import React, { useState, useEffect, useRef } from 'react';
import TierBadge from '../components/TierBadge';

const ACTION_LABELS = {
  task_created: { icon: '✅', label: "Task Added to Today's Board", color: '#2dd4bf' },
  task_priority_updated: { icon: '🚨', label: 'Task Promoted to Must Happen Today', color: '#ef4444' },
  task_completed: { icon: '🎉', label: 'Task Marked Complete', color: '#f0c040' },
  task_deleted: { icon: '🗑️', label: 'Task Removed from Board', color: '#f87171' },
  tasks_rolled_over: { icon: '🔄', label: 'Unfinished Tasks Rolled Over', color: '#60a5fa' },
  tasks_listed: { icon: '📋', label: 'Live SQLite Board Snapshot', color: '#00f0ff' },
  task_breakdown: { icon: '🧩', label: 'Task Decomposed into Subtasks', color: '#a78bfa' },
  memory_saved: { icon: '🧠', label: 'Committed to Working Memory', color: '#a78bfa' },
  memory_superseded: { icon: '🔄', label: 'Working Memory Superseded', color: '#f0c040' },
  api_weather: { icon: '🌤️', label: 'Agentic Proxy: Live Weather API', color: '#38bdf8' },
  api_web_research: { icon: '🔎', label: 'Agentic Proxy: Web Research API', color: '#a78bfa' },
  api_url_digest: { icon: '📄', label: 'Agentic Proxy: URL Digest', color: '#60a5fa' },
  note_saved: { icon: '📝', label: 'Agentic Proxy: Note Saved to Vault', color: '#2dd4bf' },
  note_read: { icon: '📂', label: 'Agentic Proxy: Sovereign Notes Vault', color: '#00f0ff' },
  notification_sent: { icon: '🔔', label: 'Agentic Proxy: Push Notification Sent', color: '#f0c040' },
  system_telemetry: { icon: '🖥️', label: 'Agentic Proxy: System Telemetry', color: '#2dd4bf' },
  sovereign_gateway: { icon: '⚖️', label: 'Agentic Proxy: Sovereign Gateway', color: '#f0c040' },
  google_drive: { icon: '☁️', label: 'G-Krusch: Google Drive & Docs', color: '#38bdf8' },
  google_calendar: { icon: '📅', label: 'G-Krusch: Google Calendar', color: '#60a5fa' },
  google_gmail: { icon: '✉️', label: 'G-Krusch: Gmail Extension', color: '#f87171' },
  concierge_reservation: { icon: '🍽️', label: 'Agentic Proxy: Concierge Reservation', color: '#f0c040' },
  commute_departure: { icon: '🚗', label: 'Agentic Proxy: Traffic & Time-to-Leave', color: '#38bdf8' },
  agentic_tool: { icon: '⚡', label: 'Agentic Proxy: Tool Executed', color: '#00f0ff' }
};

export function CompanionView({ streak, onActionExecuted }) {
  const [messages, setMessages] = useState([
    {
      id: 'welcome',
      role: 'assistant',
      content: "Hello! I'm your sovereign personal assistant. Through the Krusch Agentic Proxy (<holodata> Dual-Engine) and G-Krusch Google Workspace Extensions, I can execute live actions for you—check the weather, research the web, make reservations, calculate live traffic & Time-to-Leave alerts, search or write Google Drive docs, manage Google Calendar events, draft or search Gmail, save local Markdown notes, or manage Today's Priority Board. What can I get done for you?",
      tierUsed: 'L1_edge',
      latencyMs: 12
    }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [dailyFocus, setDailyFocus] = useState(null);
  const [isFocusLoading, setIsFocusLoading] = useState(false);
  const [departureAlerts, setDepartureAlerts] = useState([]);
  const [sentinelAlerts, setSentinelAlerts] = useState([]);
  const [expandedTraceIds, setExpandedTraceIds] = useState({});
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [isTranscribingVoice, setIsTranscribingVoice] = useState(false);
  const [autoSendVoice, setAutoSendVoice] = useState(true);
  const [voiceStatus, setVoiceStatus] = useState(null);
  const chatEndRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const speechRecRef = useRef(null);
  const liveTranscriptRef = useRef('');

  useEffect(() => {
    fetchFocus();
    fetchDepartureAlerts();
    return () => {
      if (speechRecRef.current) {
        try {
          speechRecRef.current.stop();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const toggleTrace = (id) => {
    setExpandedTraceIds(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const handleConfirmSideEffectTool = async (msgId, tc) => {
    try {
      const res = await fetch('/api/companion/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: tc.name,
          arguments: { ...(tc.arguments || {}), dryRun: false }
        })
      });
      if (res.ok) {
        const data = await res.json();
        setMessages(prev =>
          prev.map(m =>
            m.id === msgId
              ? {
                  ...m,
                  confirmedTools: { ...(m.confirmedTools || {}), [tc.name]: true }
                }
              : m
          ).concat({
            id: `${Date.now()}-confirmed`,
            role: 'assistant',
            content: `✅ **Confirmed & Executed \`${tc.name}\`**:\n\n${data.summary || JSON.stringify(data)}`,
            tierUsed: 'L0_heuristic',
            latencyMs: data.latencyMs || 5
          })
        );
        if (onActionExecuted) onActionExecuted({ type: tc.name });
      }
    } catch (err) {
      alert(`Confirmation execution failed: ${err.message}`);
    }
  };

  const fetchDepartureAlerts = async () => {
    try {
      const res = await fetch('/api/companion/departure-alerts');
      if (res.ok) {
        const data = await res.json();
        setDepartureAlerts(data.alerts || []);
        setSentinelAlerts(data.sentinelAlerts || []);
      }
    } catch {
      // Non-fatal
    }
  };

  const handleAckSentinel = async (id) => {
    try {
      await fetch(`/api/sentinel/ack/${id}`, { method: 'POST' });
      setSentinelAlerts(prev => prev.filter(a => a.id !== id));
    } catch {
      // Non-fatal
    }
  };

  const triggerBrowserDepartureAlert = async (alertItem) => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    let perm = Notification.permission;
    if (perm === 'default') {
      perm = await Notification.requestPermission();
    }
    if (perm === 'granted') {
      const c = alertItem.commute;
      new Notification(`🚗 Leave by ${c.leaveByFormatted} — ${alertItem.title}`, {
        body: `${c.trafficLevel} traffic (${c.trafficMinutes}m drive${c.trafficDelayMinutes > 0 ? `, +${c.trafficDelayMinutes}m delay` : ''}). Leave by ${c.leaveByFormatted} to arrive on time.`
      });
    }
  };

  const fetchFocus = async () => {
    try {
      const res = await fetch('/api/coach/focus');
      if (res.ok) {
        const data = await res.json();
        if (data.focus_text) {
          setDailyFocus(data.focus_text);
        }
      }
    } catch {
      // Non-fatal
    }
  };

  const handleGenerateFocus = async () => {
    setIsFocusLoading(true);
    try {
      const res = await fetch('/api/coach/focus', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setDailyFocus(data.focusText);
      }
    } catch (err) {
      alert(`Error generating focus: ${err.message}`);
    } finally {
      setIsFocusLoading(false);
    }
  };

  const sendPromptText = async (rawPrompt) => {
    const cleanPrompt = String(rawPrompt || '').trim();
    if (!cleanPrompt || isLoading) return;

    const userMsg = {
      id: Date.now().toString(),
      role: 'user',
      content: cleanPrompt
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    try {
      const res = await fetch('/api/companion/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: userMsg.content,
          history: messages.slice(-6).map(m => ({ role: m.role, content: m.content }))
        })
      });

      if (!res.ok) throw new Error(`Server returned ${res.status}`);

      const data = await res.json();
      if (data.actionExecuted && onActionExecuted) {
        onActionExecuted(data.actionExecuted);
      }
      fetchDepartureAlerts();

      setMessages(prev => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: data.reply,
          tierUsed: data.tierUsed,
          latencyMs: data.latencyMs,
          reason: data.reason,
          contextActivated: typeof data.contextActivated === 'boolean' ? data.contextActivated : null,
          actionExecuted: data.actionExecuted || null,
          agenticTrace: data.agenticTrace || null
        }
      ]);
    } catch (err) {
      setMessages(prev => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: `⚠️ Error contacting companion: ${err.message}. Make sure Ollama is running.`,
          tierUsed: 'L1_edge'
        }
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSend = async (e) => {
    e?.preventDefault();
    await sendPromptText(input);
  };

  const handleToggleVoiceChat = async () => {
    if (isRecordingVoice) {
      // Stop active recording
      setIsRecordingVoice(false);
      if (speechRecRef.current) {
        try {
          speechRecRef.current.stop();
        } catch {
          // ignore
        }
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      return;
    }

    setVoiceStatus('🎙️ Listening... Speak naturally (click Stop when finished)');
    liveTranscriptRef.current = input ? `${input.trim()} ` : '';

    // 1. Start Browser Web Speech API for real-time zero-latency dictation into input box
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
            setInput(combined);
          }
        };
        rec.onerror = () => {};
        rec.start();
        speechRecRef.current = rec;
      } catch {
        // Fallback to MediaRecorder Whisper STT
      }
    }

    // 2. Start MediaRecorder for Local Whisper STT fallback
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const browserText = liveTranscriptRef.current.trim();

        // If Browser Web Speech API already captured speech cleanly, use it immediately!
        if (browserText.length > 0) {
          setVoiceStatus(`✅ Voice captured (${browserText.split(/\s+/).length} words)`);
          setTimeout(() => setVoiceStatus(null), 3000);
          if (autoSendVoice) {
            await sendPromptText(browserText);
          }
          return;
        }

        // Otherwise, send recorded audio blob to Local Whisper STT (/api/companion/transcribe)
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        if (blob.size < 200) {
          setVoiceStatus(null);
          return;
        }

        setIsTranscribingVoice(true);
        setVoiceStatus('⚡ Transcribing voice via Local Whisper STT...');
        try {
          const formData = new FormData();
          formData.append('audio', blob, 'chat-voice.webm');
          const res = await fetch('/api/companion/transcribe', {
            method: 'POST',
            body: formData
          });
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `STT HTTP ${res.status}`);
          }
          const data = await res.json();
          if (data.transcription) {
            setInput(data.transcription);
            setVoiceStatus(`✅ Whisper STT transcribed (${data.transcription.split(/\s+/).length} words)`);
            setTimeout(() => setVoiceStatus(null), 3000);
            if (autoSendVoice) {
              await sendPromptText(data.transcription);
            }
          }
        } catch (err) {
          setVoiceStatus(`⚠️ Voice STT unavailable (${err.message}). Use Chrome/Edge/Safari for instant Web Speech dictation.`);
          setTimeout(() => setVoiceStatus(null), 5000);
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
        setVoiceStatus(`⚠️ Microphone permission denied or unavailable: ${err.message}`);
        setTimeout(() => setVoiceStatus(null), 4500);
      }
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 16 }}>
      {/* Daily Focus Card */}
      <div className="glass-panel" style={{ padding: 20, borderLeft: '4px solid var(--accent-cyan)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '1.2rem' }}>☀️</span>
            <h3 style={{ fontSize: '1.05rem', fontWeight: 700 }}>Today's Sovereign Focus</h3>
          </div>
          <button
            id="btn-refresh-focus"
            className="btn-secondary"
            onClick={handleGenerateFocus}
            disabled={isFocusLoading}
            style={{ fontSize: '0.8rem', padding: '6px 12px' }}
          >
            {isFocusLoading ? 'Synthesizing...' : dailyFocus ? '↻ Refresh Focus' : '✨ Generate Focus'}
          </button>
        </div>
        <p style={{ color: dailyFocus ? 'var(--text-main)' : 'var(--text-dim)', fontSize: '0.95rem', lineHeight: 1.5 }}>
          {dailyFocus || 'Generate your morning focus briefing to synthesize your top tasks and align your mindset.'}
        </p>
      </div>

      {/* Sentinel Watchdog Proactive LLM Alerts */}
      {sentinelAlerts.length > 0 && (
        <div
          className="glass-panel"
          style={{
            padding: '12px 18px',
            borderLeft: '4px solid #f87171',
            background: 'rgba(248, 113, 113, 0.09)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8
          }}
        >
          {sentinelAlerts.slice(0, 2).map((alert) => (
            <div
              key={alert.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
                fontSize: '0.86rem'
              }}
            >
              <div style={{ flex: 1 }}>
                <strong style={{ color: '#f87171' }}>🚨 Sentinel Watchdog ({alert.trigger_reason.replace(/_/g, ' ')}):</strong>{' '}
                <span>{alert.llm_advisory}</span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {alert.directions_url && (
                  <a
                    href={alert.directions_url}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-secondary"
                    style={{ fontSize: '0.75rem', padding: '4px 10px', textDecoration: 'none' }}
                  >
                    🗺️ Route
                  </a>
                )}
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => handleAckSentinel(alert.id)}
                  style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                >
                  ✓ Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Live Time-to-Leave & Traffic Departure Alerts Banner */}
      {departureAlerts.length > 0 && (
        <div
          className="glass-panel"
          style={{
            padding: '12px 18px',
            borderLeft: '4px solid #f0c040',
            background: 'rgba(240, 192, 64, 0.07)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8
          }}
        >
          {departureAlerts.slice(0, 2).map((item) => {
            const c = item.commute;
            return (
              <div
                key={item.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 10,
                  fontSize: '0.86rem'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span>{c.shouldLeaveEarly ? '⚠️' : '🚗'}</span>
                  <strong>Leave by {c.leaveByFormatted}</strong>
                  <span style={{ color: 'var(--text-dim)' }}>for</span>
                  <span>{item.title}</span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.74rem',
                      padding: '2px 8px',
                      borderRadius: 'var(--radius-full)',
                      background: c.shouldLeaveEarly ? 'rgba(248, 113, 113, 0.16)' : 'rgba(45, 212, 191, 0.14)',
                      color: c.shouldLeaveEarly ? '#f87171' : '#2dd4bf',
                      border: `1px solid ${c.shouldLeaveEarly ? '#f87171' : '#2dd4bf'}`
                    }}
                  >
                    {c.trafficMinutes}m drive ({c.trafficLevel} traffic{c.trafficDelayMinutes > 0 ? `, +${c.trafficDelayMinutes}m delay` : ''})
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <a
                    href={c.googleMapsDirectionsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-secondary"
                    style={{ fontSize: '0.75rem', padding: '4px 10px', textDecoration: 'none' }}
                  >
                    🗺️ Directions
                  </a>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => triggerBrowserDepartureAlert(item)}
                    style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                  >
                    🔔 Notify Me
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Chat Messages */}
      <div className="glass-panel" style={{ flex: 1, padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {messages.map(m => {
          const actionMeta = m.actionExecuted?.type ? ACTION_LABELS[m.actionExecuted.type] : null;
          const hasTrace = Boolean(m.agenticTrace && m.agenticTrace.toolCalls?.length > 0);
          const isTraceOpen = Boolean(expandedTraceIds[m.id]);
          return (
            <div
              key={m.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: m.role === 'user' ? 'flex-end' : 'flex-start',
                gap: 6
              }}
            >
              <div
                style={{
                  maxWidth: '85%',
                  padding: '12px 18px',
                  borderRadius: m.role === 'user' ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                  background: m.role === 'user' ? 'linear-gradient(135deg, #0088ff, #7928ca)' : 'var(--bg-glass-card)',
                  color: 'var(--text-main)',
                  border: m.role === 'user' ? 'none' : '1px solid var(--border-subtle)',
                  lineHeight: 1.5,
                  fontSize: '0.95rem',
                  whiteSpace: 'pre-wrap'
                }}
              >
                {m.content}
              </div>
              {m.role === 'assistant' && (m.tierUsed || actionMeta || hasTrace) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {m.tierUsed && <TierBadge tier={m.tierUsed} latencyMs={m.latencyMs} />}
                  {typeof m.contextActivated === 'boolean' && (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        fontSize: '0.69rem',
                        fontFamily: 'var(--font-mono)',
                        padding: '2px 8px',
                        borderRadius: 'var(--radius-full)',
                        background: m.contextActivated ? 'rgba(167, 139, 250, 0.12)' : 'rgba(148, 163, 184, 0.12)',
                        border: `1px solid ${m.contextActivated ? 'rgba(167, 139, 250, 0.4)' : 'rgba(148, 163, 184, 0.35)'}`,
                        color: m.contextActivated ? '#a78bfa' : '#94a3b8'
                      }}
                      title={
                        m.contextActivated
                          ? 'Knowledge Boundary Gate: Open-world query — Working Memory injected'
                          : 'Knowledge Boundary Gate: Closed-world utility query — 0 memory tokens injected'
                      }
                    >
                      {m.contextActivated ? '🧠 Context Injected' : '🛡️ Boundary Gated'}
                    </span>
                  )}
                  {actionMeta && (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        fontSize: '0.72rem',
                        fontWeight: 700,
                        fontFamily: 'var(--font-mono)',
                        padding: '2px 9px',
                        borderRadius: 'var(--radius-full)',
                        background: 'rgba(45, 212, 191, 0.12)',
                        border: `1px solid ${actionMeta.color}`,
                        color: actionMeta.color
                      }}
                    >
                      <span>{actionMeta.icon}</span>
                      <span>{actionMeta.label}</span>
                    </span>
                  )}
                  {hasTrace && typeof m.agenticTrace.confidence === 'number' && (
                    <span
                      style={{
                        fontSize: '0.69rem',
                        fontFamily: 'var(--font-mono)',
                        padding: '2px 8px',
                        borderRadius: 'var(--radius-full)',
                        background: 'rgba(45, 212, 191, 0.10)',
                        border: '1px solid rgba(45, 212, 191, 0.35)',
                        color: '#2dd4bf'
                      }}
                      title="Agentic Proxy <holodata> Extraction Confidence"
                    >
                      🎯 {Math.round(m.agenticTrace.confidence * 100)}% Conf
                    </span>
                  )}
                  {hasTrace && (
                    <button
                      type="button"
                      onClick={() => toggleTrace(m.id)}
                      style={{
                        fontSize: '0.7rem',
                        fontFamily: 'var(--font-mono)',
                        padding: '2px 8px',
                        borderRadius: 'var(--radius-full)',
                        background: 'rgba(167, 139, 250, 0.12)',
                        border: '1px solid rgba(167, 139, 250, 0.45)',
                        color: '#a78bfa',
                        cursor: 'pointer'
                      }}
                    >
                      {isTraceOpen ? '▾ Hide <holodata> Trace' : `▸ <holodata> Proxy (${m.agenticTrace.toolCalls.length} tool${m.agenticTrace.toolCalls.length > 1 ? 's' : ''})`}
                    </button>
                  )}
                  {hasTrace &&
                    m.agenticTrace.toolCalls
                      .filter(tc => (tc.requiresConfirmation || tc.dryRun) && !m.confirmedTools?.[tc.name])
                      .map((tc, idx) => (
                        <button
                          key={`${tc.name}-${idx}`}
                          type="button"
                          className="btn-primary"
                          onClick={() => handleConfirmSideEffectTool(m.id, tc)}
                          style={{
                            fontSize: '0.73rem',
                            padding: '3px 10px',
                            borderRadius: 'var(--radius-full)'
                          }}
                        >
                          ✅ Confirm &amp; Execute {tc.name}
                        </button>
                      ))}
                </div>
              )}
              {hasTrace && isTraceOpen && (
                <div
                  style={{
                    maxWidth: '85%',
                    padding: '10px 14px',
                    borderRadius: 10,
                    background: 'rgba(10, 14, 24, 0.85)',
                    border: '1px solid rgba(167, 139, 250, 0.35)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.75rem',
                    color: 'var(--text-dim)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6
                  }}
                >
                  {m.agenticTrace.blueprint && (
                    <div>
                      <strong style={{ color: '#a78bfa' }}>&lt;holodata&gt; Blueprint:</strong>{' '}
                      {m.agenticTrace.blueprint.cognitive_scratchpad || m.agenticTrace.blueprint.tool_plan || JSON.stringify(m.agenticTrace.blueprint)}
                    </div>
                  )}
                  {m.agenticTrace.pruningReport && (
                    <div>
                      <strong style={{ color: 'var(--accent-cyan)' }}>Tool Pruning:</strong>{' '}
                      Selected [{m.agenticTrace.pruningReport.selectedTools?.join(', ')}] · Pruned {m.agenticTrace.pruningReport.prunedCount} tools (~{m.agenticTrace.pruningReport.schemaTokensSavedEst} tokens saved)
                    </div>
                  )}
                  <div>
                    <strong style={{ color: '#2dd4bf' }}>Executed Tool Calls:</strong>
                    {m.agenticTrace.toolCalls.map((tc, i) => (
                      <div key={i} style={{ marginTop: 3 }}>
                        • <code>{tc.name}({JSON.stringify(tc.arguments)})</code> → {tc.dryRun ? '🛡️ Dry-Run Gate' : tc.ok ? '✅ OK' : '⚠️ Error'} ({tc.latencyMs}ms)
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {isLoading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-dim)', fontSize: '0.88rem' }}>
            <span style={{ animation: 'spin 1s infinite linear' }}>⚡</span>
            <span>Cascade Router &amp; Agentic Proxy evaluating...</span>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Quick Starters */}
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
        {[
          "What's the weather in Seattle?",
          'Search my Google Drive for project specs',
          "What's on my Google Calendar today?",
          'Check system status',
          'Save a note titled Weekly Goals: Ship v2.0 & review priorities',
          'Show my tasks for today'
        ].map((quick, idx) => (
          <button
            key={idx}
            className="btn-secondary"
            onClick={() => setInput(quick)}
            style={{ fontSize: '0.8rem', whiteSpace: 'nowrap', padding: '6px 12px' }}
          >
            {quick}
          </button>
        ))}
      </div>

      {/* Live Voice-to-Text Status Banner */}
      {voiceStatus && (
        <div
          className="glass-card"
          style={{
            padding: '8px 14px',
            borderLeft: `3px solid ${isRecordingVoice ? '#f87171' : 'var(--accent-cyan)'}`,
            fontSize: '0.82rem',
            fontFamily: 'var(--font-mono)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 10
          }}
        >
          <span>{voiceStatus}</span>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              cursor: 'pointer',
              fontSize: '0.75rem',
              color: 'var(--text-muted)'
            }}
            title="Automatically send the chat message as soon as you stop speaking"
          >
            <input
              type="checkbox"
              checked={autoSendVoice}
              onChange={(e) => setAutoSendVoice(e.target.checked)}
              style={{ width: 14, height: 14, accentColor: 'var(--accent-cyan)' }}
            />
            Auto-Send on Stop
          </label>
        </div>
      )}

      {/* Input Box + Voice-to-Text Dictation Button */}
      <form onSubmit={handleSend} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          id="btn-companion-voice"
          type="button"
          onClick={handleToggleVoiceChat}
          disabled={isLoading || isTranscribingVoice}
          className={isRecordingVoice ? 'btn-danger' : 'btn-secondary'}
          style={{
            padding: '10px 14px',
            whiteSpace: 'nowrap',
            borderColor: isRecordingVoice ? '#ef4444' : 'var(--accent-cyan)',
            color: isRecordingVoice ? '#fff' : 'var(--accent-cyan)',
            fontWeight: 700
          }}
          title="Speak your command or message (Web Speech live dictation + Local Whisper STT fallback)"
        >
          {isTranscribingVoice
            ? '⚡ STT...'
            : isRecordingVoice
              ? '⏹️ Stop'
              : '🎙️ Speak'}
        </button>
        <input
          id="input-companion-chat"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            isRecordingVoice
              ? 'Listening... speak your request (or type here)...'
              : 'Speak (🎙️) or type: weather, Calendar/Gmail/Drive actions, reservations, traffic, tasks...'
          }
          disabled={isLoading}
          style={{ flex: 1 }}
        />
        <button id="btn-companion-send" type="submit" className="btn-primary" disabled={isLoading || !input.trim()}>
          <span>Send</span>
        </button>
      </form>
    </div>
  );
}

export default CompanionView;
