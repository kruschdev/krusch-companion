import React, { useState, useEffect, useRef } from 'react';
import TierBadge from '../components/TierBadge';

export function CompanionView({ streak }) {
  const [messages, setMessages] = useState([
    {
      id: 'welcome',
      role: 'assistant',
      content: "Hello! I'm your sovereign companion. All your context, habits, and schedules stay strictly on your local home hardware. How are you feeling today?",
      tierUsed: 'L1_edge',
      latencyMs: 12
    }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [dailyFocus, setDailyFocus] = useState(null);
  const [isFocusLoading, setIsFocusLoading] = useState(false);
  const chatEndRef = useRef(null);

  useEffect(() => {
    fetchFocus();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

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
      setMessages(prev => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: data.reply,
          tierUsed: data.tierUsed,
          latencyMs: data.latencyMs,
          reason: data.reason
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
        {messages.map(m => (
          <div
            key={m.id}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: m.role === 'user' ? 'flex-end' : 'flex-start',
              gap: 4
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
            {m.role === 'assistant' && m.tierUsed && (
              <TierBadge tier={m.tierUsed} latencyMs={m.latencyMs} />
            )}
          </div>
        ))}
        {isLoading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-dim)', fontSize: '0.88rem' }}>
            <span style={{ animation: 'spin 1s infinite linear' }}>⚡</span>
            <span>Cascade Router evaluating & generating response...</span>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Quick Starters */}
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
        {[
          'What should I tackle next?',
          'Nudge me to get started',
          'Remember that I take vitamins with lunch',
          'What is 350 * 18?'
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
          placeholder="Ask a question, reflect, or note a habit..."
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
