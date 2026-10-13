# Krusch Companion — Implementation Plan

> **Target Project**: `projects/krusch-companion`  
> **Based on**: [`spec.md`](spec.md)  
> **Status**: Complete

---

## 1. Directory Structure

```
projects/krusch-companion/
├── AGENTS.md                  # Project context, rules, and stack conventions
├── INFLIGHT.md                # Real-time task tracking
├── spec.md                    # Project specification
├── implementation_plan.md     # This file
├── task.md                    # Atomic task checklist
├── package.json               # ESM Node.js 22 dependencies
├── config.json                # Layered project defaults (ports, models, timeouts)
├── config.js                  # Config loader via @krusch/toolkit/config
├── .env.example               # Environment variables
├── src/
│   ├── server.js              # Express API entrypoint
│   ├── db/
│   │   ├── schema.sql         # SQLite schema (tasks, priorities, memories, focus)
│   │   └── index.js           # SQLite wrapper using @krusch/toolkit/db (WAL enabled)
│   ├── context/
│   │   ├── memory-store.js    # Sovereign working memory (KruschContext integration)
│   │   └── boundary-gate.js   # Knowledge boundary & prompt pruning (@krusch/toolkit)
│   ├── router/
│   │   ├── cascade-client.js  # Wrapper around krusch-cascade-router
│   │   └── local-specialists.js # Local Ollama / vLLM provider endpoints
│   ├── services/
│   │   ├── chaos-dump.js      # Unstructured voice/text extraction & task mapping
│   │   ├── coach.js           # Morning focus, midday nudges, evening reflection
│   │   └── stt.js             # Local/hybrid audio transcription service
│   └── routes/
│       ├── api-tasks.js       # CRUD for 5-tier tasks & streaks
│       ├── api-companion.js   # Conversational companion dialogue with tier badges
│       ├── api-dump.js        # Voice & text Chaos Dump ingestion
│       └── api-context.js     # Memory nuggets & active invariants management
├── client/                    # React 19 + Vite frontend
│   ├── package.json
│   ├── vite.config.js
│   ├── index.html
│   └── src/
│       ├── main.jsx
│       ├── App.jsx
│       ├── index.css          # Dark glassmorphism design system
│       ├── components/
│       │   ├── TierBadge.jsx  # Visual indicator of L0/L1/L2 routing
│       │   ├── AudioRecorder.jsx # Mic capture with live waveform
│       │   └── PriorityPicker.jsx
│       └── views/
│           ├── CompanionView.jsx # Conversational companion & morning briefing
│           ├── DumpView.jsx      # Chaos dump interface with extraction preview
│           ├── TodayView.jsx     # 5-Tier priority board & streak counters
│           └── FocusView.jsx     # Single-task flow state with timer
├── tests/
│   ├── test-router.js         # Cascade routing & tier escalation test
│   ├── test-memory.js         # Working memory & superseding test
│   └── test-dump.js           # Chaos dump extraction test
├── Dockerfile                 # Multi-stage production container
└── docker-compose.yml         # Homelab service definition
```

---

## 2. Dependency Order & Implementation Stages

### Stage 1: Scaffold & Project Setup
1. Initialize `package.json` with Node ESM, link `@krusch/toolkit` and `krusch-cascade-router`.
2. Create `AGENTS.md` and `INFLIGHT.md`.
3. Set up `config.json`, `.env.example`, and `src/config.js`.

### Stage 2: Database & Context Layer
1. Define SQLite schema (`src/db/schema.sql`) for tasks, 5-tier priorities, context nuggets, daily focus briefings, and gamification streaks.
2. Implement `src/db/index.js` using `@krusch/toolkit/db` with WAL mode.
3. Build `src/context/memory-store.js` integrating KruschContext taxonomy (`decision`, `invariant`, `bug`/habit friction, `lesson`, `blocker`) and temporal superseding.
4. Implement `src/context/boundary-gate.js` with `@krusch/toolkit` pruning.

### Stage 3: Cascade Router & Local LLM Dispatcher
1. Build `src/router/cascade-client.js` consuming `createMultiSpecialistRouter` and `classifyPreRoute` from `krusch-cascade-router`.
2. Configure local Ollama and secondary compute vLLM endpoints with fallback hedging.
3. Write automated unit test `tests/test-router.js` verifying sub-15µs L0 heuristic routing and tier escalation.

### Stage 4: Core Services & Express API
1. Implement `src/services/chaos-dump.js` for zero-shot extraction of structured tasks and life context from unorganized voice/text.
2. Implement `src/services/coach.js` for daily focus and reflection generation.
3. Wire up Express routes (`api-tasks.js`, `api-companion.js`, `api-dump.js`, `api-context.js`) in `src/server.js`.
4. Validate backend endpoints via integration tests.

### Stage 5: React PWA Frontend
1. Scaffold React + Vite in `client/`.
2. Port and modernize the high-prestige dark glassmorphism design system from `first-things-first` (`index.css`).
3. Build the 4 core views:
   - **CompanionView**: Conversational dialogue with tier routing indicators (L0/L1/L2) and proactive daily briefings.
   - **DumpView**: Audio recording with canvas wave animation + text area + 1-click parse preview.
   - **TodayView**: 5-tier priority task list, drag/reorder, tactile completion checkmarks, streak counter.
   - **FocusView**: Fullscreen focus mode with ambient progress ring.
4. Verify end-to-end client build with `npm run build`.

### Stage 6: Fleet Verification & Indexing
1. Run pre-commit invariant audit: `krusch_context_nudge({ trigger: "pre_commit" })`.
2. Index repository into `krusch-git`.
3. Record project completion in `krusch-context-mcp` working memory.

---

## 3. Verification & Testing Gates

- **Gate 1**: Unit tests (`node tests/test-router.js` and `node tests/test-memory.js`) execute and pass cleanly.
- **Gate 2**: Backend starts without errors (`node src/server.js`) on designated port (default: 3004).
- **Gate 3**: Frontend builds cleanly (`cd client && npm run build`) with zero lint or bundling errors.
- **Gate 4**: Verification walkthrough demonstrates an end-to-end Chaos Dump -> Task Extraction -> Working Memory Update flow.
