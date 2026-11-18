# Install `krusch-companion`

These are instructions for a coding agent (Claude Code, Codex, Cursor, Windsurf, or Antigravity) that a person asked to install and configure `krusch-companion` (`kruschdev/krusch-companion`) on their machine.

`krusch-companion` is a Node 22+ standalone, local-first personal AI assistant and installable React 19 Progressive Web App (`http://127.0.0.1:3004`) combining a `<15us` L0 CPU Cascade Router, a 20-tool `<holodata>` Agentic Proxy with DPP Smart Tool Token Limiting, a Proactive Sentinel Watchdog, SQLite WAL (`data/companion.db`), and an embedded `@hydradb/selfgraph` (`KuzuStore`) bi-temporal personal knowledge graph.

## 1. Check Prerequisites First

Run one read-only check before installing or modifying anything:

```bash
id -u
node -v 2>/dev/null || echo "MISSING: node"
npm -v 2>/dev/null || echo "MISSING: npm"
git --version 2>/dev/null || echo "MISSING: git"
ss -ltnp 2>/dev/null | grep -E ':3004\b' || lsof -iTCP:3004 -sTCP:LISTEN 2>/dev/null || echo "PORT_3004_FREE"
ollama --version 2>/dev/null || echo "OPTIONAL_MISSING: ollama"
docker compose version 2>/dev/null || echo "OPTIONAL_MISSING: docker-compose"
```

Evaluate the results:
1. **User check**: If `id -u` prints `0` (root), stop and ask the person to run you under a normal non-root user account.
2. **Node.js `>= 22.0.0` and `npm` (Required)**: If `node -v` is missing or below `v22.0.0`, ask the person before installing or switching to Node 22 (`nvm install 22` or `fnm use 22`).
3. **Free port `3004` (Required by default)**: If port `3004` is already bound, tell the person what process holds it and ask before setting an alternate `PORT` in `.env`.
4. **Ollama & Docker Compose (Optional)**: Local `ollama` is only required for Mode 2 (100% local GPU/CPU inference), and `docker compose` is only needed if the person explicitly requests containerized deployment (`docker compose up -d` or `docker compose --profile full-stack up -d`).

## 2. Choose the Right Launch Mode

Select the launch mode safely without guessing secrets or downloading large weights unprompted:

1. **Mode 1: Zero-GPU / Zero-API-Key Instant Verification & Demo (Default if neither Ollama nor an OpenRouter key is configured yet)**: Runs the full React 19 PWA, L0 CPU router, Dual-Axis Priority Board, Working Memory, `KuzuStore` graph, and 20-tool offline vault fallbacks via `MOCK_LLM=1` at `$0.00` with zero GPU and zero API keys.
2. **Mode 2: 100% Local Ollama Mode (Private On-Device LLM)**: Uses local Ollama at `http://127.0.0.1:11434` (`qwen2.5-coder:7b` by default) while keeping `ALLOW_CLOUD_ESCALATION=false`. Always confirm with the person before running `ollama pull qwen2.5-coder:7b` if that model is not already downloaded (`ollama list`).
3. **Mode 3: Zero-GPU OpenRouter Mode (Zero-Data-Retention Cloud Cascade)**: Keep `ALLOW_CLOUD_ESCALATION=false` unless the person explicitly asks for OpenRouter mode and provides their own `OPENROUTER_API_KEY`. When requested, configure `LLM_PROVIDER=openrouter` and `ALLOW_CLOUD_ESCALATION=true` with `OPENROUTER_ZDR=true` enabled.

## 3. Install, Build & Run

Clone the repository if not already inside a `krusch-companion` checkout (check `pwd` first), prepare `.env` non-destructively, build the PWA bundle, and run diagnostics and tests:

```bash
git clone https://github.com/kruschdev/krusch-companion.git
cd krusch-companion
[ -f .env ] || cp .env.example .env

# Install backend + frontend dependencies, build client/dist, and inspect environment readiness
npm install && npm run build && npm run doctor

# Run the hermetic automated test suite and frontend linter
MOCK_LLM=1 npm test
npm run lint
```

Then start the server in the chosen mode:

- **Mode 1 (Zero-GPU / Zero-API-Key Instant Demo & Eval)**:
  ```bash
  MOCK_LLM=1 npm start
  ```
- **Mode 2 (100% Local Ollama Mode, after confirming with the person before pulling weights)**:
  ```bash
  ollama pull qwen2.5-coder:7b
  npm run doctor
  npm start
  ```
- **Mode 3 (Zero-GPU OpenRouter Mode, only when the person asks for OpenRouter and provides `OPENROUTER_API_KEY`)**:
  Update `LLM_PROVIDER=openrouter`, `ALLOW_CLOUD_ESCALATION=true`, and `OPENROUTER_API_KEY=<person-provided-key>` in `.env`, verify with `npm run doctor`, and start:
  ```bash
  npm start
  ```

Verify the server responds cleanly on `http://127.0.0.1:3004`:

```bash
curl -fsS http://127.0.0.1:3004/api/health
```

## 4. Personal Onboarding (`http://localhost:3004/setup`)

Once `krusch-companion` is running, tell the person to open **`http://localhost:3004/setup`** themselves in their browser to complete the 16-question initial onboarding wizard (owner name, partner/family Personal CRM, home/work commute origins, recurring daily habits, and custom voice vocabulary), or click **`Skip Setup`** to jump straight onto Today's Dual-Axis Board at `http://localhost:3004`.

## Never

- **Never run `npm`, `node`, or `git` with `sudo` or as `root`**.
- **Never set `ALLOW_CLOUD_ESCALATION=true`** unless the person explicitly asks for OpenRouter or cloud escalation mode.
- **Never invent or guess API keys or signing secrets** (`OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `PRIVACY_API_KEY`, `AP2_SIGNING_SECRET`, `GOOGLE_WALLET_PRIVATE_KEY`) in `.env`.
- **Never overwrite an existing `.env` file**; preserve any values the person already configured.
- **Never pull multi-gigabyte Ollama models (`ollama pull`) or start Docker containers** without confirming with the person first.
- **Never submit fabricated personal profile data to `/setup`** on the person's behalf; personal onboarding belongs strictly to the person.

## Tell the Person After

Share a concise status report:
1. **Active launch mode & privacy gate**: State whether Mode 1 (`MOCK_LLM=1`), Mode 2 (Local Ollama), or Mode 3 (OpenRouter ZDR) is running, and confirm the current `ALLOW_CLOUD_ESCALATION` setting.
2. **Verification status**: Report `npm run doctor`, `npm run lint`, and the exact `MOCK_LLM=1 npm test` pass count.
3. **Personal onboarding link**: Tell the person to open `http://localhost:3004/setup` themselves to complete their personal onboarding (or `http://localhost:3004` to use Companion right away).
