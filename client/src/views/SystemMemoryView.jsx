import React, { useState, useEffect } from 'react';

export function SystemMemoryView() {
  const [memories, setMemories] = useState([]);
  const [newContent, setNewContent] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  const loadMemories = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/context');
      if (res.ok) {
        const data = await res.json();
        setMemories(data.activeMemories || []);
      }
    } catch (err) {
      console.error('Failed to load memories:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    fetch('/api/context')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active && data) {
          setMemories(data.activeMemories || []);
        }
      })
      .catch((err) => {
        console.error('Failed to load memories:', err);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleAddMemory = async (e) => {
    e.preventDefault();
    if (!newContent.trim()) return;
    try {
      const res = await fetch('/api/context/remember', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: 'decision',
          content: newContent.trim()
        })
      });
      if (res.ok) {
        setNewContent('');
        await loadMemories();
      }
    } catch (err) {
      alert(`Failed to save note: ${err.message}`);
    }
  };

  const handleDeleteMemory = async (id) => {
    try {
      const res = await fetch(`/api/context/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setMemories(prev => prev.filter(m => m.id !== id));
      }
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Quick-Add Note / Memory Bar */}
      <form onSubmit={handleAddMemory} style={{ display: 'flex', gap: 10 }}>
        <input
          type="text"
          value={newContent}
          onChange={e => setNewContent(e.target.value)}
          placeholder="Save a note, routine, or preference for your companion to remember..."
          style={{ flex: 1, padding: '12px 16px' }}
        />
        <button type="submit" className="btn-primary" disabled={!newContent.trim()} style={{ padding: '12px 22px', whiteSpace: 'nowrap' }}>
          + Save Note
        </button>
      </form>

      {/* Saved Notes List */}
      <div className="glass-panel" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h2 style={{ fontSize: '1.08rem', fontWeight: 700, marginBottom: 4 }}>
          Saved Notes &amp; Preferences ({memories.length})
        </h2>

        {isLoading ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-dim)' }}>
            Loading saved notes...
          </div>
        ) : memories.length === 0 ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.92rem' }}>
            No saved notes yet. Add a note above or tell your companion in Chat what to remember.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {memories.map(mem => (
              <div
                key={mem.id}
                className="glass-card"
                style={{
                  padding: '12px 14px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12
                }}
              >
                <span style={{ fontSize: '0.94rem', lineHeight: 1.4 }}>{mem.content}</span>
                <button
                  type="button"
                  onClick={() => handleDeleteMemory(mem.id)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-dim)',
                    cursor: 'pointer',
                    fontSize: '0.95rem',
                    padding: '4px 6px'
                  }}
                  title="Delete note"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default SystemMemoryView;
