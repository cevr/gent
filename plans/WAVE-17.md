# Planify: Wave 17 - Platform-Native Actor And AI Collapse

## Thesis

Wave 17 is the breaking-change wave. Gent has no users and no compatibility
contract, so the correct move is to delete transitional shapes instead of
preserving them. Local databases, caches, and schema histories may be rewritten
or reset when old state keeps bad architecture alive.

The north stars are unchanged:

1. **Effect is the platform.** Use Effect RPC, Effect AI, Effect Schema, Effect
   SQL, Context, Layer, and cluster Entity where they already own a concept.
2. **Actors are the runtime shape.** Durable coordination is a typed actor or
   entity protocol. Plain resources are for services. DTO bridges, marker
   services, local mailboxes, discovery registries, and duplicate command
   unions do not survive unless they own Gent product semantics.

Wave 17 exists because the Wave 16 closeout and the fresh audits against
`effect-ts/effect-smol`, `badlogic/pi-mono`, and `anomalyco/opencode` converged
on the same answer: Gent should keep the product model, but stop carrying
parallel Effect AI types, parallel actor substrate, parallel transport DTOs, and
parallel in-process extension RPC.

## Non-Negotiable Execution Rules

- No deprecation layers, compatibility aliases, compatibility migrations, or
  old-shape shims.
- If a schema rewrite is cleaner, rewrite the SQLite schema and reset local DBs.
- If a public SDK or RPC surface is wrong, break it and migrate the repo.
- Every commit runs `bun run gate`.
- Runtime, provider, transport, storage, or extension-host commits also run
  focused tests first; significant boundary commits run `bun run test:e2e`.
- High-blast-radius work splits into sub-commits by owner. Each sub-commit must
  compile and pass gate.
- One independent review round per implementation commit. If counsel or review
  finds a structural correction, apply it in the next commit instead of
  preserving the old path.
- Mechanical rewrites should be delegated after one manual before/after proves
  the pattern.

## Carry-Forward From Wave 16

Wave 16 intentionally remains open because the actor substrate was not actually
minimal. Wave 17 absorbs those blockers as first-class work:

- Session loop ownership still lives in `AgentLoop` with maps, semaphores, and
  branch/session keys instead of a typed actor/entity protocol.
- `ExtensionTurnControl` is a manual mailbox beside the session engine.
- Stateful reactions still read actor views and discovery registries during
  projection.
- `ExtensionRuntime` is an empty marker service threaded through runtime
  contexts.

## External Audit Synthesis

### Effect Smol

Effect already owns the primitives Gent is recreating:

- `Tool` owns tool identity, schemas, annotations, approval, and dependencies at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Tool.ts:175`
  and constructors at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Tool.ts:1150`.
- `Toolkit` owns handler decoding/execution and typed result encoding at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Toolkit.ts:218`
  and
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Toolkit.ts:323`.
- `LanguageModel.GenerateTextOptions` already owns prompt, toolkit,
  toolChoice, concurrency, and disabled tool resolution at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/LanguageModel.ts:251`
  and
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/LanguageModel.ts:288`.
- `Chat` owns stateful history and toolkit-aware generate/stream entry points at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Chat.ts:93`
  and
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Chat.ts:202`.
- `Rpc` and `RpcGroup` own request schemas, handler layers, handler access, and
  grouped protocol composition at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/rpc/Rpc.ts:51`
  and
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/rpc/RpcGroup.ts:25`.
- `Entity` owns actor protocols, typed clients, layers, mailbox capacity,
  concurrency, idle behavior, and sharding integration at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/cluster/Entity.ts:50`
  and
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/cluster/Entity.ts:115`.
- `SqlClient` owns transaction scoping and transaction service derivation at
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/sql/SqlClient.ts:77`
  and
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/sql/SqlClient.ts:113`.

Conclusion: keep Effect RPC as the app transport. Do not invent HttpApi for the
main app surface. Collapse local AI/provider/actor/storage bridges toward the
Effect primitives above.

### Pi Mono

Pi should not be copied at the upper session layer; its `AgentSession` is broad.
The useful pattern is lower down: expose the loop, tools, state, and events as
direct primitives, then compose app behavior around them.

- Pi exports low-level loop primitives directly at
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/index.ts:1`.
- Its loop accepts prompt/config/context/event sink/stream function directly at
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent-loop.ts:31`
  and
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent-loop.ts:95`.
- Its stateful shell delegates turn execution to the loop at
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent.ts:374`
  and reduces events in one place at
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent.ts:488`.
- Its tool primitive carries direct execution semantics at
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/types.ts:315`.
- Its upper `AgentSession` is intentionally broad at
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/agent-session.ts:1`
  and should not become Gent's model.

Conclusion: make Gent's runtime primitive direct and typed. Do not hide it
behind a second command union or empty service marker.

### OpenCode

OpenCode is useful where it keeps one source of truth for domain/session/tool
state:

- Session domain schemas are reused directly by routes at
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/session.ts:163`
  and
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/server/routes/instance/session.ts:56`.
- Tool state is one `ToolPart` lifecycle union at
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/message-v2.ts:287`
  and the processor updates that state through lifecycle events at
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/processor.ts:259`.
- LLM streaming is one event surface consumed by the session processor at
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/llm.ts:55`
  and
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/processor.ts:539`.
- Storage keeps a simple service and session-owned operations instead of a
  broad facade plus adapter slices at
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/storage/storage.ts:60`
  and
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/session.ts:450`.

Conclusion: collapse Gent's session DTOs, tool-result rejoin helpers, turn
driver unions, and storage facade slices.

## Local Findings

### P1 - Actor Substrate Is Reimplemented Platform

Gent defines `ActorRef`, `ServiceKey`, `ActorContext`, `Behavior`, persistence,
and restart policy at
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/actor.ts:7`,
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/actor.ts:34`,
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/actor.ts:71`,
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/actor.ts:182`,
and
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/actor.ts:221`.
`ActorEngine` then owns unbounded mailboxes, ask/reply, discovery, state
streams, snapshotting, persistence keys, cleanup, and supervision at
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-engine.ts:171`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-engine.ts:249`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-engine.ts:280`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-engine.ts:341`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-engine.ts:461`,
and
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-engine.ts:582`.
`ActorHost` adds periodic snapshot persistence at
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-host.ts:403`
and
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-host.ts:463`.

**Decision:** treat the local actor engine as migration scaffolding. The final
shape is Effect Entity/RPC for true actors, or plain resources where no actor
protocol is needed.

### P1 - Extension Turn Control Is A Second Mailbox

`ExtensionTurnControl` creates `TurnControlEnvelope` with ack, an unbounded
queue, owner stack, command stream, and await path at
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/turn-control.ts:47`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/turn-control.ts:77`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/turn-control.ts:81`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/turn-control.ts:87`,
and
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/turn-control.ts:125`.
The host context sends `ctx.session.queueFollowUp` through that mailbox at
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:399`.

**Decision:** delete the turn-control mailbox. Extension follow-up/interject
commands should call the session engine/entity protocol directly.

### P1 - Runtime Command Surface Is Duplicated

`SessionRuntime` defines public payloads and a tagged command union at
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:65`
and
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:147`,
then exposes dispatch plus parallel typed methods at
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:214`.
`AgentLoop` already has the actual submit/run/steer/drain/state/watch/restore
surface at
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts:394`.
Public `actor.*` RPCs expose that internal runtime shape at
`/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs/actor.ts:13`.

**Decision:** make the session actor/entity protocol the runtime source of
truth. Delete public `actor.*` RPCs and the duplicate command union once callers
use the product RPCs or the internal entity client.

### P1 - Extension In-Process RPC Is A DTO Bridge

The extension request surface creates a request token and private ref at
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:36`
and
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:125`.
The registry then decodes unknown input, runs an erased handler, re-encodes
unknown output, and dispatches through an in-process RPC registry at
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:197`
and
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:265`.
Host context invokes that registry at
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:312`.

**Decision:** reserve extension RPC for public/client transport. In-process
extension code should yield service tags or call Effect RPC/entity clients, not
go through an erased DTO registry.

### P2 - Provider Rewraps Effect AI

`ProviderRequest` repeats upstream generation options at
`/Users/cvr/Developer/personal/gent/packages/core/src/providers/provider.ts:158`.
`ProviderService` rewraps stream/generate at
`/Users/cvr/Developer/personal/gent/packages/core/src/providers/provider.ts:191`.
`Provider.Live` resolves the model and calls `LanguageModel.streamText` at
`/Users/cvr/Developer/personal/gent/packages/core/src/providers/provider.ts:570`.
Per-profile driver state is passed as request data at
`/Users/cvr/Developer/personal/gent/packages/core/src/providers/provider.ts:164`.

**Decision:** keep model/auth resolution as a service that returns upstream
model layers. Turn execution should call `LanguageModel.streamText` directly in
the runtime context.

### P2 - External Driver TurnEvent Duplicates Effect AI Response Parts

External drivers return `TurnEvent` and `TurnEventUsage` at
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/driver.ts:197`
and
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/driver.ts:210`.
Collectors immediately convert those events back into `Response.makePart(...)`
at
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response/collectors.ts:267`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response/collectors.ts:286`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response/collectors.ts:302`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response/collectors.ts:340`,
and
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response/collectors.ts:393`.

**Decision:** external drivers stream Effect AI `Response.AnyPart` directly.
Durable Gent events remain receipts derived from the canonical response stream.

### P2 - Transport DTOs Mirror Domain Types

Domain `Session`, `Branch`, and `SessionTreeNode` exist at
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/message.ts:129`,
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/message.ts:143`,
and
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/message.ts:153`.
Transport redefines `SessionInfo`, `SessionTreeNode`, and `BranchInfo` at
`/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:52`,
`/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:64`,
and
`/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:111`.
`session-utils` maps between them at
`/Users/cvr/Developer/personal/gent/packages/core/src/server/session-utils.ts:10`
and
`/Users/cvr/Developer/personal/gent/packages/core/src/server/session-utils.ts:23`.

**Decision:** return domain classes or domain-owned read models. Delete
transport copies and mappers.

### P2 - Tool Lifecycle Is Rejoined In Clients

Gent persists `ToolCallPart` and `ToolResultPart` separately at
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/message.ts:29`
and
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/message.ts:37`.
The SDK reassembles status through helpers at
`/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts:145`
and
`/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts:165`.

**Decision:** make tool interaction state a server/domain projection. Clients
render a canonical state; they do not rejoin tool calls and results.

### P2 - Storage Has A Facade Plus Adapter Slices

`StorageService` is a broad facade at
`/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts:25`.
Focused storage tags are derived from that same object at
`/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts:163`
and mixed with direct SQL-backed tags in
`/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts:256`.

**Decision:** migrate families to direct `SqlClient` layers or true
repositories. Shrink `Storage` to schema/transaction ownership or delete it.

### P3 - SDK Namespacing Is Manual Drift

`GentRpcClient` derives from `GentRpcs`, but `makeNamespacedClient` manually
rebuilds every dotted key at
`/Users/cvr/Developer/personal/gent/packages/sdk/src/namespaced-client.ts:59`.

**Decision:** expose flat RPC as the primary SDK or generate namespace access
from keys. No hand-maintained table.

### P3 - Dead Extension Storage And Authoring Wrappers

`ExtensionStorage` is a schema-less file KV store at
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-storage.ts:1`
and is only exported internally at
`/Users/cvr/Developer/personal/gent/packages/core/src/extensions/internal.ts:8`.
Convenience authoring wrappers mostly rename `defineExtension` at
`/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:609`
and
`/Users/cvr/Developer/personal/gent/packages/core/src/extensions/authoring.ts:12`.

**Decision:** delete dead file storage and converge authoring on one path after
the larger bridge removals.

## Commit Wave

### C1 - `refactor(runtime): delete extension runtime marker`

Delete `ExtensionRuntime` and remove it from session runtime, agent loop,
host-context deps, RPC handlers, profile composition, tests, and docs. Keep the
real services explicit: `ExtensionRegistry`, `DriverRegistry`, `ActorEngine`,
`Receptionist`, `ExtensionTurnControl` until later commits delete or replace
them.

Verification: focused runtime/profile tests, `bun run gate`.

### C2 - `refactor(sdk): remove manual namespace mirror`

Make the SDK either expose the flat Effect RPC client as primary or derive the
namespaced convenience value mechanically from dotted keys. Add a drift test
that every `GentRpcs` key is reachable by the selected SDK surface.

Verification: SDK tests, TUI client tests, `bun run gate`.

### C3 - `refactor(api): return domain session and branch contracts`

Delete `SessionInfo`, `BranchInfo`, flattened `SessionTreeNode`, `sessionToInfo`,
and `branchToInfo`. Return domain `Session`, `Branch`, and domain-owned recursive
session tree shapes from RPC. Update TUI route state and tests.

Breaking change: public SDK types change immediately.

Verification: transport/RPC tests, TUI session tree tests, `bun run gate`.

### C4 - `refactor(api): remove public actor rpc surface`

Remove public `actor.*` RPCs. Route remaining use cases through product RPCs:
`message.send`, `steer.command`, `queue.*`, `session.watchRuntime`, and snapshot
or a narrow session metrics query. Keep internal runtime/entity tests in core.

Verification: RPC tests, TUI agent lifecycle tests, `bun run gate`.

### C5 - `refactor(runtime): collapse turn control into session protocol`

Delete `ExtensionTurnControl.commands`, ack envelopes, owner stacks, and the
global stream consumer. `ctx.session.queueFollowUp` and interjection paths call
the session engine/entity protocol directly for the active target.

Verification: agent-loop queue tests, extension follow-up tests,
`bun run gate`, `bun run test:e2e`.

### C6 - `refactor(ai): stream effect response parts from external drivers`

Make external drivers stream Effect AI `Response.AnyPart` directly. Delete
`TurnEvent`, `TurnEventUsage`, and the conversion switch in
`collectExternalTurnResponse`. Derive Gent durable events from response parts.

Breaking change: external driver authoring API changes immediately.

Verification: provider/external driver tests, ACP/executor tests,
`bun run gate`, `bun run test:e2e`.

### C7 - `refactor(provider): make language model the runtime boundary`

Shrink provider to model/auth resolution. Replace `ProviderRequest`,
`GenerateRequest`, and `ProviderService.stream` with upstream
`LanguageModel.streamText` calls in runtime. Preserve deterministic test helpers
as `LanguageModel` or model resolver test layers, not a parallel provider API.

Verification: provider auth tests, provider sequence/signal tests, turn phase
tests, `bun run gate`, `bun run test:e2e`.

### C8 - `refactor(tools): unify tool execution with effect toolkit`

Move permission, decode, execution, result encoding, and event emission behind a
single tool execution adapter built from Effect `Tool.Any`/`Toolkit`. Delete the
advertise-only provider toolkit. Keep Gent metadata as annotations or a small
domain-owned descriptor attached to upstream tools.

Verification: tool runner tests, provider tool schema tests, extension tool
tests, `bun run gate`, `bun run test:e2e`.

### C9 - `refactor(runtime): make session runtime an actor/entity protocol`

Replace the session loop maps and duplicate command union with a typed
session-actor protocol. Prefer Effect Entity/RPC if local Bun cluster
requirements and persistence semantics fit. If not, first isolate a minimal
entity-compatible adapter and write the mismatch down in this file before
continuing.

No compatibility shell survives the commit. Callers migrate in the same batch.

Verification: session runtime tests, recovery/checkpoint tests, queue tests,
`bun run gate`, `bun run test:e2e`.

### C10 - `refactor(extensions): remove actor bucket or replace with effect entities`

Migrate builtin stateful extensions away from `ActorEngine` view/receptionist
discovery:

- `handoff` first as the smallest stateful actor.
- `auto` next, preserving its externally visible controller behavior.
- `executor` last, because it has the highest coordination surface.

Then delete `actors:` contribution bucket, `Behavior`, `ServiceKey`,
`Receptionist`, `ActorHost`, `ActorEngine`, and actor persistence storage if no
native Effect entity adapter remains.

Verification: each extension focused suite, extension integration tests,
`bun run gate`, `bun run test:e2e`.

### C11 - `refactor(extensions): reserve rpc for public transport`

Migrate same-extension and builtin cross-extension calls from
`ctx.extension.request(ref(...))` to service tags or entity/RPC clients. Keep
public `client.extension.request` only as a transport adapter for user-facing
extension RPC. Delete request/ref/rpcRegistry paths that are no longer public
transport.

Verification: task/artifact extension tests, request permission tests,
`bun run gate`.

### C12 - `refactor(storage): replace broad storage facade with repositories`

Rewrite storage by family using direct `SqlClient` layers or focused repository
services. Start with actor/session/message families because they block the actor
and API cleanup. Reset schema instead of migrating old local shapes. Delete the
broad facade after callers are on focused owners.

Verification: storage tests after each family, `bun run gate`, `bun run test:e2e`
after the facade deletion.

### C13 - `refactor(messages): expose canonical tool interaction state`

Stop forcing SDK/TUI clients to pair `ToolCallPart` and `ToolResultPart`.
Either persist a canonical tool interaction part or expose a server/domain read
model. Delete SDK rejoin helpers after clients consume the canonical state.

Verification: message projection tests, SDK helper deletion tests, TUI render
tests, `bun run gate`.

### C14 - `refactor(tui): unify session projection streams`

Collapse duplicate TUI session subscriptions so the route owns one session
projection from snapshot, event stream, and runtime watch. `ClientProvider`
keeps transport/lifecycle/model catalog only.

Verification: TUI session feed tests, session lifecycle tests, `bun run gate`.

### C15 - `refactor(extensions): delete dead extension storage and wrappers`

Delete file-backed `ExtensionStorage`, stale tests, and authoring wrappers that
only rename `defineExtension`. Keep one extension authoring path.

Verification: extension authoring tests, `bun run gate`.

### C16 - `docs(architecture): rewrite active docs around platform-native shape`

Update `ARCHITECTURE.md`, `docs/extensions.md`, AGENTS references if needed, and
active comments/tests so the vocabulary matches the new state: Effect RPC
transport, Effect AI runtime boundary, session entity/actor, resource services,
and no migration-shaped active names.

Verification: `bun run gate`.

### C17 - `test(audit): add platform-duplication guards`

Add narrow architecture checks that fail on the old patterns:

- Empty marker services in runtime.
- Public `actor.*` RPCs.
- Transport DTOs that mirror domain `Session`/`Branch`.
- New Gent-owned AI stream/event types duplicating Effect AI response parts.
- Extension code importing deleted actor substrate directly.

Verification: check tests, `bun run gate`.

### C18 - `docs(plan): close wave 17 with recursive audit`

Run fresh local audits plus one independent Codex review and one counsel review
against the final diff. Record accepted/rejected findings in this file with
receipts. The wave is not closed by green tests alone.

Verification: `bun run gate`, `bun run test:e2e`.

## First Mechanical Delegation Point

After C3 manually migrates one session/branch consumer, delegate the remaining
transport DTO call-site migration with this recipe:

- Replace `SessionInfo` imports with domain `Session`.
- Replace `BranchInfo` imports with domain `Branch`.
- Replace `node.id`/`node.name` on session trees with `node.session.id` and
  `node.session.name`.
- Delete mapper call sites; do not add adapter functions.
- Stop and report if a consumer needs fields not present on the domain class.
- Validate each batch with `bun run typecheck`; final batch runs `bun run gate`.

After C11 manually migrates one extension request to a direct service tag,
delegate the remaining same-extension request migrations with this recipe:

- If a tool requests its own extension's service through `ctx.extension.request`,
  yield the service tag directly.
- If a request is only public/client transport, keep it until the public
  transport adapter pass.
- Do not create new bridge DTOs or compatibility refs.
- Stop and report if a call crosses process boundaries or depends on transport
  auth semantics.
- Validate each batch with focused extension tests; final batch runs
  `bun run gate`.

## Current Source Trail

Brain principles:

- `/Users/cvr/.brain/principles/never-block-on-the-human.md`
- `/Users/cvr/.brain/principles/redesign-from-first-principles.md`
- `/Users/cvr/.brain/principles/correctness-over-pragmatism.md`
- `/Users/cvr/.brain/principles/subtract-before-you-add.md`
- `/Users/cvr/.brain/principles/use-the-platform.md`
- `/Users/cvr/.brain/principles/migrate-callers-then-delete-legacy-apis.md`
- `/Users/cvr/.brain/principles/small-interface-deep-implementation.md`
- `/Users/cvr/.brain/principles/boundary-discipline.md`
- `/Users/cvr/.brain/principles/make-impossible-states-unrepresentable.md`
- `/Users/cvr/.brain/principles/serialize-shared-state-mutations.md`
- `/Users/cvr/.brain/principles/derive-dont-sync.md`
- `/Users/cvr/.brain/principles/fix-root-causes.md`

Gent:

- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`
- `/Users/cvr/Developer/personal/gent/plans/WAVE-16.md`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/actor.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/contribution.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/driver.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/message.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/providers/provider.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/phases/turn.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response/collectors.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-engine.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-host.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/extension-runtime.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/turn-control.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/profile.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs/actor.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-utils.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/namespaced-client.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/actor.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/handoff.ts`

External:

- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Tool.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Toolkit.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/LanguageModel.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Chat.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/rpc/Rpc.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/rpc/RpcGroup.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/cluster/Entity.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/sql/SqlClient.ts`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/index.ts`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent.ts`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent-loop.ts`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/types.ts`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/sdk.ts`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/agent-session.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/session.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/message-v2.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/processor.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/llm.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/storage/storage.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/server/routes/instance/session.ts`
