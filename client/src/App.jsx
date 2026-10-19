import React, { useState, useEffect } from 'react';
import CompanionView from './views/CompanionView';
import DumpView from './views/DumpView';
import TodayView from './views/TodayView';
import FocusView from './views/FocusView';
import SystemMemoryView from './views/SystemMemoryView';
import SetupView from './views/SetupView';
import ExtensionsView from './views/ExtensionsView';
import {
  readInitialSetupRoute,
  readInitialActiveTab,
  readStoredSessionId,
  writeStoredSessionId,
  navigateToSetupRoute,
  clearSetupRouteInHistory,
  fetchStreakCount,
  fetchIncompleteTasksSorted,
  fetchOnboardingStatus,
  markTaskComplete
} from './utils/companionClient';

export function App() {
  const [showSetupPage, setShowSetupPage] = useState(readInitialSetupRoute);
  const [onboardingData, setOnboardingData] = useState(null);
  const [activeTab, setActiveTab] = useState(readInitialActiveTab);
  const [streak, setStreak] = useState(0);
  const [focusTask, setFocusTask] = useState(null);
  const [activeSessionId, setActiveSessionId] = useState(() => readStoredSessionId('default-session'));

  const handleSelectSession = (nextId) => {
    setActiveSessionId(nextId);
    writeStoredSessionId(nextId);
  };

  const syncTopFocusTask = async (preferredTask = null) => {
    if (preferredTask && preferredTask.title) {
      setFocusTask(preferredTask);
      return;
    }
    const incomplete = await fetchIncompleteTasksSorted();
    if (incomplete) {
      setFocusTask(prev => {
        if (prev && incomplete.some(t => t.id === prev.id)) {
          return incomplete.find(t => t.id === prev.id);
        }
        return incomplete[0] || null;
      });
    }
  };

  const fetchStreak = async () => {
    const nextStreak = await fetchStreakCount();
    if (nextStreak !== null) {
      setStreak(nextStreak);
    }
  };

  useEffect(() => {
    let active = true;
    fetchStreakCount().then((nextStreak) => {
      if (active && nextStreak !== null) setStreak(nextStreak);
    });

    fetchIncompleteTasksSorted().then((incomplete) => {
      if (active && incomplete) {
        setFocusTask(incomplete[0] || null);
      }
    });

    fetchOnboardingStatus().then((data) => {
      if (!active || !data) return;
      setOnboardingData(data);
      if (!data.completed) {
        setShowSetupPage(true);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  const handleSelectFocus = (task) => {
    setFocusTask(task);
    setActiveTab('focus');
  };

  const handleTaskCompleted = async (id) => {
    try {
      await markTaskComplete(id);
      await fetchStreak();
      setFocusTask(null);
      await syncTopFocusTask();
    } catch (err) {
      console.error(err);
    }
  };

  const exitSetupPage = () => {
    setShowSetupPage(false);
    clearSetupRouteInHistory();
    fetchStreak();
    syncTopFocusTask();
  };

  if (showSetupPage) {
    return (
      <SetupView
        initialData={onboardingData}
        onComplete={() => exitSetupPage()}
        onSkip={() => exitSetupPage()}
      />
    );
  }

  return (
    <div style={{ maxWidth: 880, margin: '0 auto', padding: '14px 18px', minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Single Clean Top Bar: Brand + Navigation */}
      <header
        className="glass-panel"
        style={{
          padding: '10px 16px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: '1.15rem' }}>🛡️</span>
          <span style={{ fontSize: '1.02rem', fontWeight: 800, letterSpacing: '-0.01em', color: '#f8fafc' }}>
            Krusch
          </span>
          {streak > 0 && (
            <span
              style={{
                fontSize: '0.76rem',
                color: 'var(--text-muted)',
                padding: '2px 8px',
                borderRadius: 999,
                background: 'rgba(255, 255, 255, 0.05)'
              }}
              title={`${streak} day streak`}
            >
              🔥 {streak}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              navigateToSetupRoute();
              setShowSetupPage(true);
            }}
            title="Open Initial Setup / Database Seeding Page (/setup)"
            style={{
              padding: '2px 7px',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.08)',
              background: 'transparent',
              color: 'var(--text-muted)',
              fontSize: '0.72rem',
              cursor: 'pointer'
            }}
          >
            ⚙️ Setup
          </button>
        </div>

        <nav style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {[
            { id: 'companion', label: '💬 Chat' },
            { id: 'today', label: "📋 Today's Board" },
            { id: 'stream', label: '🌊 Thought Stream' },
            { id: 'focus', label: '🎯 Focus' },
            { id: 'memory', label: '🧠 Notes' },
            { id: 'extensions', label: '🧩 Extensions' }
          ].map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => {
                  setActiveTab(tab.id);
                  if (tab.id === 'focus') {
                    syncTopFocusTask();
                  }
                }}
                style={{
                  padding: '8px 14px',
                  borderRadius: 10,
                  border: 'none',
                  background: isActive ? 'rgba(0, 240, 255, 0.14)' : 'transparent',
                  color: isActive ? '#f8fafc' : 'var(--text-muted)',
                  fontWeight: isActive ? 700 : 500,
                  fontSize: '0.86rem',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease'
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      </header>

      {/* Main Content View */}
      <main style={{ flex: 1 }}>
        {activeTab === 'companion' && (
          <CompanionView
            sessionId={activeSessionId}
            onSelectSession={handleSelectSession}
            onActionExecuted={() => {
              fetchStreak();
              syncTopFocusTask();
            }}
          />
        )}
        {(activeTab === 'stream' || activeTab === 'dump') && (
          <DumpView
            onTasksCreated={(savedTasks) => {
              fetchStreak();
              syncTopFocusTask(savedTasks?.[0] || null);
            }}
            onFocusTaskSelected={handleSelectFocus}
          />
        )}
        {activeTab === 'today' && (
          <TodayView
            sessionId={activeSessionId}
            onFocusTaskSelected={handleSelectFocus}
          />
        )}
        {activeTab === 'focus' && (
          <FocusView
            task={focusTask}
            onSelectTask={setFocusTask}
            onTaskCompleted={handleTaskCompleted}
            onExitFocus={() => setActiveTab('today')}
          />
        )}
        {activeTab === 'memory' && <SystemMemoryView />}
        {activeTab === 'extensions' && (
          <ExtensionsView
            onBoardUpdated={() => {
              fetchStreak();
              syncTopFocusTask();
            }}
          />
        )}
      </main>
    </div>
  );
}

export default App;
