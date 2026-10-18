import React, { useState, useEffect, useRef } from 'react';
import { attachSilenceDetector } from '../utils/voiceSilenceDetector';

export function SetupView({ initialData = null, onComplete, onSkip }) {
  const [sections, setSections] = useState(initialData?.sections || []);
  const [profile, setProfile] = useState(initialData?.profile || {});
  const [activeStep, setActiveStep] = useState(1);
  const [showAllSteps, setShowAllSteps] = useState(false);
  const [loading, setLoading] = useState(!initialData);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [recordingFieldId, setRecordingFieldId] = useState(null);
  const [transcribingFieldId, setTranscribingFieldId] = useState(null);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const silenceMonitorRef = useRef(null);

  useEffect(() => {
    if (initialData?.sections?.length && initialData?.profile) {
      return undefined;
    }
    let mounted = true;
    fetch('/api/companion/onboarding')
      .then((r) => r.json())
      .then((data) => {
        if (!mounted) return;
        if (Array.isArray(data?.sections)) setSections(data.sections);
        if (data?.profile) setProfile(data.profile);
        setLoading(false);
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err.message || 'Failed to load setup questionnaire');
        setLoading(false);
      });
    return () => {
      mounted = false;
      if (silenceMonitorRef.current) {
        silenceMonitorRef.current.stop();
        silenceMonitorRef.current = null;
      }
    };
  }, [initialData]);

  const handleFieldChange = (id, value) => {
    setProfile((prev) => ({
      ...prev,
      [id]: value
    }));
  };

  const stopFieldRecording = () => {
    if (silenceMonitorRef.current) {
      silenceMonitorRef.current.stop();
      silenceMonitorRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    setRecordingFieldId(null);
  };

  const toggleVoiceForField = async (fieldId) => {
    if (recordingFieldId === fieldId) {
      stopFieldRecording();
      return;
    }
    if (recordingFieldId) {
      stopFieldRecording();
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        if (silenceMonitorRef.current) {
          silenceMonitorRef.current.stop();
          silenceMonitorRef.current = null;
        }
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        if (blob.size === 0) return;

        setTranscribingFieldId(fieldId);
        try {
          const formData = new FormData();
          formData.append('audio', blob, 'setup-voice.webm');
          const res = await fetch('/api/companion/transcribe', {
            method: 'POST',
            body: formData
          });
          const data = await res.json();
          if (res.ok && data.transcription) {
            setProfile((prev) => {
              const existing = String(prev[fieldId] || '').trim();
              return {
                ...prev,
                [fieldId]: existing ? `${existing}\n${data.transcription.trim()}` : data.transcription.trim()
              };
            });
          } else {
            setError(data.error || 'Could not transcribe voice input');
          }
        } catch (err) {
          setError(`Voice error: ${err.message}`);
        } finally {
          setTranscribingFieldId(null);
        }
      };

      mediaRecorder.start();
      setRecordingFieldId(fieldId);

      silenceMonitorRef.current = attachSilenceDetector(stream, {
        silenceMs: 3200,
        maxDurationMs: 45000,
        onSilenceStop: () => {
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            mediaRecorderRef.current.stop();
            setRecordingFieldId(null);
          }
        }
      });
    } catch {
      setError('Microphone permission denied or unavailable.');
    }
  };

  const handleSaveAndFinish = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/companion/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to seed database');
      try {
        localStorage.setItem('krusch_onboarding_done', '1');
      } catch {
        // ignore
      }
      if (onComplete) onComplete(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleSkipSetup = async () => {
    setSaving(true);
    try {
      await fetch('/api/companion/onboarding/skip', { method: 'POST' });
    } catch {
      // Non-fatal
    }
    try {
      localStorage.setItem('krusch_onboarding_done', '1');
    } catch {
      // ignore
    }
    setSaving(false);
    if (onSkip) onSkip();
  };

  const visibleSections = showAllSteps
    ? sections
    : sections.filter((s) => s.step === activeStep);

  const totalSteps = sections.length || 5;

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'radial-gradient(circle at top, rgba(0, 240, 255, 0.08), transparent 55%), #070b14',
        color: '#f8fafc',
        padding: '28px 18px 48px'
      }}
    >
      <div style={{ maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* Standalone Setup Header with Prominent Skip Button */}
        <header
          className="glass-panel"
          style={{
            padding: '18px 22px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 14,
            border: '1px solid rgba(0, 240, 255, 0.25)'
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: '1.35rem' }}>🛡️</span>
              <h1 style={{ margin: 0, fontSize: '1.22rem', fontWeight: 800, color: '#f8fafc' }}>
                Krusch Companion — Initial Database Seeding
              </h1>
            </div>
            <p style={{ margin: '6px 0 0 0', fontSize: '0.84rem', color: 'var(--text-muted)', lineHeight: 1.45 }}>
              Seed your Companion once so it always knows who it’s talking to, your partner & family, your home address for directions, your work schedule, and your voice vocabulary.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              onClick={() => setShowAllSteps((v) => !v)}
              style={{
                padding: '8px 12px',
                borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.14)',
                background: 'rgba(255,255,255,0.05)',
                color: '#cbd5e1',
                fontSize: '0.78rem',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              {showAllSteps ? '🪄 Step-by-Step Wizard' : '📋 View All 16 Questions'}
            </button>

            <button
              type="button"
              onClick={handleSkipSetup}
              disabled={saving}
              style={{
                padding: '9px 16px',
                borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.2)',
                background: 'rgba(255,255,255,0.07)',
                color: '#f8fafc',
                fontSize: '0.84rem',
                fontWeight: 700,
                cursor: 'pointer'
              }}
            >
              Skip Setup →
            </button>
          </div>
        </header>

        {/* Step Progress Pills */}
        {!showAllSteps && sections.length > 0 && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${sections.length}, minmax(0, 1fr))`,
              gap: 8
            }}
          >
            {sections.map((sec) => {
              const isCurrent = sec.step === activeStep;
              const isPast = sec.step < activeStep;
              return (
                <button
                  key={sec.sectionId}
                  type="button"
                  onClick={() => setActiveStep(sec.step)}
                  style={{
                    padding: '10px 10px',
                    borderRadius: 10,
                    border: isCurrent
                      ? '1px solid rgba(0, 240, 255, 0.55)'
                      : isPast
                        ? '1px solid rgba(45, 212, 191, 0.35)'
                        : '1px solid rgba(255,255,255,0.08)',
                    background: isCurrent
                      ? 'rgba(0, 240, 255, 0.14)'
                      : isPast
                        ? 'rgba(45, 212, 191, 0.08)'
                        : 'rgba(15, 23, 42, 0.6)',
                    color: isCurrent ? '#f8fafc' : '#cbd5e1',
                    fontSize: '0.76rem',
                    fontWeight: isCurrent ? 700 : 500,
                    cursor: 'pointer',
                    textAlign: 'left',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  <span style={{ opacity: 0.7, marginRight: 5 }}>Step {sec.step}:</span>
                  {sec.sectionTitle.replace(/^[^\s]+\s/, '')}
                </button>
              );
            })}
          </div>
        )}

        {error && (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 10,
              background: 'rgba(255, 42, 133, 0.12)',
              border: '1px solid rgba(255, 42, 133, 0.35)',
              color: '#ff80b5',
              fontSize: '0.84rem'
            }}
          >
            ⚠️ {error}
          </div>
        )}

        {loading ? (
          <div className="glass-panel" style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
            Loading standardized seeding questions...
          </div>
        ) : (
          visibleSections.map((section) => (
            <section
              key={section.sectionId}
              className="glass-panel"
              style={{
                padding: '22px 24px',
                display: 'flex',
                flexDirection: 'column',
                gap: 18
              }}
            >
              <div style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: 12 }}>
                <div style={{ fontSize: '1.06rem', fontWeight: 800, color: '#f8fafc' }}>
                  {section.sectionTitle}
                </div>
                <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: 4 }}>
                  {section.sectionSubtitle}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {section.questions.map((q) => {
                  const isRec = recordingFieldId === q.id;
                  const isTrans = transcribingFieldId === q.id;
                  return (
                    <div
                      key={q.id}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                        padding: '12px 14px',
                        borderRadius: 12,
                        background: 'rgba(15, 23, 42, 0.55)',
                        border: '1px solid rgba(255,255,255,0.07)'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                        <label
                          htmlFor={`setup-${q.id}`}
                          style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f8fafc', lineHeight: 1.35 }}
                        >
                          <span style={{ color: 'var(--accent-cyan)', marginRight: 6 }}>Q{q.number}.</span>
                          {q.question}
                        </label>

                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span
                            style={{
                              fontSize: '0.68rem',
                              padding: '2px 8px',
                              borderRadius: 999,
                              background: 'rgba(0, 240, 255, 0.08)',
                              border: '1px solid rgba(0, 240, 255, 0.2)',
                              color: '#94a3b8'
                            }}
                            title="Target database table & key seeded by this answer"
                          >
                            🗄️ {q.targetTable}
                          </span>

                          <button
                            type="button"
                            onClick={() => toggleVoiceForField(q.id)}
                            disabled={Boolean(isTrans)}
                            style={{
                              padding: '4px 10px',
                              borderRadius: 8,
                              border: isRec
                                ? '1px solid rgba(255, 42, 133, 0.6)'
                                : '1px solid rgba(0, 240, 255, 0.25)',
                              background: isRec
                                ? 'rgba(255, 42, 133, 0.2)'
                                : 'rgba(0, 240, 255, 0.08)',
                              color: isRec ? '#ff80b5' : 'var(--accent-cyan)',
                              fontSize: '0.74rem',
                              fontWeight: 700,
                              cursor: 'pointer'
                            }}
                          >
                            {isTrans ? '⏳...' : isRec ? '⏹️ Stop' : '🎙️ Speak'}
                          </button>
                        </div>
                      </div>

                      {q.type === 'textarea' ? (
                        <textarea
                          id={`setup-${q.id}`}
                          rows={2}
                          value={profile[q.id] ?? ''}
                          onChange={(e) => handleFieldChange(q.id, e.target.value)}
                          placeholder={q.placeholder}
                          style={{
                            width: '100%',
                            padding: '10px 12px',
                            borderRadius: 8,
                            border: '1px solid rgba(255,255,255,0.12)',
                            background: 'rgba(2, 6, 23, 0.65)',
                            color: '#f8fafc',
                            fontSize: '0.88rem',
                            fontFamily: 'inherit',
                            resize: 'vertical'
                          }}
                        />
                      ) : (
                        <input
                          id={`setup-${q.id}`}
                          type="text"
                          value={profile[q.id] ?? ''}
                          onChange={(e) => handleFieldChange(q.id, e.target.value)}
                          placeholder={q.placeholder}
                          style={{
                            width: '100%',
                            padding: '10px 12px',
                            borderRadius: 8,
                            border: '1px solid rgba(255,255,255,0.12)',
                            background: 'rgba(2, 6, 23, 0.65)',
                            color: '#f8fafc',
                            fontSize: '0.88rem',
                            fontFamily: 'inherit'
                          }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))
        )}

        {/* Bottom Navigation Bar */}
        <footer
          className="glass-panel"
          style={{
            padding: '16px 22px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 12
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {!showAllSteps && activeStep > 1 && (
              <button
                type="button"
                onClick={() => setActiveStep((s) => Math.max(1, s - 1))}
                style={{
                  padding: '10px 16px',
                  borderRadius: 10,
                  border: '1px solid rgba(255,255,255,0.16)',
                  background: 'rgba(255,255,255,0.05)',
                  color: '#f8fafc',
                  fontWeight: 600,
                  fontSize: '0.86rem',
                  cursor: 'pointer'
                }}
              >
                ← Previous Step
              </button>
            )}

            <button
              type="button"
              onClick={handleSkipSetup}
              disabled={saving}
              style={{
                padding: '10px 16px',
                borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'transparent',
                color: 'var(--text-muted)',
                fontWeight: 600,
                fontSize: '0.84rem',
                cursor: 'pointer'
              }}
            >
              Skip for Now →
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {!showAllSteps && activeStep < totalSteps ? (
              <>
                <button
                  type="button"
                  onClick={handleSaveAndFinish}
                  disabled={saving}
                  style={{
                    padding: '10px 16px',
                    borderRadius: 10,
                    border: '1px solid rgba(45, 212, 191, 0.4)',
                    background: 'rgba(45, 212, 191, 0.12)',
                    color: '#2dd4bf',
                    fontWeight: 700,
                    fontSize: '0.84rem',
                    cursor: 'pointer'
                  }}
                >
                  {saving ? 'Seeding...' : '💾 Save & Enter App Now'}
                </button>
                <button
                  type="button"
                  onClick={() => setActiveStep((s) => Math.min(totalSteps, s + 1))}
                  className="btn-primary"
                  style={{
                    padding: '10px 20px',
                    borderRadius: 10,
                    fontWeight: 700,
                    fontSize: '0.88rem'
                  }}
                >
                  Next Step ({activeStep}/{totalSteps}) →
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={handleSaveAndFinish}
                disabled={saving}
                className="btn-primary"
                style={{
                  padding: '11px 22px',
                  borderRadius: 10,
                  fontWeight: 800,
                  fontSize: '0.92rem'
                }}
              >
                {saving ? '⏳ Seeding Database...' : '✅ Seed Database & Enter Krusch Companion →'}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

export default SetupView;
