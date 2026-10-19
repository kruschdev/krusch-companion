import React, { useState, useEffect } from 'react';

const DEFAULT_EXTENSIONS = [
  {
    id: 'krusch-fs-explorer',
    name: 'KruschFS Local Document & PDF Search',
    category: 'filesystem',
    enabled: true,
    description: 'Search local PDFs, manuals, receipts, and notes across ~/Documents & ~/Downloads with SHA-256 page verification.'
  },
  {
    id: 'multimodal-vision',
    name: 'Multimodal Vision & Receipt/Flyer Triage (gemma4:e4b)',
    category: 'vision',
    enabled: true,
    description: 'Extract tasks, school flyer dates, and receipt line items using local multimodal vision.'
  },
  {
    id: 'finance-subscription-sentinel',
    name: 'Subscriptions & Recurring Bill Ledger',
    category: 'finance',
    enabled: true,
    description: 'Track recurring subscriptions and surface 3-day auto-renewal alerts into Lane 1.'
  },
  {
    id: 'health-biometric-sync',
    name: 'Biometric Energy & Sleep Readiness Sync',
    category: 'health_biometrics',
    enabled: true,
    description: 'Sync sleep hours, HRV, and readiness score to adapt Today Priority Board to your energy.'
  },
  {
    id: 'media-jellyfin-controller',
    name: 'Media, Focus Soundscape & Jellyfin Controller',
    category: 'media_controller',
    enabled: true,
    description: 'One-click brown noise, rain ambient, lo-fi focus audio, and kruschmedia Jellyfin control.'
  },
  {
    id: 'messaging-shortcut-bridge',
    name: '2-Way Telegram / Discord & iOS Action Button Hub',
    category: 'messaging_bridge',
    enabled: true,
    description: 'Webhook bridge for Telegram/Discord bots and iOS Action Button voice/JSON shortcuts.'
  }
];

export function ExtensionsView({ onBoardUpdated } = {}) {
  const [extensions, setExtensions] = useState(DEFAULT_EXTENSIONS);
  const [statusBanner, setStatusBanner] = useState('');

  // 1. KruschFS Search state
  const [fsQuery, setFsQuery] = useState('warranty');
  const [fsResult, setFsResult] = useState(null);
  const [fsLoading, setFsLoading] = useState(false);

  // 2. Multimodal Vision state
  const [visionPrompt, setVisionPrompt] = useState('Extract action items, deadlines, and total amount from this receipt or flyer.');
  const [visionFileName, setVisionFileName] = useState('');
  const [visionImageData, setVisionImageData] = useState('');
  const [visionResult, setVisionResult] = useState(null);
  const [visionLoading, setVisionLoading] = useState(false);

  // 3. Finance / Subscriptions state
  const [financeData, setFinanceData] = useState({ subscriptions: [], upcomingRenewals: [], monthlyTotal: 0 });
  const [subName, setSubName] = useState('');
  const [subAmount, setSubAmount] = useState('');
  const [subRenewalDate, setSubRenewalDate] = useState('');
  const [financeResult, setFinanceResult] = useState('');

  // 4. Health & Biometric Energy state
  const [sleepHours, setSleepHours] = useState(6.5);
  const [readinessScore, setReadinessScore] = useState(72);
  const [hrvMs, setHrvMs] = useState(55);
  const [energyBand, setEnergyBand] = useState('medium');
  const [healthResult, setHealthResult] = useState('');
  const [healthLoading, setHealthLoading] = useState(false);

  // 5. Media & Focus Soundscape state
  const [mediaState, setMediaState] = useState({ activeSession: null, sessions: [], jellyfinUrl: 'http://100.69.39.19:8096' });
  const [mediaVolume, setMediaVolume] = useState(65);
  const [mediaResult, setMediaResult] = useState('');

  // 6. Shortcut & Messaging Bot Hub state
  const [shortcutPreview, setShortcutPreview] = useState(null);
  const [botInput, setBotInput] = useState('What is my top priority task today?');
  const [botReply, setBotReply] = useState('');
  const [botLoading, setBotLoading] = useState(false);

  const loadHubData = async () => {
    try {
      const [extRes, finRes, healthRes, mediaRes, shortRes] = await Promise.allSettled([
        fetch('/api/extensions'),
        fetch('/api/finance'),
        fetch('/api/health-sync'),
        fetch('/api/media'),
        fetch('/api/companion/shortcut')
      ]);

      if (extRes.status === 'fulfilled' && extRes.value.ok) {
        const data = await extRes.value.json();
        const list = data.extensions || data.items || (Array.isArray(data) ? data : null);
        if (Array.isArray(list) && list.length > 0) {
          setExtensions(list);
        }
      }

      if (finRes.status === 'fulfilled' && finRes.value.ok) {
        const data = await finRes.value.json();
        const resolvedMonthlyTotal =
          data.monthlyRecurringTotal ??
          data.monthlyTotal ??
          data.summary?.monthlyRecurringTotal ??
          data.data?.monthlyRecurringTotal ??
          data.data?.monthlyTotal ??
          0;
        setFinanceData({
          subscriptions: data.subscriptions || data.data?.subscriptions || [],
          upcomingRenewals: data.upcomingRenewals || data.data?.upcomingRenewals || [],
          monthlyRecurringTotal: resolvedMonthlyTotal,
          monthlyTotal: resolvedMonthlyTotal
        });
      }

      if (healthRes.status === 'fulfilled' && healthRes.value.ok) {
        const data = await healthRes.value.json();
        const current =
          data.current ||
          data.latest ||
          data.metrics?.current ||
          data.metrics?.latest ||
          data.data?.current ||
          data.metrics ||
          data;
        if (current) {
          if (current.sleep_hours !== undefined || current.sleepHours !== undefined) {
            setSleepHours(Number(current.sleep_hours ?? current.sleepHours ?? 7.5));
          }
          if (current.readiness_score !== undefined || current.readinessScore !== undefined) {
            setReadinessScore(Number(current.readiness_score ?? current.readinessScore ?? 80));
          }
          if (current.hrv_ms !== undefined || current.hrvMs !== undefined) {
            setHrvMs(Number(current.hrv_ms ?? current.hrvMs ?? 55));
          }
          if (current.energy_band || current.energyBand) {
            setEnergyBand(current.energy_band || current.energyBand);
          }
        }
      }

      if (mediaRes.status === 'fulfilled' && mediaRes.value.ok) {
        const data = await mediaRes.value.json();
        const payload = data.data || data;
        setMediaState({
          activeSession: payload.activeSession || null,
          sessions: payload.sessions || [],
          jellyfinUrl: payload.jellyfinUrl || 'http://100.69.39.19:8096'
        });
        if (payload.activeSession?.volume !== undefined) {
          setMediaVolume(Number(payload.activeSession.volume));
        }
      }

      if (shortRes.status === 'fulfilled' && shortRes.value.ok) {
        const data = await shortRes.value.json();
        setShortcutPreview(data);
      }
    } catch (err) {
      console.error('Failed to hydrate Extensions Hub:', err);
    }
  };

  useEffect(() => {
    loadHubData();
  }, []);

  const handleToggleExtension = async (ext) => {
    const extensionId = ext.id || ext.extensionId;
    const nextEnabled = !ext.enabled;
    setExtensions(prev =>
      prev.map(item => ((item.id || item.extensionId) === extensionId ? { ...item, enabled: nextEnabled } : item))
    );
    try {
      const res = await fetch('/api/extensions/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extensionId, enabled: nextEnabled })
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.extensions)) {
          setExtensions(data.extensions);
        }
        setStatusBanner(`Extension "${ext.name || extensionId}" ${nextEnabled ? 'enabled' : 'disabled'}.`);
      }
    } catch (err) {
      setStatusBanner(`Toggle saved locally (${err.message}).`);
    }
  };

  // 1. KruschFS Search handler
  const handleFsSearch = async (e) => {
    e.preventDefault();
    if (!fsQuery.trim()) return;
    setFsLoading(true);
    try {
      const res = await fetch('/api/companion/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: 'krusch_fs_explorer',
          action: 'search',
          query: fsQuery.trim(),
          args: { action: 'search', query: fsQuery.trim() }
        })
      });
      const data = await res.json();
      setFsResult(data);
    } catch (err) {
      setFsResult({ ok: false, summary: `Search failed: ${err.message}` });
    } finally {
      setFsLoading(false);
    }
  };

  // 2. Multimodal Vision handler
  const handleVisionFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVisionFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setVisionImageData(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleRunVision = async (sampleTitle = '') => {
    setVisionLoading(true);
    try {
      const effectivePrompt = sampleTitle
        ? `${visionPrompt} (Sample: ${sampleTitle})`
        : visionPrompt;
      let res = await fetch('/api/companion/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: 'vision_capture',
          action: 'analyze_receipt',
          prompt: effectivePrompt,
          fileName: visionFileName || sampleTitle || 'sample-receipt.jpg',
          imageBase64: visionImageData || null
        })
      });
      if (!res.ok) {
        res = await fetch('/api/companion/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool: 'vision_capture',
            action: 'analyze_receipt',
            prompt: effectivePrompt,
            args: {
              action: 'analyze_receipt',
              prompt: effectivePrompt,
              imagePath: visionFileName || 'sample-receipt.jpg'
            }
          })
        });
      }
      const data = await res.json();
      setVisionResult(data);
      if (onBoardUpdated) onBoardUpdated();
    } catch (err) {
      setVisionResult({ ok: false, summary: `Vision triage error: ${err.message}` });
    } finally {
      setVisionLoading(false);
    }
  };

  // 3. Subscriptions & Recurring Bills handlers
  const handleAddSubscription = async (e) => {
    e.preventDefault();
    if (!subName.trim()) return;
    try {
      const payload = {
        action: 'add_subscription',
        name: subName.trim(),
        amount: parseFloat(subAmount) || 14.99,
        billingCycle: 'monthly',
        nextRenewalDate: subRenewalDate || new Date(Date.now() + 2 * 86400000).toISOString().split('T')[0]
      };
      let res = await fetch('/api/finance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        res = await fetch('/api/companion/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool: 'subscription_bill_tracker',
            ...payload,
            args: payload
          })
        });
      }
      const data = await res.json();
      setFinanceResult(data.summary || `Saved subscription: ${subName}`);
      setSubName('');
      setSubAmount('');
      await loadHubData();
      if (onBoardUpdated) onBoardUpdated();
    } catch (err) {
      setFinanceResult(`Failed to add subscription: ${err.message}`);
    }
  };

  const handleScanRenewals = async () => {
    try {
      let res = await fetch('/api/finance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'check_renewals', daysAhead: 3 })
      });
      if (!res.ok) {
        res = await fetch('/api/companion/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool: 'subscription_bill_tracker',
            action: 'check_renewals',
            args: { action: 'check_renewals', daysAhead: 3 }
          })
        });
      }
      const data = await res.json();
      setFinanceResult(data.summary || 'Scanned 3-day auto-renewals and surfaced urgent bill alerts.');
      await loadHubData();
      if (onBoardUpdated) onBoardUpdated();
    } catch (err) {
      setFinanceResult(`Renewal scan failed: ${err.message}`);
    }
  };

  // 4. Health & Biometric Readiness handlers
  const handleSyncHealth = async (adaptBoard = false) => {
    setHealthLoading(true);
    try {
      const action = adaptBoard ? 'adapt_board' : 'log_metrics';
      const payload = {
        action,
        sleepHours: Number(sleepHours),
        sleepScore: Number(readinessScore),
        readinessScore: Number(readinessScore),
        hrvMs: Number(hrvMs),
        source: 'companion_extensions_ui'
      };
      let res = await fetch('/api/health-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        res = await fetch('/api/companion/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool: 'health_energy_sync',
            ...payload,
            args: payload
          })
        });
      }
      const data = await res.json();
      const nextBand =
        data.energyBand ||
        data.data?.energyBand ||
        data.current?.energy_band ||
        (Number(readinessScore) < 60 || Number(sleepHours) < 6.0 ? 'low_recovery' : Number(readinessScore) < 78 ? 'medium' : 'high');
      setEnergyBand(nextBand);
      setHealthResult(
        data.recommendation ||
          data.summary ||
          data.data?.recommendation ||
          `Synced ${sleepHours}h sleep & ${readinessScore}/100 readiness (${nextBand}).`
      );
      await loadHubData();
      if (adaptBoard && onBoardUpdated) {
        onBoardUpdated();
      }
    } catch (err) {
      setHealthResult(`Health sync failed: ${err.message}`);
    } finally {
      setHealthLoading(false);
    }
  };

  // 5. Media & Focus Soundscape handler
  const handleMediaControl = async ({ action = 'play', query = '', provider = 'focus_audio' } = {}) => {
    try {
      const payload = {
        action,
        query,
        provider,
        volume: Number(mediaVolume)
      };
      let res = await fetch('/api/media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        res = await fetch('/api/companion/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool: 'media_controller',
            ...payload,
            args: payload
          })
        });
      }
      const data = await res.json();
      const resolved = data.data || data;
      if (resolved.activeSession !== undefined || resolved.sessions) {
        setMediaState(prev => ({
          ...prev,
          activeSession: resolved.activeSession ?? null,
          sessions: resolved.sessions || prev.sessions
        }));
      }
      setMediaResult(data.summary || `Media action "${action}" (${query || provider}) executed.`);
    } catch (err) {
      setMediaResult(`Media control error: ${err.message}`);
    }
  };

  // 6. Shortcut & Bot Bridge handler
  const handleTestBotTurn = async (e) => {
    e.preventDefault();
    if (!botInput.trim()) return;
    setBotLoading(true);
    try {
      let res = await fetch('/api/companion/shortcut', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: botInput.trim(),
          message: botInput.trim(),
          platform: 'ios_action_button'
        })
      });
      if (!res.ok) {
        res = await fetch('/api/companion/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool: 'messaging_shortcut_bridge',
            action: 'send_digest',
            message: botInput.trim(),
            args: { action: 'send_digest', message: botInput.trim() }
          })
        });
      }
      const data = await res.json();
      setBotReply(data.reply || data.summary || data.spokenResponse || JSON.stringify(data));
      await loadHubData();
      if (onBoardUpdated) onBoardUpdated();
    } catch (err) {
      setBotReply(`Shortcut bridge error: ${err.message}`);
    } finally {
      setBotLoading(false);
    }
  };

  const badgeColorForBand = (band) => {
    if (band === 'low_recovery') return '#f43f5e';
    if (band === 'medium') return '#fbbf24';
    return '#10b981';
  };

  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header & Opt-In Extensions Registry */}
      <section className="glass-panel" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h2 style={{ fontSize: '1.18rem', fontWeight: 800, color: '#f8fafc', display: 'flex', alignItems: 'center', gap: 8 }}>
              🧩 Extensions &amp; Capabilities Hub
            </h2>
            <p style={{ fontSize: '0.84rem', color: 'var(--text-muted)', marginTop: 2 }}>
              Opt-in sovereign capabilities for document RAG, multimodal vision, recurring bills, biometric energy sync, focus audio, and mobile shortcuts.
            </p>
          </div>
          <button type="button" className="btn-secondary" onClick={loadHubData} style={{ fontSize: '0.8rem', padding: '7px 14px' }}>
            🔄 Refresh State
          </button>
        </div>

        {statusBanner && (
          <div
            style={{
              padding: '8px 12px',
              borderRadius: 10,
              background: 'rgba(0, 240, 255, 0.1)',
              border: '1px solid rgba(0, 240, 255, 0.25)',
              color: '#38bdf8',
              fontSize: '0.82rem'
            }}
          >
            {statusBanner}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(245px, 1fr))', gap: 10 }}>
          {extensions.map((ext) => {
            const extId = ext.id || ext.extensionId;
            const isEnabled = Boolean(ext.enabled);
            return (
              <div
                key={extId}
                className="glass-card"
                style={{
                  padding: '12px 14px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 10,
                  borderColor: isEnabled ? 'rgba(0, 240, 255, 0.28)' : 'rgba(255,255,255,0.06)'
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.86rem', fontWeight: 700, color: '#f8fafc' }}>{ext.name || extId}</div>
                  <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 2 }}>
                    {ext.description || ext.category}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggleExtension(ext)}
                  style={{
                    padding: '5px 11px',
                    borderRadius: 999,
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: '0.73rem',
                    fontWeight: 700,
                    background: isEnabled ? 'rgba(16, 185, 129, 0.2)' : 'rgba(255, 255, 255, 0.08)',
                    color: isEnabled ? '#34d399' : 'var(--text-muted)'
                  }}
                >
                  {isEnabled ? 'ON' : 'OFF'}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* 6 Quick Action Cards Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 14 }}>
        {/* Card 1: KruschFS Local Document & PDF Search */}
        <section className="glass-panel" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <h3 style={{ fontSize: '1rem', fontWeight: 700 }}>🗂️ KruschFS Local Document &amp; PDF Search</h3>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 2 }}>
              Hybrid BM25 + SHA-256 page search across ~/Documents, ~/Downloads, and sovereign notes.
            </p>
          </div>
          <form onSubmit={handleFsSearch} style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={fsQuery}
              onChange={(e) => setFsQuery(e.target.value)}
              placeholder="Search PDFs, warranties, tax docs, manuals..."
              style={{ flex: 1, padding: '9px 12px', fontSize: '0.86rem' }}
            />
            <button type="submit" className="btn-primary" disabled={fsLoading} style={{ padding: '9px 14px', fontSize: '0.84rem' }}>
              {fsLoading ? 'Searching...' : '🔎 Search'}
            </button>
          </form>
          {fsResult && (
            <div
              style={{
                fontSize: '0.8rem',
                padding: 10,
                borderRadius: 10,
                background: 'rgba(0,0,0,0.28)',
                color: '#e2e8f0',
                whiteSpace: 'pre-wrap'
              }}
            >
              {fsResult.summary || JSON.stringify(fsResult.data || fsResult, null, 2)}
            </div>
          )}
        </section>

        {/* Card 2: Multimodal Vision & Receipt/Flyer Triage */}
        <section className="glass-panel" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <h3 style={{ fontSize: '1rem', fontWeight: 700 }}>📷 Multimodal Vision &amp; Receipt/Flyer Triage (gemma4:e4b)</h3>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 2 }}>
              Snap a receipt, bill, whiteboard, or school flyer to extract checklist items directly onto Today&apos;s Board.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="file"
              accept="image/*"
              onChange={handleVisionFileChange}
              style={{ fontSize: '0.78rem', color: 'var(--text-muted)', flex: 1 }}
            />
            <button
              type="button"
              className="btn-primary"
              disabled={visionLoading}
              onClick={() => handleRunVision('Costco Receipt & School Flyer')}
              style={{ padding: '8px 14px', fontSize: '0.82rem' }}
            >
              {visionLoading ? 'Analyzing...' : '⚡ Triage Receipt / Flyer'}
            </button>
          </div>
          <input
            type="text"
            value={visionPrompt}
            onChange={(e) => setVisionPrompt(e.target.value)}
            placeholder="Vision instruction..."
            style={{ padding: '8px 12px', fontSize: '0.82rem' }}
          />
          {visionResult && (
            <div
              style={{
                fontSize: '0.8rem',
                padding: 10,
                borderRadius: 10,
                background: 'rgba(0,0,0,0.28)',
                color: '#e2e8f0',
                whiteSpace: 'pre-wrap'
              }}
            >
              {visionResult.summary || visionResult.analysis || JSON.stringify(visionResult)}
            </div>
          )}
        </section>

        {/* Card 3: Subscriptions & Recurring Bill Ledger */}
        <section className="glass-panel" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <div>
              <h3 style={{ fontSize: '1rem', fontWeight: 700 }}>💳 Subscriptions &amp; Recurring Bill Ledger</h3>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 2 }}>
                Monthly recurring burn: <strong>${Number(financeData.monthlyTotal || 0).toFixed(2)}/mo</strong> ({financeData.subscriptions.length} tracked)
              </p>
            </div>
            <button type="button" className="btn-secondary" onClick={handleScanRenewals} style={{ padding: '7px 12px', fontSize: '0.78rem' }}>
              🔔 Scan 3-Day Renewals
            </button>
          </div>
          <form onSubmit={handleAddSubscription} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <input
              type="text"
              value={subName}
              onChange={(e) => setSubName(e.target.value)}
              placeholder="Service (e.g. Gym, Cloud)"
              style={{ flex: 2, minWidth: 120, padding: '8px 10px', fontSize: '0.82rem' }}
            />
            <input
              type="text"
              value={subAmount}
              onChange={(e) => setSubAmount(e.target.value)}
              placeholder="$19.99"
              style={{ flex: 1, minWidth: 70, padding: '8px 10px', fontSize: '0.82rem' }}
            />
            <input
              type="text"
              value={subRenewalDate}
              onChange={(e) => setSubRenewalDate(e.target.value)}
              placeholder="YYYY-MM-DD"
              style={{ flex: 1, minWidth: 105, padding: '8px 10px', fontSize: '0.82rem' }}
            />
            <button type="submit" className="btn-primary" style={{ padding: '8px 12px', fontSize: '0.82rem' }}>
              + Add
            </button>
          </form>
          {financeResult && (
            <div style={{ fontSize: '0.79rem', color: '#38bdf8', background: 'rgba(0,0,0,0.24)', padding: '8px 10px', borderRadius: 8 }}>
              {financeResult}
            </div>
          )}
        </section>

        {/* Card 4: Biometric Energy & Sleep Readiness Sync */}
        <section className="glass-panel" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <div>
              <h3 style={{ fontSize: '1rem', fontWeight: 700 }}>⌚ Biometric Energy &amp; Sleep Readiness Sync</h3>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 2 }}>
                Protects Lane 1 (Must Happen Today) while adapting high-energy deep work on low-recovery days.
              </p>
            </div>
            <span
              style={{
                padding: '4px 10px',
                borderRadius: 999,
                fontSize: '0.74rem',
                fontWeight: 700,
                background: 'rgba(255,255,255,0.07)',
                color: badgeColorForBand(energyBand)
              }}
            >
              {energyBand.toUpperCase()} ({readinessScore}/100)
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <label style={{ fontSize: '0.76rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
              Sleep Hours ({sleepHours}h)
              <input
                type="range"
                min="3.5"
                max="10"
                step="0.5"
                value={sleepHours}
                onChange={(e) => setSleepHours(parseFloat(e.target.value))}
              />
            </label>
            <label style={{ fontSize: '0.76rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
              Readiness ({readinessScore})
              <input
                type="range"
                min="25"
                max="100"
                step="1"
                value={readinessScore}
                onChange={(e) => setReadinessScore(parseInt(e.target.value, 10))}
              />
            </label>
            <label style={{ fontSize: '0.76rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
              HRV ({hrvMs} ms)
              <input
                type="range"
                min="20"
                max="120"
                step="1"
                value={hrvMs}
                onChange={(e) => setHrvMs(parseInt(e.target.value, 10))}
              />
            </label>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-secondary"
              disabled={healthLoading}
              onClick={() => handleSyncHealth(false)}
              style={{ padding: '8px 12px', fontSize: '0.82rem' }}
            >
              💾 Log Biometrics
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={healthLoading}
              onClick={() => handleSyncHealth(true)}
              style={{ padding: '8px 14px', fontSize: '0.82rem', flex: 1, justifyContent: 'center' }}
            >
              ⚡ Adapt Today&apos;s Board to My Energy
            </button>
          </div>

          {healthResult && (
            <div style={{ fontSize: '0.79rem', color: '#34d399', background: 'rgba(0,0,0,0.25)', padding: '8px 10px', borderRadius: 8 }}>
              {healthResult}
            </div>
          )}
        </section>

        {/* Card 5: Media & Focus Soundscape Controller */}
        <section className="glass-panel" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <div>
              <h3 style={{ fontSize: '1rem', fontWeight: 700 }}>🎧 Media &amp; Focus Soundscape Controller</h3>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 2 }}>
                {mediaState.activeSession
                  ? `Playing: ${mediaState.activeSession.title} (${mediaState.activeSession.volume}%)`
                  : `Ready • Jellyfin twin (${mediaState.jellyfinUrl})`}
              </p>
            </div>
            <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>Vol {mediaVolume}%</span>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => handleMediaControl({ action: 'play', query: 'brown noise', provider: 'focus_audio' })}
              style={{ padding: '8px 12px', fontSize: '0.8rem' }}
            >
              🟫 Brown Noise
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => handleMediaControl({ action: 'play', query: 'rain ambient', provider: 'focus_audio' })}
              style={{ padding: '8px 12px', fontSize: '0.8rem' }}
            >
              🌧️ Rain Ambient
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => handleMediaControl({ action: 'play', query: 'lofi focus', provider: 'focus_audio' })}
              style={{ padding: '8px 12px', fontSize: '0.8rem' }}
            >
              🎹 Lo-Fi Focus
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => handleMediaControl({ action: 'status', query: 'jellyfin', provider: 'jellyfin' })}
              style={{ padding: '8px 12px', fontSize: '0.8rem' }}
            >
              🎬 Jellyfin Status
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => handleMediaControl({ action: 'stop' })}
              style={{ padding: '8px 12px', fontSize: '0.8rem', color: '#f43f5e' }}
            >
              ⏹️ Stop
            </button>
          </div>

          {mediaResult && (
            <div style={{ fontSize: '0.79rem', color: '#38bdf8', background: 'rgba(0,0,0,0.25)', padding: '8px 10px', borderRadius: 8 }}>
              {mediaResult}
            </div>
          )}
        </section>

        {/* Card 6: 2-Way Telegram / Discord / iOS Action Button Shortcut Hub */}
        <section className="glass-panel" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <h3 style={{ fontSize: '1rem', fontWeight: 700 }}>🤖 2-Way Telegram / Discord / iOS Action Button Hub</h3>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 2 }}>
              One-tap JSON voice/text endpoint (<code>/api/companion/shortcut</code>) for iPhone Action Button, Apple Watch &amp; chat bots.
            </p>
          </div>

          <form onSubmit={handleTestBotTurn} style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={botInput}
              onChange={(e) => setBotInput(e.target.value)}
              placeholder="Send a test voice/bot command..."
              style={{ flex: 1, padding: '8px 12px', fontSize: '0.84rem' }}
            />
            <button type="submit" className="btn-primary" disabled={botLoading} style={{ padding: '8px 14px', fontSize: '0.82rem' }}>
              {botLoading ? 'Sending...' : '🚀 Test Turn'}
            </button>
          </form>

          {shortcutPreview && (
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', background: 'rgba(0,0,0,0.22)', padding: '7px 10px', borderRadius: 8 }}>
              Shortcut Status: <strong>{shortcutPreview.spokenBriefing || shortcutPreview.summary || 'Ready for iOS Shortcut & Webhook calls'}</strong>
            </div>
          )}

          {botReply && (
            <div
              style={{
                fontSize: '0.8rem',
                padding: 10,
                borderRadius: 10,
                background: 'rgba(0,0,0,0.28)',
                color: '#e2e8f0',
                whiteSpace: 'pre-wrap'
              }}
            >
              {botReply}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default ExtensionsView;
