# Wave 35 Final Audit Receipt

- **HEAD audited:** `7604fda0` (post C1-C15.4)
- **Date:** 2026-05-11
- **Lanes:** 9 independent parallel reviews (Agent / Explore subagents on sonnet)
- **Method:** Each lane read against fresh receipts; no cross-pollination. Consolidated below.

## Verdict

**Wave 35 cannot close yet.** Audit reports multiple P0 findings spanning union shapes, actor-model integrity, public-API ceremony, ctx-as-param leaks, and yield-don't-thread holes. Wave 36 (or W35 follow-up sub-commits, per "scope is not a constraint") will absorb them.

Per the durable directive at `plans/WAVE-35.md:258-266`: _"Scope is not a constraint. Do not defer findings to a later wave for ergonomic reasons. Correctness is preferred over scope discipline: 100 commits is fine as long as the end state is structurally superior."_ All P0s ship in this wave. P1s ship in this wave unless they require fresh-context design work.

## P0 Punch List

### Lane 1 — Effect simplification

**[L1-P0-1] `ToolInteractionPending` hand-rolled tagged class**

- `packages/core/src/runtime/agent/turn-helpers.ts:484-490`
- Hand-rolled `class ToolInteractionPending extends Data.TaggedError(...)` instead of `Schema.TaggedErrorClass<>()`. Codebase rule (CLAUDE.md): every tagged/discriminated union uses `Schema.TaggedUnion` / `Schema.TaggedErrorClass`.
- Fix: convert to `class ToolInteractionPending extends Schema.TaggedErrorClass<ToolInteractionPending>()("ToolInteractionPending", { ... }) {}`.

**[L1-P0-2] Duplicate type declarations `AssistantResponsePart`/`ToolResponsePart`**

- `packages/core/src/runtime/agent/turn-response.ts:78-85`
- Both `AssistantResponsePart` and `ToolResponsePart` are redeclared as local literal unions despite already being public exports from `@gent/core-internal/domain/message`. Counter to CLAUDE.md "Import from here, never redeclare locally" rule.
- Fix: delete the duplicates; import the types from `domain/message`.

### Lane 2 — Actor model + wide-event

**[L2-P0-1] `openLoop` missing `withWorkspace` boundary wrapper**

- `packages/core/src/runtime/agent/agent-loop.actor.ts:772`
- The `openLoop` mailbox handler invokes downstream actor work without wrapping in `withWorkspace`, dropping the wide-event boundary on this code path. All other actor handlers wrap correctly.
- Fix: add `withWorkspace(workspaceId, ...)` wrapper.

### Lane 4 — Public API ceremony

**[L4-P0-1] `defineScheduledJob` is ceremonial identity**

- `packages/core/src/extensions/api.ts` (definition + re-export)
- Function takes `ScheduledJob` and returns the same `ScheduledJob` unchanged. Pure identity wrapping for "intent". No tests assert it; no consumers depend on the wrapper.
- Fix: delete `defineScheduledJob`; callers construct `ScheduledJob` directly.

**[L4-P0-2] `defineAgent` is ceremonial identity**

- `packages/core/src/extensions/api.ts`
- Same shape: input `AgentDefinition`, output identical `AgentDefinition`. No transform.
- Fix: delete or justify. Audit finds no justification.

**[L4-P0-3] `request()` boilerplate × 45 sites: repeated `extensionId` plumbing**

- All extension `request(...)` call sites (45 occurrences across `packages/extensions/src/`) thread the same `{ extensionId: "@gent/foo" }` literal that already lives in the surrounding `defineExtension({ id })` scope.
- Fix: scoped factory — `defineExtension` exposes a closure-bound `request` that auto-fills `extensionId`. Removes 45 boilerplate lines.

### Lane 7 — Ctx-as-param leaks

**[L7-P0-1] `GentToolMetadata.effect` ctx-as-param escape hatch (public)**

- `packages/core/src/domain/capability/tool.ts` — `GentToolMetadata.effect` signature accepts `ctx` as parameter.
- Tools that need the host should `yield* ExtensionContext` inside. The current shape lets the platform leak through the public extension authoring API in ways forbidden by the no-context-params memory.
- Fix: drop `ctx` parameter from `effect` signature; require tools to yield ExtensionContext internally.

**[L7-P0-2] `GentExtension.setup` ctx-as-param escape hatch**

- `packages/core/src/domain/extension.ts` — `setup` accepts a `ctx` parameter, an escape hatch the rest of the surface deliberately doesn't permit.
- Fix: drop `ctx` parameter from `setup`; require setup to yield context internally.

### Lane 8 — Yield-don't-thread

**[L8-P0-1] `withStorageTransaction(sql, effect)` — sql threaded as param**

- `packages/core/src/storage/sqlite-storage.ts:27-39` (exported)
- 3 direct production threading sites: `runtime/agent/turn-helpers.ts:81-83`, `runtime/agent/agent-runner.ts:330+343`, `runtime/agent/agent-loop.behavior.ts:279+890`.
- 3 closure-captured uses (less severe): `server/session-commands.ts:214-216, 664-666`, `server/session-queries.ts:53-55`.
- Fix: remove `sql` parameter; yield `SqlClient.SqlClient` inside `withStorageTransaction`. R-channel surfaces the requirement.

**[L8-P0-2] `selectTodoById(sql, id)` — sql threaded as param**

- `packages/extensions/src/todo-storage.ts:84`
- Returns Effect; called from `makeTodoStorageService` (line 243) which already yields sql.
- Fix: drop sql param; yield internally.

**[L8-P0-3] Five todo-storage helpers threading sql**

- `packages/extensions/src/todo-storage.ts` lines 110, 118, 141, 150, 161 — `tableColumns`, `tableHasForeignKey`, `todosTableNeedsReset`, `todoEdgesTableNeedsReset`, `resetIncompatibleTodoTables`.
- All `Effect.fn`-wrapped, all thread sql; module-private call chain.
- Fix: drop sql param from all five; yield internally.

**[L8-P0-4] `makeExecutionToolkit({ registry, ... })` — ExtensionRegistry threaded as param**

- `packages/core/src/runtime/agent/tool-runner.ts:121-174`
- Module-private; caller `ToolRunner.Live.run` at line 313-318 already yields `ExtensionRegistry`.
- Fix: drop `registry` from params; yield `ExtensionRegistry` inside `makeExecutionToolkit`.

### Lane 9 — Composable-method demotions

(Same C12 pattern from W34. All eight are pure compositions over already-public services.)

**[L9-P0-D1] `SessionQueries.listSessions`** — pass-through `Effect.map` over `SessionStorage.list`.

**[L9-P0-D2] `SessionQueries.getChildSessions`** — `SessionStorage.list` + `.filter(parentId === target)`.

**[L9-P0-D3] `SessionQueries.listBranches`** — pass-through over `BranchStorage.listByPosition`.

**[L9-P0-D4] `SessionQueries.listMessages`** — pass-through over `MessageStorage.listByBranch`.

**[L9-P0-D5] `ModelRegistry.get`** — Map lookup over already-public `listModels`.

**[L9-P0-D6] `DriverRegistry.getExternalExecutor`** — Map lookup over already-public `listExternalExecutors`.

**[L9-P0-D7] `ConfigService.getPermissionRules`** — pass-through over `loadConfig`.

**[L9-P0-D8] `ExtensionAgentService.get`** — duplicates `requireAgent` standalone helper at `registry.ts:565`.

All eight: demote to pure helper functions; delete the service method.

## P1 Punch List

### Lane 5 — Test taxonomy

(Lane 5 results have not surfaced in this session. Defer to fresh-context audit if needed; no findings ship from this lane in W35.)

### Lane 6 — File cohesion

**Eleven small-file merges (clear collapse candidates):**

1. `packages/core/src/domain/business-errors.ts` (21 lines, 1 consumer) → merge into `server/errors.ts`
2. `packages/core/src/domain/defaults.ts` (27 lines, 2 sibling consumers) → merge into `runtime/agent/turn-helpers.ts`
3. `packages/core/src/domain/steer.ts` (25 lines, re-exported via transport-contract) → fold into `server/transport-contract.ts`
4. `packages/core/src/domain/extension-agent-helpers.ts` (27 lines, 1 consumer) → inline into `domain/extension.ts` or `extensions/api.ts`
5. `packages/core/src/domain/extension-session-helpers.ts` (25 lines, 1 consumer) → inline into `domain/extension.ts` or `extensions/api.ts`
6. `packages/core/src/domain/agent-pair.ts` (47 lines, 1 consumer via api.ts) → fold into `domain/agent.ts`
7. `packages/core/src/runtime/sql-client.ts` (42 lines, **0 production consumers** — test-only) → delete or inline into `sqlite-storage.ts`
8. `packages/core/src/runtime/format-schema-error.ts` (40 lines, **0 production consumers** — test-only) → delete if dead
9. `packages/core/src/server/index.ts` (16 lines, 1 consumer) → merge `AppServicesLive` into `server-root.ts`
10. `packages/core/src/domain/session-pubsub-registry.ts` (74 lines, 1 consumer) → inline into `event-store-live.ts`
11. `packages/core/src/domain/session-mutations.ts` (63 lines, borderline 2-subsystem consumers) — leave if used as a cross-subsystem boundary; otherwise inline.

### Lane 8 — P2 builder threading

**[L8-P2-1] `buildSearchFilters(sql, ...)` — DSL-builder threading**

- `packages/core/src/storage/search-storage.ts:23-37`
- Synchronous SQL-fragment builder; returns SQL value not Effect. Distinct from Effect-context threading. Lower priority but worth tidying.
- Fix: inline at single call site.

## P2 Punch List

### Lane 6 — Nice-to-merge files (consumer-clean but not viral)

1. `packages/sdk/src/transport-headers.ts` (14 lines, 2 same-package consumers) → fold into `client.ts`
2. `packages/core/src/runtime/ws-tracing.ts` (75 lines, 1 consumer) → inline into `server-routes.ts`
3. `packages/core/src/domain/tool-output.ts` (27 lines, 3 sibling consumers in runtime/agent/) → merge into `turn-helpers.ts`
4. `packages/extensions/src/handoff-tool.ts` (90 lines, only `handoff.ts` consumer) → merge into `handoff.ts`
5. `packages/sdk/src/runtime-boundary.ts` (28 lines, 1 consumer) → respect `*-boundary.ts` lint; fold into `client.ts` only if linter allows.

## Disposition

W35 follow-up sub-commits (C16+):

- **C16**: L1-P0-1 ToolInteractionPending → `Schema.TaggedErrorClass`
- **C17**: L1-P0-2 delete duplicate `AssistantResponsePart`/`ToolResponsePart`
- **C18**: L2-P0-1 add `withWorkspace` wrapper to `openLoop`
- **C19**: L4-P0-1 delete `defineScheduledJob`
- **C20**: L4-P0-2 delete `defineAgent` (audit justification or delete)
- **C21**: L4-P0-3 scoped `request` factory via `defineExtension`
- **C22**: L7-P0-1 drop `ctx` from `GentToolMetadata.effect`
- **C23**: L7-P0-2 drop `ctx` from `GentExtension.setup`
- **C24**: L8-P0-1 yield sql in `withStorageTransaction`
- **C25**: L8-P0-2/3 yield sql in todo-storage helpers
- **C26**: L8-P0-4 yield registry in `makeExecutionToolkit`
- **C27**: L9-P0-D1..D8 demote 8 composable methods to pure helpers
- **C28**: L6-P1 file collapse pass (11 merges + 2 dead-file deletions)

P2s rolled to W36 if any independent design tension surfaces during P0 fixes.

## Counter-rule confirmations

Lane 6 explicitly cleared the following small files as legitimate (wide reuse, cross-package, or boundary-by-convention):

`provider-error.ts`, `storage-error.ts`, `guards.ts`, `runtime-environment.ts`, `queue.ts`, `event-publisher.ts`, `message-part-projection.ts`, `windowing.ts`, `interaction-request.ts`, `rpc-harness.ts`, `fake-fetch.ts`, `language-model.ts`, `theme/index.ts`, `client/index.ts`, `acp-agents/executor-boundary.ts`, `executor/platform-adapter.ts`, `wide-event-boundary.ts`, `extensions/src/client.ts`, all `anthropic/`, all `openai/`.

Lane 8 cleared the following as legitimate context-threading patterns (per-turn overrides, layer-factories, configuration bundles):

- `agent-loop.behavior.ts` executeTools/collectTurnStream/finalizeTurn — intentional per-turn overrides via `Effect.provideService` at line 701.
- `agent-runner.ts` runEphemeralAgent — canonical snapshot-and-pass to layer factory.
- `ephemeral-root.ts` makeEphemeralAgentRootLayer — layer constructor.
- `rpc-handlers.ts` resolveProfileServices — resolved-config bundle, not service threading.
