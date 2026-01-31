# Auth Storage Plan — Curated Startup

## Phase 0 — Findings (current state)

- [ ] Key storage: macOS-only Keychain shell via `security`; list uses `dump-keychain` (slow/brittle). File fallback is plaintext. Refs: `packages/core/src/auth-storage.ts`
- [ ] Provider key resolution: env var → AuthStorage; no startup gating for required agents. Refs: `packages/providers/src/provider-factory.ts`, `apps/tui/src/routes/home.tsx`
- [ ] Auth UI exists but manual `/auth` flow only; no onboarding prompt. Refs: `apps/tui/src/routes/auth.tsx`, `apps/tui/src/routes/home.tsx`
- [ ] Provider list duplicated in SDK/server vs core SUPPORTED_PROVIDERS. Refs: `packages/sdk/src/direct-client.ts`, `packages/server/src/rpc-handlers.ts`, `packages/core/src/model.ts`
- [ ] Required-provider list for active agents not centralized (cowork/deepwork models live in core). Refs: `packages/core/src/agent.ts`, `packages/runtime/src/model-registry.ts`

## Phase 1 — Decisions (need answers)

- [ ] Storage backend policy (keychain-only vs hybrid vs encrypted file). Refs: `packages/core/src/auth-storage.ts`
- [ ] Startup check entrypoint (TUI only vs server/core). Refs: `apps/tui/src/app.tsx`, `packages/server/src/index.ts`, `packages/runtime/src/*`
- [ ] Prompt UX (single modal vs per-provider flow; allow skip?). Refs: `apps/tui/src/routes/auth.tsx`, `apps/tui/src/client/context.tsx`
- [ ] Provider catalog source (core SUPPORTED_PROVIDERS vs registry). Refs: `packages/core/src/model.ts`, `packages/runtime/src/model-registry.ts`

## Phase 2 — Design

- [ ] Add `AuthStorage.LiveSystem` (OS-aware keychain + optional encrypted file fallback). Refs: `packages/core/src/auth-storage.ts`, `/Users/cvr/.cache/repo/Effect-TS/effect/packages/platform/src/KeyValueStore.ts`
- [ ] Add `AuthGuard` service to compute required providers from active agents/modes and assert keys present. Refs: `packages/core/src/agent.ts`, `packages/runtime/src/model-registry.ts`, `packages/providers/src/provider-factory.ts`
- [ ] Normalize provider list for UI (derive from core SUPPORTED_PROVIDERS). Refs: `packages/core/src/model.ts`, `packages/sdk/src/direct-client.ts`, `packages/server/src/rpc-handlers.ts`

## Phase 3 — Implementation

- [ ] Implement AuthGuard service + layer wiring. Refs: `packages/runtime/src/*`, `packages/server/src/index.ts`, `packages/sdk/src/direct-client.ts`
- [ ] TUI startup prompt flow: if missing keys, push `/auth` modal or inline prompt; store on submit. Refs: `apps/tui/src/app.tsx`, `apps/tui/src/routes/auth.tsx`, `apps/tui/src/client/context.tsx`
- [ ] Replace hardcoded provider lists in SDK/server with core list. Refs: `packages/sdk/src/direct-client.ts`, `packages/server/src/rpc-handlers.ts`, `packages/core/src/model.ts`
- [ ] Tighten key resolution to preferred storage ordering (per decision). Refs: `packages/providers/src/provider-factory.ts`, `packages/core/src/auth-storage.ts`

## Phase 4 — Tests

- [ ] AuthStorage LiveSystem: key set/get/list/delete (unit). Refs: `tests/auth.test.ts`
- [ ] AuthGuard: missing key triggers prompt path; present key passes. Refs: `tests/runtime.test.ts` or new test in `tests/core.test.ts`
- [ ] TUI onboarding: missing key routes to auth + stores key. Refs: `apps/tui/tests/e2e.test.ts`

## Phase 5 — Docs

- [ ] Update docs for key storage + onboarding flow. Refs: `docs/*`, `ARCHITECTURE.md`
