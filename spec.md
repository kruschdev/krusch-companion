# Krusch Companion — Sovereign Personal Assistant Specification

> **Project Name**: Krusch Companion (`krusch-companion`)  
> **Author**: Antigravity & Krusch  
> **Date**: 2026-10-13  
> **Status**: Review & Plan  
> **Evolution Path**: Consolidates & supersedes `projects/first-things-first` with `krusch-context-mcp` working memory and `krusch-cascade-router` tier escalation.

---

## 1. What Is This?

**Krusch Companion** is a sovereign, privacy-first personal assistant and life companion designed as an uncompromised alternative to cloud-tethered assistants (Meta Muse, xAI Grok, OpenAI Dot). It provides deeply personalized daily assistance, proactive habit coaching, ADHD-friendly voice "Chaos Dumps," and a 5-tier priority framework. 

Crucially, **100% of user data, episodic memory, and personal context remains strictly local and user-owned** on home hardware. By coupling the sub-15µs CPU **Cascade Router** (`krusch-cascade-router`) with the structured working memory and temporal superseding of **KruschContext** (`krusch-context-mcp`), Krusch Companion routes 85%+ of daily interactions to local edge models (Ollama 3B/7B) or compute nodes (`kruschdev` 14B/32B) at $0.00 cost, with zero surveillance and zero cognitive drift.

---

## 2. User Stories

- **As a user wanting complete digital privacy**, I want an assistant that runs entirely on my own local hardware (or self-hosted home server), so that my private thoughts, daily schedule, medical notes, and family relationships are never harvested or trained on by Big Tech.
- **As someone managing ADHD or executive overwhelm**, I want to speak or type an unformatted, rambling voice dump ("Chaos Dump") and have the assistant immediately distill it into actionable tasks, assign them to my 5-tier priority framework, and update my life context.
- **As a busy person with evolving routines**, I want my assistant to remember my habits and preferences, but automatically supersede old habits when I change them (e.g., "I stopped drinking coffee after 2 PM") so it doesn't give contradictory advice.
- **As a homelab owner**, I want utility tasks (quick notes, timers, arithmetic, simple lookups) to execute in microseconds without wasting heavy cloud LLM tokens, while reserving deep reasoning models for complex life planning.
- **As a daily user**, I want an engaging, modern interface (dark glassmorphism, responsive touch targets, voice-first capture) that provides a clear morning focus briefing and evening reflection.

---

## 3. Core Features

| Feature | Priority | Description | Notes |
|---------|----------|-------------|-------|
| **Hierarchical Cascade Dispatcher** | Must-have | Integrated `krusch-cascade-router` evaluating prompts in <15µs on CPU. Tier 0 (deterministic rule) -> Tier 1 (local Ollama 3B/7B) -> Tier 2 (local compute swarm 14B/32B) -> Tier 3 (opt-in cloud). | Zero token cost for utility commands; sub-second TTFT on local edge. |
| **Sovereign Working Memory (KruschContext)** | Must-have | Native SQLite WAL working memory leveraging the closed taxonomy (`decision`, `invariant`, `bug`/habit friction, `lesson`, `blocker`) with temporal superseding (`MemoryInvalidationEngine`). | Replaces brittle markdown regex edits from `first-things-first`. |
| **Knowledge Boundary & Memory Gating** | Must-have | Integration of `@krusch/toolkit` `shouldActivateMemory` and prune gates to prevent memory pollution and cognitive degradation on closed-world tasks. | Based on arXiv: 2608.23982 research. |
| **Voice-First Chaos Dump Engine** | Must-have | Audio upload / browser STT transcription coupled with LLM intent parsing to extract structured tasks, schedule adjustments, and memory nuggets in one pass. | Preserves and refines the core UX of `first-things-first`. |
| **5-Tier Dynamic Priority Framework** | Must-have | Customizable personal priority hierarchy (e.g., Faith/Values, Family/Partner, Health/Self, Work/Career, Chores/Backlog) with task organization. | Enables clear cognitive offloading. |
| **Proactive Coaching & Daily Focus** | Must-have | Morning daily focus synthesis, midday friction nudges, and evening reflection logs generated from today's tasks and active context nuggets. | Non-judgmental, constructive ADHD coaching. |
| **Single-Task Focus Mode & Gamification** | Must-have | Distraction-free single task view with timer, streak tracking, and optional completion bonus points. | Proven behavioral anchor from FTF. |
| **Private Chat & Companion Dialogue** | Must-have | Empathetic, conversational assistant surface that answers questions, deliberates on decisions, and references personal context naturally. | Parity with Dot / Muse conversational feel. |
| **Home Ecosystem Bridge (Home Assistant / Fleet)** | Nice-to-have | Optional integrations for smart home control (Home Assistant) and fleet health triggers. | Modular plug-in architecture. |

---

## 4. Technical Constraints & Architecture

- **Stack**: Node.js 22+ (ESM).
- **Backend Framework**: Express.js with `@krusch/toolkit` modules (`llm`, `config`, `db`, `streaming`, `prune`, `memory-invalidation`).
- **Router Layer**: Direct dependency on `projects/krusch-cascade-router` (`createMultiSpecialistRouter`, `classifyPreRoute`, `detectKnowledgeBoundary`).
- **Context Layer**: Local SQLite WAL database via `better-sqlite3` / `@krusch/toolkit/db` adhering to the `krusch-context-mcp` memory schema (episodes, nuggets, state briefings, temporal invalidation).
- **LLM Runtimes**:
  - **Local Tier 1**: Ollama on `krusch` (localhost:11434) using `qwen2.5:7b` / `llama3.2:3b`.
  - **Local Tier 2**: vLLM or Ollama on `kruschdev` (100.106.193.66) using `qwen2.5-coder:14b` or `deepseek-v4-flash`.
  - **Tier 3 (Opt-in)**: OpenRouter or Gemini 3.1 Flash-Lite / 3 Flash via `@krusch/toolkit/llm` strictly behind user consent toggle.
- **Frontend**: React 19 + Vite (ESM) with Vanilla CSS / Dark Glassmorphism design system (`App.css`, `index.css`), responsive across desktop, tablet, and mobile PWA.
- **Deployment**: Dockerized on `kruschserv` (or local workstation `krusch`), standard Makefile, zero internet exposure except via Cloudflare Tunnel or local Tailscale mesh.

---

## 5. Data Model

The data model is stored in local SQLite (`data/companion.db`) with WAL mode enabled:

```
┌─────────────────────────────────────────────────────────────┐
│                          User Profile                       │
│  - id, name, preferences, streak, gamify_opt_in             │
└──────────────────────────────┬──────────────────────────────┘
                               │
       ┌───────────────────────┼───────────────────────┐
       ▼                       ▼                       ▼
┌──────────────┐       ┌──────────────┐       ┌─────────────────┐
│  Priorities  │       │ Context Store│       │      Tasks      │
│  (1 to 5)    │       │ (KruschMem)  │       │ - id, title     │
│ - id, label  │       │ - category   │       │ - priority_id   │
│ - color, icon│       │ - content    │       │ - date, status  │
│ - weight     │       │ - superseded_│       │ - points, notes │
└──────┬───────┘       │   by, ts     │       └─────────────────┘
       │               └──────────────┘
       ▼
┌──────────────┐       ┌──────────────┐       ┌─────────────────┐
│ Daily Focus  │       │ Reflections  │       │ Chat Dialogue   │
│ & Analysis   │       │ & Check-ins  │       │ - session_id    │
│ - date, raw  │       │ - date, type │       │ - role, content │
│ - structured │       │ - coach_msg  │       │ - tier_used     │
└──────────────┘       └──────────────┘       └─────────────────┘
```

---

## 6. UI / UX Design & Aesthetics

The UI builds upon the proven luxury glassmorphism standard of the Krusch ecosystem:
- **Palette**: Deep void dark mode (`#0a0b10`), glowing cyan/amber accents (`#00f0ff`, `#ffb700`, `#7928ca`), translucent panels with backdrop blur (`backdrop-filter: blur(16px)`).
- **Navigation (4 Core Views)**:
  1. **Companion (Chat & Daily Briefing)**: Conversational dialogue with the assistant, proactive morning brief, habit check-ins, tier routing badge (showing L0/L1/L2 escalation source).
  2. **Chaos Dump (Voice & Rapid Capture)**: Large, responsive microphone button with visual audio wave feedback, single-click paste/transcribe, instant preview of extracted tasks and context updates.
  3. **Today (5-Tier Priority Dashboard)**: Drag-and-drop or 1-tap priority assignments, completion checkboxes with tactile micro-animations, streak counter, and gamification badge.
  4. **Focus & Mind (Single-Task Flow)**: Zero-distraction fullscreen view for the current #1 task with countdown/stopwatch, ambient sound toggle, and instant completion trigger.

---

## 7. Edge Cases & Gotchas

1. **Local Node Offline / Network Partition**:
   - If `kruschdev` (Tier 2 compute) is unreachable or asleep, the Cascade Router must automatically degrade to local Tier 1 (Ollama on `krusch`) without hanging the user's UI.
2. **Conflicting Life Facts**:
   - When a user states a new preference or schedule rule that contradicts an old one, the system must invoke `supersedeMemoryRecord` to mark the old rule inactive rather than keeping conflicting facts in the active prompt context.
3. **Noisy Voice Transcriptions**:
   - Fast-path regex cleaning strips filler utterances ("um", "ah", "like") before handing text to the cascade classifier.
4. **Data Exfiltration Guard**:
   - Explicit setting in `config.json` (`allowCloudEscalation: false` by default). Any attempt to route to Tier 3 without explicit user authorization is rejected at the router level.

---

## 8. Acceptance Criteria

- [ ] Project scaffolds cleanly inside `projects/krusch-companion` with Node 22 ESM backend and Vite/React client.
- [ ] Backend loads `@krusch/toolkit` and `krusch-cascade-router` with sub-15µs routing validation.
- [ ] SQLite database initializes with WAL mode, storing tasks, priorities, daily focus, and KruschContext memory records.
- [ ] Voice/Text "Chaos Dump" takes unstructured input and extracts:
  - Structured tasks with auto-categorization into the 5-tier priority framework.
  - Persistent life nuggets saved to the local working memory.
- [ ] Cascade Router displays real-time execution tier badges (`L0 Heuristic`, `L1 Local Edge`, `L2 Swarm Compute`) on responses.
- [ ] Daily Focus and Reflection endpoints operate without reliance on external cloud APIs.
- [ ] Passes automated integration tests for cascade routing, memory superseding, and task creation.
- [ ] Indexed into `krusch-git` via `sync_to_pg.js` and registered in working memory.

---

## 9. Out of Scope for V1

- Native iOS/Android app store packaging (V1 targets high-performance mobile PWA).
- Multi-tenant cloud hosting (V1 is strictly single-user / sovereign family homelab deployment).
- Direct fine-tuning of model weights (prompt steering and invariant retrieval provide sufficient personalization without catastrophic forgetting).

---

## 10. Delivery Phases

| Phase | Milestone | Deliverables |
|---|---|---|
| **Phase 1: Foundation & Backend Core** | Scaffold `krusch-companion`, SQLite schema, `@krusch/toolkit` integration, `krusch-cascade-router` multi-tier client. | Backend API, route classifier, local Ollama integration, memory CRUD. |
| **Phase 2: Chaos Dump & Priority Engine** | Port & evolve `first-things-first` logic into structured KruschContext memory updates and 5-tier task management. | Task routes, STT transcription, extraction prompt with JSON validation. |
| **Phase 3: React PWA Frontend** | High-prestige dark glassmorphism client with 4 views (Companion Chat, Chaos Dump, Today, Focus Mode). | React/Vite client, audio wave recording, streak & gamify components. |
| **Phase 4: Invariant Audit & Homelab Registration** | Unit & integration tests, pre-commit invariant check, `krusch-git` registration, Dockerfile setup. | Passing test suite, `AGENTS.md`, `INFLIGHT.md`, git sync. |
