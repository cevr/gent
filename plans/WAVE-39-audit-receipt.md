# Wave 39 closing 9-lane audit receipt

## Frame

- HEAD audited: `98fd176c` (W39 spine complete through S7-C26).
- Method: 9 independent Opus `general-purpose` Agent lanes against
  fresh HEAD; no cross-pollination; first six lanes launched, then
  remaining lanes queued as slots opened.
- Disposition rule: any P0 or P1 finding opens Wave 40. Do not
  tail-extend W39. P2s roll into W40 ride-along bucket.

## Tally

| Lane                               | P0    | P1     | P2     |
| ---------------------------------- | ----- | ------ | ------ |
| L1 - Effect simplification         | 0     | 0      | 6      |
| L2 - Actor + wide-event boundaries | 0     | 4      | 4      |
| L3 - Schema / storage integrity    | 0     | 5      | 2      |
| L4 - Public API ceremony           | 0     | 7      | 1      |
| L5 - Test taxonomy                 | 0     | 5      | 3      |
| L6 - File cohesion                 | 0     | 3      | 4      |
| L7 - Ctx-as-param leaks            | 0     | 8      | 2      |
| L8 - Yield-don't-thread            | 1     | 5      | 1      |
| L9 - Composable-method demotions   | 0     | 4      | 3      |
| **Total**                          | **1** | **41** | **26** |

Wave 40 is needed: 1 P0, 41 P1s.

## W39 closure verification

- **S1-C1 -> L3-P0-1**: Event JSON decode failures now route through
  `EventDecodeError` and warning logs in
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/event-storage.ts`.
  Closed.
- **S1-C2 -> L3-P1-1**: actor payload `WorkspaceId` uses the brand in
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts`.
  Closed, but L2 found unvalidated `parseEntityId` reconstruction.
- **S1-C3 -> L3-P1-2**: no `decodeSync` remains in
  `InteractionStorage.listPending`. Closed.
- **S1-C4 -> L3-P1-3/L3-P1-4**: `RecordToolResult.toolName` and
  `DriverFailureRef.id` are branded. Closed, but `InvokeTool.toolName`
  still erases the brand.
- **S2-C5 -> L2-P1-1/L2-P1-2**: `session.getSnapshot` and
  `session.getTree` are wrapped in wide-event RPC boundaries. Closed,
  but `getSessionSnapshot` still swallows actor failures inside the
  boundary.
- **S2-C6/S2-C7 -> L9-P1-1/L9-P1-2**: `runPrompt` double-wrap and
  `restoreSession` delegation are demoted. Closed.
- **S3-C8 -> L1-P1-2**: turn-helper trace parity closed in the split
  turn modules.
- **S4-C9 through S4-C13 -> L6-P1 cluster**: empty `phases/` removed;
  `agent-loop.behavior.ts`, `agent-runner.ts`, `session-commands.ts`,
  and `turn-helpers.ts` split below the W39 threshold. Closed.
- **S5-C14 through S5-C20 -> L7/L8 cluster**: pricing lookup and
  direct turn-source yield fixes closed, but audit found remaining deps
  bags, ctx params, callback seams, and re-injection patterns.
- **S6-C21 -> L1-P1-1**: `Permission.Live` collapsed to a pure layer.
  Closed.
- **S7-C22/S7-C23 -> L4-P1 cluster**: duplicate `Message` export and
  `GentRpcClient` public leak removed. Closed.
- **S7-C24/S7-C25/S7-C26 -> L5-P1 cluster**: actor-command coverage
  moved under `tests/runtime/agent-loop/`, `recordToolResult` dedupe
  assertions restored, and permission test names made behavioral.
  Partially closed: audit found more actor-internal tests at the wrong
  directory boundary and broader method-shaped describe blocks.

## P0 finding

### L8 - Yield-don't-thread

- **L8-P0-1** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ts:81-92`,
  `:163`, `:287-298`, `:328`, `:478` - `InProcessRunner` and
  `SubprocessRunner` snapshot the full layer-build context and reattach
  it with `Effect.provideContext(...)` for every run. This is the
  largest remaining yield-then-thread pattern: dozens of services are
  captured across a closure boundary instead of being declared once at
  the runner seam.

## P1 findings by lane

### L2 - Actor + wide-event boundaries

- **L2-P1-1** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:967-975`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/ids.ts:33,45` -
  `AgentLoop.Interrupt` builds `SteerCommand.Cancel` with
  `Schema.decodeSync`; long `ActorCommandId` values can defect instead
  of returning typed actor failure.
- **L2-P1-2** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.entity-id.ts:72-75`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/workspace-rpc.ts:7,27-33` -
  `parseEntityId` reconstructs branded ids with `.make(...)` without
  schema validation, bypassing the actor payload brand boundary.
- **L2-P1-3** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:579-639` -
  `extension.request` can enqueue follow-ups and reach actor-backed
  runtime state but is not wrapped in `withWideEvent(rpcBoundary(...))`.
- **L2-P1-4** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-queries.ts:117` -
  `getSessionSnapshot` catches actor `GetState` failures and returns
  `Idle`, so the new wide-event boundary reports success while actor
  errors disappear.

### L3 - Schema / storage integrity

- **L3-P1-1** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite/rows.ts:112,114,127,129`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/session-storage.ts:108,120,130`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/branch-storage.ts:109,123`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/relationship-storage.ts:62,83,97,105` -
  `sessionFromRow` and `branchFromRow` still use
  `Schema.decodeUnknownSync`, so corrupt durable rows defect instead of
  entering the typed storage error channel.
- **L3-P1-2** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite/rows.ts:30,143-146` -
  malformed `message.metadata` silently decodes to `undefined` via
  `Schema.decodeUnknownOption`.
- **L3-P1-3** -
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/protocol.ts:379,383,387` -
  ACP external-agent wire responses decode with sync throws inside
  `Effect.map`.
- **L3-P1-4** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:159-166,243` -
  `InvokeTool.toolName` remains raw `Schema.String` while
  `RecordToolResult.toolName` is branded.
- **L3-P1-5** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:969-974` -
  `Interrupt` constructs `SteerCommand` through a hand-rolled `_tag`
  literal plus `Schema.decodeSync` instead of the tagged constructor.

### L4 - Public API ceremony

- **L4-P1-1** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:192-197` -
  `SignalError` and four `GentPlatform*` types remain public though
  only core internals/tests consume them.
- **L4-P1-2** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:128` -
  `MessageMetadata` remains public without extension/example
  consumers.
- **L4-P1-3** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:93-94`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/prompt.ts:15-25` -
  `sectionStartMarker` and `sectionEndMarker` are exported but raw
  marker consumers do not exist.
- **L4-P1-4** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:86`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:201` -
  `ExtensionTurnContext` remains public without extension/example
  consumers.
- **L4-P1-5** -
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/index.ts:27,34,35,39`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts:298,301` -
  `CreateSessionResult`, `GentClientOptions`, `StateSpec`, and
  `ProviderSpec` are public but have no out-of-package consumers.
- **L4-P1-6** -
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts:3,62-65`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/index.ts:53-58`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/index.ts:16-19` -
  SDK re-exports `effect/unstable/ai/Prompt` part types through the
  public entrypoint, binding the API to unstable transport shapes.
- **L4-P1-7** -
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/namespaced-client.ts:58-59`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/index.ts:15-16,19,43`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts:97-98`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/package.json:5-8` -
  `GentConnectionError`, `GentLifecycle`, and `ConnectionState` have
  a dead namespaced-client re-export chain.

### L5 - Test taxonomy

- **L5-P1-1** -
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop-queue.test.ts:18,32,34-37`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop-streaming.test.ts:7,37-49`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop-interactions.test.ts:29` -
  actor-internal tests still live directly under `tests/runtime/`
  while importing `AgentLoopTestActor` or `agent-loop/helpers`.
- **L5-P1-2** -
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent/agent-loop.session-governance.test.ts:11` -
  describe block names the service rather than behavior.
- **L5-P1-3** -
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/tool-runner.test.ts:50`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/tracer.test.ts:8`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/model-registry.test.ts:177`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/todo-service.test.ts:43`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/config-service.test.ts:15`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/session-profile.test.ts:41` -
  runtime tests retain class/service-named describe blocks.
- **L5-P1-4** -
  `/Users/cvr/Developer/personal/gent/packages/core/tests/domain/prompt.test.ts:14,91,155`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/domain/event.test.ts:21,54`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/domain/message.test.ts:6`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/domain/agent-runspec.test.ts:11`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/domain/agent-pair.test.ts:26`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/domain/agent-driver-routing.test.ts:19` -
  domain tests retain factory/function-named describe blocks.
- **L5-P1-5** -
  `/Users/cvr/Developer/personal/gent/packages/core/tests/server/session-idempotency.test.ts:551-558` -
  live `Effect.sleep("100 millis")` is used as a state-transition
  proxy for idempotency-cache eviction.

### L6 - File cohesion

- **L6-P1-1** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:95-250,256-399,401-473,475-1157,1158-1194` -
  actor payload schemas, entity descriptors, queue/state helpers,
  handlers, and layers still live in one 1100+ line file.
- **L6-P1-2** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/message-part-projection.ts:81-345,345-388,389-405,407-577,579-877` -
  display, search, image conversion, response normalization, and
  bidirectional message conversion share one 700+ line file.
- **L6-P1-3** -
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/oauth.ts:23-72,74-107,109-176,178-204,206-241,243-328,330-490,492-678,680-746` -
  credential schema/IO, keychain, fallback heuristics, account
  listing, writeback, token refresh, headers, and body parsing share
  one file.

### L7 - Ctx-as-param leaks

- **L7-P1-1** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:321-377,379-387,444-456,458-472` -
  `BehaviorDeps` re-threads Tag-shaped services into queue, turn
  execution, and worker factories.
- **L7-P1-2** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime-context.ts:65,81,119,135,144,153,164`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:266-275` -
  `MakeExtensionHostContextDeps` is threaded into session environment
  helpers instead of yielding the needed Tags inside.
- **L7-P1-3** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts:51-60,227,234-247,301-305`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-tool-execution.ts:30-58`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts:107-115` -
  `ToolRunner.run` still takes `ctx` while callers also rebind
  `CurrentExtensionHostContext`.
- **L7-P1-4** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:25-37,71-107`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.turn-execution.ts:300-309` -
  extension reaction slots thread `ExtensionHostContext` as a
  positional parameter then convert it back into Tags.
- **L7-P1-5** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ts:92,148,298,313`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ephemeral.ts:101,127`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/ephemeral-root.ts:88-93,136-145,223-224` -
  parent service snapshots are threaded through ephemeral runner
  helpers as positional `Context.Context<never>` values.
- **L7-P1-6** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ts:282,397`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/host-platform.ts:62-68`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/credential-service.ts:222`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/controller.ts:89` -
  `ChildProcessSpawner` is yielded and re-injected with
  `Effect.provideService`.
- **L7-P1-7** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.worker.ts:18-32`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:253-262,444-472` -
  worker receives `publishEvent` and `runTurn` callbacks instead of
  yielding the underlying services.
- **L7-P1-8** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:1080-1095`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.turn-execution.ts:333-349` -
  turn-scoped registry/permission/host context overrides are manually
  reconstructed with global Tag `provideService` calls at each call
  site.

### L8 - Yield-don't-thread

- **L8-P1-1** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/message-storage.ts:57-58,66-73,108-109,129-130` -
  `MessageStorage.Live` yields SQL/platform services and re-injects
  them into helper closures called in the same layer body.
- **L8-P1-2** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-profile.ts:94-118,127,145-148` -
  `SessionProfileCache.Live` rebuilds yielded platform services into a
  `Layer.succeed` detour and `Layer.buildWithScope`.
- **L8-P1-3** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/host-platform.ts:39-45,66-71` -
  `makeExtensionHostPlatform` captures `ChildProcessSpawner` and
  re-injects it for every `runProcess` call.
- **L8-P1-4** -
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/credential-service.ts:206-225` -
  `AnthropicCredentialService.buildShape` captures four platform Tags
  and re-injects them into every IO call.
- **L8-P1-5** -
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/keychain-client.ts:480-488` -
  `keychainClient` captures `GentPlatform` and `AnthropicPlatform` and
  re-injects them into `transformPayloadHere`.

### L9 - Composable-method demotions

- **L9-P1-1** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:548-573`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/registry.test.ts:19-22`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts:393`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:82` -
  registry-side `findAgent`, `findModelCapability`, and `requireAgent`
  are dead non-test surface.
- **L9-P1-2** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:524-538` -
  `listAgents`, `listModelCapabilities`, and `listExtensionStatuses`
  thin-wrap `getResolved()` field reads.
- **L9-P1-3** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:500-504,525-533,433-492`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-resolve.ts:176-187` -
  `resolveToolPolicy` wraps pure `compileToolPolicy` for a single
  call site.
- **L9-P1-4** -
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/approval-service.ts:26-84`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/interaction-request.ts:142-164` -
  `ApprovalService.Live` and `LiveWithStorage` identity-reshape
  `makeApprovalInteractionService` into an identical interface.

## P2 ride-along bucket

- **L1-P2-1..6**: redundant command/mutation trace wrappers,
  `Effect.void.pipe(Effect.as(undefined))`, extra actor handler gen,
  point-free `Effect.fn` wrapper, and pubsub registry combinator
  simplifications.
- **L2-P2-1..4**: actor handler ordering inconsistency, `openLoop`
  trace wrapper, cold-branch reads force loop startup, stream RPCs lack
  open/close wide-event envelope.
- **L3-P2-1..2**: durable message metadata encode uses sync encode;
  `HandlerRequest` hand-rolls `_tag` structural augmentation.
- **L4-P2-1**: SDK type-only re-export chains duplicate canonical
  transport/domain exports.
- **L5-P2-1..3**: vague `concurrency` describe, helper polling audience
  mismatch, retry describe naming.
- **L6-P2-1..4**: `rpc-handlers.ts`, executor sidecar, agent-loop utils,
  and agent-loop test helper cohesion cleanups.
- **L7-P2-1..2**: no-op mirrored-event observer callback and follow-up
  callback indirection.
- **L8-P2-1**: executor controller re-injects `ChildProcessSpawner`.
- **L9-P2-1..3**: `listSlashCommands` field-read helper, mutation
  context aliases, and EventPublisher demotion non-action note.

## Wave 40 disposition

Open Wave 40. Schedule the L8 P0 first, then cluster the 41 P1s by
root shape:

1. Runner/context re-threading P0.
2. Storage/schema decode and actor boundary safety.
3. Wide-event and actor lifecycle boundary leaks.
4. Public API ceremony deletion.
5. Test taxonomy and boundary relocation.
6. File cohesion splits.
7. Ctx-as-param and yield-don't-thread remaining seams.
8. ExtensionRegistry / ApprovalService composable-method demotions.

Wave 40 must include the same closing 9-lane audit batch.
