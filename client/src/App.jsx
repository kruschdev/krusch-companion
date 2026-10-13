import React, { useState, useEffect } from 'react';
import CompanionView from './views/CompanionView';
import DumpView from './views/DumpView';
import TodayView from './views/TodayView';
import FocusView from './views/FocusView';

export function App() {
  const [activeTab, setActiveTab] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get('tab');
      if (['companion', 'dump', 'today', 'focus'].includes(tab)) return tab;
    } catch {
      // fallback
    }
    return 'companion';
  });
  const [streak, setStreak] = useState(0);
  const [focusTask, setFocusTask] = useState(null);
  const [backendHealth, setBackendHealth] = useState(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    fetchHealth();
    fetchStreak();

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const fetchHealth = async () => {
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        setBackendHealth(await res.json());
      }
    } catch {
      // Local dev offline
    }
  };

  const fetchStreak = async () => {
    try {
      const res = await fetch('/api/streak');
      if (res.ok) {
        const data = await res.json();
        setStreak(data.streak || 0);
      }
    } catch {
      // Non-fatal
    }
  };

  const handleSelectFocus = (task) => {
    setFocusTask(task);
    setActiveTab('focus');
  };

  const handleTaskCompleted = async (id) => {
    try {
      await fetch(`/api/tasks/${id}/complete`, { method: 'PATCH' });
      fetchStreak();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '16px 20px', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Top Header */}
      <header
        className="glass-panel"
        style={{
          padding: '16px 24px',
          marginBottom: 20,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: 'linear-gradient(135deg, #00f0ff, #7928ca)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.25rem',
              boxShadow: 'var(--glow-cyan)'
            }}
          >
            🛡️
          </div>
          <div>
            <h1 style={{ fontSize: '1.25rem', fontWeight: 800, letterSpacing: '-0.02em', color: '#f8fafc' }}>
              KRUSCH COMPANION
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.72rem', color: 'var(--accent-emerald)', fontFamily: 'var(--font-mono)' }}>
              <span>●</span>
              <span>100% SOVEREIGN · ZERO-CLOUD LOCAL EDGE</span>
            </div>
          </div>
        </div>

        {/* Status Pills */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              borderRadius: 'var(--radius-full)',
              background: 'rgba(255, 255, 255, 0.06)',
              border: '1px solid var(--border-subtle)',
              fontSize: '0.82rem',
              fontWeight: 700
            }}
          >
            <span>🔥</span>
            <span>{streak} Day Streak</span>
          </div>

          {backendHealth?.provider === 'openrouter' ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px',
                borderRadius: 'var(--radius-full)',
                background: 'rgba(255, 183, 0, 0.10)',
                border: '1px solid rgba(255, 183, 0, 0.35)',
                fontSize: '0.75rem',
                color: 'var(--accent-amber)',
                fontFamily: 'var(--font-mono)'
              }}
            >
              <span>☁️</span>
              <span>{backendHealth.openrouterModel?.split('/')[1] || 'OpenRouter'}</span>
            </div>
          ) : backendHealth?.edgeModel ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px',
                borderRadius: 'var(--radius-full)',
                background: 'rgba(0, 240, 255, 0.08)',
                border: '1px solid rgba(0, 240, 255, 0.25)',
                fontSize: '0.75rem',
                color: 'var(--accent-cyan)',
                fontFamily: 'var(--font-mono)'
              }}
            >
              <span>⚡</span>
              <span>{backendHealth.edgeModel}</span>
            </div>
          ) : null}
        </div>
      </header>

      {/* Navigation Tabs */}
      <nav
        style={{
          display: 'flex',
          gap: 8,
          marginBottom: 20,
          background: 'rgba(16, 20, 32, 0.5)',
          padding: 6,
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-subtle)'
        }}
      >
        {[
          { id: 'companion', label: '💬 Companion Chat' },
          { id: 'dump', label: '🌪️ Chaos Dump' },
          { id: 'today', label: "📋 Today's Board" },
          { id: 'focus', label: '🎯 Focus Mode' }
        ].map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                flex: 1,
                padding: '10px 14px',
                borderRadius: 10,
                border: 'none',
                background: isActive ? 'linear-gradient(135deg, rgba(0, 240, 255, 0.2), rgba(121, 40, 202, 0.2))' : 'transparent',
                color: isActive ? '#f8fafc' : 'var(--text-muted)',
                fontWeight: isActive ? 700 : 500,
                fontSize: '0.88rem',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                borderBottom: isActive ? '2px solid var(--accent-cyan)' : '2px solid transparent'
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      {/* Main Content View */}
      <main style={{ flex: 1 }}>
        {activeTab === 'companion' && <CompanionView streak={streak} />}
        {activeTab === 'dump' && <DumpView onTasksCreated={fetchStreak} />}
        {activeTab === 'today' && <TodayView onFocusTaskSelected={handleSelectFocus} />}
        {activeTab === 'focus' && (
          <FocusView
            task={focusTask}
            onTaskCompleted={handleTaskCompleted}
            onExitFocus={() => setActiveTab('today')}
          />
        )}
      </main>

      {/* Footer */}
      <footer style={{ marginTop: 32, padding: '16px 0', textAlign: 'center', borderTop: '1px solid var(--border-subtle)', color: 'var(--text-dim)', fontSize: '0.78rem' }}>
        Krusch Companion v1.0.0 · Powered by <strong style={{ color: 'var(--text-muted)' }}>krusch-cascade-router</strong> & <strong style={{ color: 'var(--text-muted)' }}>krusch-context-mcp</strong> · 100% Private Homelab AI
      </footer>
    </div>
  );
}

export default App;
