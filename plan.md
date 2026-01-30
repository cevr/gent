# Agent Loop Session Scoping Plan

## Findings (all contributing paths)

- Follow-up queue drains using the prior run’s `sessionId/branchId/bypass`, not the queued message context. Refs: `packages/runtime/src/agent/agent-loop.ts`
- `currentAgent` is global, so agent choice drifts across sessions and restarts; server snapshot shows per-branch agent via events. Refs: `packages/runtime/src/agent/agent-loop.ts`, `packages/server/src/core.ts`

## Plan

### Phase 1 — Fix scoping

- [x] Store follow-up queue entries with message + bypass; drain using each entry’s message context. Refs: `packages/runtime/src/agent/agent-loop.ts`
- [x] Track current agent per session/branch and hydrate from latest `AgentSwitched` on first use. Refs: `packages/runtime/src/agent/agent-loop.ts`

### Phase 2 — Verify

- [x] Update tests if needed. Refs: `tests/runtime.test.ts`
- [x] Run full gate: `bun run gate`. Refs: `package.json`
