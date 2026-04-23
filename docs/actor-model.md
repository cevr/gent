# Actor Model Spec (Gent)

Actor model as the organizing metaphor. Not as an excuse for extra public surfaces.

## Stable Boundary

`SessionRuntime` is the public session actor boundary.

Public write surface:

- `dispatch(command: RuntimeCommand)`

Public read surface:

- `getState(...)`
- `watchState(...)`
- `getQueuedMessages(...)`
- `drainQueuedMessages(...)`
- `getMetrics(...)`

`AgentLoop` is internal. `ActorProcess` is dead. RPC, SDK, and direct callers all converge on `SessionRuntime`.

## Runtime Command Algebra

The runtime mailbox is explicit:

- `SendUserMessage`
- `RecordToolResult`
- `InvokeTool`
- `ApplySteer`
- `RespondInteraction`

Those commands are schema-tagged values with `_tag`, not ambient method bags or stringly-typed payloads.

## Ownership

`SessionRuntime` owns:

- session + branch command ingress
- queue serialization
- checkpoint / recovery
- interaction parking + resume
- runtime state snapshots
- watch-state fanout

`AgentLoop` owns:

- turn reduction
- model / external turn execution
- tool phase orchestration
- internal loop state transitions

`ToolRunner` owns tool execution. It is not a public actor boundary.

## Mailbox Semantics

- FIFO per `sessionId + branchId`
- one active turn per runtime target
- interrupt preempts the active turn
- interject queues a steering turn
- follow-ups batch structurally
- tool results route by `toolCallId`
- waiting-for-interaction is cold state, not a blocked fiber

## Actor Shape

The runtime is still actor-like:

- isolated state per session/branch
- explicit message algebra
- serialized processing
- crash-safe recovery via checkpoint + storage
- diagnostic event receipts

What changed is the boundary honesty. We do not expose every internal actor-ish mechanism as a first-class API.

## Tool Lifecycle

1. `SessionRuntime` accepts a turn command
2. `AgentLoop` resolves prompt, driver, tools, and queue state
3. driver emits turn events
4. tool calls run through `ToolRunner`
5. results feed back into loop state
6. runtime publishes receipts and persists durable state

Model turns and external-driver turns share the same runtime ownership. There is no second public loop.

## Supervision

Core rule: let it crash inside the owned boundary, then recover at the boundary that owns durability.

- provider stream failure -> loop emits error receipt and runtime surfaces failure
- tool timeout / failure -> tool receipt emitted, loop applies policy
- restart / crash -> checkpoint + storage restore loop/runtime state
- extension actor failure -> isolated to the owning extension runtime/resource

## Persistence

Persistence is structural, not optional folklore:

- storage holds durable session / message / event / interaction facts
- checkpoint holds resumable loop/runtime state
- interaction resume replays from storage, not in-memory continuations

## Non-Goals

- exposing internal loop actors as public APIs
- rebuilding a second mutable runtime bridge
- cluster/distribution design in this document

See `docs/migrations/runtime-union-provider.md` for the migration from the old `ActorProcess` boundary.
