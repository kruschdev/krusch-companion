# In-Flight Work Tracker: Krusch Companion

> **Current Phase**: V3.8 Release Ready & Verified ✅ (`62/62` Tests Passing, `0` Lint Warnings)

## Summary
Krusch Companion (`krusch-companion`) is fully implemented, verified, and indexed into the homelab fleet. It provides a sovereign, privacy-first personal assistant alternative to Meta Muse, xAI Grok Companion, OpenClaw ("Grokbot"), Nous Hermes Agent, Block Goose, and OpenAI Dot.

## Status
- [x] Initialized Git repository and connected remote: `git@github.com:kruschdev/krusch-companion.git`
- [x] Authored full specification (`spec.md` including V3.8 Section 11 `INV-EXT-01`..`INV-EXT-08`), implementation plan (`implementation_plan.md`), and `AGENTS.md`
- [x] Implemented SQLite WAL database schema and helper methods (`src/db/`)
- [x] Implemented KruschContext working memory store with temporal fact superseding (`src/context/memory-store.js`)
- [x] Implemented Knowledge Boundary Gating and context pruning (`src/context/boundary-gate.js`)
- [x] Integrated `krusch-cascade-router` with L0 Heuristic (<15µs), L1 Local Edge (`qwen2.5-coder:7b`), L2 Swarm (`qwen3-coder-30b-moe:latest` on `kruschdev` + `hermes3:latest` on `kruschserv`), and L3 Frontier (`z-ai/glm-5.3` via OpenRouter ZDR) (`src/router/cascade-client.js`)
- [x] Implemented 20 Sovereign Tools and the 3-Stage Smart Tool Token Limiter (`93%–98%` schema token savings via DPP `routeDiverseTools` + `compactToolSchemaForPrompt`) (`src/agent/agentic-proxy.js`, `src/agent/tools.js`)
- [x] Implemented Standalone 16-Question Initial Setup & Multi-Table Database Seeding Page (`/setup`, `src/services/onboarding.js`, `client/src/views/SetupView.jsx`)
- [x] Implemented Local Faster-Whisper ASR Server (`scripts/whisper_asr_server.py`) & Adaptive Voice Silence Detector (`client/src/utils/voiceSilenceDetector.js`) with custom vocabulary biasing (`data/whisper-prompt.txt`)
- [x] Implemented Multi-Thread Saved Chat Conversations & Companion-Integrated Today's Board (`client/src/views/CompanionView.jsx`, `client/src/views/TodayView.jsx`)
- [x] Wired Opt-In Skylight Calendar 2 Connector (`@krusch/companion-skylight-connector`, `SKYLIGHT_CALENDAR_TOOL`, `/api/skylight`) while preserving the 20-tool default catalog token invariant (`ENABLE_SKYLIGHT_CONNECTOR=1`)
- [x] **V3.8 Personal AI Ecosystem & Opt-In Extension Pack** (executed via 6 parallel subagents under `/spec-first-refactor`):
  - **Opt-In Extension Registry & KruschFS Local Document/PDF Bridge** (`src/extensions/extension-registry.js`, `src/extensions/krusch-fs-extension.js`, `INV-EXT-01`, `INV-EXT-02`)
  - **Multimodal Vision & Camera Triage (`gemma4:e4b`)** (`src/services/vision.js`, `INV-EXT-03`)
  - **2-Way Spoken Voice Mode & Local RIFF/WAVE TTS Engine** (`src/services/tts.js`, `client/src/utils/liveVoiceLoop.js`, `INV-EXT-04`)
  - **2-Way Interactive Telegram / Discord / Mobile Shortcut Bot** (`src/services/channel-bot.js`, `INV-EXT-05`)
  - **Subscriptions, Bills & Receipt Ledger + Zero-Token Sentinel Channel 5 Auto-Renewal Watchdog** (`src/extensions/finance-ledger-extension.js`, `src/services/sentinel-daemon.js`, `INV-EXT-06`)
  - **Biometric Energy Readiness Sync + Jellyfin Media Controller + `🧩 Extensions` UI Hub** (`src/extensions/health-media-extension.js`, `client/src/views/ExtensionsView.jsx`, `INV-EXT-07`, `INV-EXT-08`)
- [x] **4-Agent Parallel Security/DB/UI/Referee Audit & Remediations (`SEC-01`..`02`, `SPEC-01`..`06`, `DB-01`..`03`, `UI-01`..`04`)**:
  - Enforced `fs.realpathSync` containment and 2 MB size cap in `src/extensions/krusch-fs-extension.js`
  - Hardened `isSafePublicUrl` against bracketed IPv6 (`[::1]`), `::ffff:`, and Tailscale CGNAT (`100.64.0.0/10`) and gated `replyWebhookUrl` in `src/services/channel-bot.js`
  - Dynamically merged `getEnabledExtensionTools()` into `src/agent/agentic-proxy.js` (`INV-EXT-01`)
  - Initialized `ensureFinanceLedgerTables()` inside `src/services/vision.js` (`SPEC-02`), made callback claims atomic in `src/services/channel-bot.js` (`DB-01`), and made `adaptBoardToEnergyReadiness` idempotent (`DB-03`)
- [x] **Proposal Redlines $\to$ Reference-Backed Skill Playbook Distiller (`INV-EXT-09`, `distillProposalToSkill`, `GET/POST /api/companion/distill-skill`, `.agent/skills/distill-skill/SKILL.md`)**
- [x] All 62 unit/integration tests passing cleanly (`npm test`) and `npm run lint` (`oxlint`) 0 warnings / 0 errors
- [x] L0 Dual-Zero-Finding Verification Gate (`checkConvergence` + `evaluateRefereeConsensus`) passed (`consecutiveZeroPasses: 2`, `isConverged: true`)
- [x] Re-indexed into `krusch-git` (Repo ID 154)


