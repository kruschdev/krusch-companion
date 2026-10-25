# Krusch Companion — Sovereign Personal Assistant (`AGENTS.md`)

> **Version**: `v3.8.0` (`krusch-companion.service` on `krusch:3004`, `crush0` Kiosk, Faster-Whisper STT `:9000`)  
> **Core Role**: Privacy-first, local-first personal AI assistant pairing ambient voice Thought Streams, a Dual-Axis 5-Tier Priority Board, 16-question `/setup` onboarding, Google AP2 Payment Mandates, Google Wallet Passes, and an opt-in Skylight Calendar 2 Connector (`@krusch/companion-skylight-connector`) with `krusch-context-mcp` working memory and `krusch-cascade-router`.

---

## 🏗️ Architecture & Key File Map

| Layer | Path | Responsibility |
|---|---|---|
| **SDK & Server Entry** | `src/index.js`, `src/server.js`, `config.js` | Programmatic SDK exports (`COMPANION_TOOLS`, `executeCompanionTool`, `validateCompanionConfig`), Express HTTP server (`:3004`, `KRUSCH_NO_LISTEN` test guard), and `@krusch/toolkit/config` loader. |
| **Agent & Tool Router** | `src/agent/tools.js`, `src/router/` | 20-tool default catalog (strictly preserving token ceiling unless `ENABLE_SKYLIGHT_CONNECTOR=1`), `<holodata>` parser, AP2 HMAC-SHA256 payment mandates, Google Wallet pass builder, and `krusch-cascade-router` integration. |
| **Persistence & Onboarding** | `src/db/`, `src/services/onboarding.js` | SQLite WAL (`data/companion.db`), `VACUUM INTO` verified backups, temporal memory superseding (`MemoryInvalidationEngine`), and 16-question `/setup` seeding (`companion_context`, `companion_contacts`, `data/whisper-prompt.txt`). |
| **Frontend Client** | `client/src/` (`App.jsx`, `views/`, `utils/companionClient.js`) | React 19 + Vite dark glassmorphism UI, `AudioRecorder.jsx` voice Thought Stream, and `companionClient.js` client I/O boundary wrapper (`VALID_COMPANION_TABS`, `sanitizeSessionId`, `sortIncompleteTasks`). |
| **Verification Suite** | `tests/test-hardening.test.js`, `tests/test-extensions-v38.test.js` | Hermetic unit, security hardening, AP2/Wallet, Skylight connector, and client boundary test suites (`npm test`). |

---

## 🖥️ Multi-Family 5-GPU + Colab G4 Routing Standard

- **L0 Deterministic Fast-Path (`<15µs` CPU)**: Math (`safeEvaluateArithmetic`), timers, notes, and task mutations execute directly on SQLite with `$0.00` LLM overhead.
- **L1/L2 Local Multi-Family Pool (`keep_alive: -1`, `100% GPU`)**:
  - Primary Local Node (`OLLAMA_URL`, default `127.0.0.1:11434`): `qwen2.5-coder:7b` (fast local tool/tagger) + `snowflake-arctic-embed2:latest` (`1024`-dim embeddings).
  - Executor & Referee Pool (`VISION_OLLAMA_URL` / secondary GPU host): `gemma4:e4b` (multimodal/tool executor) + `hermes3:latest` (coaching, prose & cross-family Referee).
  - Heavy Synthesis Pool (compute GPU host): `qwen3-coder-30b-moe:latest` (30B MoE heavy synthesis).
- **L2.5 On-Demand Burst (`127.0.0.1:11435`)**: `gpt-oss:120b` (`131K` ctx) via SSH tunnel when active.

---

## 🛑 Core Invariants (`INV-COMP-01` – `INV-COMP-05`)

1. **Local-First Sovereignty (`INV-COMP-01`)**: Never exfiltrate journal entries, voice dumps, or memories to external cloud LLMs unless explicitly enabled (`allowCloudEscalation: false`).
2. **20-Tool Default Catalog Ceiling (`INV-COMP-02`)**: `COMPANION_TOOLS` must remain at exactly 20 default tools unless `ENABLE_SKYLIGHT_CONNECTOR=1` opts in `SKYLIGHT_CALENDAR_TOOL`.
3. **Confirm-Before-Act Side-Effect Gate (`INV-COMP-03`)**: External side-effect tools (email, SMS, calendar, AP2 payment mandates) require explicit `confirmed: true` or dry-run preview before execution.
4. **Client Boundary Encapsulation (`INV-COMP-04`)**: Browser `localStorage`, URL routing, and `/api/*` fetches in `client/src/` must route through `client/src/utils/companionClient.js` with `logClientBoundaryWarning` observability.
5. **Temporal Fact Superseding (`INV-COMP-05`)**: Updated personal habits or preferences must supersede prior records via `MemoryInvalidationEngine` rather than duplicating rows.
