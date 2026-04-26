# Planify: Recursive Hardening Wave 6

## Final Verification Receipt (C17)

Wave 6 implementation completed through commit `83bd5ef9` (C17 recursive
verification rerun). The eight-lane audit at `83bd5ef9` surfaced three
cross-cutting findings closed in three sub-commits:

- `a3336bc7` fix(domain): make brand symbols module-private (5 sites:
  `CAPABILITY_REF`, `ReadOnlyBrand`, two `extension-protocol` metadata
  symbols, `taggedEnumVariantDefinitionMarker` — `Symbol.for` → `Symbol`)
- `f3655412` fix(openai): typed `OAuthError` replaces 9 plain `Error` throws
  (token-exchange-failed, token-refresh-failed, callback-error, missing-code,
  state-mismatch, callback-timeout, cancelled discriminants)
- `cad345ba` fix(domain): bound `FileLockService` lock map by refcount
  (Map<string, Semaphore> → refcount-bounded Map<string, LockEntry>;
  `currentSize()` accessor + 2 regression-locking tests)

The audit also surfaced one architectural finding scoped out into Wave 7
(state-shape vs `Resource.machine` appropriateness — pi-mono comparison
finding folded as Lane 9 of the recursive-verification fanout).

**Status**: Closed. Wave 6 ships at `cad345ba`. Wave 7 plan is in `PLAN.md`.

### Wave 6 commit log (chronological, oldest first)

- `d3fa1c00` C1: fix(extensions): persist ACP-driver tool-result output into transcript
- `a0e52fc4` C1 fixup: cover mixed text+non-text ACP tool-result blocks
- `99aa9d5e` C2: fix(tui): derive model from snapshot.metrics.lastModelId
- `e1cd9ba2` C2 fixup: cover lastModelId hydration and switchSession clear
- `69f67a26` C3: fix(tui,sdk): adopt requestId for headless retry, branch mutations, bootstrap session.create
- `e0f071c9` C4: feat(providers): expose Provider.Sequence + Provider.Signal as statics
- `1fa3c9c2` C4 fixup: sweep stale createSequenceProvider/createSignalProvider/DebugProvider references
- `bafdd297` C5: test: wrap bun-test bodies in Effect.timeout for scope safety
- `9486ca71` C5 fixup: extend Effect.timeout coverage to remaining 8 integration test files
- `df9b77ff` C6: test(runtime): observe interrupt via actor.call, not Effect.sleep
- `3efc9a94` C7: fix(server): introduce InvalidStateError + migrate validateBranchDeletion
- `af9071e6` C7 fixup: migrate session-commands defects to NotFoundError/InvalidStateError
- `30fdf43d` C7 fixup: assert NotFoundError/InvalidStateError tags on rejection paths
- `57654d45` C8: refactor(domain): eliminate domain→runtime back-imports
- `1e851aa9` C9: refactor(runtime): route agent-runner RunSpec construction through makeRunSpec
- `e9d910ab` C10: fix(core): omit InteractionPendingReader and resolve cwd via registry
- `1fad0ed3` C11: fix(providers): trace stream + preserve cause + fail-closed bedrock + drop ProviderAuth.Test + DEFAULT_MODEL_ID
- `52a6c936` C12: refactor(domain): exhaustive event helpers + schemafy Approval/AgentRun + brand AgentName
- `c51d0320` C12 fixup: close AgentName brand leaks + use AgentRunResult constructors
- `04f4bf1f` C12 fixup: finish AgentName brand pass — test-utils + persisted config
- `07acc906` C13: refactor(storage): drop dead todos table + acquire/release PRAGMA foreign_keys + parameterize getSessionAncestors
- `e6a665df` C14: refactor(extensions): action display fields + request/Ref pairing + tool() intent
- `bfc8a30f` C15: fix(server): TTL/eviction for dedup cache + split Layer.mergeAll dependency
- `6b49b1fd` C16: test: realize createRpcHarness + rename method-call-shaped tests
- `83bd5ef9` C17: chore(audit): rerun recursive verification
- `a3336bc7` C17 closeout: brand symbol privacy
- `f3655412` C17 closeout: OAuth typed errors
- `cad345ba` C17 closeout: FileLockService refcount-bounded eviction

---

## Context

Wave 5 implementation completed through commit `c56a1192` (C13 fixup) and was
gated. Fresh final verification then ran eight independent audit lanes at HEAD
`c56a1192`:

1. runtime ownership / actor-model clarity
2. extension API boundaries
3. Effect-native AI integration
4. storage model
5. domain modeling / constructor discipline
6. suppression debt / boundary discipline
7. SDK/TUI adapter debt
8. test taxonomy / behavioral coverage

All eight lanes completed and reported findings. The recursive audit surfaced
nine P1s and twenty-five+ P2s spanning test scope-finalizer leaks, untyped
business-validation defects in `session-commands`, a documented-but-missing
`Provider.Sequence` API, ACP-driver tool-result transcript loss (regression of
C6 intent on the protocol path), TUI ignoring server-authoritative
`metrics.lastModelId` (regression of C10 lesson for the `model` field),
headless retries without `requestId` (defeats C12), forbidden domain→runtime
imports, and RunSpec construction sites that escaped C9.

This plan supersedes Wave 5. The plan is not complete until every batch below
is implemented, gated, reviewed once, and a final recursive audit reports no
P1/P2 findings. Wave 5's text is archived at `plans/WAVE-5.md` with its
verification receipt.

## Scope

- **In**: scope-finalizer-safe test timeouts, agent-loop interrupt observation
  via state (no wall-clock sleep), typed RPC error channel for
  session-commands business validation, `Provider.Sequence` realization (or
  doc reconciliation), ACP tool-result `output` persistence, TUI model display
  reading from `metrics.lastModelId`, headless `requestId` adoption, branch
  mutation `requestId` adoption, bootstrap session-create `requestId` adoption,
  domain→runtime back-import elimination, RunSpec migration in
  `agent-runner.ts`, ephemeral runtime `InteractionPendingReader` override,
  `terminateSessionMachineRuntime` cwd-resolution via registry, dedup cache
  TTL/eviction, action `name`/`category`/`keybind` plumbing or removal,
  request/Ref typed pairing, `tool()` `intent` field, `Provider.stream`
  Effect.fn wrapping, `ProviderError` cause preservation, Bedrock/OpenAI
  fail-closed conformance, `ProviderAuth.Test` deletion, hardcoded model
  literal removal, dead `todos` table removal, `PRAGMA foreign_keys` acquire/
  release, `getSessionAncestors` parameter binding, `getEventBranchId`/
  `getEventSessionId` `_tag`-exhaustive narrowing, `ApprovalRequest`/
  `ApprovalDecision` schemafication, `AgentRunResult`/`AgentRunToolCall`
  schemafication, `AgentName` branding, `Layer.mergeAll` dependency violation
  fix, `createRpcHarness` realization (or doc reconciliation), method-call-
  shaped test name renaming.
- **Out**: cosmetic refactors not tied to a finding, test naming wave (kept
  in scope but lower priority than P1s), package-policy reintroduction.

## Constraints

- Correctness over pragmatism.
- Breaking changes allowed if migrated in the same wave.
- No feature cuts.
- One implementation commit per batch (sub-commits allowed inside a batch if
  blast radius > 20 files; each sub-commit must compile and pass gate).
- Run `bun run gate` for every batch.
- Run `bun run test:e2e` for high-blast-radius runtime/server/SDK batches
  (marked below).
- Run exactly one review subagent per implementation commit.
- If a review finds real P1/P2, fix with a follow-up commit and gate again.
- Final batch reruns the same eight audit lanes. If any P1/P2 remains,
  overwrite this file with the next Planify plan and continue.

## Applicable Skills

`architecture`, `effect-v4`, `test`, `code-style`, `bun`, `planify`

## Gate Command

`bun run gate`

---

## Audit Findings

| ID    | Severity | Finding                                                                                                                                                                                                                      | Evidence                                                                                                                                                                                                                                                                           |
| ----- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W6-1  | P1       | ACP-driver tool-result `output` is dropped by `mapToolCallUpdate`. Every successful ACP tool call round-trips into the transcript as `{ value: null }`. Regression of C6 intent on the protocol path.                        | `packages/extensions/src/acp-agents/executor.ts:88`, `packages/extensions/src/acp-agents/executor.ts:100`, `packages/core/src/runtime/agent/agent-loop.ts:925`, `packages/core/src/runtime/agent/agent-loop.ts:940`                                                                |
| W6-2  | P1       | TUI displays the locally-resolved model from `AgentsByName` instead of the server-authoritative `metrics.lastModelId` exposed in the snapshot. Same C10 lesson as cost; not migrated for `model`.                            | `apps/tui/src/client/context.tsx:822`, `apps/tui/src/client/context.tsx:826`, `apps/tui/src/client/context.tsx:59`, `apps/tui/src/client/context.tsx:832`, `apps/tui/src/routes/session.tsx:110`, `packages/core/src/runtime/session-runtime.ts:189`                               |
| W6-3  | P1       | Headless prompt send retries up to 20× without `requestId`. Each retry that lands after the server accepted the prior attempt produces a duplicate user message and extra turn. Defeats C12.                                 | `apps/tui/src/headless-runner.ts:69`, `apps/tui/src/headless-runner.ts:84`, `packages/core/src/server/session-commands.ts:1086`, `packages/core/src/server/session-commands.ts:1116`                                                                                               |
| W6-4  | P1       | `Provider.Sequence([...])` is documented as the canonical mocking seam in `AGENTS.md` and `packages/core/CLAUDE.md` but does not exist; only `createSequenceProvider` is exported from `debug/provider.ts`.                  | `packages/core/src/providers/provider.ts:516`, `packages/core/src/debug/provider.ts:123`, `packages/core/src/debug/provider.ts:281`, `AGENTS.md:110`, `packages/core/CLAUDE.md`                                                                                                    |
| W6-5  | P1       | Bun-test timeouts without internal `Effect.timeout` (~25 sites including the brand-new C13 two-cwd test). Scope finalizers do not run on test timeout — workers, EventPublisher fibers, tempdirs leak.                       | `packages/e2e/tests/transport-contract.test.ts:244`, `packages/core/tests/extensions/capability-permission-rules.test.ts:141`, `packages/core/tests/extensions/executor-integration.test.ts:294`, `packages/core/tests/extensions/skills/skills-rpc.test.ts:90`                    |
| W6-6  | P1       | `Effect.sleep("1 millis")` used as a state-transition barrier between `agentLoop.steer({ _tag: "Interrupt" })` and `controls.emitAll(1)`. Should observe via `getState`, not wall-clock sleep.                               | `packages/core/tests/runtime/agent-loop.test.ts:1809`                                                                                                                                                                                                                              |
| W6-7  | P1       | 26 `Effect.die` sites in `session-commands.ts` for user-input/business validation reachable from RPC handlers. RPC clients cannot pattern-match, retry, or surface clean errors. Should be typed `Schema.TaggedError` in E.  | `packages/core/src/server/session-commands.ts:274`, `packages/core/src/server/session-commands.ts:283`, `packages/core/src/server/session-commands.ts:466`, `packages/core/src/server/session-commands.ts:884`, `packages/core/src/server/session-commands.ts:1246`                |
| W6-8  | P1       | Three domain modules import from `runtime/`, inverting the dependency rule. Domain types must not depend on runtime types.                                                                                                   | `packages/core/src/domain/auth-guard.ts:5`, `packages/core/src/domain/auth-guard.ts:6`, `packages/core/src/domain/prompt-presenter.ts:6`, `packages/core/src/domain/prompt-presenter.ts:7`, `packages/core/src/domain/resource.ts:52`                                              |
| W6-9  | P1       | `agent-runner.ts` constructs RunSpec via spread literals at three sites instead of `makeRunSpec`. C9 migrated extension callers but the runtime itself bypasses the smart constructor.                                       | `packages/core/src/runtime/agent/agent-runner.ts:759`, `packages/core/src/runtime/agent/agent-runner.ts:976`, `packages/core/src/runtime/agent/agent-runner.ts:1123`                                                                                                               |
| W6-10 | P2       | `OVERRIDE_TAG_SETS.storage` omits `InteractionPendingReader`. Ephemeral subagents read parent's durable interaction store while writing to a fresh in-memory store — wrong-store ghosts during ephemeral turns.              | `packages/core/src/runtime/composer.ts:174`, `packages/core/src/runtime/composer.ts:185`, `packages/core/src/runtime/composer.ts:144`, `packages/extensions/src/interaction-tools/projection.ts:36`, `packages/core/src/storage/sqlite-storage.ts:1834`                            |
| W6-11 | P2       | `terminateSessionMachineRuntime` resolves the per-cwd MachineEngine via `sessionStorage.getSession()`. For descendants caught by the post-delete cleanup, the row is already gone → falls back to ambient → mailbox leaks.   | `packages/core/src/server/session-commands.ts:86`, `packages/core/src/server/session-commands.ts:118`, `packages/core/src/server/session-commands.ts:1216`                                                                                                                         |
| W6-12 | P2       | `Provider.stream` is not wrapped in `Effect.fn`. Provider streams are the hottest tracing surface in the system; tracing is silently disabled on every model turn. Project rule: `Effect.fn` for all service methods.        | `packages/core/src/providers/provider.ts:429`, `packages/core/src/providers/provider.ts:486`                                                                                                                                                                                       |
| W6-13 | P2       | `ProviderError` constructed at `resolveModel` catch loses `cause`. Schema accepts `cause` but the construction site never sets it. Original cause chain dropped at the seam.                                                 | `packages/core/src/providers/provider.ts:130`, `packages/core/src/providers/provider.ts:133`, `packages/core/src/providers/provider.ts:146`, `packages/extensions/src/bedrock/index.ts:7`, `packages/extensions/src/openai/index.ts:124`                                           |
| W6-14 | P2       | Bedrock driver throws plain `Error` from `resolveModel` — wrapped as transient `ProviderError`, retried instead of failing closed. Violates C5 contract for `ProviderAuthError`.                                             | `packages/extensions/src/bedrock/index.ts:6`, `packages/extensions/src/bedrock/index.ts:10`, `packages/extensions/src/openai/index.ts:124`                                                                                                                                         |
| W6-15 | P2       | `ProviderAuth.Test` is byte-identical to `.Live`. Lingering antipattern that the recent `Provider.Test()` / `EventStore.Test()` deletion sweep removed elsewhere.                                                            | `packages/core/src/providers/provider-auth.ts:32`, `packages/core/src/providers/provider-auth.ts:40`, `packages/core/src/providers/provider-auth.ts:47`                                                                                                                            |
| W6-16 | P2       | Hardcoded `"anthropic/claude-opus-4-6"` literal bypasses `ModelId.make` brand. Two different "default" models in the codebase; `domain/agent.ts` already exports `DEFAULT_MODEL_ID`.                                         | `packages/core/src/runtime/make-extension-host-context.ts:330`, `packages/core/src/domain/agent.ts:96`                                                                                                                                                                             |
| W6-17 | P2       | `getEventBranchId` uses raw `as BranchId` cast + structural-key `"branchId" in event` narrowing instead of `_tag`-exhaustive `Match.tag`. Adding a new branchId-bearing variant returns silent `undefined`.                  | `packages/core/src/domain/event.ts:447`, `packages/core/src/domain/event.ts:452`, `packages/core/src/domain/event.ts:456`                                                                                                                                                          |
| W6-18 | P2       | `ApprovalRequest` / `ApprovalDecision` plain interfaces with dual declaration (`interface` + `Schema.Struct`) and `as unknown as Schema.Any` cast. No `ApprovalDecisionSchema` at all.                                       | `packages/core/src/domain/interaction-request.ts:25`, `packages/core/src/domain/interaction-request.ts:34`, `packages/core/src/domain/interaction-request.ts:67`, `packages/core/src/domain/interaction-request.ts:73`                                                             |
| W6-19 | P2       | `AgentRunResult` is a hand-rolled `_tag` union, not `TaggedEnumClass`. Crosses serialization boundaries (RunSpec IPC nearby). No constructor enforces variant invariants. `AgentRunToolCall` plain interface.                | `packages/core/src/domain/agent.ts:205`, `packages/core/src/domain/agent.ts:228`                                                                                                                                                                                                   |
| W6-20 | P2       | `AgentName` is unbranded `Schema.String`. 14 production call sites use `as AgentName` (no-op today) but will silently break when branding lands.                                                                             | `packages/core/src/domain/agent.ts:10`, `packages/core/src/domain/agent.ts:11`, `packages/core/src/domain/agent.ts:54`, `packages/extensions/src/memory/dreaming.ts:11`, `packages/extensions/src/memory/agents.ts:47`                                                             |
| W6-21 | P2       | Dead `todos` table: schema, migration legacy-table dance, and orphan-cleanup all execute on every startup. Zero INSERT/UPDATE/SELECT writers in the repo.                                                                    | `packages/core/src/storage/sqlite-storage.ts:794`, `packages/core/src/storage/sqlite-storage.ts:810`, `packages/core/src/storage/sqlite-storage.ts:1024`, `packages/core/src/storage/sqlite-storage.ts:1091`, `packages/core/src/storage/sqlite-storage.ts:532`                    |
| W6-22 | P2       | `PRAGMA foreign_keys = OFF` in `task-tools-storage` and `migrateForeignKeyConstraints` lacks `acquire/release`. Safety relies entirely on connection teardown, not failure-safe pragma flip.                                 | `packages/extensions/src/task-tools-storage.ts:207`, `packages/extensions/src/task-tools-storage.ts:248`, `packages/core/src/storage/sqlite-storage.ts:591`, `packages/core/src/storage/sqlite-storage.ts:855`                                                                     |
| W6-23 | P2       | `getSessionAncestors` uses `sql.unsafe` with hand-rolled `'${sessionId.replace(/'/g, "''")}'` instead of parameter binding. Compare safe form in `deleteSession`. SessionId branding is structural, not enforced at runtime. | `packages/core/src/storage/sqlite-storage.ts:1608`, `packages/core/src/storage/sqlite-storage.ts:1621`, `packages/core/src/storage/sqlite-storage.ts:1226`, `packages/core/src/storage/sqlite-storage.ts:1234`                                                                     |
| W6-24 | P2       | `action.name` / `category` / `keybind` documented in `ActionInput` but silently dropped in the lowering. Slash menus show `"executor-start"` instead of the author-supplied `"Executor: Start"`.                             | `packages/core/src/domain/capability/action.ts:36`, `packages/core/src/domain/capability/action.ts:67`, `packages/core/src/domain/capability/action.ts:87`, `packages/core/src/domain/capability/action.ts:103`, `packages/extensions/src/executor/index.ts:30`                    |
| W6-25 | P2       | Every `request({...})` in task-tools is followed by a hand-rolled `CapabilityRef` re-stating intent/input/output. Typed link lost; intent typo only caught at runtime in `capability-host.ts`.                               | `packages/extensions/src/task-tools/requests.ts:28`, `packages/extensions/src/task-tools/requests.ts:49`, `packages/extensions/src/task-tools/requests.ts:51`, `packages/extensions/src/task-tools/requests.ts:57`, `packages/extensions/src/task-tools/requests.ts:326`           |
| W6-26 | P2       | `tool()` hardcodes `intent: "write"`. Read-only `fs-tools/read.ts`, `grep.ts`, `glob.ts` cannot honestly express read intent. Future read-only sub-agent gates cannot use intent as the filter.                              | `packages/core/src/domain/capability/tool.ts:107`, `packages/core/src/domain/capability/tool.ts:121`, `packages/core/src/domain/capability/tool.ts:139`                                                                                                                            |
| W6-27 | P2       | `app-bootstrap.ts` calls `client.session.create({ cwd })` without `requestId`. Bootstrap-time transient retry produces duplicate sessions. Interactive `createSession` path is correct.                                      | `apps/tui/src/app-bootstrap.ts:223`, `apps/tui/src/app-bootstrap.ts:274`, `apps/tui/src/client/context.tsx:659`                                                                                                                                                                    |
| W6-28 | P2       | Branch mutations (`branch.create` / `branch.fork` / `branch.switch`) carry no `requestId`. Transient retry can fork twice or create two sibling branches.                                                                    | `packages/core/src/server/transport-contract.ts:127`, `packages/core/src/server/transport-contract.ts:193`, `apps/tui/src/client/context.tsx:751`, `apps/tui/src/client/context.tsx:815`                                                                                           |
| W6-29 | P2       | Dedup cache (`createRequestCache` / `sendRequestCache`) leaks: success paths never evict, only failure does. Long-running shared servers accumulate one Map entry per user prompt + per session create indefinitely.         | `packages/core/src/server/session-commands.ts:607`, `packages/core/src/server/session-commands.ts:612`, `packages/core/src/server/session-commands.ts:709`, `packages/core/src/server/session-commands.ts:1102`                                                                    |
| W6-30 | P2       | `Layer.mergeAll` dependency violation in server bootstrap. `SessionRuntimeTerminatorLive` provides a service required by sibling layers in the same `mergeAll` call. TS41 lint warning shipped.                              | `packages/core/src/server/index.ts:8`                                                                                                                                                                                                                                              |
| W6-31 | P2       | `createRpcHarness` referenced in `packages/core/CLAUDE.md` as the canonical RPC acceptance helper does not exist (0 grep results). Rule cannot be followed; C13 ad-hoc layer composition was the only path.                  | `packages/core/CLAUDE.md`                                                                                                                                                                                                                                                          |
| W6-32 | P2       | Method-call-shaped test names cluster. Project rule: "Behavioral naming: describe outcomes, not method calls." 8+ files affected.                                                                                            | `packages/core/tests/extensions/storage.test.ts:44`, `packages/core/tests/domain/auth-storage.test.ts:19`, `packages/core/tests/runtime/config-service.test.ts:18`, `packages/core/tests/extensions/registry.test.ts:314`, `packages/core/tests/runtime/agent-runner.test.ts:1173` |

Clean audit lanes at `c56a1192`:

- No clean lanes this wave. All eight lanes returned at least one finding.

---

## Implementation Batches

Wave 6 batches are sequenced **P1s first, in blast-radius order**, then P2s
clustered by surface. Each batch is one commit (sub-commits allowed if blast
radius > 20 files); each batch gates and is reviewed once. The final batch is
the recursive-audit rerun.

### Commit 1: `fix(extensions): persist ACP-driver tool-result output into transcript`

**Why W6-1 first**: regression of C6 intent on the protocol path — every
successful ACP tool call is currently lossy in the transcript. Pure extension/
runtime change, low blast radius.

**Files**: `packages/extensions/src/acp-agents/executor.ts`,
`packages/core/src/extensions/api.ts` (`ToolCompleted` if `output` field needs
to land on the schema), `packages/core/src/runtime/agent/agent-loop.ts`
(consumer side at lines 925-940), tests.

**Verification**: `bun run gate` + `bun run test:e2e`.

### Commit 2: `fix(tui): read model from snapshot.metrics.lastModelId`

**Why W6-2**: regression of the C10 lesson on the `model` field. TUI shows
wrong model when agent override resolves server-side to a different driver.

**Files**: `apps/tui/src/client/context.tsx` (`model()` and `modelInfo()`),
`apps/tui/src/routes/session.tsx`, tests.

**Verification**: `bun run gate`.

### Commit 3: `fix(tui,sdk): adopt requestId for headless retry, branch mutations, bootstrap session.create`

**Why W6-3 + W6-27 + W6-28 batched**: same pattern, same surface, same
contract addition. Headless duplication is the active P1; bootstrap and branch
duplication are latent P2s on the same retry semantics.

**Files**: `apps/tui/src/headless-runner.ts`,
`apps/tui/src/app-bootstrap.ts`,
`apps/tui/src/client/context.tsx` (createBranch/forkBranch/switchBranch),
`packages/core/src/server/transport-contract.ts`
(CreateBranchInput/ForkBranchInput/SwitchBranchInput requestId fields),
`packages/core/src/server/session-commands.ts` (server-side dedup for branch
mutations), tests.

**Verification**: `bun run gate` + `bun run test:e2e`.

### Commit 4: `feat(providers): expose Provider.Sequence + reconcile docs`

**Why W6-4**: documented-but-missing API. Either add the static (preferred —
matches `Provider.Debug` / `Provider.Failing` shape) or reconcile every doc
reference. P1 because new test authors hit a dead surface.

**Files**: `packages/core/src/providers/provider.ts` (add `Provider.Sequence`
static delegating to `createSequenceProvider`),
`packages/core/src/debug/provider.ts` (decide if standalone export stays or
goes), `AGENTS.md`, `packages/core/CLAUDE.md`, `packages/core/AGENTS.md`,
tests.

**Verification**: `bun run gate`.

### Commit 5: `test: wrap bun-test bodies in Effect.timeout for scope safety`

**Why W6-5**: P1 across 25 sites. Scope finalizers leak on timeout; tests
spawn workers, sqlite, EventPublisher fibers, tempdirs.

**Files**: 7+ test files listed in evidence — `transport-contract.test.ts`,
`capability-permission-rules.test.ts`, `executor-integration.test.ts`,
`skills-rpc.test.ts`, `actor-lifecycle.test.ts`, `task-rpc.test.ts`,
`interaction-commands.test.ts`. Pattern: wrap each test body in
`Effect.timeout("N seconds")` shorter than the bun timeout.

**Verification**: `bun run gate` + `bun run test:e2e`.

### Commit 6: `test(runtime): observe interrupt via state, not Effect.sleep`

**Why W6-6**: small P1, clean fix. Replace wall-clock sleep with state
observation.

**Files**: `packages/core/tests/runtime/agent-loop.test.ts` (line 1809),
possibly `packages/core/src/runtime/agent/agent-loop.state.ts` if a state
predicate is missing.

**Verification**: `bun run gate`.

### Commit 7: `fix(server): type session-commands business validation as RPC errors`

**Why W6-7**: 26 `Effect.die` sites reachable from RPC. Largest blast radius
in the wave; sub-commits allowed.

**Files**: `packages/core/src/server/session-commands.ts` (define typed
errors, replace each `Effect.die` with `Effect.fail` of the typed error),
`packages/core/src/server/transport-contract.ts` (declare error schemas in
RPC response unions), `packages/core/src/server/rpc-handler-groups/session.ts`
(propagate typed errors), `packages/sdk/src/client.ts` (consumer-side typing),
TUI consumers if they currently catch defects, tests.

**Sub-commits permitted**: (7a) define error taxonomy + add to one path;
(7b-d) migrate remaining paths grouped by RPC method.

**Verification**: `bun run gate` + `bun run test:e2e` per sub-commit.

### Commit 8: `refactor(domain): eliminate domain→runtime back-imports`

**Why W6-8**: forbidden direction. Pure refactor. Move `ExtensionRegistry`,
`DriverRegistry`, `ApprovalService`, `RuntimePlatform`, scope-brand types
to wherever they're owned, or re-shape the consuming domain types so they
don't need them.

**Files**: `packages/core/src/domain/auth-guard.ts`,
`packages/core/src/domain/prompt-presenter.ts`,
`packages/core/src/domain/resource.ts`, downstream call sites.

**Verification**: `bun run gate`.

### Commit 9: `refactor(runtime): route agent-runner RunSpec construction through makeRunSpec`

**Why W6-9**: completes C9. Three sites in `agent-runner.ts`.

**Files**: `packages/core/src/runtime/agent/agent-runner.ts` (lines 759, 976,
1123), tests.

**Verification**: `bun run gate`.

### Commit 10: `fix(runtime): add InteractionPendingReader to ephemeral storage override + cwd-resolve via registry on terminate`

**Why W6-10 + W6-11 batched**: both are residual holes in the C1/C4 hardening
of the runtime composition + termination paths. Same surface (descendant +
ephemeral lifecycle), same evidence file, same gate.

**Files**: `packages/core/src/runtime/composer.ts` (`OVERRIDE_TAG_SETS.storage`

- `EphemeralOverrideProvides`), `packages/core/src/server/session-commands.ts`
  (`terminateSessionMachineRuntime` accepts `sessionCwdRegistry`), tests.

**Verification**: `bun run gate` + `bun run test:e2e`.

### Commit 11: `fix(providers): wrap Provider.stream in Effect.fn + preserve cause + fail-closed Bedrock/OpenAI + delete ProviderAuth.Test + drop hardcoded model literal`

**Why W6-12 through W6-16 batched**: all in the providers/AI surface, all
small, all share the gate.

**Files**: `packages/core/src/providers/provider.ts` (stream wrap, cause
preservation), `packages/extensions/src/bedrock/index.ts` (typed error or
removal), `packages/extensions/src/openai/index.ts` (typed error for OAuth
gating), `packages/core/src/providers/provider-auth.ts` (delete `Test`
duplicate), `packages/core/src/runtime/make-extension-host-context.ts:330`
(reuse `DEFAULT_MODEL_ID`), tests.

**Verification**: `bun run gate` + `bun run test:e2e`.

### Commit 12: `refactor(domain): exhaustive event helpers + schemafy Approval/AgentRun + brand AgentName`

**Why W6-17 through W6-20 batched**: domain modeling cluster. All
`Schema.Class`/`TaggedEnumClass` work; touches the same domain files.

**Files**: `packages/core/src/domain/event.ts` (exhaustive `Match.tag` for
`getEventSessionId`/`getEventBranchId`),
`packages/core/src/domain/interaction-request.ts` (single
`Schema.Struct`-derived `ApprovalRequest`/`ApprovalDecision`),
`packages/core/src/domain/agent.ts` (`AgentRunResult` as `TaggedEnumClass`,
`AgentRunToolCall` as `Schema.Struct`, `AgentName` brand), 14 call sites of
`as AgentName`, tests.

**Verification**: `bun run gate` + `bun run test:e2e`.

### Commit 13: `refactor(storage): drop dead todos table + acquire/release PRAGMA foreign_keys + parameterize getSessionAncestors`

**Why W6-21 through W6-23 batched**: storage cluster.

**Files**: `packages/core/src/storage/sqlite-storage.ts` (delete `todos`
schema, migration block, repair query; wrap `PRAGMA foreign_keys = OFF` in
`Effect.acquireUseRelease`; replace `sql.unsafe` recursive CTE with safe
parameter binding), `packages/extensions/src/task-tools-storage.ts`
(acquire/release pattern in migration), tests.

**Verification**: `bun run gate` + `bun run test:e2e`.

### Commit 14: `refactor(extensions): action display fields + request/Ref pairing + tool() intent`

**Why W6-24 through W6-26 batched**: extension authoring API cluster.

**Files**: `packages/core/src/domain/capability/action.ts` (lowering for
`name`/`category`/`keybind` or removal), `packages/core/src/server/extension-health.ts`
or wherever `SlashCommand` is shaped, `packages/extensions/src/executor/index.ts`
(remove duplicated promptSnippet),
`packages/core/src/domain/capability/request.ts` (return `{ token, ref }` or
attach ref via symbol), `packages/extensions/src/task-tools/requests.ts`
(8 sites, delete standalone refs), `packages/core/src/domain/capability/tool.ts`
(accept `intent?: Intent`), `fs-tools/{read,grep,glob}.ts` (mark read), tests.

**Verification**: `bun run gate`.

### Commit 15: `fix(server): TTL/eviction for dedup cache + split Layer.mergeAll dependency`

**Why W6-29 + W6-30 batched**: server bootstrap cluster.

**Files**: `packages/core/src/server/session-commands.ts` (TTL/LRU eviction
on success entries — bounded Map, scheduled cleanup, or evict-on-resolve
after a delay window), `packages/core/src/server/index.ts` (split
`SessionRuntimeTerminatorLive` from sibling layers via `Layer.provideMerge`),
tests.

**Verification**: `bun run gate` + `bun run test:e2e`.

### Commit 16: `test: realize createRpcHarness + rename method-call-shaped tests`

**Why W6-31 + W6-32 batched**: test infrastructure + naming cluster.

**Files**: new `packages/core/src/test-utils/rpc-harness.ts` (or relative
path used from tests), migrate one or two existing tests to demonstrate it,
rename ~30 method-call-shaped test descriptions in 8 files.

**Verification**: `bun run gate`.

### Commit 17 (final): `chore(audit): rerun recursive verification`

**Justification**: same recursive-audit gate as Wave 5 closer. Eight
independent audit lanes against HEAD. If any P1/P2 remains, archive `PLAN.md`
as `plans/WAVE-6.md` with verification receipt and overwrite `PLAN.md` with
the next wave.

**Files**: `plans/WAVE-6.md` + `PLAN.md` (one or the other).

**Verification**:

- `bun run gate`
- `bun run test:e2e`
- Eight independent audit agents (same lane definitions as Wave 5).
