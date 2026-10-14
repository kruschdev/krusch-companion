# Architecture Decision Records (ADRs) — Krusch Companion

This document records the core architectural decisions behind **Krusch Companion**.

---

## ADR-001: Native `node:sqlite` (WAL Mode) Over External Database Servers

* **Status**: Accepted
* **Context**: Personal AI companions often fail on setup complexity when they require external PostgreSQL, Redis, or vector database containers just to store tasks and personal context.
* **Decision**: Use Node 22+'s built-in `node:sqlite` (`DatabaseSync`) with `PRAGMA journal_mode = WAL` and `VACUUM INTO` hot backups (`data/companion.db`).
* **Consequences**:
  - **Pros**: Zero native C++ compilation step (`node-gyp` free), single-file portability, instant startup, and sub-millisecond local reads (`p50 ~0.18ms`).
  - **Cons**: Requires Node.js `>=22.5.0`. Single-writer concurrency (well-suited for a personal/household sovereign instance).

---

## ADR-002: Dual-Axis Priority Architecture (Execution Lanes × Life Pillars)

* **Status**: Accepted
* **Context**: Traditional single-axis "values-first" boards create the **Priority Paradox**: if *Core Values* (`Tier 1`) or *Family* (`Tier 2`) always sort above *Work & Provision* (`Tier 5`), recurring daily habits bury urgent bills, client deadlines, or appointments that must happen today to provide for the family.
* **Decision**: Decouple **Execution Priority (`execution_priority 1..4`: When it must happen today)** from **Life Pillar (`pillar`: Why it matters in the grand scheme of life)**.
  - **Axis 1 (Execution Lanes)**: `P1 Must Happen Today — Deadlines & Provision`, `P2 High-Impact Focus`, `P3 Daily Habits & Anchors`, `P4 Backlog`.
  - **Axis 2 (Life Pillars)**: `🏠 Provision & Finance`, `🔧 Work & Mastery`, `💕 Family & Partner`, `👧 Children & Loved Ones`, `💪 Health & Self`, `🙏 Core Values & Faith`.
* **Consequences**:
  - **Pros**: Urgent provision and deadlines (`P1`) always surface at the very top of Today's Board, while recurring daily habits stay grounded in `P3` (`Daily Habits & Anchors`) without burying time-critical tasks. Every task also carries a human-readable `lane_reason` (*"Why this lane?"*).

---

## ADR-003: 3-Tier Cascade Router (`L0` Deterministic → `L1` Edge → `L2` Deep Reasoning)

* **Status**: Accepted
* **Context**: Sending every utility check, math calculation, or task board mutation through a large LLM wastes latency, energy, and context tokens.
* **Decision**: Route all prompts through a 3-tier cascade:
  - **`L0_heuristic` (`<15 µs` pure CPU / `<1 ms` with SQLite)**: Deterministic shunting-yard AST math parser, time/date lookup, and regex-grounded board actions (`create_task`, `promote_task_priority`, `complete_task`, `rollover_tasks`, `remember_fact`).
  - **`L1_edge`**: Local 7B Ollama model (`qwen2.5-coder:7b`) or OpenRouter ZDR equivalent for conversational turns, Thought Stream extraction, and `<holodata>` tool calls.
  - **`L2_swarm`**: Escalated only when prompt complexity or multi-step synthesis exceeds the L1 threshold.
* **Consequences**:
  - **Pros**: Common board operations and utility queries resolve deterministically with zero hallucination risk; reproducible via `npm run bench`.

---

## ADR-004: `<holodata>` Agentic Proxy & Side-Effect Confirmation Gate

* **Status**: Accepted
* **Context**: Small local models (7B–14B) degrade when injected with 10+ verbose JSON tool schemas simultaneously, and autonomous execution of external side-effect tools (sending emails, modifying calendar events, booking reservations) carries safety risks.
* **Decision**:
  1. **Intent-Scoped Tool Pruning**: `selectRelevantTools(prompt)` prunes the tool registry to the `1–3` tools matching the user's intent before prompt assembly.
  2. **Deterministic Fallback Layer**: `inferFallbackToolCalls(prompt)` catches common intents (weather, time-to-leave, Google Drive/Calendar/Gmail lookups) even if a small local model omits the `<holodata>` XML tag.
  3. **Side-Effect Dry-Run Confirmation Gate**: External side-effect actions (`gkrusch_gmail` send/draft, `gkrusch_calendar` create, `concierge_reservation` book, `send_notification`) support an explicit `dryRunMode` (`POST /api/settings/runtime`) that returns a structured preview requiring confirmation before mutating external state.

---

## ADR-005: Conditional Knowledge Boundary Gate & Temporal Memory Superseding

* **Status**: Accepted
* **Context**: Unconditionally injecting personal working memory into closed-world utility queries wastes prompt tokens and causes persona bleed; conversely, appending new preferences without retiring old ones causes temporal contradictions.
* **Decision**:
  - **Knowledge Boundary Gate (`src/context/boundary-gate.js`)**: Suppresses memory injection (`0` tokens) on closed-world utility queries and activates working memory only on open-world/personal queries.
  - **Temporal Superseding (`src/context/memory-store.js`)**: Updating a preference or routine sets `superseded_by = <new_id>` on the prior record, preserving lineage (`GET /api/context/history`) while guaranteeing `0%` outdated contradiction rate in active prompt briefings.
