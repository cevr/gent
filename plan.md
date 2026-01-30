# Codebase Audit Plan — Curated + Actor Model

## Phase 1 — Inputs

- [x] Scan Effect cluster patterns (scoped forks, entity lifecycles). Refs: `/Users/cvr/.cache/repo/Effect-TS/effect/packages/cluster/src/Entity.ts`, `/Users/cvr/.cache/repo/Effect-TS/effect/packages/cluster/src/RunnerServer.ts`, `/Users/cvr/.cache/repo/Effect-TS/effect/packages/cluster/src/internal/entityReaper.ts`
- [x] Scan gent runtime + server concurrency, session scope, perf. Refs: `packages/runtime/src/agent/agent-loop.ts`, `packages/runtime/src/actor-process.ts`, `packages/runtime/src/model-registry.ts`, `packages/server/src/core.ts`, `packages/storage/src/sqlite-storage.ts`

## Phase 2 — Findings

- [x] Global single-flight in AgentLoop blocks concurrent sessions; not actor-model. Refs: `packages/runtime/src/agent/agent-loop.ts`
- [x] Steer/interrupt is global (no session/branch targeting). Multi-session can be interrupted/steered by the wrong caller. Refs: `packages/runtime/src/agent/agent-loop.ts`, `packages/runtime/src/actor-process.ts`
- [x] N+1 branch lookups in session listing: listSessions queries branches per session; scales poorly. Refs: `packages/server/src/core.ts`, `packages/storage/src/sqlite-storage.ts`
- [x] Background fibers launched with `forkDaemon` inside scoped layers; not tied to layer scope. Effect cluster uses `forkScoped` for lifecycle safety. Refs: `packages/runtime/src/model-registry.ts`, `packages/server/src/core.ts`, `packages/runtime/src/actor-process.ts`, `/Users/cvr/.cache/repo/Effect-TS/effect/packages/cluster/src/Entity.ts`

## Phase 3 — Execute (per choices)

- [x] Per-session+branch AgentLoop actor queues (concurrent sessions). Refs: `packages/runtime/src/agent/agent-loop.ts`
- [x] Steer/interrupt scoped to session+branch (RPC + SDK + UI). Refs: `packages/runtime/src/agent/agent-loop.ts`, `packages/runtime/src/actor-process.ts`, `packages/server/src/rpcs.ts`, `packages/server/src/rpc-handlers.ts`, `packages/sdk/src/client.ts`, `packages/sdk/src/direct-client.ts`, `apps/tui/src/client/context.tsx`, `apps/tui/src/main.tsx`
- [x] Batch branch lookup for listSessions (single query). Refs: `packages/storage/src/sqlite-storage.ts`, `packages/server/src/core.ts`
- [x] Replace `forkDaemon` with `forkScoped` where scope available. Refs: `packages/runtime/src/model-registry.ts`

## Phase 4 — Tests + Gate

- [x] Concurrency test: two sessions run concurrently (actor model). Refs: `tests/runtime.test.ts`
- [x] Steer scoping test: interrupt only affects targeted session/branch. Refs: `tests/runtime.test.ts`
- [x] listSessions batch test: first branch per session (no N+1). Refs: `tests/storage.test.ts` or `tests/core.test.ts`
- [x] Run full gate `bun run gate`. Refs: `package.json`
