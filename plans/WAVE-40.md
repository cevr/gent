# Wave 40 plan

## Frame

- **Source**: closes 1 P0 + 41 P1 from
  `plans/WAVE-39-audit-receipt.md`.
- **HEAD start**: `98fd176c` (W39 S7-C26 complete).
- **Rule**: sub-commit per spine or cohesive cluster; gate between
  batches; counsel after each commit. Do not tail-extend W39.
- **P0 first**: L8-P0-1 (AgentRunner full-context snapshot and
  re-injection) lands before any P1 work.
- **P2 bucket**: 26 P2s roll in only as opportunistic ride-alongs
  when touching the same files.

## Spines

### S1 - Runner context boundary (L8 P0 + L7 overlap)

Closes L8-P0-1. Highest priority.

- **C1 (P0)**: Replace the full-context snapshot/re-provide pattern in
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ts`
  for `InProcessRunner` and `SubprocessRunner`. Declare the runner seam
  requirements structurally instead of capturing `Effect.context<...>()`
  and reattaching it on every run. Pair-check
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ephemeral.ts`
  and `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/ephemeral-root.ts`
  so parent service snapshots are not threaded as positional bags.

### S2 - Schema, storage, and actor decode safety (L2 + L3)

Closes L2-P1-1, L2-P1-2, L3-P1-1, L3-P1-2, L3-P1-3,
L3-P1-4, L3-P1-5.

- **C2**: Convert `sessionFromRow` and `branchFromRow` in
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite/rows.ts`
  from sync decoders to Effect-channel decoders. Propagate typed
  storage errors through session, branch, and relationship storage.
- **C3**: Make durable `message.metadata` decode loud and typed.
  Replace `decodeUnknownOption` silent drops in
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite/rows.ts`.
  Ride-along: message metadata encode should use an Effect encoder.
- **C4**: Convert ACP wire response decoders in
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/protocol.ts`
  from sync throws inside `Effect.map` to typed protocol errors.
- **C5**: Brand `InvokeTool.toolName` in
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts`.
- **C6**: Replace `Interrupt`'s `Schema.decodeSync(SteerCommand)` with
  the tagged constructor or Effect-channel decoding.
- **C7**: Validate `parseEntityId` segments in
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.entity-id.ts`
  through their Schemas instead of `.make(...)`.

### S3 - Wide-event and actor read/write boundaries (L2)

Closes L2-P1-3, L2-P1-4.

- **C8**: Wrap `extension.request` in
  `withWideEvent(rpcBoundary(...))` at
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts`.
- **C9**: Stop `getSessionSnapshot` from reporting actor `GetState`
  failures as clean `Idle` snapshots in
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-queries.ts`.
  Split expected cold-actor fallback from real actor failure and annotate
  the wide-event path.

### S4 - Public API ceremony deletion (L4)

Closes L4-P1-1 through L4-P1-7.

- **C10**: Remove or internalize unused public extension API exports:
  `SignalError`, `GentPlatform*`, `MessageMetadata`,
  `sectionStartMarker`, `sectionEndMarker`, and `ExtensionTurnContext`
  from `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`.
  Update internal imports to core-internal/domain sources.
- **C11**: Trim dead SDK public type exports:
  `CreateSessionResult`, `GentClientOptions`, `StateSpec`,
  `ProviderSpec`, and unstable `Prompt` part aliases from
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/index.ts` and
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts`.
- **C12**: Delete the dead namespaced-client re-export chain in
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/namespaced-client.ts`.

### S5 - Test taxonomy and runtime boundary (L5)

Closes L5-P1-1 through L5-P1-5.

- **C13**: Move remaining actor-internal runtime tests under
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop/`:
  `agent-loop-queue.test.ts`, `agent-loop-streaming.test.ts`, and
  `agent-loop-interactions.test.ts`.
- **C14**: Rename service/class-shaped runtime describe blocks in
  agent governance, tool runner, tracer, model registry, todo service,
  config service, and session profile tests to behavioral groupings.
- **C15**: Rename function/factory-shaped domain describe blocks in
  prompt, event, message, run-spec, agent-pair, and driver-routing
  tests to behavioral groupings.
- **C16**: Replace the live `Effect.sleep` idempotency-cache eviction
  proxy in
  `/Users/cvr/Developer/personal/gent/packages/core/tests/server/session-idempotency.test.ts`
  with deterministic control flow (`TestClock`, Deferred, or a direct
  eviction hook).

### S6 - File cohesion splits (L6)

Closes L6-P1-1 through L6-P1-3. High blast radius: counsel before
each split and sub-commit per file.

- **C17**: Split
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts`
  into actor operation schemas, entity descriptor/layers, handler
  factory, and local queue/state helpers.
- **C18**: Split
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/message-part-projection.ts`
  into display/search projection, stream-part normalization, image data
  conversion, and message/Prompt/Response conversion modules.
- **C19**: Split
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/oauth.ts`
  into credentials file IO, keychain primitives, OAuth refresh, account
  listing/writeback, and Anthropic header/body parsing.

### S7 - Remaining ctx-as-param seams (L7)

Closes L7-P1-1 through L7-P1-8. High blast radius: sub-commit by
service seam.

- **C20**: Replace `BehaviorDeps` service threading in
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts`
  with honest R-channel requirements or focused Tags in queue, turn
  execution, and worker modules.
- **C21**: Stop threading `MakeExtensionHostContextDeps` through
  session environment helpers in
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime-context.ts`.
- **C22**: Drop `ctx` from `ToolRunner.run`; use
  `CurrentExtensionHostContext` and a local tool-call-id enrichment
  boundary.
- **C23**: Drop positional `ExtensionHostContext` from extension
  reaction calls; use reaction-scoped host context Tags.
- **C24**: Remove parent-service snapshot threading through ephemeral
  runner/root seams after S1 establishes the replacement pattern.
- **C25**: Remove `ChildProcessSpawner` yield/re-inject call sites in
  agent-runner, host-platform, Anthropic credential service, and
  executor controller.
- **C26**: Replace `AgentLoopWorker` callback parameters
  (`publishEvent`, `runTurn`) with yielded services/Tags.
- **C27**: Centralize turn-scoped registry/permission/host overrides
  behind a declared turn-profile Tag instead of reconstructing global
  Tag overrides at each call site.

### S8 - Yield-don't-thread cleanup (L8)

Closes L8-P1-1 through L8-P1-5.

- **C28**: Remove SQL/platform re-injection from
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/message-storage.ts`.
- **C29**: Remove platform-layer rebuild detour from
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-profile.ts`.
- **C30**: Remove `ChildProcessSpawner` capture/re-injection from
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/host-platform.ts`.
- **C31**: Remove platform Tag capture/re-injection from
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/credential-service.ts`.
- **C32**: Remove platform Tag capture/re-injection from
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/keychain-client.ts`.

### S9 - Composable-method demotions (L9)

Closes L9-P1-1 through L9-P1-4.

- **C33**: Delete registry-side dead helpers `findAgent`,
  `findModelCapability`, and duplicate `requireAgent`; update or delete
  test-only coverage.
- **C34**: Demote `listAgents`, `listModelCapabilities`, and
  `listExtensionStatuses` to `getResolved()` field reads.
- **C35**: Inline `resolveToolPolicy` at the single call site and keep
  `compileToolPolicy` pure.
- **C36**: Collapse `ApprovalService.Live` / `LiveWithStorage` identity
  reshapes around `makeApprovalInteractionService`.

## Closing audit (final batch)

After S9 lands and gate is clean at W40 HEAD, run the same 9-lane
audit pattern used to close W37, W38, and W39. Identical scope per
lane; do not vary prompts across waves.

- **L1 - Effect simplification**: `Effect.fn` trace-name gaps,
  `Effect.gen` arrows that could be `Effect.succeed`,
  dead/redundant Effect wraps.
- **L2 - Actor + wide-event boundaries**:
  `withWideEvent(rpcBoundary(...))` coverage on new/changed RPC
  handlers, actor handler trace wraps, race conditions,
  `Effect.forkScoped` vs `Effect.fork` mistakes, entityIdOf
  argument mismatches.
- **L3 - Schema / storage integrity**: row Schemas, decode safety
  (no `Schema.decodeSync` throws), brand erasure at boundaries,
  TaggedUnion vs hand-rolled `_tag` literals, `Effect.option` silent
  drops on durable storage.
- **L4 - Public API ceremony**: dead exports from
  `@gent/core/extensions/api` + `@gent/sdk`, parallel API names,
  double-exports, internal transports leaked through public surface.
- **L5 - Test taxonomy**: behavioral describe naming (not method
  names), Runtime Boundary respect (`packages/core/CLAUDE.md` rules),
  RPC acceptance coverage for new extension surface, `Effect.sleep`
  proxies for state transitions.
- **L6 - File cohesion**: files >700 lines mixing concerns, empty
  residue directories, generic utilities living in feature-specific
  files.
- **L7 - Ctx-as-param leaks**: service Tags / facades threaded as
  function parameters, callbacks for what should be service methods,
  registry Tags scoped wrong.
- **L8 - Yield-don't-thread**: closure-captured Tags then re-injected
  via `provideService`, services threaded through scope-crossing
  closures, helper call sites re-threading what the caller already
  yielded.
- **L9 - Composable-method demotions**: service interface methods that
  thin-wrap other public methods or actor commands, helpers with zero
  non-test callers, pure functions masquerading as service methods.

Each lane: independent Opus `general-purpose` Agent against fresh
HEAD; no cross-pollination; cap at 6-8 findings; severity-prefixed
(P0/P1/P2); file:line citations for every claim.

When all 9 return, write `plans/WAVE-40-audit-receipt.md` using the
same template: Frame -> Tally table -> W40 closure verification ->
P0 findings -> P1 findings by lane -> P2 ride-along bucket -> Wave 41
disposition.

## Disposition rule

P0/P1 findings from the W40 closing audit will open Wave 41. Do not
tail-extend W40. P2s roll into W41 ride-along bucket.
