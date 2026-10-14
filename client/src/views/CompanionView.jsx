import React, { useState, useEffect, useRef } from 'react';
import TierBadge from '../components/TierBadge';

const ACTION_LABELS = {
  task_created: { icon: '✅', label: "Task Added to Today's Board", color: '#2dd4bf' },
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
  agentic_tool: { icon: '⚡', label: 'Agentic Proxy: Tool Executed', color: '#00f0ff' }
};

export function CompanionView({ streak, onActionExecuted }) {
  const [messages, setMessages] = useState([
    {
      id: 'welcome',
      role: 'assistant',
      content: "Hello! I'm your sovereign personal assistant. Through the Krusch Agentic Proxy (<holodata> Dual-Engine) and G-Krusch Google Workspace Extensions, I can execute live actions for you—check the weather, research the web, search or write Google Drive docs, manage Google Calendar events, draft or search Gmail, save local Markdown notes, send push notifications, inspect system telemetry, or manage Today's Priority Board. What can I get done for you?",
      tierUsed: 'L1_edge',
      latencyMs: 12
    }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [dailyFocus, setDailyFocus] = useState(null);
  const [isFocusLoading, setIsFocusLoading] = useState(false);
  const [expandedTraceIds, setExpandedTraceIds] = useState({});
  const chatEndRef = useRef(null);

  useEffect(() => {
    fetchFocus();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const toggleTrace = (id) => {
    setExpandedTraceIds(prev => ({ ...prev, [id]: !prev[id] }));
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

  const handleSend = async (e) => {
    e?.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMsg = {
      id: Date.now().toString(),
      role: 'user',
      content: input.trim()
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

      setMessages(prev => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: data.reply,
          tierUsed: data.tierUsed,
          latencyMs: data.latencyMs,
          reason: data.reason,
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
                  <div>
                    <strong style={{ color: '#2dd4bf' }}>Executed Tool Calls:</strong>
                    {m.agenticTrace.toolCalls.map((tc, i) => (
                      <div key={i} style={{ marginTop: 3 }}>
                        • <code>{tc.name}({JSON.stringify(tc.arguments)})</code> → {tc.ok ? '✅ OK' : '⚠️ Error'} ({tc.latencyMs}ms)
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

      {/* Input Box */}
      <form onSubmit={handleSend} style={{ display: 'flex', gap: 10 }}>
        <input
          id="input-companion-chat"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask for weather, Google Drive/Calendar/Gmail actions, web research, notes, or tasks..."
          disabled={isLoading}
        />
        <button id="btn-companion-send" type="submit" className="btn-primary" disabled={isLoading || !input.trim()}>
          <span>Send</span>
        </button>
      </form>
    </div>
  );
}

export default CompanionView;
