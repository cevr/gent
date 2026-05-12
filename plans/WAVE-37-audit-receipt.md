# Wave 37 closing 9-lane audit receipt

## Frame

- HEAD audited: `210f737d` (W37 spine complete: S1 row Schemas,
  S2 TaggedUnion + GentRpcError collision, S3 wide-event coverage,
  S4 actor/runtime correctness + steer supersede, S5 JSON-parse
  hardening, S6 RPC acceptance backfill + sleep-proxy fixes, S7
  composable-method demotions (3 of 5; C18 + recordToolResult →
  W38), S8 actorContext capture-once, S9 L1 trace-name parity
  (3 of 5; 2 policy-blocked), S10 file cohesion + match-sorter
  ride-along).
- Method: 9 independent Opus `general-purpose` Agent lanes against
  fresh HEAD; no cross-pollination; codex rate-limited so all
  lanes were Opus per `feedback_counsel_fallback_opus.md`.
- Disposition rule: **any P0 or P1 finding opens Wave 38. Do not
  tail-extend W37.** P2s roll into W38 ride-along bucket.

## Tally

| Lane                               | P0    | P1     | P2     |
| ---------------------------------- | ----- | ------ | ------ |
| L1 — Effect simplification         | 0     | 4      | 4      |
| L2 — Actor + wide-event boundaries | 0     | 0      | 3      |
| L3 — Schema / storage integrity    | 0     | 0      | 6      |
| L4 — Public API ceremony           | 0     | 2      | 2      |
| L5 — Test taxonomy                 | 0     | 0      | 3      |
| L6 — File cohesion                 | 0     | 0      | 5      |
| L7 — Ctx-as-param leaks            | 0     | 3      | 2      |
| L8 — Yield-don't-thread            | 0     | 0      | 4      |
| L9 — Composable-method demotions   | 0     | 3      | 3      |
| **Total**                          | **0** | **12** | **32** |

Wave 38 is needed (12 P1s, no P0s). No emergency.

## W37 closure verification (claim → reality)

All 19 P1 closures from `plans/WAVE-36-audit-receipt.md` verified
clean at HEAD `210f737d`:

- L2-P1-1: `finalizeTurn` uses `WideEvent.set({...})` at behavior:930;
  `runTurnWorker` wrapped in `withWideEvent(turnBoundary(...))` at
  behavior:1187-1189. ✓
- L2-P1-2: `closeBehavior` wrapped in `startupSemaphore.withPermits(1)`
  at actor:515-524. ✓
- L2-P1-3: superseded with durable code comment at
  `session-runtime.ts:605-618` referencing W35-C7.3 + W37-S4-C10
  empirical timeouts. ✓
- L2-P1-4: `rpcBoundary` confirmed on session.create/delete/
  updateReasoningLevel + branch.create/switch/fork + message.send +
  steer.command + queue.drain/get + interaction.respondInteraction.
  Stream-shaped session.watchRuntime/events correctly unwrapped. ✓
- L3-P1-1/2/3: row Schemas (`Schema.Struct`) at rows.ts:36-85;
  `decodeMessageRow`/`decodeMessageChunkRow`/`decodeEventRow` at
  storage seams. Zero `as XRow` casts. ✓
- L3-P1-4: `parseAnswers` uses `Schema.fromJsonString` +
  `Schema.decodeUnknownEffect` + `Effect.orElseSucceed`. ✓
- L3-P1-5: sidecar uses Schema.Struct + decodeRegistryFile +
  immutable spread/rest. ✓
- L3-P1-6/7: GentRpcError + InterruptPayload via
  `Schema.toTaggedUnion("_tag")`. AppServiceError alias dropped;
  TUI sites migrated. ✓
- L4-P1: GentRpcsClient alias dropped; publicSetupContext removed.
  (Caveat: see new L4 P1 below — `GentClientRpcError` alias still
  present at sdk/client.ts:104.)
- L5-P1-1/2/3: 8 new RPC acceptance tests via `createRpcHarness`
  - `Effect.sleep` proxies replaced with `Effect.never` /
    Deferred-gated factories. ✓
- L9-P1-1/2/4: `ExtensionRegistry.listPromptSections` +
  `listFailedExtensions` + `SessionRuntime.invokeTool` deleted
  from interfaces. Tests migrated to `actorClientFactory +
entityIdOf`. `docs/actor-model.md` clean. ✓

S8 actorContext capture-once verified clean (L7 + L8 confirmed
no R-channel occlusion / monotonic widening).

## P1 findings (W38 spine candidates)

### L1 — Effect simplification (4 P1, all `Effect.fn` trace-name gaps)

- **L1-P1-1** —
  `packages/extensions/src/librarian/repo-explorer.ts:88-204` —
  `GitReader` Tag's four service methods (`clone`, `fetch`,
  `listFiles`, `readFile`) are plain `Effect.gen` arrows without
  `Effect.fn("GitReader.<m>")` names. Fix: wrap each.
- **L1-P1-2** —
  `packages/extensions/src/executor/sidecar.ts:598-648` —
  `ExecutorSidecar` Tag's four methods (`resolveEndpoint`, `stop`,
  `find`, `resolveSettings`) lack trace names. Sidecar spawn/poll
  is one of the slowest paths in the system. Fix: wrap each.
- **L1-P1-3** —
  `packages/core/src/runtime/agent/agent-loop.actor.ts:937-1101` —
  Submit/SubmitDurable/QueueFollowUp/Steer/Interrupt/
  RespondInteraction/DrainQueue/GetQueue/GetState/RecordToolResult/
  InvokeTool/TerminateBranch handler bodies are anonymous
  `Effect.gen` arrows. Cluster traces attribute to
  `withWorkspace`/`provideContext`, not `AgentLoop.<op>`. Fix:
  wrap each handler in `Effect.fn("AgentLoop.<op>")`.
- **L1-P1-4** —
  `packages/core/src/runtime/agent/agent-loop.behavior.ts:192-199,
502-643, 1214-1311` — Public `AgentLoopBehavior` state-transition
  methods (`interruptActiveStream`, `setStartingState`,
  `reserveStartOrQueueFollowUp`, `reserveRunStartOrQueueFollowUp`,
  `takeNextQueuedTurnFromState`, `clearInFlightTurn`,
  `appendSteering`, `drainQueue`, `switchAgentOnState`, `interrupt`,
  `startTurn`, `switchAgent`, `respondInteraction`, `start`,
  `close`, `saveCheckpoint`, `persistRuntimeState`,
  `commitQueueTransaction`) lack `Effect.fn` trace names. Inner
  helpers (`executeTools`, `collectTurnStream`, `runTurn`,
  `finalizeTurn`) ARE traced. Fix: wrap each outer behavior member.

### L4 — Public API ceremony (2 P1)

- **L4-P1-1** — `packages/sdk/src/client.ts:103-104` —
  `GentClientRpcError` is a one-line type alias of the canonical
  `GentRpcClientError`. SDK exports both names. 5 TUI sites use
  `GentClientRpcError`; the source name should be renamed to match
  the public consumer rather than maintaining a parallel API.
  Fix: rename source at `packages/core/src/server/rpcs.ts:194` to
  `GentClientRpcError`; drop the alias + `GentRpcClientError`
  re-export from `packages/sdk/src/client.ts`.
- **L4-P1-2** — 14 dead public exports from
  `@gent/core/extensions/api` with zero external callers:
  `messagePartSearchText`, `messagePartToolResult`,
  `stringifySearchValue`, `MessagePartsDisplayTextOptions`,
  `ImagePartProjection`, `ToolCallPartProjection`,
  `ToolResultPartProjection`, `AnyResourceContribution`,
  `AnyDriverContribution`, `ResourceSpec`, `ResourceScope`,
  `ScopeOf`, `FieldSpec`, `DefineExtensionInput`. Fix: delete each
  unused export. `FieldSpec` + `DefineExtensionInput` go
  file-local. Internal-use projection helpers re-export from
  `@gent/core-internal/domain/message-part-projection.js` for
  storage/tests only.

### L7 — Ctx-as-param leaks (3 P1, **W36 lane escapees**)

These three findings predate W37 (commits 2026-05-06/05-10) and
were missed by W36 L7 which claimed "0 P0/P1/P2 fully clean".

- **L7-P1-1** —
  `packages/core/src/runtime/agent/agent-loop.behavior.ts:686-687,
704-705, 974-976, 1080-1081` — `executeTools` helper threads
  `extensionRegistry: ExtensionRegistryService` + `permission:
PermissionService` as params, then re-provides via
  `Effect.provideService(ExtensionRegistry, params.extensionRegistry)`
  / `Effect.provideService(Permission, params.permission)`. Same
  anti-pattern W33 fixup `8dc38d97` documented for `ToolRunOptions`.
  Fix: drop the two service-Tag-valued fields from params; lift
  R-channel requirement to `executeTools`; wrap call sites with
  `Effect.provideService(...)`.
- **L7-P1-2** — same file `719-721, 755-760, 1043-1058` —
  `collectTurnStream` helper threads `ExtensionRegistry` +
  `Permission` + `DriverRegistry` as params and re-provides each.
  Fix: drop from params; wrap call site with the same triple
  `Effect.provideService` that already exists at lines 1023-1025
  for `resolveTurnContext`.
- **L7-P1-3** — same file `872, 910, 1097-1105` — `finalizeTurn`
  helper threads `extensionRegistry`, reaches into
  `params.extensionRegistry.extensionReactions.emitTurnAfter(...)`.
  Fix: drop from params; yield `ExtensionRegistry` inside; wrap
  call at line 1097 with `Effect.provideService(ExtensionRegistry,
turnExtensionRegistry)`.

### L9 — Composable-method demotions (3 P1)

- **L9-P1-1** —
  `packages/core/src/runtime/session-runtime.ts:221-223, 706-712` —
  `SessionRuntime.getState` wraps
  `AgentLoopActor.getState(entityIdOf(...))` (via thin
  `getRuntimeState` at 386-395). 6 test callers, ZERO production
  callers. Structural twin of the closed S7-C19 `invokeTool`. Fix:
  delete from interface + impl; migrate test sites to direct
  `actorClientFactory + entityIdOf` (same pattern as
  `session-runtime.test.ts:568-579`).
- **L9-P1-2** —
  `packages/core/src/runtime/extensions/driver-registry.ts:56-59,
93-112` — `requireModel` + `requireExternal` are pure
  error-wrapping over `getModel`/`getExternal`. ZERO production
  callers (production sites at `model-resolver.ts:59`,
  `provider-auth.ts:89,129`, `turn-helpers.ts:293,570` use
  `getModel`/`getExternal` directly + undefined check). Tests only.
  Fix: delete both from interface + impl; drop 2 test stubs.
- **L9-P1-3** — `packages/core/src/domain/permission.ts:63-68,
82-94`, `packages/core/src/runtime/profile.ts:111-116` —
  `Permission.addRule` + `removeRule` + `getRules` are pure
  adaptors over `ConfigService.addPermissionRule` /
  `removePermissionRule` / `get + concat`. ZERO production callers
  for any of the three; tests-only. `PermissionService` becomes
  `{ check }`. Fix: drop the three methods from interface + Live +
  profile impls; collapse tests to direct `ConfigService` calls.

## P2 ride-along bucket (32 items → W38)

### L1 — Effect simplification (4 P2)

- L1-P2-1: `packages/extensions/src/executor/sidecar.ts:438-453` —
  `pollHealth` hand-rolled while loop. Idiomatic Effect would be
  `Effect.iterate` or `Schedule.spaced + Schedule.upTo`.
- L1-P2-2: `packages/core/src/runtime/session-runtime.ts:309-319` —
  `provideActorStateServices` / `provideActorStateServicesToStream`
  could collapse to one combinator generic over Effect/Stream.
- L1-P2-3: `packages/core/src/runtime/extensions/registry.ts:548-572`
  — `findAgent` / `findModelCapability` / `requireAgent` lack
  trace names.
- L1-P2-4:
  `packages/core/src/runtime/agent/agent-loop.behavior.ts:123-143`
  — `resolveStoredAgent` exported helper lacks trace name.

### L2 — Actor + wide-event (3 P2)

- L2-P2-1: `packages/core/src/server/rpc-handlers.ts:443-509,
536-560` — Config/auth/driver RPC writes (permission.deleteRule,
  driver.set/clear, auth.setKey/deleteKey/authorize/callback)
  mutate persistent state without `withWideEvent(rpcBoundary(...))`.
- L2-P2-2:
  `packages/core/src/runtime/agent/agent-loop.actor.ts:720-724` —
  `openLoop` failure branch publishes half-initialized handle
  (queue init failed, but `Ref.set(handleRef, handle)` ran).
  Currently harmless; invariant-violating.
- L2-P2-3: same file `:878, 927-928` — `applySteer` reads
  `projectedState` outside the loop's mutex bracket. Idempotent
  spurious `interruptActiveStream` race.

### L3 — Schema / storage (6 P2)

- L3-P2-1: `packages/core/src/storage/sqlite/rows.ts:112,127` —
  `decodeSessionRow` + `decodeBranchRow` use
  `Schema.decodeUnknownSync`, throwing into the host Effect.
  Sibling Message/Event rows use `decodeUnknownEffect`. Fix to
  consistent Effect-channel decode.
- L3-P2-2: `packages/core/src/storage/interaction-storage.ts:58,156`
  — `decodeRow = Schema.decodeSync(...)` then `rows.map(decodeRow)`.
  Same inconsistency.
- L3-P2-3: `packages/extensions/src/auto/index.ts:71-74` —
  `parseCheckpointResult` uses raw `JSON.parse(result)` then
  `decodeCheckpointOutput`. Should be
  `Schema.fromJsonString(CheckpointOutput)`.
- L3-P2-4: `apps/tui/src/utils/parse-tool-output.ts:30-31` — raw
  `JSON.parse(output)` + redundant `as T` cast.
- L3-P2-5: `packages/core/src/domain/guards.ts:12` —
  `parseJsonUnknown` exported with zero call sites. Delete.
- L3-P2-6: `packages/extensions/src/acp-agents/protocol.ts:203` —
  `parsed["id"] as RequestId` cast on JSON-RPC `unknown` without
  runtime guard.

### L4 — Public API (2 P2)

- L4-P2-1: `apps/tui/src/theme/index.ts:2` — `selectedForeground`
  re-export with zero callers.
- L4-P2-2: `packages/core/src/extensions/api.ts:195` —
  `ExtensionContextService` exported but only referenced from
  tests. Move to `@gent/core-internal/test-utils/`.

### L5 — Test taxonomy (3 P2)

- L5-P2-1: `apps/tui/tests/extension-lifecycle.test.ts:59,82,100,
133,162,180,208,237,251,252,270` — 11 sites use `Effect.sleep
("0 millis")` as state-transition gate. Pre-W37 violation.
- L5-P2-2: `apps/tui/tests/atom-solid.test.ts:26`,
  `apps/tui/tests/use-session-feed.test.tsx:41`,
  `apps/tui/tests/child-session-tracker.test.ts:34` — same pattern
  at smaller scale.
- L5-P2-3: `apps/tui/tests/app-auth.test.tsx:44,375,844` — wall-
  clock proxy `Effect.sleep("10/20 millis")` for state gates.
  Use `waitFor` from `helpers-boundary.ts:41` instead.

### L6 — File cohesion (5 P2)

- L6-P2-1: `packages/core/tests/extensions/host-facet-survivors.
test.ts:106` — file/describe name encodes W33-C9.5 migration.
- L6-P2-2: Hand-rolled tagged unions in TUI src + repo-explorer
  (`prompt-search-state.ts:4-12`, `session-ui-state.ts:23-33`,
  `composer-state.ts:21-22`, `prompt-search-flow.ts:4`,
  `repo-explorer.ts:12-14`). Lint rule may not cover TUI src.
- L6-P2-3: Migration tokens (`Commit N`, `W3x-Cy`) in comments +
  test describe blocks across keychain-transform, beta-cache,
  claude-sdk, claude-code-executor, session-runtime,
  agent-loop.behavior, get-branch-tree.test, extension-session-
  helpers.test, claude-code-executor.test,
  anthropic-platform-adapter.test, anthropic-keychain-transform.
  test.
- L6-P2-4: `packages/extensions/src/librarian/repo-explorer.ts`
  584 lines mixing GitReader service + spec parser + RepoTool.
  Split into `git-reader.ts`, `repo-spec.ts`, `repo-tool.ts`.
- L6-P2-5: `packages/e2e/src/test-cleanup-boundary.ts` is a 4-line
  pass-through with one importer. Inline at the call site.

### L7 — Ctx-as-param (2 P2)

- L7-P2-1: `packages/core/src/server/rpc-handlers.ts:71-74` +
  `packages/core/src/runtime/make-extension-host-context.ts:51,
392` carry `ExtensionRegistryService` as a record field in
  `ResolvedSessionServices` / host-ctx deps. Profile-scoped
  registry Tag would be cleaner.
- L7-P2-2: `packages/core/src/runtime/session-runtime-context.ts:
19-52` — `SessionEnvironment` / `SessionEnvironmentDefaults`
  carry three service interfaces as record fields. Once L7 P1s
  fix, emit `Layer.Layer<ExtensionRegistry | DriverRegistry |
Permission>` instead of an interface-bag.

### L8 — Yield-don't-thread (4 P2)

- L8-P2-1: `packages/core/src/runtime/agent/agent-loop.behavior.
ts:704-705, 755-757, 1023-1026` — `runTurn` stacks 2-3
  `Effect.provideService` calls at three leaves. Capture-once
  `turnContext` bag mirroring W37-S8 actorContext.
- L8-P2-2: `packages/core/src/runtime/agent/agent-loop.actor.ts:
1078-1081` — `InvokeTool` handler stacks
  `Effect.provideService(ExtensionRegistry)` +
  `Effect.provideService(Permission)`. Hoist into shared
  `provideTurnEnvironmentServices` helper.
- L8-P2-3: `packages/core/src/runtime/make-extension-host-context.
ts:345-389` — `withAmbientHostContextOverrides` conditionally
  pipes up to 12 `Effect.provideService` calls. Build single
  `Context` snapshot then `Effect.provide`.
- L8-P2-4: `packages/extensions/src/anthropic/credential-service.
ts:220-225` — `provideIO` stacks 4 `Effect.provideService` calls
  invoked repeatedly. Precompute `ioContext` once.

### L9 — Method demotions (3 P2 + 1 dead-API note)

- L9-P2-1: `packages/core/src/runtime/extensions/registry.ts:498,
524` — `listModelCapabilities` is `Effect.succeed([...resolved.
modelCapabilities.values()])`. Demote to `getResolved().
modelCapabilities` reads.
- L9-P2-2: same file `:507, 534` — `listAgents` is the same shape
  over `resolved.agents`.
- L9-P2-3: same file `:510, 535` — `listExtensionStatuses` is a
  literal pass-through over `resolved.extensionStatuses`.
- **Dead-API note (out-of-lane)** — `ResourceManager.withNeeds` /
  `ResourceManagerService` has ZERO non-test callers. Service is
  still plumbed through `ephemeral-root.ts:54,77,210,230` +
  `dependencies.ts:446`. This is dead API, not a demotable wrapper.
  Belongs in a dead-surface lane for W38.

## Disposition

- **All 12 P1s** become Wave 38 spine commits, grouped by lane.
  Estimated wave shape: 5 spines (S1 trace-name parity, S2 SDK +
  api ceremony, S3 ctx-as-param leak fixes, S4 method demotions,
  S5 W37 carry-over: C18 ModelRegistry.refresh fixture redesign +
  recordToolResult demotion + mcp-codemode/claude-sdk Promise
  pyramids).
- **All 32 P2s** roll into W38 as ride-along bucket — pick up
  opportunistically within spines that touch the same files.
- **Dead-API note**: `ResourceManagerService` deletion is a
  separate W38 dead-surface lane (zero non-test callers).
- Per durable rule, Wave 37 closes here. Audit findings are not
  worth re-opening W37 commits.
