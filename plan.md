# Flattened Agent Loop Rewrite

## Summary

Rewrite `packages/core/src/runtime/agent/agent-loop.ts` as one flat machine per
`sessionId + branchId`.

No outer machine plus inner handwritten loop.
No nested `TurnMachine` unless the flat version gets worse in code.
No string-array queue API.

Keep streams and tool execution as state-scoped tasks.
Keep chunk accumulation task-local.
Keep `Stream.interruptWhen(...)`.
Do not use `Effect.whileLoop` as the main orchestrator.

## Locked Decisions

- Flat machine, not nested machine
- Structured queue entries now, not later
- Queue lanes stay split: `steering` + `followUp`
- Preserve current user-facing semantics:
  - queued follow-ups batch with `\n`
  - steering drains before follow-up
  - interjection agent override is one-turn scoped
  - provider failure still flushes queued work
  - interruption persists partial assistant output
- Cluster/entity integration is out of scope

## Target Shape

### Machine states

- `Idle`
- `Resolving`
- `Streaming`
- `ExecutingTools`
- `Finalizing`

### Machine-owned business state

- `queue: { steering: QueueEntry[]; followUp: QueueEntry[] }`
- `currentAgent?: AgentName`
- `handoffSuppress: number`
- `turn: ...` payload for non-idle states

### Runtime-only infra outside machine state

- provider abort / interrupt handle for the active stream
- serial tool semaphore
- storage/provider/event-store/tool-runner services

## Public API Changes

Introduce structured queue entries across:

- `AgentLoopService`
- `ActorProcess`
- `GentCore`
- RPC schemas
- SDK client
- TUI client/session route/widget

Queue entry shape:

- `id: MessageId`
- `kind: "steering" | "follow-up"`
- `content: string`
- `createdAt: Date`
- `agentOverride?: AgentName`
- `bypass: boolean`

Queue API shape:

- `{ steering: QueueEntry[]; followUp: QueueEntry[] }`

## Execution Batches

### Batch 0 — Planning checkpoint

- update `PLAN.md`
- lock execution checklist

### Batch 1 — Core queue types and public surfaces

- add structured queue entry schema/type
- update `AgentLoopService` / `ActorProcess` / `GentCore`
- update RPC and SDK queue types
- update tests that only depend on queue shape

### Batch 2 — Flat machine rewrite

- replace current mixed machine + imperative loop with one flat machine
- remove queue ownership refs / recursive drain helpers
- preserve interruption, failure flush, tool execution, and handoff semantics
- keep `run(...)` blocking semantics when starting from idle

### Batch 3 — TUI queue migration

- move session/client queue state to structured entries
- update queue widget rendering and restore-to-composer path
- keep backend as source of truth

### Batch 4 — Verification and cleanup

- runtime regressions
- full gate
- final cleanup of dead helpers / types

## Regression Checklist

- queued regular messages batch into one persisted follow-up
- steering executes before queued follow-up
- queue reads do not drain
- queue drain returns structured entries
- queued work flushes after provider failure
- interruption persists partial assistant output
- serial tool calls do not overlap
- auto-handoff suppression still works
- TUI queue widget renders structured entries and restore still joins with `\n`
