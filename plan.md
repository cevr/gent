# Curated Config + Consolidation Plan (Model-Immutable)

## Goal

- Curated experience: models fixed per agent; no user-facing model config; smallest possible config surface. Refs: `ARCHITECTURE.md`, `packages/core/src/agent.ts`
- Prefer consolidation over fragmentation unless a clear domain boundary exists. Refs: `packages/runtime/src/agent/agent-loop.ts`, `packages/runtime/src/agent/tool-runner.ts`

## Findings (with refs)

- Model override expectations linger in tests (even though payload has no model). Refs: `tests/api.test.ts`, `packages/server/src/rpcs.ts`
- ProviderFactory accepts provider-less model IDs (defensive fallback). Refs: `packages/providers/src/provider-factory.ts`
- Core config types add unused surface. Refs: `packages/core/src/index.ts`
- CLI exposes agent + bypass flags (user-config surface). Refs: `apps/tui/src/main.tsx`
- Models.dev registry override is env-configurable. Refs: `packages/runtime/src/model-registry.ts`, `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/provider/models.ts`
- Consolidation candidates: tiny runtime helpers and HTTP API shim. Refs: `packages/runtime/src/agent/agent-loop.ts`, `packages/runtime/src/agent/tool-runner.ts`, `packages/server/src/http-api.ts`
- External contrast: pi-mono supports extensive model config via models.json (anti-goal for curated). Refs: `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/model-registry.ts`

## Decisions Needed (blocking)

- [x] Remove CLI `--agent` flag (keep `/agent`). Refs: `apps/tui/src/main.tsx`
- [x] Keep CLI `--bypass` flag. Refs: `apps/tui/src/main.tsx`
- [x] Hardcode models.dev (remove env override). Refs: `packages/runtime/src/model-registry.ts`
- [x] Remove core `GentConfig` entirely. Refs: `packages/core/src/index.ts`
- [x] Require strict `provider/model` IDs (no fallback). Refs: `packages/providers/src/provider-factory.ts`

## Plan (progressive disclosure)

### Phase 1 — Lock model immutability

- [x] Remove stale model tests + any remaining optional model fields. Refs: `tests/api.test.ts`, `packages/server/src/rpcs.ts`
- [x] Enforce strict model IDs in ProviderFactory (no provider-less fallback). Refs: `packages/providers/src/provider-factory.ts`
- [x] Confirm UI always shows resolved agent model (no “unknown” fallbacks). Refs: `apps/tui/src/client/context.tsx`, `apps/tui/src/components/status-bar.tsx`

### Phase 2 — Reduce config surface

- [x] Keep `--bypass`, remove `--agent` (internal env used by subagent runner only). Refs: `apps/tui/src/main.tsx`, `packages/runtime/src/agent/subagent-runner.ts`
- [x] Remove GentConfig types (runtime config service only). Refs: `packages/core/src/index.ts`, `packages/runtime/src/config-service.ts`
- [x] Hardcode models.dev URL (no env override). Refs: `packages/runtime/src/model-registry.ts`

### Phase 3 — Consolidation pass

- [x] Inline `system-prompt` helper into AgentLoop. Refs: `packages/runtime/src/agent/agent-loop.ts`
- [x] Keep ToolRunner as its own service (permission/tool boundary). Refs: `packages/runtime/src/agent/tool-runner.ts`
- [x] Keep HTTP API shim (still used by REST). Refs: `packages/server/src/http-api.ts`

### Phase 4 — Docs + tests + gate

- [x] Docs already state “no model config”; no edits needed. Refs: `ARCHITECTURE.md`, `docs/actor-model.md`, `docs/mode-catalog.md`
- [x] Update/trim tests for removed config/model pathways. Refs: `tests/api.test.ts`, `tests/runtime.test.ts`, `apps/tui/tests/*`
- [x] Run full gate: `bun run gate`. Refs: `package.json`
