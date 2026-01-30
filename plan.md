# Consolidation Plan — Core/Server/Tools

## Goal

Consolidate fragmented files with no strong domain boundary.

## Plan

### Phase 0 — Prep

- [x] Confirm consolidation scope (core agent, server ops+rpcs, tools ask-user+question)
- [x] Map imports to update

### Phase 1 — Core agent flattening

- [x] Create `packages/core/src/agent.ts` (definition + prompts + registry + subagent runner)
- [x] Remove `packages/core/src/agent/*` directory
- [x] Update core exports + internal imports

### Phase 2 — Server ops+rpcs merge

- [x] Merge `packages/server/src/operations.ts` into `packages/server/src/rpcs.ts`
- [x] Update imports to use `rpcs.ts`
- [x] Remove `packages/server/src/operations.ts`

### Phase 3 — Tools ask-user+question merge

- [x] Move Question handler/tool into `packages/tools/src/ask-user.ts`
- [x] Update exports/imports
- [x] Remove `packages/tools/src/question.ts`

### Phase 4 — Verify

- [x] `bun run typecheck`
- [x] `bun run lint`
- [x] `bun run test`
