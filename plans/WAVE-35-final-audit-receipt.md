# Wave 35 Closing Audit Receipt

- **HEAD audited:** `f95f18dd` (post C1-C28.5)
- **Date:** 2026-05-11
- **Lanes:** 9 independent parallel reviews (Agent / Explore subagents)
- **Method:** Each lane read against fresh receipts; no cross-pollination. Consolidated below.

## Verdict

**Wave 35 cannot close yet.** Audit reports 6 P0s + 12 P1s + 3 P2s spanning public-API ceremony, composable-method demotions, file cohesion, schema-validation boundaries, and test-taxonomy holes. Per durable directive (`plans/WAVE-35.md:258-266`) — _"Scope is not a constraint. 100 commits is fine as long as the end state is structurally superior."_ — all P0s + P1s ship in W35 follow-up sub-commits.

## P0 Punch List

### Lane 4 — Public API ceremony

**[L4-P0-1] `AgentRunOverridesSchema` / `type AgentRunOverrides` are dead public surface**

- `packages/core/src/extensions/api.ts:74-78`
- Zero consumers in `packages/extensions/`, `apps/`, or tests via `@gent/core/extensions/api`. The only real consumer (`turn-helpers.ts`) imports directly from internal `domain/agent.js`. Runtime-internal concern.
- Fix: remove from `api.ts`.

**[L4-P0-2] `resolveRunPersistence` is dead public surface**

- `packages/core/src/extensions/api.ts:79`
- Zero consumers via `@gent/core/extensions/api`; the only call site is `agent-runner.ts` via internal import. Runtime-internal helper.
- Fix: remove from `api.ts`.

### Lane 9 — Composable-method demotions

**[L9-P0-1] `SessionCommands.steer` identity wrapper**

- `packages/core/src/server/session-commands.ts:1002`
- `steer: (command) => sessionRuntime.steer(command)` — no error mapping, no span, no branching. `SessionRuntimeError ⊂ AppServiceError`.
- Fix: remove from `SessionCommands`; call `sessionRuntime.steer` directly from `rpc-handlers.ts:372`.

**[L9-P0-2] `SessionCommands.drainQueuedMessages` pass-through**

- `packages/core/src/server/session-commands.ts:1003-1006`
- Pure pass-through with only `Effect.withSpan` added. Span belongs at the RPC handler.
- Fix: remove from `SessionCommands`; inline at `rpc-handlers.ts:375`, move span there.

**[L9-P0-3] `SessionQueries.getQueuedMessages` pass-through**

- `packages/core/src/server/session-queries.ts:144-147`
- Pure pass-through with only `Effect.withSpan` added.
- Fix: remove from `SessionQueriesService`; inline at `rpc-handlers.ts:378`, move span there.

**[L9-P0-4] `ExtensionRegistry.listPermissionRules` zero-consumer Effect.succeed wrapper**

- `packages/core/src/runtime/extensions/registry.ts:511,542`
- `() => Effect.succeed(resolved.permissionRules)`. Zero production callers; production code already reads `params.profile.resolved.permissionRules` directly (`profile.ts:341`).
- Fix: remove from `ExtensionRegistryService` interface and `fromResolved`.

## P1 Punch List

### Lane 1 — Effect simplification

**[L1-P1-1] `AgentRunnerService.run` lacks `Effect.fn` wrapper**

- `packages/core/src/runtime/agent/agent-runner.ts:830, 1007`
- Both `InProcessRunner.run` and `SubprocessRunner.run` are plain `(params) => Effect.gen(...)` — no stack-frame label.
- Fix: wrap with `Effect.fn("AgentRunner.run")(function* (params) { ... })`.

**[L1-P1-2] `interruptPayloadToSteerCommand` manually reconstructs `_tag` objects**

- `packages/core/src/runtime/session-runtime.ts:273-295`
- Maps `InterruptPayload` → `SteerCommand` by building literals with hard-coded `_tag` strings rather than spreading the already-tagged payload.
- Fix: replace switch body with `return { ...input }` (both unions share identical field names) or inline `SteerCommand.make` at the call site and delete the function.

### Lane 3 — Schema/storage integrity

**[L3-P1-1] `WorkspaceId` flows as bare `string` — not branded**

- `packages/core/src/server/workspace-rpc.ts:10,24`
- `CurrentWorkspaceId` typed as `Context.Reference<string>`; `validateWorkspaceId` returns `Effect.Effect<string, ...>`. Leaks as bare `string` through all storage modules; `durable_operations` PK uses raw string.
- Fix: define `WorkspaceId = Schema.String.pipe(branded("WorkspaceId"))` in `ids.ts`; return `WorkspaceId` from `validateWorkspaceId`; type `CurrentWorkspaceId` as `Context.Reference<WorkspaceId>`.

**[L3-P1-2] `SessionMutationsService` accepts `requestId?: string`**

- `packages/core/src/domain/session-mutations.ts:23,30,36`
- `createSessionBranch`, `forkSessionBranch`, `switchActiveBranch` skip the `RequestId` schema (which exists at `ids.ts:42`). Raw unsanitized string reaches `durable_operations` PK.
- Fix: change all three to `requestId?: RequestId`.

**[L3-P1-3] `SessionOperationStorageService` accepts `requestId: string`**

- `packages/core/src/storage/session-operation-storage.ts:48,52,55,59`
- `getCreateSession`/`saveCreateSession`/`getCreateBranch`/`saveCreateBranch` (and fork/switch siblings) accept `requestId: string` — direct storage boundary with no schema validation.
- Fix: type all `requestId` parameters as `RequestId`.

### Lane 5 — Test taxonomy

**[L5-P1-1] `Effect.sleep` as state-transition gate**

- `packages/extensions/tests/acp-agents/acp-invalidation.test.ts:110`
- Comment: "Yield once so the rpc helper writes its request and parks." Timing-dependent sleep with no `Deferred` synchronization.
- Fix: expose a `Deferred` from `makeAcpConnection` (or its stub) completed when the pending RPC `Deferred` is registered; yield that instead of sleeping.

**[L5-P1-2] `Effect.sleep` polling loops lack `waitFor` abstraction**

- `packages/core/tests/runtime/agent-loop/helpers.ts:491`
- `packages/core/tests/runtime/agent-loop-queue.test.ts:144`
- `for` loops with `Effect.sleep("1 millis")` polling for state transitions.
- Fix: replace with `waitFor` helper (analogous to existing `waitForRuntimeState` pattern in `helpers.ts`).

### Lane 6 — File cohesion

**[L6-P1-1] `server/rpcs/runtime.ts` → `server/rpcs.ts`**

- 21 lines, 1 consumer.

**[L6-P1-2] `server/rpcs/auth.ts` → `server/rpcs.ts`**

- 42 lines, 1 consumer.

**[L6-P1-3] `server/rpcs/extension.ts` → `server/rpcs.ts`**

- 57 lines, 1 consumer. Collapses the `rpcs/` directory to a single ~200-line file once D1-D3 land.

**[L6-P1-4] `server/ws-tracing.ts` → `server/server-routes.ts`**

- 75 lines, 1 consumer (`server-routes.ts`). WS-tracing middleware used exclusively by the route builder.

### Lane 4 — Public API dual-name

**[L4-P1-1] `AgentRunResult` exported twice (as type + `AgentRunResultSchema`)**

- `packages/core/src/extensions/api.ts:75-76`
- Same `Schema.Union` value exported under two public names; only `delegate-tool.ts:50` uses the `Schema` alias. Creates ambiguity about whether `AgentRunResult` is a type or a schema.
- Fix: drop `AgentRunResultSchema` alias; update `delegate-tool.ts` to use `AgentRunResult` directly.

## P2 Punch List

**[L1-P2-1] `Promise<ExecutorMcpInspection>` recursive helper inside `Effect.tryPromise`**

- `packages/extensions/src/executor/mcp-bridge.ts:251`
- Recursive Promise pagination inside `Effect.tryPromise`. Functionally contained but not Effect-native.
- Fix: replace with `Effect.iterate` / `Stream.paginateEffect`.

**[L3-P2-1] `ALTER TABLE` migrations lack `Effect.ignoreCause` idempotency guard**

- `packages/core/src/storage/schema.ts:218,248`
- Migrations `003_session_workspace` and `005_interaction_decision` (`ADD COLUMN`) are unguarded. If re-applied, SQLite throws "duplicate column name" and bricks the database.
- Fix: wrap both `ALTER TABLE` statements with `Effect.catchAll(() => Effect.void)` (or the project's established `Effect.ignoreCause` guard pattern).

**[L5-P2-1] Tool tests without RPC acceptance coverage**

- `packages/extensions/tests/delegate/delegate-tool.test.ts`
- `packages/extensions/tests/memory/tools.test.ts`
- Both use `runToolWithCtx`, bypassing the per-request scope boundary.
- Fix: add at least one `createRpcHarness` acceptance test per directory.

**[L5-P2-2] `resource-manager.test.ts` uses `Effect.sleep` as concurrent-work proxy**

- `packages/core/tests/runtime/resource-manager.test.ts:90,113`
- Sleeps simulate work duration to verify mutual exclusion. Tests verify concurrency correctly with `Deferred` elsewhere (lines 18-32).
- Fix: replace timed-sleep tests with a `Deferred`-based "both running" gate.

## Counter-rule confirmations (clean lanes)

- **Lane 2 (Actor model + wide-event):** all mailbox handlers in `agent-loop.actor.ts` wrap in `withWorkspace`; all `WideEvent.set()` sites have an enclosing `withWideEvent` boundary; no dead `MachineEngine`/`Resource.machine` surface; no orphaned actor files; no leaked `Scope`.
- **Lane 7 (Ctx-as-param leaks):** no shipped extension imports `FileIndex`/`FileLockService`/`ExtensionStatePublisher`; `ProviderAuthorizeContext`/`ProviderCallbackContext` are plain data structs (correct); `ExtensionSetupContext` accessed via `yield*` (correct).
- **Lane 8 (Yield-don't-thread):** all candidate sites match allowed exceptions (per-turn overrides, layer factories, resolved-config bundles, layer-internal closures).

## Disposition

Wave 35 follow-up sub-commits (C29+):

- **C29**: L4-P0-1 / L4-P0-2 — drop `AgentRunOverridesSchema`, `AgentRunOverrides`, `resolveRunPersistence` from `api.ts`
- **C30**: L4-P1-1 — drop `AgentRunResultSchema` alias; rename `delegate-tool.ts` import to use `AgentRunResult`
- **C31**: L9-P0-1 / L9-P0-2 — demote `SessionCommands.steer` + `drainQueuedMessages`
- **C32**: L9-P0-3 — demote `SessionQueries.getQueuedMessages`
- **C33**: L9-P0-4 — drop `ExtensionRegistry.listPermissionRules`
- **C34**: L1-P1-1 — wrap `AgentRunner.run` with `Effect.fn`
- **C35**: L1-P1-2 — collapse `interruptPayloadToSteerCommand`
- **C36**: L3-P1-1 — brand `WorkspaceId`
- **C37**: L3-P1-2 — type `SessionMutationsService.requestId` as `RequestId`
- **C38**: L3-P1-3 — type `SessionOperationStorageService.requestId` as `RequestId`
- **C39**: L5-P1-1 — replace `acp-invalidation.test.ts` sleep with `Deferred`
- **C40**: L5-P1-2 — extract `waitFor` for state-transition polling in agent-loop tests
- **C41**: L6-P1-1 / L6-P1-2 / L6-P1-3 — collapse `server/rpcs/{runtime,auth,extension}.ts` into `server/rpcs.ts`
- **C42**: L6-P1-4 — collapse `server/ws-tracing.ts` into `server/server-routes.ts`

P2s (L1-P2-1, L3-P2-1, L5-P2-1, L5-P2-2) roll into the closing P2 pass after the P0/P1 set lands; if any independent design tension surfaces, defer to W36 with named follow-ups.
