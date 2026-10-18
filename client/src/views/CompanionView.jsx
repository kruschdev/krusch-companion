import React, { useState, useEffect, useRef } from 'react';
import { attachSilenceDetector } from '../utils/voiceSilenceDetector';

const ACTION_LABELS = {
  task_created: { icon: '✅', label: 'Added to Today', color: '#2dd4bf' },
  task_list_updated: { icon: '📝', label: 'Checklist Updated', color: '#2dd4bf' },
  checklist_item_toggled: { icon: '☑️', label: 'Checklist Item Updated', color: '#2dd4bf' },
  task_priority_updated: { icon: '🚨', label: 'Marked Must-Do', color: '#ef4444' },
  task_prioritized: { icon: '🚨', label: 'Marked Must-Do', color: '#ef4444' },
  task_completed: { icon: '🎉', label: 'Task Completed', color: '#f0c040' },
  task_deleted: { icon: '🗑️', label: 'Task Removed', color: '#f87171' },
  tasks_rolled_over: { icon: '🔄', label: 'Tasks Rolled Over', color: '#60a5fa' },
  task_breakdown: { icon: '🧩', label: 'Steps Added', color: '#a78bfa' },
  memory_saved: { icon: '🧠', label: 'Saved to Notes', color: '#a78bfa' },
  memory_superseded: { icon: '🔄', label: 'Note Updated', color: '#f0c040' },
  note_saved: { icon: '📝', label: 'Note Saved', color: '#2dd4bf' },
  google_calendar: { icon: '📅', label: 'Calendar Updated', color: '#60a5fa' },
  google_gmail: { icon: '✉️', label: 'Gmail Action', color: '#f87171' },
  google_drive: { icon: '☁️', label: 'Google Drive', color: '#38bdf8' }
};

const WELCOME_MSG = {
  id: 'welcome',
  role: 'assistant',
  content: "Hi! What's on your mind, or what can I add to your list today?"
};

const createSessionId = () => `chat-${Date.now()}`;

function renderCleanMessage(content) {
  const lines = String(content || '')
    .replace(/^>\s*/gm, '')
    .split('\n');

  return lines.map((line, lineIdx) => {
    const parts = line.split(/(\*\*[^*]+\*\*)/g);
    return (
      <React.Fragment key={lineIdx}>
        {parts.map((part, partIdx) => {
          if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
            return <strong key={partIdx}>{part.slice(2, -2)}</strong>;
          }
          return <span key={partIdx}>{part}</span>;
        })}
        {lineIdx < lines.length - 1 && <br />}
      </React.Fragment>
    );
  });
}

export function CompanionView({
  sessionId = 'default-session',
  onSelectSession,
  onActionExecuted
}) {
  const [sessions, setSessions] = useState([]);
  const [messages, setMessages] = useState([WELCOME_MSG]);
  const [showSidebar, setShowSidebar] = useState(true);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [isTranscribingVoice, setIsTranscribingVoice] = useState(false);
  const [autoSendVoice, setAutoSendVoice] = useState(true);
  const [voiceStatus, setVoiceStatus] = useState(null);

  const chatEndRef = useRef(null);
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

  const loadSessionsList = async () => {
    try {
      const res = await fetch('/api/companion/sessions');
      if (res.ok) {
        const data = await res.json();
        setSessions(Array.isArray(data.sessions) ? data.sessions : []);
      }
    } catch {
      // Non-fatal
    }
  };

  useEffect(() => {
    let active = true;
    fetch('/api/companion/sessions')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active && data) {
          setSessions(Array.isArray(data.sessions) ? data.sessions : []);
        }
      })
      .catch(() => {});

    fetch(`/api/companion/sessions/${encodeURIComponent(sessionId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!active) return;
        if (data && Array.isArray(data.messages) && data.messages.length > 0) {
          setMessages(data.messages);
        } else {
          setMessages([WELCOME_MSG]);
        }
      })
      .catch(() => {
        if (active) setMessages([WELCOME_MSG]);
      });

    return () => {
      active = false;
      stopVoiceRecording();
    };
  }, [sessionId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const handleStartNewChat = () => {
    const newId = createSessionId();
    setMessages([WELCOME_MSG]);
    if (onSelectSession) {
      onSelectSession(newId);
    }
  };

  const handleDeleteSession = async (e, targetId) => {
    e.stopPropagation();
    try {
      await fetch(`/api/companion/sessions/${encodeURIComponent(targetId)}`, {
        method: 'DELETE'
      });
      const updated = sessions.filter(s => s.sessionId !== targetId);
      setSessions(updated);
      if (targetId === sessionId) {
        const fallbackId = updated[0]?.sessionId || createSessionId();
        if (onSelectSession) onSelectSession(fallbackId);
        if (!updated[0]) setMessages([WELCOME_MSG]);
      }
    } catch {
      // ignore
    }
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
            content: data.summary || 'Done!',
            actionExecuted: { type: data.actionType || tc.name }
          })
        );
        if (onActionExecuted) onActionExecuted({ type: tc.name });
      }
    } catch (err) {
      alert(`Confirmation failed: ${err.message}`);
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

    const priorHistory = messages
      .filter(m => m.id !== 'welcome')
      .slice(-8)
      .map(m => ({ role: m.role, content: m.content }));

    setMessages(prev => [...prev.filter(m => m.id !== 'welcome'), userMsg]);
    setInput('');
    setIsLoading(true);

    try {
      const res = await fetch('/api/companion/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: userMsg.content,
          sessionId,
          activeView: 'companion_chat',
          history: priorHistory
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
          actionExecuted: data.actionExecuted || null,
          agenticTrace: data.agenticTrace || null
        }
      ]);
      loadSessionsList();
    } catch (err) {
      setMessages(prev => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: `Sorry, I couldn't reach the assistant right now (${err.message}).`
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
      stopVoiceRecording();
      return;
    }

    setVoiceStatus('🎙️ Listening... (auto-stops when you finish speaking)');
    liveTranscriptRef.current = input ? `${input.trim()} ` : '';

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
          setVoiceStatus(null);
          if (autoSendVoice) {
            await sendPromptText(browserText);
          }
          return;
        }

        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        if (blob.size < 200) {
          setVoiceStatus(null);
          return;
        }

        setIsTranscribingVoice(true);
        setVoiceStatus('Transcribing...');
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
          const cleanTranscript = String(data.transcription || '').trim();
          if (cleanTranscript) {
            setInput(cleanTranscript);
            setVoiceStatus(null);
            if (autoSendVoice) {
              await sendPromptText(cleanTranscript);
            }
          } else {
            setVoiceStatus(null);
          }
        } catch (err) {
          setVoiceStatus(`⚠️ Voice unavailable (${err.message})`);
          setTimeout(() => setVoiceStatus(null), 4000);
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
        setVoiceStatus(`⚠️ Microphone unavailable: ${err.message}`);
        setTimeout(() => setVoiceStatus(null), 4000);
      }
    }
  };

  const activeSessionMeta = sessions.find(s => s.sessionId === sessionId);

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 135px)', minHeight: 460, gap: 12 }}>
      {/* Collapsible Saved Conversations Sidebar */}
      {showSidebar && (
        <aside
          className="glass-panel"
          style={{
            width: 220,
            flexShrink: 0,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            overflowY: 'auto'
          }}
        >
          <button
            type="button"
            className="btn-primary"
            onClick={handleStartNewChat}
            style={{
              width: '100%',
              justifyContent: 'center',
              padding: '9px 12px',
              fontSize: '0.84rem'
            }}
          >
            + New Chat
          </button>

          <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '4px 4px 0' }}>
            Conversations ({sessions.length})
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, overflowY: 'auto' }}>
            {sessions.length === 0 ? (
              <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', padding: '8px 4px' }}>
                No saved chats yet.
              </div>
            ) : (
              sessions.map((s) => {
                const isSelected = s.sessionId === sessionId;
                return (
                  <div
                    key={s.sessionId}
                    onClick={() => onSelectSession && onSelectSession(s.sessionId)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 6,
                      padding: '8px 10px',
                      borderRadius: 10,
                      cursor: 'pointer',
                      background: isSelected ? 'rgba(0, 240, 255, 0.14)' : 'transparent',
                      border: isSelected ? '1px solid rgba(0, 240, 255, 0.35)' : '1px solid transparent',
                      color: isSelected ? '#f8fafc' : 'var(--text-muted)',
                      fontSize: '0.82rem',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontWeight: isSelected ? 600 : 400,
                        flex: 1
                      }}
                      title={s.title}
                    >
                      {s.title}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => handleDeleteSession(e, s.sessionId)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-dim)',
                        cursor: 'pointer',
                        fontSize: '0.78rem',
                        padding: '0 2px',
                        lineHeight: 1
                      }}
                      title="Delete conversation"
                    >
                      ✕
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </aside>
      )}

      {/* Main Conversation Column */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        {/* Chat Thread Panel */}
        <div
          className="glass-panel"
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}
        >
          {/* Minimal Chat Header */}
          <div
            style={{
              padding: '10px 16px',
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 10
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowSidebar(prev => !prev)}
                style={{ padding: '4px 10px', fontSize: '0.78rem' }}
                title="Toggle saved conversations sidebar"
              >
                {showSidebar ? '◀ Chats' : `☰ Chats (${sessions.length})`}
              </button>
              <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-main)' }}>
                {activeSessionMeta ? activeSessionMeta.title : 'New Conversation'}
              </span>
            </div>

            <button
              type="button"
              className="btn-secondary"
              onClick={handleStartNewChat}
              style={{ padding: '4px 10px', fontSize: '0.78rem' }}
            >
              + New Chat
            </button>
          </div>

          {/* Messages Scroll Area */}
          <div
            style={{
              flex: 1,
              padding: '18px 20px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 14
            }}
          >
            {messages.map(m => {
              const actionMeta = m.actionExecuted?.type ? ACTION_LABELS[m.actionExecuted.type] : null;
              const pendingConfirmations = (m.agenticTrace?.toolCalls || []).filter(
                tc => (tc.requiresConfirmation || tc.dryRun) && !m.confirmedTools?.[tc.name]
              );

              return (
                <div
                  key={m.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: m.role === 'user' ? 'flex-end' : 'flex-start',
                    gap: 5
                  }}
                >
                  <div
                    style={{
                      maxWidth: '82%',
                      padding: '12px 16px',
                      borderRadius: m.role === 'user' ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                      background: m.role === 'user' ? 'linear-gradient(135deg, #0088ff, #7928ca)' : 'var(--bg-glass-card)',
                      color: 'var(--text-main)',
                      border: m.role === 'user' ? 'none' : '1px solid var(--border-subtle)',
                      lineHeight: 1.5,
                      fontSize: '0.95rem'
                    }}
                  >
                    {renderCleanMessage(m.content)}
                  </div>

                  {m.role === 'assistant' && (actionMeta || pendingConfirmations.length > 0) && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingLeft: 4 }}>
                      {actionMeta && (
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 5,
                            fontSize: '0.73rem',
                            fontWeight: 600,
                            padding: '2px 10px',
                            borderRadius: 'var(--radius-full)',
                            background: 'rgba(45, 212, 191, 0.10)',
                            border: `1px solid ${actionMeta.color}55`,
                            color: actionMeta.color
                          }}
                        >
                          <span>{actionMeta.icon}</span>
                          <span>{actionMeta.label}</span>
                        </span>
                      )}

                      {pendingConfirmations.map((tc, idx) => (
                        <button
                          key={`${tc.name}-${idx}`}
                          type="button"
                          className="btn-primary"
                          onClick={() => handleConfirmSideEffectTool(m.id, tc)}
                          style={{
                            fontSize: '0.76rem',
                            padding: '4px 12px',
                            borderRadius: 'var(--radius-full)'
                          }}
                        >
                          Confirm &amp; Run
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {isLoading && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: '0.9rem', paddingLeft: 4 }}>
                <span>Thinking...</span>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
        </div>

        {/* Voice Status Banner (only visible when listening/transcribing) */}
        {voiceStatus && (
          <div
            className="glass-card"
            style={{
              padding: '8px 14px',
              borderLeft: `3px solid ${isRecordingVoice ? '#f87171' : 'var(--accent-cyan)'}`,
              fontSize: '0.84rem',
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
                fontSize: '0.78rem',
                color: 'var(--text-muted)'
              }}
            >
              <input
                type="checkbox"
                checked={autoSendVoice}
                onChange={(e) => setAutoSendVoice(e.target.checked)}
                style={{ width: 14, height: 14, accentColor: 'var(--accent-cyan)' }}
              />
              Auto-send
            </label>
          </div>
        )}

        {/* Input Bar */}
        <form onSubmit={handleSend} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button
            id="btn-companion-voice"
            type="button"
            onClick={handleToggleVoiceChat}
            disabled={isLoading || isTranscribingVoice}
            className={isRecordingVoice ? 'btn-danger' : 'btn-secondary'}
            style={{
              padding: '12px 16px',
              whiteSpace: 'nowrap',
              borderColor: isRecordingVoice ? '#ef4444' : 'var(--border-subtle)',
              background: isRecordingVoice ? 'rgba(239, 68, 68, 0.2)' : undefined,
              color: isRecordingVoice ? '#fca5a5' : 'var(--text-main)',
              fontWeight: 600
            }}
            title="Speak your message"
          >
            {isTranscribingVoice ? '...' : isRecordingVoice ? '⏹️ Stop' : '🎙️ Speak'}
          </button>

          <input
            id="input-companion-chat"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isRecordingVoice ? 'Listening...' : 'Message your companion or add a task...'}
            disabled={isLoading}
            style={{ flex: 1, padding: '12px 16px' }}
          />

          <button
            id="btn-companion-send"
            type="submit"
            className="btn-primary"
            disabled={isLoading || !input.trim()}
            style={{ padding: '12px 22px' }}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

export default CompanionView;
