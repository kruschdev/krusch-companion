# Krusch Companion — Task Checklist

> **Project**: `projects/krusch-companion`  
> **Status**: Ready for Execution

---

## Phase 1: Scaffolding & Config
- [ ] **Task 1.1**: Initialize `package.json` with Node 22 ESM, linking `@krusch/toolkit` and `krusch-cascade-router`.
- [ ] **Task 1.2**: Create `AGENTS.md` and `INFLIGHT.md` documenting architecture, stack, and rules of engagement.
- [ ] **Task 1.3**: Create `config.json`, `.env.example`, and `src/config.js` using `@krusch/toolkit/config`.

## Phase 2: Database & Context Layer
- [ ] **Task 2.1**: Write SQLite schema (`src/db/schema.sql`) for tasks, priorities, working memory nuggets, reflections, and streaks.
- [ ] **Task 2.2**: Implement `src/db/index.js` wrapper using `@krusch/toolkit/db` with WAL mode and transaction helpers.
- [ ] **Task 2.3**: Build `src/context/memory-store.js` implementing KruschContext closed taxonomy and temporal superseding.
- [ ] **Task 2.4**: Implement `src/context/boundary-gate.js` with Knowledge Boundary routing and prompt pruning.
- [ ] **Task 2.5**: Write and verify `tests/test-memory.js` testing memory CRUD, superseding, and boundary gating.

## Phase 3: Cascade Router Integration
- [ ] **Task 3.1**: Implement `src/router/cascade-client.js` wrapping `krusch-cascade-router` with local Ollama (`krusch:11434`) and vLLM (`kruschdev`) endpoints.
- [ ] **Task 3.2**: Configure fallback hedging for offline nodes and privacy constraints (cloud escalation blocked unless enabled).
- [ ] **Task 3.3**: Write and verify `tests/test-router.js` validating sub-15µs L0 heuristic routing and tier escalation.

## Phase 4: Core Services & Express API
- [ ] **Task 4.1**: Build `src/services/chaos-dump.js` to parse unstructured voice/text into structured tasks and life context nuggets.
- [ ] **Task 4.2**: Implement `src/services/coach.js` for daily focus synthesis and evening reflection.
- [ ] **Task 4.3**: Implement Express server (`src/server.js`) and API routes (`api-tasks.js`, `api-companion.js`, `api-dump.js`, `api-context.js`).
- [ ] **Task 4.4**: Write and verify `tests/test-dump.js` testing end-to-end dump extraction and task creation.

## Phase 5: React PWA Frontend
- [ ] **Task 5.1**: Scaffold React + Vite application inside `client/`.
- [ ] **Task 5.2**: Port and polish dark glassmorphism design system in `client/src/index.css` and `App.css`.
- [ ] **Task 5.3**: Build `CompanionView.jsx` (conversational dialogue with tier routing badges and daily briefing).
- [ ] **Task 5.4**: Build `DumpView.jsx` (audio recording with live waveform and 1-click task preview).
- [ ] **Task 5.5**: Build `TodayView.jsx` (5-tier priority task list, reordering, streak tracking).
- [ ] **Task 5.6**: Build `FocusView.jsx` (single-task distraction-free flow with timer).
- [ ] **Task 5.7**: Verify production build (`npm run build`).

## Phase 6: Verification & Homelab Integration
- [ ] **Task 6.1**: Run `krusch_context_nudge({ trigger: "pre_commit" })` to audit project invariants.
- [ ] **Task 6.2**: Index repository into `krusch-git` using `scripts/sync_to_pg.js`.
- [ ] **Task 6.3**: Persist project completion in `krusch-context-mcp` working memory.
