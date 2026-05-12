# Wave 38 plan

## Frame

- **Source**: closes 12 P1 findings from `plans/WAVE-37-audit-receipt.md`
  - 4 carry-overs from W37 deferrals (C18 ModelRegistry.refresh,
    recordToolResult demotion, mcp-codemode + claude-sdk Promise pyramids).
- **HEAD start**: `210f737d` (W37 spine close).
- **Rule**: Sub-commit per spine; counsel after each commit via Opus
  Agent fallback (codex rate-limited until 2026-05-12); one revision
  round per commit; gate between batches.
- **P2 bucket**: 32 items roll into W38 as opportunistic ride-alongs
  (pick up within spines that touch the same files; do not let P2 sweeps
  inflate the diff).

## Spines

### S1 — Trace-name parity (`Effect.fn` wraps)

Closes L1-P1-1, L1-P1-2, L1-P1-3, L1-P1-4. All four are mechanical
trace-name additions; smallest model can apply the pattern.

- **C1**: `GitReader` Tag — wrap `clone`, `fetch`, `listFiles`,
  `readFile` in `Effect.fn("GitReader.<m>")` at
  `packages/extensions/src/librarian/repo-explorer.ts:88-204`.
- **C2**: `ExecutorSidecar` Tag — wrap `resolveEndpoint`, `stop`,
  `find`, `resolveSettings` in `Effect.fn("ExecutorSidecar.<m>")` at
  `packages/extensions/src/executor/sidecar.ts:598-648`.
- **C3**: AgentLoop actor handlers — wrap Submit/SubmitDurable/
  QueueFollowUp/Steer/Interrupt/RespondInteraction/DrainQueue/
  GetQueue/GetState/RecordToolResult/InvokeTool/TerminateBranch
  bodies in `Effect.fn("AgentLoop.<op>")` at
  `packages/core/src/runtime/agent/agent-loop.actor.ts:937-1101`.
- **C4**: AgentLoopBehavior public methods — wrap each of the ~17
  state-transition methods in `Effect.fn("AgentLoop.<method>")` at
  `packages/core/src/runtime/agent/agent-loop.behavior.ts:192-199,
502-643, 1214-1311`.
- **P2 ride-alongs in scope**: L1-P2-3 (`findAgent`/
  `findModelCapability`/`requireAgent` trace names — C4 file
  adjacency), L1-P2-4 (`resolveStoredAgent` trace name — C4 file).

### S2 — SDK + Public API cleanup

Closes L4-P1-1, L4-P1-2.

- **C5**: Rename source `GentRpcClientError` → `GentClientRpcError`
  at `packages/core/src/server/rpcs.ts:194`. Drop alias + redundant
  re-export at `packages/sdk/src/client.ts:103-104`. SDK exports
  only the canonical name.
- **C6**: Delete 14 dead public exports from
  `@gent/core/extensions/api`: `messagePartSearchText`,
  `messagePartToolResult`, `stringifySearchValue`,
  `MessagePartsDisplayTextOptions`, `ImagePartProjection`,
  `ToolCallPartProjection`, `ToolResultPartProjection`,
  `AnyResourceContribution`, `AnyDriverContribution`, `ResourceSpec`,
  `ResourceScope`, `ScopeOf`, `FieldSpec`, `DefineExtensionInput`.
  `FieldSpec` + `DefineExtensionInput` become file-local. Internal
  projection helpers re-export only from
  `@gent/core-internal/domain/message-part-projection.js`.
- **P2 ride-alongs in scope**: L4-P2-2 `ExtensionContextService`
  move to `@gent/core-internal/test-utils/` (C6 file adjacency).

### S3 — Yield-don't-thread fixes (turn-helpers)

Closes L7-P1-1, L7-P1-2, L7-P1-3. **W36 lane escapees**: these
three findings predate W37 (commits 2026-05-06/05-10) and were
missed by W36 L7. Spine S3 follows W33-fixup `8dc38d97` pattern.

- **C7**: `executeTools` — drop `extensionRegistry` + `permission`
  params; lift R-channel; wrap two call sites at
  `agent-loop.behavior.ts:974-976` + `:1080-1081` with
  `Effect.provideService(ExtensionRegistry, ...)` +
  `Effect.provideService(Permission, ...)`.
- **C8**: `collectTurnStream` — drop `extensionRegistry` +
  `permission` + `driverRegistry` params; wrap call at
  `agent-loop.behavior.ts:1043-1058` with the same triple
  `Effect.provideService` that exists at `:1023-1025` for
  `resolveTurnContext`.
- **C9**: `finalizeTurn` — drop `extensionRegistry` param; yield
  `ExtensionRegistry` inside; wrap call at
  `agent-loop.behavior.ts:1097-1105` with
  `Effect.provideService(ExtensionRegistry, turnExtensionRegistry)`.
- **P2 ride-alongs in scope**: L8-P2-1 (capture-once `turnContext`
  bag mirroring W37-S8 actorContext — same file, same pattern;
  apply AFTER C7-C9 to avoid double-rework), L8-P2-2 (InvokeTool
  handler share the bag if hoisted to a shared helper),
  L7-P2-1/P2-2 (Profile-scoped registry Tag for
  `ResolvedSessionServices` + `SessionEnvironment` — same lane,
  larger lift; consider deferring to W39 if S3 already heavy).

### S4 — Composable-method demotions

Closes L9-P1-1, L9-P1-2, L9-P1-3 + W37 carry-overs.

- **C10**: Demote `SessionRuntime.getState` (twin of S7-C19
  `invokeTool`). Delete from interface + impl. Migrate 6 test
  sites at `packages/core/tests/runtime/session-runtime.test.ts:
370, 507, 850, 1003, 1034, 1046` to `actorClientFactory +
entityIdOf(DefaultWorkspaceId, ...)` (pattern at `:568-579`).
- **C11**: Demote `DriverRegistry.requireModel` +
  `requireExternal` at
  `packages/core/src/runtime/extensions/driver-registry.ts:56-59,
93-112`. Pair-demotion, single commit. Drop 2 test stubs at
  `packages/core/tests/drivers/driver-registry.test.ts:138-154`.
- **C12**: Demote `Permission.addRule` + `removeRule` + `getRules`
  at `packages/core/src/domain/permission.ts:63-68, 82-94` +
  `packages/core/src/runtime/profile.ts:111-116`. Collapse 3 test
  describe blocks at `packages/core/tests/domain/permission.test.
ts:118-180` to direct `ConfigService` calls.
  `PermissionService` becomes `{ check }`.
- **C13** (W37 carry-over): Demote `SessionRuntime.recordToolResult`
  per W37-S7 counsel finding — structurally identical to
  `invokeTool` (pure wrapper over `AgentLoopActor.RecordToolResult.
make(...)`). Zero non-test callers (7 hits, all in
  `session-runtime.test.ts`).
- **C14** (W37 carry-over): `ModelRegistry.refresh` fixture
  redesign — replace 5 test sites with `waitFor(registry.list(),
predicate)` per test-407 precedent. Then drop `refresh` from
  interface at `packages/core/src/runtime/extensions/
model-registry.ts:240`.
- **P2 ride-alongs in scope**: L9-P2-1/P2-2/P2-3
  (`listModelCapabilities` / `listAgents` / `listExtensionStatuses`
  — same file, same pattern; demote within C10-C12).

### S5 — Dead-surface deletion

- **C15**: Delete `ResourceManagerService` (`withNeeds` + the
  entire service). ZERO non-test callers. Plumbing to remove:
  `packages/core/src/runtime/resource-manager.ts` (entire file),
  `packages/core/src/runtime/ephemeral-root.ts:54, 77, 210, 230`
  references, `packages/core/src/server/dependencies.ts:446`
  wiring, all of `packages/core/tests/runtime/resource-manager.
test.ts`.

### S6 — Policy-blocked Promise pyramids (W37 carry-over)

Conditional spine: only proceed if TS377081 `asyncFunction` policy
gets revisited. Per W37 S9 counsel recommendation, amend W36 audit
receipt to mark these as `policy-blocked` so future audits don't
re-flag.

- **C16** (conditional): mcp-codemode Promise pyramid →
  `async function*` per receipt's prescribed shape. Requires
  policy change OR localized `eslint-disable-next-line`.
- **C17** (conditional): claude-sdk Promise pyramid → same shape.

## Optional spines (defer if scope inflates)

### S7 — Schema/storage decode consistency (L3 P2 cluster)

- L3-P2-1: `decodeSessionRow`/`decodeBranchRow` → `decodeUnknownEffect`.
- L3-P2-2: `interaction-storage` decodeRow → `decodeUnknownEffect`.
- L3-P2-3: `auto/index.ts:71-74` → `Schema.fromJsonString`.
- L3-P2-4: `parse-tool-output.ts:30-31` → `Schema.fromJsonString`.
- L3-P2-5: delete `parseJsonUnknown` at `guards.ts:12`.
- L3-P2-6: add runtime guard at `protocol.ts:203` JSON-RPC `id` cast.

### S8 — File cohesion ride-alongs (L6 P2 cluster)

- L6-P2-1: rename `host-facet-survivors.test.ts` → process-shaped name.
- L6-P2-2: convert hand-rolled tagged unions in TUI src +
  repo-explorer to `Schema.TaggedUnion`. Investigate why lint rule
  doesn't cover TUI src.
- L6-P2-3: strip `Commit N`/`W3x-Cy` migration tokens from
  comments + test describe blocks.
- L6-P2-4: split `librarian/repo-explorer.ts` 584 lines →
  `git-reader.ts` + `repo-spec.ts` + `repo-tool.ts`.
- L6-P2-5: inline `packages/e2e/src/test-cleanup-boundary.ts` at
  its one call site.

### S9 — Wide-event spread to auth/driver/permission RPCs (L2 P2 cluster)

- L2-P2-1: Wrap `permission.deleteRule`, `driver.set/clear`,
  `auth.setKey/deleteKey/authorize/callback` with
  `withWideEvent(rpcBoundary("<op>"))`. No sessionId at this seam;
  tap `WideEvent.set({ provider })` for auth ones.

### S10 — Test taxonomy backfill (L5 P2 cluster)

- L5-P2-1/2/3: replace 15+ `Effect.sleep("0 millis")` /
  `Effect.sleep("10 millis")` proxies in TUI test files with
  `waitFor` polling or Deferred gates.

### S11 — Actor invariant tightening (L2 P2 remainders)

- L2-P2-2: `openLoop` failure branch — don't publish `handleRef`
  on failure path.
- L2-P2-3: `applySteer` race — read `projectedState` inside the
  loop's mutex bracket.

## Counsel cadence

After each commit:

1. Run gate (typecheck + lint + fmt + build + test).
2. Counsel via Opus Agent fallback (codex rate-limited until
   2026-05-12).
3. If counsel returns `revise`: one fixup commit. If `block`:
   revisit design.
4. Update `memory/project_w38_status.md` per spine completion.

## Disposition rule

P0/P1 findings from the W38 closing audit will open Wave 39. Do
not tail-extend W38. P2s roll into W39 ride-along bucket.
