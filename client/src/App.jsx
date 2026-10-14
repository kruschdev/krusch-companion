import React, { useState, useEffect } from 'react';
import CompanionView from './views/CompanionView';
import DumpView from './views/DumpView';
import TodayView from './views/TodayView';
import FocusView from './views/FocusView';
import SystemMemoryView from './views/SystemMemoryView';

export function App() {
  const [activeTab, setActiveTab] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get('tab');
      if (['companion', 'stream', 'dump', 'today', 'focus', 'memory'].includes(tab)) {
        return tab === 'dump' ? 'stream' : tab;
      }
    } catch {
      // fallback
    }
    return 'companion';
  });
  const [streak, setStreak] = useState(0);
  const [focusTask, setFocusTask] = useState({
    id: 4,
    title: 'Pay electric bill & review Q4 contract invoice before 5pm',
    notes: 'Lane 1: Must Happen Today — Deadlines & Provision',
    execution_lane_emoji: '🚨',
    execution_lane_short: 'Must Happen Today',
    execution_lane_color: '#ef4444',
    pillar_emoji: '🏠',
    pillar_name: 'Provision & Finance',
    pillar_color: '#f97316'
  });
  const [backendHealth, setBackendHealth] = useState(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const [isRunningDemo, setIsRunningDemo] = useState(false);
  const [runtimeMode, setRuntimeMode] = useState('balanced');
  const [dryRunGate, setDryRunGate] = useState(false);

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
      const [res, dbgRes] = await Promise.all([fetch('/api/health'), fetch('/api/debug')]);
      if (res.ok) {
        setBackendHealth(await res.json());
      }
      if (dbgRes.ok) {
        const dbg = await dbgRes.json();
        if (dbg.resourceMode) setRuntimeMode(dbg.resourceMode);
        if (typeof dbg.dryRunMode === 'boolean') setDryRunGate(dbg.dryRunMode);
      }
    } catch {
      // Local dev offline
    }
  };

  const handleUpdateRuntimeQuick = async (patch) => {
    try {
      const res = await fetch('/api/settings/runtime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      if (res.ok) {
        const data = await res.json();
        setRuntimeMode(data.resourceMode);
        setDryRunGate(Boolean(data.dryRunMode));
      }
    } catch {
      // Non-fatal
    }
  };

  const handleRunSampleTryItFlow = async () => {
    setIsRunningDemo(true);
    try {
      const sampleStream =
        'Pay electric bill and review Q4 client invoice before 5pm today, call the dentist to confirm Thursday appointment, pick up prescription at CVS, drink 2 liters of water every day, and remember that we decided to keep Friday evenings device-free for family dinner.';
      const res = await fetch('/api/companion/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: sampleStream })
      });
      if (res.ok) {
        await fetchStreak();
        setShowSetupWizard(false);
        setActiveTab('today');
      }
    } catch (err) {
      alert(`Demo flow error: ${err.message}`);
    } finally {
      setIsRunningDemo(false);
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button
            id="btn-quick-setup-wizard"
            type="button"
            className="btn-secondary"
            onClick={() => setShowSetupWizard(prev => !prev)}
            style={{
              fontSize: '0.76rem',
              padding: '6px 12px',
              borderRadius: 'var(--radius-full)',
              borderColor: 'var(--accent-cyan)',
              color: '#f8fafc',
              fontWeight: 700
            }}
            title="Open Guided Setup, Resource Mode & 1-Click Sample Flow"
          >
            🚀 Setup & Try It
          </button>

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
              <span>{backendHealth.edgeModel} · {runtimeMode.toUpperCase()}</span>
            </div>
          ) : null}
        </div>
      </header>

      {/* Guided First-Run Setup & 1-Click "Try It" Wizard Panel */}
      {showSetupWizard && (
        <div
          className="glass-panel"
          style={{
            padding: 20,
            marginBottom: 20,
            borderLeft: '4px solid var(--accent-cyan)',
            display: 'flex',
            flexDirection: 'column',
            gap: 14
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h3 style={{ fontSize: '1.08rem', fontWeight: 800 }}>
                🚀 Guided First-Run Setup & 1-Click &ldquo;Try It&rdquo; Onboarding
              </h3>
              <p style={{ fontSize: '0.84rem', color: 'var(--text-muted)' }}>
                Configure your compute profile, side-effect safety gate, or populate a sample Thought Stream in one click.
              </p>
            </div>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setShowSetupWizard(false)}
              style={{ fontSize: '0.78rem', padding: '4px 10px' }}
            >
              ✕ Close
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
            <div className="glass-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <strong style={{ fontSize: '0.86rem', color: 'var(--accent-cyan)' }}>
                1. Resource & Routing Mode
              </strong>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
                Choose <strong>Minimal</strong> on CPU-only laptops (locks to L0/L1), <strong>Balanced</strong> for standard cascade, or <strong>Quality</strong> for deep reasoning.
              </span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {['minimal', 'balanced', 'quality'].map(m => (
                  <button
                    key={m}
                    type="button"
                    className="btn-secondary"
                    onClick={() => handleUpdateRuntimeQuick({ resourceMode: m })}
                    style={{
                      fontSize: '0.74rem',
                      padding: '4px 10px',
                      borderColor: runtimeMode === m ? 'var(--accent-cyan)' : undefined,
                      background: runtimeMode === m ? 'rgba(0,240,255,0.14)' : undefined
                    }}
                  >
                    {m.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            <div className="glass-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <strong style={{ fontSize: '0.86rem', color: '#f0c040' }}>
                2. Side-Effect Confirmation Gate
              </strong>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
                Require explicit confirmation before executing external tools (Gmail send, Calendar create, Concierge booking).
              </span>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => handleUpdateRuntimeQuick({ dryRunMode: !dryRunGate })}
                style={{
                  fontSize: '0.76rem',
                  padding: '6px 10px',
                  borderColor: dryRunGate ? '#f0c040' : '#2dd4bf',
                  color: dryRunGate ? '#f0c040' : '#2dd4bf'
                }}
              >
                {dryRunGate ? '🛡️ Confirm-Before-Act: ON' : '⚡ Live Execution: ON (Click for Confirm Gate)'}
              </button>
            </div>

            <div className="glass-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <strong style={{ fontSize: '0.86rem', color: '#2dd4bf' }}>
                3. Instant &ldquo;Try It&rdquo; Sample Flow
              </strong>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
                Triages a sample Thought Stream into Dual-Axis tasks & Working Memory and opens Today&apos;s Board immediately.
              </span>
              <button
                type="button"
                className="btn-primary"
                disabled={isRunningDemo}
                onClick={handleRunSampleTryItFlow}
                style={{ fontSize: '0.78rem', padding: '7px 12px' }}
              >
                {isRunningDemo ? '⚡ Extracting Sample Stream...' : '✨ Run Sample Stream → Open Board'}
              </button>
            </div>
          </div>
        </div>
      )}

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
          { id: 'stream', label: '🌊 Thought Stream' },
          { id: 'today', label: "📋 Today's Board" },
          { id: 'focus', label: '🎯 Focus Mode' },
          { id: 'memory', label: '🧠 Memory & Inspector' }
        ].map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                flex: 1,
                padding: '10px 12px',
                borderRadius: 10,
                border: 'none',
                background: isActive ? 'linear-gradient(135deg, rgba(0, 240, 255, 0.2), rgba(121, 40, 202, 0.2))' : 'transparent',
                color: isActive ? '#f8fafc' : 'var(--text-muted)',
                fontWeight: isActive ? 700 : 500,
                fontSize: '0.84rem',
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
        {activeTab === 'companion' && <CompanionView streak={streak} onActionExecuted={fetchStreak} />}
        {(activeTab === 'stream' || activeTab === 'dump') && <DumpView onTasksCreated={fetchStreak} />}
        {activeTab === 'today' && <TodayView onFocusTaskSelected={handleSelectFocus} />}
        {activeTab === 'focus' && (
          <FocusView
            task={focusTask}
            onTaskCompleted={handleTaskCompleted}
            onExitFocus={() => setActiveTab('today')}
          />
        )}
        {activeTab === 'memory' && <SystemMemoryView />}
      </main>

      {/* Footer */}
      <footer style={{ marginTop: 32, padding: '16px 0', textAlign: 'center', borderTop: '1px solid var(--border-subtle)', color: 'var(--text-dim)', fontSize: '0.78rem' }}>
        Krusch Companion v1.0.0 · Powered by <strong style={{ color: 'var(--text-muted)' }}>krusch-cascade-router</strong> & <strong style={{ color: 'var(--text-muted)' }}>krusch-context-mcp</strong> · 100% Sovereign & Local AI
      </footer>
    </div>
  );
}

export default App;
