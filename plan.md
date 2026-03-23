# Agent Loop Machine Shape Refinement

## Summary

Replace the completed rewrite plan with a follow-on pass focused on pushing
`packages/core/src/runtime/agent/agent-loop.ts` from "flat but still branchy"
to "phase-explicit and mostly pure."

Keep current queue semantics and public APIs. Internal architecture pass only.

## Locked Decisions

- Flat machine stays flat. No nested `TurnMachine`.
- No cluster/entity integration in this pass.
- No queue API changes. Keep `{ steering, followUp }`.
- No user-visible semantic changes:
  - follow-ups still batch with `\n`
  - steering still drains before follow-up
  - interjection agent override stays one-turn scoped
  - provider failure still flushes queued work
  - interruption still persists partial assistant output
- Use `effect-machine` harder where it helps:
  - `State.derive(...)`
  - `.onAny(...)`
  - state-scoped `.task(...)`
- Do not use `Effect.whileLoop` as orchestration.

## Target Shape

### Machine states

- `Idle`
- `Resolving`
- `Streaming`
- `ExecutingTools`
- `Finalizing`

### State payloads

- `TurnEnvelope`
  - `message`
  - `bypass`
  - `startedAtMs`
  - `agentOverride`
  - `turnInterrupted`
  - `interruptAfterTools`
- `ResolvedTurn`
  - `currentTurnAgent`
  - `messages`
  - `tools`
  - `systemPrompt`
  - `modelId`
  - `reasoning`
- `AssistantDraft`
  - `text`
  - `reasoning`
  - `toolCalls`
  - `usage?`

### Phase ownership

- `Resolving`
  - persist incoming user/interjection message
  - resolve agent/tools/prompt/model/reasoning
  - emit `Resolved`
- `Streaming`
  - run provider stream only
  - publish stream events
  - collect `AssistantDraft`
  - persist assistant output on success
  - persist partial assistant output on interrupt/failure
- `ExecutingTools`
  - execute tool calls from `AssistantDraft`
  - persist tool result message
- `Finalizing`
  - update turn duration
  - publish `TurnCompleted`
  - run handoff suppression logic
  - dequeue next turn or return idle

## Implementation Batches

### Batch 0 — Plan checkpoint

- replace `PLAN.md` with this follow-on plan

### Batch 1 — Introduce real resolve phase

- add `Resolving` state
- add `Resolved` event
- add `TurnEnvelope`, `ResolvedTurn`, `AssistantDraft`
- remove dead `PhaseFailed.error` payload
- keep behavior unchanged

Commit after gate.

### Batch 2 — Split phase tasks from machine shell

- extract phase tasks into `agent-loop-phases.ts`
- keep `agent-loop.ts` as machine/service wiring shell
- split into:
  - resolving task
  - streaming task
  - tools task
  - finalizing task
- add one shared wrapper for logs/span/error publication

Commit after gate.

### Batch 3 — Collapse transition boilerplate

- move state-independent events to `.onAny(...)`:
  - `QueueFollowUp`
  - `ClearQueue`
  - `SwitchAgent`
- keep phase-specific handlers explicit:
  - `QueueSteering`
  - `Interrupt`
  - phase completion/failure events
- replace repeated object spreads with `State.derive(...)` or small pure helpers

Commit after gate.

### Batch 4 — Cleanup and verification

- remove dead helpers/types left behind by the split
- confirm complexity remains under current lint threshold
- run full gate

Commit after gate.

## Regression Checklist

- idle start enters resolve phase first
- text-only turns skip tool execution
- tool-call turns persist assistant message before tool result message
- interrupt during streaming persists partial assistant output
- steering during streaming interrupts immediately
- steering during tool execution waits for tools, then finalizes as interrupted
- provider failure still flushes queued work
- queue read/drain semantics stay unchanged
- follow-up batching stays unchanged
- handoff suppression stays unchanged
