# Contributing to Krusch Companion

Thank you for contributing to **Krusch Companion**! This guide covers standalone local setup, verification commands, and architectural conventions.

---

## 🚀 Standalone Quick Start for Contributors

Krusch Companion has **zero private monorepo dependencies**—all packages install directly from public npm.

```bash
git clone https://github.com/krusch-homelab/krusch-companion.git
cd krusch-companion
npm install
npm run build
```

### Verify Your Environment
Run the built-in Setup Doctor to inspect Node.js (`>=22.0.0`), SQLite WAL integrity, frontend bundle status, and LLM provider readiness:
```bash
npm run doctor
```

---

## 🧪 Running Tests & Reproducible Benchmarks

Before opening a pull request, ensure both the automated test suite and the benchmark suite pass:

```bash
# 1. Run all unit, integration, and security hardening tests (no live GPU required):
MOCK_LLM=1 npm test

# 2. Run reproducible latency, Knowledge Boundary, and Temporal Superseding benchmarks:
npm run bench
```

---

## 🛡️ Core Engineering Invariants

1. **Zero Cloud Lock-In**: Every feature must work with local SQLite (`node:sqlite`) and either local Ollama (`qwen2.5-coder:7b`) or zero-GPU OpenRouter ZDR mode (`LLM_PROVIDER=openrouter`).
2. **No `eval()` or `new Function()`**: All deterministic L0 heuristics (`src/router/cascade-client.js`) must use safe AST/shunting-yard evaluation.
3. **SSRF & Path-Traversal Guards**:
   - External URL tools (`fetch_url_digest`) must validate URLs through `isSafeExternalUrl()` to block loopback, RFC1918 private IPs, and cloud metadata endpoints (`169.254.169.254`).
   - Local note vault operations (`save_local_note`, `read_local_note`) must sanitize filenames and enforce `path.resolve()` prefix containment inside `data/notes/`.
4. **Side-Effect Tool Safety**: Any new tool in `src/agent/tools.js` that mutates external state (email, calendar, reservations, webhooks) must register in `isExternalSideEffectCall()` so the `dryRunMode` confirmation gate is respected.
5. **Dual-Axis Priority Integrity**: Tasks must always carry both an `execution_priority` (`1..4` — *When it must happen today*) and a `pillar` (*Why it matters*), plus a human-readable `lane_reason`.
