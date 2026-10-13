<p align="center">
  <h1 align="center">🛡️ Krusch Companion</h1>
  <p align="center">
    <strong>The Sovereign Personal AI & Executive Operating System</strong><br>
    <em>A 100% private, local-first alternative to Meta Muse, xAI Grok, and OpenAI Dot.</em>
  </p>
</p>

<p align="center">
  <a href="https://github.com/kruschdev/krusch-companion/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.0.0-green.svg?style=flat-square" alt="Node Version">
  <a href="https://github.com/kruschdev/krusch-cascade-router"><img src="https://img.shields.io/badge/Router-krusch--cascade--router-cyan.svg?style=flat-square" alt="Powered By krusch-cascade-router"></a>
  <a href="https://github.com/kruschdev/krusch-context-mcp"><img src="https://img.shields.io/badge/Memory-KruschContext%20Engine-purple.svg?style=flat-square" alt="KruschContext Engine"></a>
  <img src="https://img.shields.io/badge/Privacy-100%25%20Zero--Cloud%20Sovereign-emerald.svg?style=flat-square" alt="100% Sovereign">
  <img src="https://img.shields.io/badge/tests-18%20passed-brightgreen.svg?style=flat-square" alt="Tests Passed">
</p>

---

## ⚡ The Big Tech Dilemma: "Who owns your digital second brain?"

Consumer AI assistants (**Meta Muse**, **xAI Grok Companion**, and **OpenAI Dot**) are built on a non-negotiable compromise:
* **The Surveillance Tax**: Every unformatted diary entry, intimate thought, medical note, family schedule, and personal habit is ingested into centralized cloud data centers.
* **The Training Fuel**: Your life’s private context is logged and mined to train future foundation models and refine behavioral profiling.
* **Walled Gardens**: If Big Tech changes its terms of service, raises subscription pricing, or deletes an account, your digital memory is lost forever.
* **The Routing Tax**: Even trivial utility queries (`"What is 15% tip on $85?"` or `"Remember to drink water"`) make a 1,000ms cloud roundtrip costing token fees and generating telemetry.

### 🛡️ The Sovereign Answer: Krusch Companion
**Krusch Companion** is a local-first, privacy-first personal assistant and executive co-pilot. It consolidates the ADHD-friendly voice capture ("Chaos Dump") and 5-tier priority framework from `first-things-first` with the **sub-15µs CPU Cascade Router** (`krusch-cascade-router`) and **KruschContext working memory** (`krusch-context-mcp`).

**100% of your data, memory nuggets, schedules, and conversations live in a local SQLite database on your own home hardware.** Daily interactions cost **$0.00** and operate with zero cloud reliance.

---

## ⚖️ Architectural Comparison

| Dimension | Meta Muse | xAI Grok Companion | OpenAI Dot | **Krusch Companion** |
|:---|:---|:---|:---|:---|
| **Data Ownership** | Meta Cloud Data Centers | xAI Cloud Clusters | OpenAI / Microsoft Cloud | **100% Local Homelab Hardware** (Local SQLite WAL) |
| **Inference Routing** | Monolithic Cloud Calls | Monolithic Cloud Calls | Monolithic Cloud Calls | **Cascade Router**: L0 CPU Heuristic (<15µs) + L1 Edge (7B) + L2 Swarm (14B) |
| **Daily Cost** | Subscription / Ad-Tracking | Subscription / X Premium | Subscription ($20+/mo) | **$0.00 / Zero-Token Cost** for 95%+ of daily tasks |
| **Offline Operation** | ❌ Dead without internet | ❌ Dead without internet | ❌ Dead without internet | ✅ **100% Fully Functional Offline** |
| **Memory Architecture** | Unbounded Vector RAG | Vector Search over Tweets/Chats | Episodic Chat Logs | **KruschContext**: 5 closed categories with **temporal fact superseding** |
| **Context Hygiene** | Injects noisy history into all turns | Blasts history into prompts | Inconsistent memory filters | **Knowledge Boundary Gating** (arXiv: 2608.23982) isolates self-contained tasks |
| **Executive Function / ADHD** | Conversational chitchat | Conversational banter | Empathy journaling | **Chaos Dump Engine**: Rambling voice/text triaged into a **5-tier priority board** |
| **Client Interface** | Mobile App Store lock-in | App Store lock-in | App Store lock-in | **Installable PWA** (Apple HIG compliant, dark glassmorphism) |

---

## 🏛️ System Architecture

```
                                 [ User Interaction ]
                       (Voice WebM / Text / Keyboard Hotkeys)
                                         │
                                         ▼
                     ┌───────────────────────────────────────┐
                     │     krusch-cascade-router (L1 Gate)   │
                     │       <15µs CPU Intent & Cost Gate    │
                     └───────────────────┬───────────────────┘
                                         │
        ┌────────────────────────────────┼────────────────────────────────┐
        ▼                                ▼                                ▼
  [ Tier 0: Direct ]             [ Tier 1: Edge Local ]          [ Tier 2: Deep Local ]
  - Safe AST Arithmetic (<15µs)   - Local 7B Ollama               - Local 14B Swarm
  - Direct Memory Persistence    - Sub-second daily chat,        - Complex life planning,
  - Zero LLM Token Cost ($0.00)     triage, morning briefing        deep chaos dump synthesis
        │                                │                                │
        └────────────────────────────────┴────────────────────────────────┘
                                         │
                                         ▼
                     ┌───────────────────────────────────────┐
                     │          KruschContext Engine         │
                     │  - Working Memory (5 Closed Taxonomies│
                     │  - Temporal Fact Superseding & Decay  │
                     │  - Knowledge Boundary Gate (Pruning)  │
                     │  - SQLite WAL (Atomic VACUUM Backups) │
                     └───────────────────────────────────────┘
                                         │ (Strictly Opt-in, default blocked)
                                         ▼
                     [ Tier 3: Sovereign Cloud Escalation ]
                     (User-permissioned frontier reasoning only)
```

---

## 💎 Core Pillars

### 1. Sub-15µs CPU Cascade Router
- **L0 Deterministic Heuristic**: Captures commands like `"Remember that my dentist is on Friday"` or evaluates arithmetic expressions in microseconds on CPU with zero token expenditure.
- **L1 Local Edge**: Dispatches daily conversational chitchat to local Ollama (`qwen2.5-coder:7b` or `hermes3:latest`), returning in sub-second latencies.
- **L2 Compute Swarm**: Transparently escalates heavy, multi-paragraph reasoning prompts to compute servers (e.g. dual-GPU nodes on LAN) with automatic fallback hedging if the compute server is asleep.
- **L3 Cloud Privacy Gate**: External cloud escalation is strictly disabled by default (`allowCloudEscalation: false`).

### 2. KruschContext Working Memory & Temporal Superseding
Unlike naive vector memory that hoards conflicting facts and causes model schizophrenia:
- **5-Category Closed Taxonomy**:
  - `decision`: Established choices or firm commitments.
  - `invariant`: Non-negotiable boundaries, constraints, or health rules.
  - `bug`: Friction points, habits you want to break, or personal pitfalls.
  - `lesson`: Helpful routines or tactical insights learned.
  - `blocker`: Active external dependencies or emotional stressors.
- **Temporal Superseding (`MemoryInvalidationEngine`)**: When you say *"I stopped drinking coffee after 2 PM"*, the old routine is cleanly deactivated and linked via `superseded_by`, eliminating prompt contradiction.
- **30-Day Decay Review**: Stale facts older than 30 days are automatically surfaced for hygiene review.

### 3. Knowledge Boundary Gating (*arXiv: 2608.23982*)
Recent research proves that injecting long-term personal context into mathematically or syntactically self-contained tasks (arithmetic, simple timers, syntax formatting) introduces cognitive interference and degrades accuracy. Krusch Companion automatically gates memory retrieval, suppressing irrelevant backstory when executing closed-world tasks.

### 4. Executive Triage: ADHD Chaos Dump
Built specifically to conquer executive dysfunction and overwhelm:
1. **Unformatted Capture**: Speak into the live audio waveform recorder or paste an unstructured stream-of-consciousness text block.
2. **Instant Triage**: The assistant strips cognitive noise, parses actionable tasks, assigns them to your **5-Tier Priority Framework**, extracts life memories, and highlights the **ONE single task** to do first.
3. **Single-Task Focus Mode**: Fullscreen flow state with an ambient timer ring, micro-nudge coaching (`"Just do 3 minutes"`), and hotkeys (`Space` to toggle, `Esc` to exit).

### 5. Enterprise Hardening & Zero-Lock Backups
- **AST Recursive-Descent Evaluator**: Replaces dangerous `eval` and `Function` calls with a pure AST arithmetic tokenizer that handles powers, decimals, and parentheses while safely rejecting code injection and division-by-zero.
- **Prompt Injection Shield**: Integrated `sanitizeAgentMessage` from `@krusch/toolkit/trajectory-guard` filters ChatML breakouts, Llama tags, and recursive prompt contagion.
- **Sovereign Backup API**: Zero-lock SQLite database snapshots created in milliseconds via `VACUUM INTO` (`POST /api/backup`).
- **PWA Durability**: Installable Progressive Web App with service worker caching (`sw.js`) and offline state detection.

---

## 🖥️ User Interface Tour

The frontend is a luxury **Dark Glassmorphism** React 19 SPA styled with tailored HSL variables, backdrop blurs, and Apple HIG touch targets:

1. **💬 Companion View**: Conversational dialogue with proactive morning focus briefings, quick prompts, and **Real-Time Tier Badges** (`L0 Heuristic`, `L1 Edge`, `L2 Swarm`).
2. **🌪️ Chaos Dump View**: Live HTML5 Canvas microphone waveform visualizer + multiline textarea (`Ctrl+Enter` to submit) + structured extraction preview.
3. **📋 Today's Board**: 5-Tier Priority Dashboard (Core Values, Family & Partner, Loved Ones, Health & Self, Work & Mastery) with tactile checkmarks, streak counter, and gamification points.
4. **🎯 Focus Mode**: Distraction-free single-task execution with a glowing cyan timer ring, Pomodoro presets, and AI initiation nudges.

---

## 🚀 Quickstart

### Prerequisites
- **Node.js**: `v22.0.0+`
- **Ollama**: Running locally (`curl http://localhost:11434/api/tags`) with `qwen2.5-coder:7b` or `hermes3:latest`.

```bash
# Pull recommended local edge model
ollama pull qwen2.5-coder:7b
```

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/kruschdev/krusch-companion.git
cd krusch-companion

# 2. Install dependencies
npm install
cd client && npm install && cd ..

# 3. Run the automated test suite (18 unit & integration tests)
npm test

# 4. Start the development server
npm run dev
```

Visit **`http://localhost:3004`** in your browser (or install as a PWA on your phone via Safari / Chrome).

---

## 🐳 Docker Deployment

Krusch Companion includes a multi-stage `Dockerfile` and `docker-compose.yml` configured for home server deployment:

```bash
# Start containerized service
docker compose up -d

# View live logs
docker compose logs -f
```

---

## 📡 REST API Reference

| Method | Endpoint | Description |
|:---|:---|:---|
| `GET` | `/api/health` | Service status, connected local models, and privacy gate configuration. |
| `POST` | `/api/companion/chat` | Main conversational endpoint routed via Cascade Router (`{ prompt, history, sessionId }`). |
| `POST` | `/api/companion/dump` | Ingests unformatted Chaos Dump text and triages into 5-tier tasks and memories. |
| `POST` | `/api/companion/voice` | Accepts multipart `audio` (WebM/WAV) -> Whisper STT -> Chaos Dump pipeline. |
| `GET` | `/api/tasks` | Retrieves tasks for date (`?date=YYYY-MM-DD`). |
| `POST` | `/api/tasks` | Creates a new structured task (`{ title, priority_id, notes, energy_level }`). |
| `PATCH` | `/api/tasks/:id/complete` | Toggles task completion and updates gamification points. |
| `DELETE`| `/api/tasks/:id` | Deletes a task. |
| `GET` | `/api/streak` | Retrieves continuous task completion streak data. |
| `GET` | `/api/coach/focus` | Retrieves today's active morning focus briefing. |
| `POST` | `/api/coach/focus` | Synthesizes a new morning focus briefing from tasks and working memory. |
| `POST` | `/api/coach/nudge` | Generates a 1-sentence ADHD micro-nudge for the current task. |
| `POST` | `/api/coach/reflect` | Synthesizes an evening reflection celebrating wins. |
| `GET` | `/api/context` | Retrieves active working memory nuggets and compiled state briefing. |
| `POST` | `/api/context` | Persists a new memory nugget (`{ category, content, key }`). |
| `POST` | `/api/context/:id/supersede`| Invalidates an old memory record and links an updated fact (`{ newContent, reason }`). |
| `GET` | `/api/context/decay` | Lists memories older than N days (`?days=30`) for hygiene review. |
| `POST` | `/api/backup` | Creates an atomic zero-lock SQLite backup via `VACUUM INTO`. |
| `GET` | `/api/system/integrity` | Executes SQLite `PRAGMA integrity_check`. |

---

## ⚙️ Configuration (`config.json`)

```json
{
  "app": {
    "name": "Krusch Companion",
    "port": 3004,
    "host": "0.0.0.0"
  },
  "cascade": {
    "allowCloudEscalation": false,
    "l0HeuristicEnabled": true,
    "speculativeHedging": true,
    "edgeModel": "qwen2.5-coder:7b",
    "swarmModel": "qwen2.5-coder:14b",
    "ollamaUrl": "http://127.0.0.1:11434",
    "swarmUrl": "http://100.106.193.66:8000/v1"
  },
  "db": {
    "path": "./data/companion.db"
  },
  "context": {
    "maxTokenBudget": 3000,
    "decayDays": 30
  },
  "whisper": {
    "host": "localhost",
    "port": 9000,
    "enabled": true
  }
}
```

---

## 📚 Academic Foundations

Krusch Companion operationalizes breakthroughs from recent AI agent and inference research:
1. **Knowledge Boundary Routing & Selective Memory**: *"Memory Is Not Always Needed"* (arXiv: 2608.23982) — Suppressing episodic memory on self-contained tasks eliminates cognitive drift.
2. **Mind Virus Containment**: *"Mind Viruses: Self-Propagating Ideas in Multi-Agent LLM Systems"* (arXiv: 2608.10218) — Input sanitization filtering delimiter and system-tag breakouts.
3. **Temporal Invalidation & Lineage**: *MobileMem: Lifelong Memory Management for Personal Agents* (arXiv: 2608.13606) — Explicit superseding of obsolete lifestyle facts.
4. **Hedged Multi-Model Cascades**: *The Tail at Scale* (Dean & Barroso, CACM 2013) & *RouterArena* — Parallel fallback hedging to eliminate sequential model cascade latency.

---

## 📄 License

MIT © [kruschdev](https://github.com/kruschdev). Part of the Krusch Homelab Sovereign AI Ecosystem.
