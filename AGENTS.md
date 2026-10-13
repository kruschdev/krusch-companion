# Krusch Companion — Sovereign Personal Assistant

## Overview
Krusch Companion (`krusch-companion`) is a privacy-first, sovereign personal assistant and executive companion. It evolves and consolidates the ADHD-friendly voice capture ("Chaos Dump") and 5-tier priority framework from `first-things-first` with `krusch-context-mcp` working memory and `krusch-cascade-router` hierarchical tiering. All state, personal habits, notes, and tasks live strictly on local homelab hardware with $0.00 cloud token costs for daily interactions.

## Architecture & Layout
```
krusch-companion/
├── AGENTS.md                  # Project context & architecture
├── INFLIGHT.md                # In-flight task tracker
├── spec.md                    # Project specification
├── implementation_plan.md     # Implementation plan & verification gates
├── task.md                    # Atomic task checklist
├── package.json               # Node.js 22 ESM backend
├── config.json                # Layered configuration defaults
├── config.js                  # Layered loader using @krusch/toolkit/config
├── src/
│   ├── server.js              # Express API server (default port: 3004)
│   ├── db/                    # SQLite database with WAL mode
│   ├── context/               # Working memory & knowledge boundary gating
│   ├── router/                # krusch-cascade-router integration
│   ├── services/              # Chaos Dump, Coach, STT
│   └── routes/                # REST endpoints
├── client/                    # React 19 + Vite frontend (dark glassmorphism)
└── tests/                     # Unit and integration test suites
```

## Stack
- **Runtime**: Node.js 22+ (ESM)
- **Backend**: Express.js
- **Shared Toolkit**: `@krusch/toolkit` (LLM, DB, Config, Pruning, Invalidation)
- **Cascade Router**: `krusch-cascade-router` (sub-15µs CPU heuristic classifier, local edge 3B/7B, swarm 14B/32B)
- **Database**: SQLite WAL via `@krusch/toolkit/db`
- **Frontend**: React 19, Vite, Vanilla CSS
- **Local LLMs**: Ollama on `krusch` (localhost:11434) and vLLM on `kruschdev`

## Key Commands
```bash
npm install              # Install backend dependencies
npm test                 # Run test suites
npm run dev              # Run server with watch mode
cd client && npm install # Install frontend dependencies
cd client && npm run dev # Run Vite dev server
cd client && npm run build # Production build
```

## Core Invariants
1. **Local-First Privacy**: Never exfiltrate user journal entries, voice dumps, or memories to external cloud LLMs unless explicitly permitted in `config.json` (`allowCloudEscalation: false`).
2. **Sub-15µs L0 Fast-Path**: Utility and deterministic queries (math, alarms, notes, task creation) must bypass LLMs using Cascade Router heuristics.
3. **Fact Superseding**: Contradictory personal habits or preferences must supersede previous memory records using `MemoryInvalidationEngine`.
4. **Zero-Trust Hydration**: Always use `krusch_context_retrieve` and `krusch_context_remember` during agent workflows.
