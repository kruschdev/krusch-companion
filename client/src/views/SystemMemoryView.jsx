import React, { useState, useEffect } from 'react';

const CATEGORY_META = {
  decision: { emoji: '🧭', label: 'Decision & Commitment', color: '#38bdf8' },
  invariant: { emoji: '🛡️', label: 'Invariant & Boundary', color: '#2dd4bf' },
  lesson: { emoji: '💡', label: 'Lesson & Routine', color: '#a78bfa' },
  bug: { emoji: '⚠️', label: 'Friction & Pitfall', color: '#f0c040' },
  blocker: { emoji: '🚧', label: 'Blocker & Dependency', color: '#e8587a' }
};

export function SystemMemoryView() {
  const [memories, setMemories] = useState([]);
  const [supersededHistory, setSupersededHistory] = useState([]);
  const [decayCandidates, setDecayCandidates] = useState([]);
  const [doctor, setDoctor] = useState(null);
  const [debugInfo, setDebugInfo] = useState(null);
  const [activeSubTab, setActiveSubTab] = useState('memory'); // 'memory' | 'inspector' | 'doctor'
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [newCategory, setNewCategory] = useState('decision');
  const [newContent, setNewContent] = useState('');
  const [supersedingId, setSupersedingId] = useState(null);
  const [supersedeContent, setSupersedeContent] = useState('');
  const [statusMsg, setStatusMsg] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadAll();
  }, []);

  const showBanner = (msg) => {
    setStatusMsg(msg);
    setTimeout(() => setStatusMsg(null), 4000);
  };

  const loadAll = async () => {
    setIsLoading(true);
    try {
      const [ctxRes, histRes, docRes, dbgRes] = await Promise.all([
        fetch('/api/context'),
        fetch('/api/context/history'),
        fetch('/api/doctor'),
        fetch('/api/debug')
      ]);

      if (ctxRes.ok) {
        const ctxData = await ctxRes.json();
        setMemories(ctxData.activeMemories || []);
        setDecayCandidates(ctxData.decayCandidates || []);
      }
      if (histRes.ok) {
        const histData = await histRes.json();
        setSupersededHistory(histData.supersededMemories || []);
      }
      if (docRes.ok) {
        setDoctor(await docRes.json());
      }
      if (dbgRes.ok) {
        setDebugInfo(await dbgRes.json());
      }
    } catch (err) {
      console.error('Failed to load system & memory view:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddMemory = async (e) => {
    e.preventDefault();
    if (!newContent.trim()) return;
    try {
      const res = await fetch('/api/context/remember', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: newCategory,
          content: newContent.trim()
        })
      });
      if (res.ok) {
        setNewContent('');
        showBanner('🧠 Added fact to Working Memory.');
        await loadAll();
      }
    } catch (err) {
      alert(`Failed to add memory: ${err.message}`);
    }
  };

  const handleSupersede = async (oldMem) => {
    if (!supersedeContent.trim()) return;
    try {
      const res = await fetch('/api/context/supersede', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetId: oldMem.id,
          category: oldMem.category,
          content: supersedeContent.trim()
        })
      });
      if (res.ok) {
        setSupersedingId(null);
        setSupersedeContent('');
        showBanner(`🔄 Superseded memory #${oldMem.id} with temporal lineage link.`);
        await loadAll();
      }
    } catch (err) {
      alert(`Supersede failed: ${err.message}`);
    }
  };

  const handleDeleteMemory = async (id) => {
    try {
      const res = await fetch(`/api/context/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setMemories(prev => prev.filter(m => m.id !== id));
        showBanner(`🗑️ Removed memory #${id}.`);
      }
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
  };

  const handleUpdateRuntime = async (patch) => {
    try {
      const res = await fetch('/api/settings/runtime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      if (res.ok) {
        const updated = await res.json();
        setDebugInfo(prev => (prev ? { ...prev, ...updated } : updated));
        showBanner(`⚙️ Updated runtime setting (${Object.keys(patch).join(', ')}).`);
      }
    } catch (err) {
      alert(`Failed to update runtime setting: ${err.message}`);
    }
  };

  const filteredMemories =
    categoryFilter === 'all'
      ? memories
      : memories.filter(m => m.category === categoryFilter);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header & Sub-Navigation + Portability Export */}
      <div
        className="glass-panel"
        style={{
          padding: 20,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 14
        }}
      >
        <div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 800, marginBottom: 4 }}>
            🧠 Working Memory, Routing Inspector & Setup Doctor
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.86rem' }}>
            Inspect temporal memory lineage, configure cascade resource mode & side-effect safety gates, or export your data.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <a
            href="/api/export?format=markdown"
            download
            className="btn-secondary"
            style={{ fontSize: '0.8rem', padding: '6px 12px', textDecoration: 'none' }}
            title="Download all tasks, memories, and priorities as portable Markdown"
          >
            📥 Export Markdown
          </a>
          <a
            href="/api/export?format=json"
            download
            className="btn-secondary"
            style={{ fontSize: '0.8rem', padding: '6px 12px', textDecoration: 'none' }}
            title="Download full JSON snapshot of tasks, memories, and lineage"
          >
            📦 Export JSON
          </a>
          <button
            type="button"
            className="btn-secondary"
            onClick={loadAll}
            style={{ fontSize: '0.8rem', padding: '6px 12px' }}
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {statusMsg && (
        <div
          className="glass-card"
          style={{
            padding: '10px 16px',
            borderLeft: '4px solid var(--accent-cyan)',
            fontSize: '0.88rem'
          }}
        >
          {statusMsg}
        </div>
      )}

      {/* Sub-Tabs */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {[
          { id: 'memory', label: `🧠 Working Memory (${memories.length} Active · ${supersededHistory.length} Superseded)` },
          { id: 'inspector', label: '🔬 Routing, <holodata> & Safety Gate Inspector' },
          { id: 'doctor', label: `🩺 Setup Doctor (${doctor?.status === 'ok' ? 'All Ready' : 'Checks'})` }
        ].map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveSubTab(tab.id)}
            className="btn-secondary"
            style={{
              padding: '8px 14px',
              fontSize: '0.83rem',
              borderColor: activeSubTab === tab.id ? 'var(--accent-cyan)' : 'var(--border-subtle)',
              background: activeSubTab === tab.id ? 'rgba(0, 240, 255, 0.14)' : 'rgba(16, 20, 32, 0.5)',
              color: activeSubTab === tab.id ? '#f8fafc' : 'var(--text-muted)',
              fontWeight: activeSubTab === tab.id ? 700 : 500
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="glass-panel" style={{ padding: 32, textAlign: 'center', color: 'var(--text-dim)' }}>
          Loading sovereign telemetry & working memory...
        </div>
      ) : activeSubTab === 'memory' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Add New Memory Form */}
          <form onSubmit={handleAddMemory} className="glass-card" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <select
              value={newCategory}
              onChange={e => setNewCategory(e.target.value)}
              style={{ width: 'auto', minWidth: 165 }}
            >
              {Object.entries(CATEGORY_META).map(([key, meta]) => (
                <option key={key} value={key}>
                  {meta.emoji} {meta.label}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={newContent}
              onChange={e => setNewContent(e.target.value)}
              placeholder="Store a durable fact, routine, preference, or family note..."
              style={{ flex: 1, minWidth: 240 }}
            />
            <button type="submit" className="btn-primary" disabled={!newContent.trim()}>
              + Remember Fact
            </button>
          </form>

          {/* Category Filter Pills */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setCategoryFilter('all')}
              style={{
                fontSize: '0.76rem',
                padding: '4px 12px',
                borderColor: categoryFilter === 'all' ? 'var(--accent-cyan)' : undefined
              }}
            >
              All ({memories.length})
            </button>
            {Object.entries(CATEGORY_META).map(([key, meta]) => {
              const count = memories.filter(m => m.category === key).length;
              return (
                <button
                  key={key}
                  type="button"
                  className="btn-secondary"
                  onClick={() => setCategoryFilter(key)}
                  style={{
                    fontSize: '0.76rem',
                    padding: '4px 12px',
                    borderColor: categoryFilter === key ? meta.color : undefined
                  }}
                >
                  {meta.emoji} {meta.label} ({count})
                </button>
              );
            })}
          </div>

          {/* Active Working Memories List */}
          <div className="glass-panel" style={{ padding: 18 }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 12 }}>
              Active Working Memory Facts ({filteredMemories.length})
            </h3>
            {filteredMemories.length === 0 ? (
              <p style={{ color: 'var(--text-dim)', fontSize: '0.88rem', fontStyle: 'italic' }}>
                No active memories in this category yet.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {filteredMemories.map(mem => {
                  const meta = CATEGORY_META[mem.category] || CATEGORY_META.preference;
                  const isEditing = supersedingId === mem.id;
                  return (
                    <div
                      key={mem.id}
                      className="glass-card"
                      style={{
                        padding: '12px 14px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                        borderLeft: `3px solid ${meta.color}`
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: 1 }}>
                          <span
                            style={{
                              fontSize: '0.72rem',
                              fontWeight: 700,
                              padding: '2px 8px',
                              borderRadius: 999,
                              background: `${meta.color}22`,
                              color: meta.color,
                              border: `1px solid ${meta.color}55`
                            }}
                          >
                            {meta.emoji} {meta.label}
                          </span>
                          <span style={{ fontSize: '0.93rem', fontWeight: 500 }}>{mem.content}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => {
                              setSupersedingId(isEditing ? null : mem.id);
                              setSupersedeContent(mem.content);
                            }}
                            style={{ fontSize: '0.73rem', padding: '4px 9px' }}
                            title="Supersede this fact with updated information (preserves temporal lineage)"
                          >
                            🔄 Supersede
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteMemory(mem.id)}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: 'var(--text-dim)',
                              cursor: 'pointer',
                              fontSize: '0.95rem',
                              padding: 4
                            }}
                            title="Delete Memory"
                          >
                            ✕
                          </button>
                        </div>
                      </div>

                      {isEditing && (
                        <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                          <input
                            type="text"
                            value={supersedeContent}
                            onChange={e => setSupersedeContent(e.target.value)}
                            placeholder="Enter updated fact that supersedes this memory..."
                            style={{ flex: 1, minWidth: 220, fontSize: '0.85rem' }}
                          />
                          <button
                            type="button"
                            className="btn-primary"
                            onClick={() => handleSupersede(mem)}
                            style={{ fontSize: '0.78rem', padding: '6px 12px' }}
                          >
                            Save Superseded Fact
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Superseded Lineage History */}
          <div className="glass-panel" style={{ padding: 18 }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 6 }}>
              🔄 Temporal Superseding Lineage ({supersededHistory.length} Retired Facts)
            </h3>
            <p style={{ color: 'var(--text-dim)', fontSize: '0.8rem', marginBottom: 12 }}>
              Superseded memories are automatically excluded from prompt injection so the LLM never hallucinates outdated schedules or preferences.
            </p>
            {supersededHistory.length === 0 ? (
              <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem', fontStyle: 'italic' }}>
                No superseded memories yet. Click &ldquo;🔄 Supersede&rdquo; on any active memory when a schedule or preference changes.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {supersededHistory.map(oldMem => (
                  <div
                    key={oldMem.id}
                    className="glass-card"
                    style={{
                      padding: '10px 14px',
                      opacity: 0.75,
                      fontSize: '0.84rem',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4
                    }}
                  >
                    <div>
                      <span style={{ textDecoration: 'line-through', color: 'var(--text-dim)' }}>
                        #{oldMem.id} [{oldMem.category}]: {oldMem.content}
                      </span>
                    </div>
                    {oldMem.superseded_by_content && (
                      <div style={{ color: 'var(--accent-emerald)', fontFamily: 'var(--font-mono)', fontSize: '0.78rem' }}>
                        ↳ Superseded by #{oldMem.superseded_by}: &ldquo;{oldMem.superseded_by_content}&rdquo;
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 30-Day Decay Candidates */}
          {decayCandidates.length > 0 && (
            <div className="glass-panel" style={{ padding: 18, borderLeft: '4px solid var(--accent-amber)' }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 6 }}>
                ⏳ 30-Day Decay Review Candidates ({decayCandidates.length})
              </h3>
              <p style={{ color: 'var(--text-dim)', fontSize: '0.8rem', marginBottom: 10 }}>
                These memories have not been accessed in over 30 days. Supersede or delete if no longer accurate.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {decayCandidates.map(dc => (
                  <div key={dc.id} className="glass-card" style={{ padding: '8px 12px', fontSize: '0.84rem', display: 'flex', justifyContent: 'space-between' }}>
                    <span>[{dc.category}] {dc.content}</span>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => handleDeleteMemory(dc.id)}
                      style={{ fontSize: '0.72rem', padding: '2px 8px' }}
                    >
                      Retire
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : activeSubTab === 'inspector' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Runtime Resource Mode & Side-Effect Confirmation Gate */}
          <div className="glass-panel" style={{ padding: 18, borderLeft: '4px solid var(--accent-cyan)' }}>
            <h3 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: 12 }}>
              ⚙️ Runtime Resource Mode & Side-Effect Safety Gate
            </h3>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: '0.84rem', fontWeight: 600 }}>Cascade Resource Profile:</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  {[
                    { id: 'minimal', label: '🌱 Minimal (Edge/CPU Priority)' },
                    { id: 'balanced', label: '⚡ Balanced (Default Cascade)' },
                    { id: 'quality', label: '🚀 Quality (Deep Reasoning)' }
                  ].map(mode => {
                    const active = (debugInfo?.resourceMode || 'balanced') === mode.id;
                    return (
                      <button
                        key={mode.id}
                        type="button"
                        className="btn-secondary"
                        onClick={() => handleUpdateRuntime({ resourceMode: mode.id })}
                        style={{
                          fontSize: '0.78rem',
                          padding: '6px 12px',
                          borderColor: active ? 'var(--accent-cyan)' : undefined,
                          background: active ? 'rgba(0, 240, 255, 0.14)' : undefined,
                          color: active ? '#f8fafc' : undefined
                        }}
                      >
                        {mode.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: '0.84rem', fontWeight: 600 }}>External Side-Effect Tool Gate (Gmail/Calendar/Reservations):</span>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => handleUpdateRuntime({ dryRunMode: !debugInfo?.dryRunMode })}
                  style={{
                    fontSize: '0.8rem',
                    padding: '6px 14px',
                    borderColor: debugInfo?.dryRunMode ? '#f0c040' : '#2dd4bf',
                    color: debugInfo?.dryRunMode ? '#f0c040' : '#2dd4bf'
                  }}
                >
                  {debugInfo?.dryRunMode
                    ? '🛡️ Confirm-Before-Act (Dry-Run Preview Enabled)'
                    : '⚡ Live Execution Enabled (Click to Enable Dry-Run Gate)'}
                </button>
              </div>
            </div>
          </div>

          {/* Last Cascade Router & Knowledge Boundary Decision */}
          <div className="glass-panel" style={{ padding: 18 }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 10 }}>
              🧭 Last Cascade Routing & Knowledge Boundary Decision
            </h3>
            {debugInfo?.lastRoutingDecision ? (
              <div
                className="glass-card"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.8rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  padding: 14
                }}
              >
                <div><strong>Timestamp:</strong> {debugInfo.lastRoutingDecision.timestamp}</div>
                <div><strong>Prompt:</strong> &ldquo;{debugInfo.lastRoutingDecision.promptPreview}&rdquo;</div>
                <div><strong>Selected Tier:</strong> <span style={{ color: 'var(--accent-cyan)' }}>{debugInfo.lastRoutingDecision.tierUsed}</span> ({debugInfo.lastRoutingDecision.latencyMs}ms)</div>
                <div><strong>Routing Reason:</strong> {debugInfo.lastRoutingDecision.reason}</div>
                <div>
                  <strong>Knowledge Boundary Gate:</strong>{' '}
                  <span style={{ color: debugInfo.lastRoutingDecision.contextActivated ? '#a78bfa' : '#2dd4bf' }}>
                    {debugInfo.lastRoutingDecision.contextActivated
                      ? '🧠 Context Injected (Open-World Personal Query)'
                      : '🛡️ Boundary Gated (Closed-World Utility — 0 Memory Tokens Injected)'}
                  </span>
                </div>
                {debugInfo.lastRoutingDecision.agenticToolsCalled?.length > 0 && (
                  <div>
                    <strong>&lt;holodata&gt; Tools Executed:</strong> {debugInfo.lastRoutingDecision.agenticToolsCalled.join(', ')}
                  </div>
                )}
              </div>
            ) : (
              <p style={{ color: 'var(--text-dim)', fontSize: '0.86rem', fontStyle: 'italic' }}>
                Send a message in Companion Chat to inspect live L0/L1/L2 routing and Knowledge Boundary decisions.
              </p>
            )}
          </div>

          {/* Dynamic Tool Pruning & Sentinel Watchdog Telemetry */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
            <div className="glass-panel" style={{ padding: 16 }}>
              <h3 style={{ fontSize: '0.96rem', fontWeight: 700, marginBottom: 8 }}>
                ✂️ Dynamic Tool Pruning Visibility
              </h3>
              {debugInfo?.toolPruningReport ? (
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div>
                    <strong>Schema Reduction:</strong> {debugInfo.toolPruningReport.totalToolsAvailable} tools →{' '}
                    <span style={{ color: 'var(--accent-cyan)' }}>{debugInfo.toolPruningReport.prunedCount} injected</span> ({debugInfo.toolPruningReport.reductionPct}% pruned)
                  </div>
                  <div>
                    <strong>Injected Schemas:</strong> {(debugInfo.toolPruningReport.selectedTools || []).join(', ')}
                  </div>
                </div>
              ) : (
                <p style={{ fontSize: '0.82rem', color: 'var(--text-dim)', fontStyle: 'italic' }}>
                  Prunes 21 schemas down to ≤ 4 domain-matched tools per turn (~81% prompt reduction).
                </p>
              )}
            </div>

            <div className="glass-panel" style={{ padding: 16 }}>
              <h3 style={{ fontSize: '0.96rem', fontWeight: 700, marginBottom: 8 }}>
                🛰️ Sentinel Watchdog Wake / Silent Audit
              </h3>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div>
                  <strong>Daemon State:</strong>{' '}
                  <span style={{ color: debugInfo?.sentinelStatus?.isRunning ? '#2dd4bf' : 'var(--text-dim)' }}>
                    {debugInfo?.sentinelStatus?.isRunning ? '🟢 Active Polling' : '⚪ Standby'}
                  </span>
                </div>
                <div>
                  <strong>Total Checks:</strong> {debugInfo?.sentinelStatus?.totalChecks || 0} |{' '}
                  <strong>Silent:</strong> {debugInfo?.sentinelStatus?.silentChecks || 0} |{' '}
                  <strong>LLM Wakes:</strong> {debugInfo?.sentinelStatus?.totalAlertsTriggered || 0}
                </div>
                <div>
                  <strong>Last Decision:</strong> {debugInfo?.sentinelStatus?.lastDecisionReason || 'No threshold breaches'}
                </div>
              </div>
            </div>
          </div>

          {/* Agentic Tool Execution Telemetry */}
          <div className="glass-panel" style={{ padding: 18 }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 10 }}>
              🔧 &lt;holodata&gt; Agentic Proxy Tool Telemetry &amp; TTL Cache
            </h3>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12, fontFamily: 'var(--font-mono)', fontSize: '0.82rem' }}>
              <span>Total Calls: <strong>{debugInfo?.agenticTools?.totalCalls || 0}</strong></span>
              <span style={{ color: '#2dd4bf' }}>Success: <strong>{debugInfo?.agenticTools?.totalSuccess || 0}</strong></span>
              <span style={{ color: '#f87171' }}>Failures: <strong>{debugInfo?.agenticTools?.totalFailures || 0}</strong></span>
              <span style={{ color: '#f0c040' }}>Dry-Run Previews: <strong>{debugInfo?.agenticTools?.totalDryRuns || 0}</strong></span>
              <span style={{ color: '#38bdf8' }}>60s TTL Cache Hits: <strong>{debugInfo?.agenticTools?.cacheHits || 0}</strong></span>
            </div>
            {debugInfo?.agenticTools?.perTool && Object.keys(debugInfo.agenticTools.perTool).length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {Object.entries(debugInfo.agenticTools.perTool).map(([toolName, stat]) => (
                  <div
                    key={toolName}
                    className="glass-card"
                    style={{
                      padding: '8px 12px',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.78rem',
                      display: 'flex',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: 8
                    }}
                  >
                    <strong>{toolName}</strong>
                    <span>
                      Calls: {stat.calls} | OK: {stat.success} | Fail: {stat.failures} | DryRun: {stat.dryRuns} | Cache: {stat.cacheHits || 0} | Last: {stat.lastLatencyMs}ms
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ color: 'var(--text-dim)', fontSize: '0.84rem', fontStyle: 'italic' }}>
                No agentic tool calls recorded in this session yet.
              </p>
            )}

            {/* Local Failed / Low-Confidence Extraction Audit Log */}
            {Array.isArray(debugInfo?.failedToolCallLogs) && debugInfo.failedToolCallLogs.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <h4 style={{ fontSize: '0.86rem', fontWeight: 700, marginBottom: 6, color: '#f0c040' }}>
                  ⚠️ Local Failed &amp; Low-Confidence Tool Call Audit Log ({debugInfo.failedToolCallLogs.length})
                </h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {debugInfo.failedToolCallLogs.slice(0, 8).map((entry, idx) => (
                    <div
                      key={idx}
                      className="glass-card"
                      style={{ padding: '8px 12px', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', borderLeft: '3px solid #f0c040' }}
                    >
                      [{entry.type}] <strong>{entry.tool}</strong>: {entry.reason} ({entry.timestamp})
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Setup Doctor Checklist */
        <div className="glass-panel" style={{ padding: 18 }}>
          <h3 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: 6 }}>
            🩺 Sovereign Setup Doctor & Environment Verification
          </h3>
          <p style={{ color: 'var(--text-dim)', fontSize: '0.82rem', marginBottom: 14 }}>
            Run <code>npm run doctor</code> in your terminal or inspect live readiness checks below.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(doctor?.checks || []).map(chk => {
              const badgeColor =
                chk.status === 'ok'
                  ? '#2dd4bf'
                  : chk.status === 'warn'
                    ? '#f0c040'
                    : chk.status === 'fail'
                      ? '#f87171'
                      : '#60a5fa';
              return (
                <div
                  key={chk.id}
                  className="glass-card"
                  style={{
                    padding: '10px 14px',
                    borderLeft: `3px solid ${badgeColor}`,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 8
                  }}
                >
                  <div>
                    <strong style={{ fontSize: '0.9rem' }}>{chk.label}</strong>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                      {chk.detail}
                    </div>
                  </div>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      padding: '2px 10px',
                      borderRadius: 999,
                      background: `${badgeColor}22`,
                      color: badgeColor,
                      border: `1px solid ${badgeColor}66`,
                      textTransform: 'uppercase'
                    }}
                  >
                    {chk.status}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default SystemMemoryView;
