# Actor Model Spec (Gent)

Actor model as the organizing metaphor. Not as an excuse for extra public surfaces.

## Stable Boundary

`SessionRuntime` is the public session actor boundary.

Public write surface:

- `sendUserMessage(...)`
- `recordToolResult(...)`
- `steer(...)`
- `respondInteraction(...)`

Public read surface:

- `getState(...)`
- `watchState(...)`
- `getQueuedMessages(...)`
- `drainQueuedMessages(...)`
- `getMetrics(...)`

`AgentLoop` is internal. RPC, SDK, and direct callers all converge on `SessionRuntime`.

## Runtime Protocol

The public runtime protocol is explicit:

- user-message submission
- external tool-result recording
- steering
- interaction response

Each operation owns its typed payload. There is no generic public dispatch bridge.

## Ownership

`SessionRuntime` owns:

- session + branch command ingress
- validation of existing `(sessionId, branchId)` targets before writes and reads
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
- commands target an existing session branch, not a raw session id plus assumed branch ownership
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

Extensions do not get a parallel local actor substrate. Extension state lives in
declared resources/services and crosses the runtime through explicit slots:
capabilities, RPC requests, hooks, drivers, and scheduled resources.

## Persistence

Persistence is structural, not optional folklore:

- storage holds durable session / message / event / interaction facts
- SQLite storage is split into a small public assembler plus schema and focused implementation modules
- checkpoint holds resumable loop/runtime state
- interaction resume replays from storage, not in-memory continuations

## Non-Goals

- exposing internal loop actors as public APIs
- rebuilding a second mutable runtime bridge
- local extension actors, receptionist discovery, or mailbox persistence
- cluster/distribution design in this document
