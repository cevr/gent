# Planify: Recursive Hardening Wave 5

## Context

Wave 4 implementation completed through commit `404e6cb8` and was gated. Fresh
final verification then ran eight independent audit lanes at HEAD `404e6cb8`:

1. runtime ownership / actor-model clarity
2. extension API boundaries
3. Effect-native AI integration
4. storage model
5. domain modeling / constructor discipline
6. suppression debt / boundary discipline
7. SDK/TUI adapter debt
8. test taxonomy / behavioral coverage

All eight lanes completed and reported findings. The recursive audit surfaced
two P1s and twelve additional P2s spanning session delete races, transport
capability context, provider auth fail-closed, external-driver transcript
persistence, keychain error classification, domain constructor discipline, JSON
boundary validation, SDK/TUI adapter identity proof, idempotency, and
cwd-scoped public acceptance coverage.

This plan supersedes Wave 4. The plan is not complete until every batch below
is implemented, gated, reviewed once, and a final recursive audit reports no
P1/P2 findings. Wave 4's text is archived at `plans/WAVE-4.md`.

## Scope

- **In**: descendant-delete race, deleted-session stream rejection,
  transport-public action context, cross-scope machine actor shadowing,
  raw-extension loader validation, provider missing-auth fail-closed,
  external-driver tool-call transcript persistence, task/branch FK parity,
  keychain error classification, tagged-enum/protocol type-guard correctness,
  `ExtensionActorStatusInfo` DTO dedup, `RunSpec` constructor migration, TUI
  builtin-agent dependency smell, JSON boundary validation (auto-journal,
  OpenAI/Anthropic OAuth, ACP protocol), identity-probed `server stop`,
  requestId-backed idempotency for `session.create` / `message.send`, public
  RPC acceptance for per-cwd auth/event routing, ACP codemode real-executor
  coverage.
- **Out**: cosmetic refactors, rename churn. (The `packages/tooling/policy/`
  source-scan suite was removed before this wave started; structural locks
  move into custom oxlint rules instead.)

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

| ID    | Severity | Finding                                                                                                                                                                                                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W5-1  | P1       | Descendant delete collects the tree before the durable cascade. A child session created concurrently is durably cascade-deleted but its runtime loop, event stream, and cwd-registry are never cleaned up.         | `packages/core/src/server/session-commands.ts:1024`, `packages/core/src/server/session-commands.ts:1079`, `packages/core/src/server/session-commands.ts:644`, `packages/core/src/server/session-commands.ts:937`, `packages/core/src/storage/sqlite-storage.ts:1209`, `packages/core/src/runtime/event-store-live.ts:100`                                                                                                                                                                                                                                                                                              |
| W5-2  | P1       | `transport-public` actions receive only `CapabilityCoreContext`, so `extension.send/ask` throws. Executor `/executor-start` / `/executor-stop` are advertised but no-op via transport.                             | `packages/core/src/domain/capability/action.ts:45`, `packages/core/src/domain/capability/action.ts:60`, `packages/extensions/src/executor/index.ts:28`, `packages/extensions/src/executor/index.ts:37`, `packages/extensions/src/executor/index.ts:42`, `packages/extensions/src/executor/index.ts:51`, `packages/core/src/server/rpc-handler-groups/extension.ts:200`, `packages/core/src/runtime/extensions/capability-host.ts:52`, `packages/core/src/runtime/extensions/capability-host.ts:232`, `apps/tui/src/extensions/context.tsx:275`, `apps/tui/src/extensions/context.tsx:285`                              |
| W5-3  | P2       | Deleted/missing sessions still accepted by `watchRuntime`, actor `getState/getMetrics`, queue reads, event streams. After restart (tombstones gone), stale clients get ghost idle runtime or silent empty streams. | `packages/core/src/runtime/session-runtime.ts:316`, `packages/core/src/runtime/agent/agent-loop.ts:2088`, `packages/core/src/runtime/agent/agent-loop.ts:3497`, `packages/core/src/runtime/agent/agent-loop.ts:3525`, `packages/core/src/runtime/event-store-live.ts:66`, `packages/core/src/server/rpc-handler-groups/session.ts:81`, `packages/core/src/server/rpc-handler-groups/session.ts:90`, `packages/core/src/server/rpc-handler-groups/session.ts:145`, `packages/core/src/server/rpc-handler-groups/session.ts:148`, `packages/core/src/server/rpc-handler-groups/actor.ts:30`                              |
| W5-4  | P2       | Cross-scope machine actors do not obey extension scope precedence. Project/user machine override decodes with higher-scope protocol but dispatches to the lower-scope actor.                                       | `packages/core/src/runtime/extensions/activation.ts:211`, `packages/core/src/runtime/extensions/registry.ts:81`, `packages/core/src/runtime/extensions/registry.ts:190`, `packages/core/src/runtime/extensions/resource-host/machine-protocol.ts:184`, `packages/core/src/runtime/extensions/resource-host/machine-protocol.ts:197`, `packages/core/src/runtime/extensions/resource-host/machine-lifecycle.ts:323`, `packages/core/src/runtime/extensions/resource-host/machine-engine.ts:93`                                                                                                                          |
| W5-5  | P2       | Loader accepts any object with `manifest.id` + `setup`, bypassing `defineExtension` shape validation. Malformed user/project extensions defect activation instead of failing closed.                               | `packages/core/src/extensions/api.ts:424`, `packages/core/src/extensions/api.ts:487`, `packages/core/src/runtime/extensions/loader.ts:136`, `packages/core/src/runtime/extensions/loader.ts:150`, `packages/core/src/runtime/extensions/loader.ts:240`, `packages/core/src/runtime/extensions/activation.ts:16`, `packages/core/src/runtime/extensions/activation.ts:258`                                                                                                                                                                                                                                              |
| W5-6  | P2       | OpenAI missing-auth path is not fail-closed: when no stored key, no OAuth, and no env var, driver proceeds with `OpenAiClient.layer({})` and fails late as HTTP error. Auth gate lives only in TUI state.          | `packages/core/src/providers/provider.ts:76`, `packages/extensions/src/openai/index.ts:129`, `packages/extensions/src/openai/index.ts:145`, `packages/core/src/server/rpc-handler-groups/actor.ts:17`, `apps/tui/src/routes/session-controller.ts:173`                                                                                                                                                                                                                                                                                                                                                                 |
| W5-7  | P2       | External-driver tool-call / tool-result are emitted as events only, never persisted into message parts. Rebuilt ACP/Claude Code `<historical-transcript>` loses prior tool history.                                | `packages/core/src/runtime/agent/agent-loop.ts:852`, `packages/core/src/runtime/agent/agent-loop.ts:918`, `packages/core/src/runtime/agent/agent-loop.ts:684`, `packages/extensions/src/acp-agents/claude-code-executor.ts:78`, `packages/extensions/src/acp-agents/executor.ts:121`, `packages/extensions/src/acp-agents/transcript.ts:114`                                                                                                                                                                                                                                                                           |
| W5-8  | P2       | `TaskStorage.tasks` has no composite `(branch_id, session_id)` FK. Tasks survive branch delete as orphaned session-visible rows; cross-session `branchId` accepted on create.                                      | `packages/extensions/src/task-tools-storage.ts:155`, `packages/extensions/src/task-tools-storage.ts:169`, `packages/extensions/src/task-tools-storage.ts:188`, `packages/extensions/src/task-tools-storage.ts:204`, `packages/extensions/src/task-tools/projection.ts:27`, `packages/core/src/storage/sqlite-storage.ts:927`, `packages/core/src/storage/sqlite-storage.ts:937`, `packages/core/src/storage/sqlite-storage.ts:1279`                                                                                                                                                                                    |
| W5-9  | P2       | Keychain `get` / `list` swallow every `security` failure as "missing auth", collapsing locked-keychain / denied-access / malformed-command into the same state. Downstream auth expects real errors to surface.    | `packages/core/src/domain/auth-storage.ts:102`, `packages/core/src/domain/auth-storage.ts:130`, `packages/core/src/domain/auth-store.ts:132`, `packages/core/src/domain/auth-guard.ts:132`, `packages/core/tests/domain/auth-store.test.ts:130`, `packages/core/tests/server/auth-rpc.test.ts:178`                                                                                                                                                                                                                                                                                                                     |
| W5-10 | P2       | `TaggedEnumClass.isAnyOf` / `match` only check `_tag`, claiming full variant type. `{ _tag: "Circle" }` passes as `Circle`. Payload-level spoof untouched by Wave-4 protocol sealing.                              | `packages/core/src/domain/schema-tagged-enum-class.ts:335`, `packages/core/src/domain/schema-tagged-enum-class.ts:338`, `packages/core/src/domain/schema-tagged-enum-class.ts:358`, `packages/core/tests/domain/schema-tagged-enum-class.test.ts:118`, `packages/core/tests/domain/schema-tagged-enum-class.test.ts:200`                                                                                                                                                                                                                                                                                               |
| W5-11 | P2       | Extension protocol command/request `.is` predicates check only `extensionId` + `_tag` but narrow to full-payload messages. Callers use it as validation.                                                           | `packages/core/src/domain/extension-protocol.ts:240`, `packages/core/src/domain/extension-protocol.ts:297`, `packages/extensions/src/artifacts/index.ts:183`, `packages/extensions/src/skills/index.ts:89`, `packages/extensions/src/handoff.ts:53`                                                                                                                                                                                                                                                                                                                                                                    |
| W5-12 | P2       | `ExtensionActorStatusInfo` duplicated as domain and transport DTO. Same wire shape, separate class identities, mapper in between. Drift bait.                                                                      | `packages/core/src/domain/extension.ts:79`, `packages/core/src/server/transport-contract.ts:385`, `packages/core/src/server/extension-health.ts:12`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| W5-13 | P2       | `makeRunSpec` smart constructor exists and is compile-locked, but every production extension caller passes raw literals.                                                                                           | `packages/core/src/domain/agent.ts:183`, `packages/core/src/extensions/api.ts:75`, `packages/extensions/src/counsel/counsel-tool.ts:63`, `packages/extensions/src/delegate/delegate-tool.ts:111`, `packages/extensions/src/handoff-tool.ts:43`, `packages/extensions/src/research/research-tool.ts:111`, `packages/extensions/src/session-tools/read-session.ts:140`                                                                                                                                                                                                                                                   |
| W5-14 | P2       | TUI imports `AllBuiltinAgents` to infer model/cost locally. Connected/remote server can run agents the TUI does not know; UI truth diverges from transport contract.                                               | `apps/tui/src/client/context.tsx:21`, `apps/tui/src/client/context.tsx:64`, `apps/tui/src/client/context.tsx:484`, `apps/tui/src/client/context.tsx:803`, `packages/core/src/server/transport-contract.ts:235`, `packages/core/src/runtime/agent/agent-loop.state.ts:273`                                                                                                                                                                                                                                                                                                                                              |
| W5-15 | P2       | JSON at persistence / external-protocol / OAuth boundaries parsed via `JSON.parse(...) as T`. Corrupt-but-parseable rows cross into domain.                                                                        | `packages/extensions/src/auto-journal.ts:132`, `packages/extensions/src/auto.ts:534`, `packages/extensions/src/auto.ts:541`, `packages/extensions/src/auto.ts:600`, `packages/extensions/src/openai/oauth.ts:61`, `packages/extensions/src/anthropic/oauth.ts:352`, `packages/extensions/src/acp-agents/protocol.ts:201`, `packages/extensions/src/acp-agents/protocol.ts:210`                                                                                                                                                                                                                                         |
| W5-16 | P2       | TUI `server stop` filters by host/live PID and SIGTERMs without identity probe. SDK path is already identity-proofed; CLI stop adapter is not.                                                                     | `apps/tui/src/main.tsx:434`, `apps/tui/src/main.tsx:443`, `packages/sdk/src/server.ts:321`, `packages/sdk/src/server.ts:338`, `packages/sdk/src/server-registry.ts:233`, `packages/sdk/src/server-registry.ts:242`                                                                                                                                                                                                                                                                                                                                                                                                     |
| W5-17 | P2       | `requestId` exposed on `session.create` / `message.send` but not enforced. WS retry enabled; handlers forward into logs only. `/new` bypasses the shared client entirely. Retries fork state.                      | `packages/sdk/src/client.ts:226`, `packages/core/src/server/transport-contract.ts:19`, `packages/core/src/server/transport-contract.ts:182`, `packages/core/src/server/rpc-handler-groups/session.ts:40`, `packages/core/src/server/rpc-handler-groups/session.ts:118`, `packages/core/src/server/session-commands.ts:644`, `packages/core/src/server/session-commands.ts:714`, `packages/core/src/server/session-commands.ts:1003`, `packages/core/src/runtime/session-runtime.ts:333`, `apps/tui/src/client/context.tsx:647`, `apps/tui/src/client/context.tsx:822`, `apps/tui/src/routes/session-controller.ts:472` |
| W5-18 | P2       | `auth.listProviders` per-session-cwd behavior has no public RPC acceptance with a distinct cwd. `ConfigService.Test` ignores `cwd`, so a regression back to launch-cwd `get()` would still pass tests.             | `packages/core/src/server/rpc-handler-groups/config.ts:97`, `packages/core/src/domain/auth-guard.ts:98`, `packages/core/src/test-utils/e2e-layer.ts:224`, `packages/core/src/runtime/config-service.ts:321`, `packages/core/tests/server/auth-rpc.test.ts:107`                                                                                                                                                                                                                                                                                                                                                         |
| W5-19 | P2       | Per-cwd event/profile router has unit-shaped coverage but no worker/RPC acceptance with a secondary-cwd session. Secondary-cwd sessions can persist messages while extension actors dispatch to no runtime.        | `packages/core/src/server/dependencies.ts:173`, `packages/core/src/server/dependencies.ts:279`, `packages/core/src/server/event-publisher.ts:274`, `packages/core/tests/server/event-publisher.test.ts:396`, `packages/e2e/tests/transport-contract.test.ts:16`, `packages/e2e/tests/transport-harness.ts:70`                                                                                                                                                                                                                                                                                                          |
| W5-20 | P2       | ACP codemode tool bridge split-tested: codemode tests stub `runTool`, external-turn tests use mock `TurnExecutor`s. Real `makeAcpRunTool` Effect/Promise boundary has no end-to-end coverage.                      | `packages/extensions/src/acp-agents/executor.ts:150`, `packages/extensions/src/acp-agents/executor-boundary.ts:27`, `packages/core/tests/extensions/acp-agents.test.ts:164`, `packages/core/tests/runtime/external-turn.test.ts:80`                                                                                                                                                                                                                                                                                                                                                                                    |

Clean audit lanes at `404e6cb8`:

- No clean lanes this wave. All eight lanes returned at least one P2.

---

## Commit 1: `fix(server): serialize descendant delete against child create`

**Justification**: Session deletion is the lifecycle boundary. Collecting the
descendant tree before the durable cascade leaves a race window in which a new
child is durably cascade-deleted but its runtime loop, event stream, and
cwd-registry survive as ghosts. Correctness over pragmatism: serialize.

**Principles**:

- `serialize-shared-state-mutations`: delete and child-create mutate the same
  durable lineage and must be structurally serialized, not racy-scoped.
- `make-operations-idempotent`: re-running cleanup after a concurrent child
  creation must converge, not skip the new descendant.
- `fix-root-causes`: fix at the ownership boundary (session-commands), not by
  adding post-hoc sweeps.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                  | Change                                                                                                                                      | Lines      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `packages/core/src/server/session-commands.ts`        | serialize child create and descendant delete under a shared lineage lock / exclusive tx; re-collect descendants atomically with the cascade | ~640-1100  |
| `packages/core/src/storage/sqlite-storage.ts`         | expose the transactional seam required for atomic collect + cascade (if not already)                                                        | ~1180-1230 |
| `packages/core/src/runtime/event-store-live.ts`       | route cascade-removed sessions into `removeSession` for every id the cascade touched                                                        | ~90-120    |
| `packages/core/tests/server/session-commands.test.ts` | public RPC regression: create child mid-delete; assert new child's runtime / stream / cwd-registry all cleaned                              | relevant   |

**Verification**:

- Targeted: `bun test packages/core/tests/server/session-commands.test.ts`
- Full: `bun run gate`
- High risk: `bun run test:e2e`

---

## Commit 2: `fix(capabilities): give transport-public actions the wide context`

**Justification**: `action({ public: true })` advertises that the action runs
over the transport surface. Giving the transport path only
`CapabilityCoreContext` while the handler type declares `ModelCapabilityContext`
is a boundary contract violation: all existing public actions call
`extension.send/ask`. Today `/executor-start` / `/executor-stop` silently
no-op over transport.

**Principles**:

- `boundary-discipline`: the transport boundary must satisfy the handler's
  declared context, not a narrow subset.
- `make-impossible-states-unrepresentable`: either all public actions receive
  the wide context, or `public: true` is typed to require a narrower
  signature. Not "declare wide, deliver narrow."
- `small-interface-deep-implementation`: resolve in one place
  (rpc-handler-groups/extension + capability-host), not at every caller.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                        | Change                                                                                                   | Lines    |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------- |
| `packages/core/src/server/rpc-handler-groups/extension.ts`  | build `ModelCapabilityContext` for `transport-public` action dispatch (session/runtime/extension bundle) | ~180-230 |
| `packages/core/src/runtime/extensions/capability-host.ts`   | remove the narrow-ctx proxy that throws on `extension` for `transport-public`                            | ~40-250  |
| `packages/core/tests/server/extension-commands-rpc.test.ts` | public RPC regression: `/executor-start` + `/executor-stop` roundtrip produces extension traffic         | relevant |
| `apps/tui/src/extensions/context.tsx`                       | surface the previously-swallowed failure, or remove the swallow now that the path works                  | ~270-290 |

**Verification**:

- Targeted: `bun test packages/core/tests/server/extension-commands-rpc.test.ts`
- Full: `bun run gate`
- High risk: `bun run test:e2e`

---

## Commit 3: `fix(runtime): reject deleted sessions at all public read boundaries`

**Justification**: Wave 4 added storage-check on dispatch. Read paths
(`watchRuntime`, actor state/metrics, queue reads, event subscriptions) still
return ghost idle state or hang on empty streams after restart, because they
rely on in-memory tombstones. Reads must validate existence at the same
boundary as writes.

**Principles**:

- `boundary-discipline`: every public session-scoped read is a boundary;
  missing durable session is invalid input.
- `terminal-state-exit-safety`: a subscriber to a deleted session must
  terminate explicitly, not wait forever on a silent empty stream.
- `test-through-public-interfaces`: cover via RPC, not only direct runtime.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                     | Change                                                                                 | Lines      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------- |
| `packages/core/src/server/rpc-handler-groups/session.ts` | validate session existence for `events`, `watchRuntime`, queue ops before stream open  | ~75-155    |
| `packages/core/src/server/rpc-handler-groups/actor.ts`   | validate session existence before state/metrics read                                   | ~20-60     |
| `packages/core/src/runtime/event-store-live.ts`          | reject subscription for sessions missing from storage                                  | ~55-80     |
| `packages/core/src/runtime/agent/agent-loop.ts`          | remove the silent "return idle state" path; either validate or refuse                  | ~3490-3530 |
| `packages/core/tests/server/session-commands.test.ts`    | post-delete, cross-process: subscribe/read every public boundary returns typed failure | relevant   |

**Verification**:

- Targeted: `bun test packages/core/tests/server/session-commands.test.ts`
- Full: `bun run gate`
- High risk: `bun run test:e2e`

---

## Commit 4: `fix(extensions): scope-resolve machine actors and reject raw-loaded extensions`

**Justification**: Two boundary leaks in the extension loader/registry:
(a) capabilities respect scope precedence but machine actors do not — a
higher-scope override decodes with its protocol but dispatches to a lower-scope
actor; (b) the loader accepts any `{ manifest.id, setup }` object, bypassing
`defineExtension` validation and letting malformed contributions defect
activation. Both are single-point-of-install boundary failures.

**Principles**:

- `boundary-discipline`: loader and machine-actor selection are install-time
  boundaries. Fail closed on malformed input and respect declared scope.
- `make-impossible-states-unrepresentable`: a duplicate `(extensionId, tag)`
  across scopes must resolve deterministically, not race on registration
  order.
- `migrate-callers-then-delete-legacy-apis`: if raw `GentExtension` objects are
  allowed for tests, keep that path internal and typed, not a leak through
  `loader.installContributions`.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                                      | Change                                                                                                | Lines    |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------- |
| `packages/core/src/runtime/extensions/loader.ts`                          | run every loaded contribution through `defineExtension` validation; fail extension on shape mismatch  | ~130-260 |
| `packages/core/src/runtime/extensions/resource-host/machine-protocol.ts`  | key machine actor registration by `(scope, extensionId, tag)` and resolve by highest-precedence scope | ~180-210 |
| `packages/core/src/runtime/extensions/resource-host/machine-engine.ts`    | use the same scope-aware lookup on dispatch instead of "first match"                                  | ~85-110  |
| `packages/core/src/runtime/extensions/resource-host/machine-lifecycle.ts` | spawn at most one actor per `(extensionId, tag)` winning scope; drop shadowed spawns                  | ~310-340 |
| `packages/core/tests/extensions/loader.test.ts`                           | regression: malformed raw extension fails activation, not mid-install cast                            | relevant |
| `packages/core/tests/extensions/concurrency.test.ts`                      | regression: higher-scope machine override wins protocol + dispatch                                    | relevant |

**Verification**:

- Targeted: `bun test packages/core/tests/extensions/loader.test.ts packages/core/tests/extensions/concurrency.test.ts`
- Full: `bun run gate`

---

## Commit 5: `fix(providers): fail closed when no credential source is available`

**Justification**: The OpenAI driver falling through to `OpenAiClient.layer({})`
when no stored key / OAuth / env var is present violates auth fail-closed.
The TUI auth gate is an observation, not a boundary — non-TUI callers and
initial prompts hit the provider unauthenticated and fail as generic HTTP
errors, masking the real typed auth failure.

**Principles**:

- `boundary-discipline`: credential resolution is the driver boundary; absence
  is a typed `ProviderAuthError`, not a late HTTP failure.
- `fix-root-causes`: close the boundary in the driver, not by asking every
  caller to check first.
- `prove-it-works`: cover non-TUI public RPC paths.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                        | Change                                                                                       | Lines    |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------- |
| `packages/extensions/src/openai/index.ts`                   | remove the unauthenticated fallthrough; return `ProviderAuthError` when no credential source | ~120-150 |
| `packages/extensions/src/anthropic/index.ts`                | same guard for Anthropic                                                                     | relevant |
| `packages/core/src/providers/provider.ts`                   | ensure missing auth maps to `ProviderAuthError` at the driver boundary, not `undefined`      | ~70-120  |
| `packages/core/tests/providers/provider-resolution.test.ts` | regression: missing-everywhere auth returns typed failure before HTTP                        | relevant |
| `packages/core/tests/server/actor-rpc.test.ts`              | non-TUI public RPC: dispatch with no credentials returns typed auth error                    | relevant |

**Verification**:

- Targeted: `bun test packages/core/tests/providers/provider-resolution.test.ts packages/core/tests/server/actor-rpc.test.ts`
- Full: `bun run gate`

---

## Commit 6: `fix(runtime): persist external-driver tool calls and results into transcript`

**Justification**: Wave 4 preserved live user parts. The other half of the same
boundary — external-driver tool calls and results — is still observability-only.
`<historical-transcript>` rebuilds lose tool history exactly where external
codemode sessions depend on it most. ACP/Claude Code adapters already produce
`ToolStarted` / `ToolCompleted` / `ToolFailed`; the collector must turn those
into `Response.makePart("tool-call")` / `tool-result`.

**Principles**:

- `fix-root-causes`: fix the collector boundary, not each driver adapter.
- `derive-dont-sync`: the transcript's tool history must be _derived_ from the
  same stream the event log consumes, not a second free-hand pass.
- `test-through-public-interfaces`: prove via external-turn + transcript-rebuild.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                         | Change                                                                                                                                                                                               | Lines    |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `packages/core/src/runtime/agent/agent-loop.ts`              | map `ToolStarted` / `ToolCompleted` / `ToolFailed` into `Response.makePart("tool-call"/"tool-result")` in the external collector; keep the tool-name via `toolCallId -> toolName` map if not carried | ~840-930 |
| `packages/extensions/src/acp-agents/claude-code-executor.ts` | ensure `toolName` (and enough input metadata) travels with `ToolStarted`                                                                                                                             | ~70-130  |
| `packages/extensions/src/acp-agents/executor.ts`             | same for ACP mapping                                                                                                                                                                                 | ~110-140 |
| `packages/extensions/src/acp-agents/transcript.ts`           | verify `tool-call` + `tool-result` parts render with the existing renderer                                                                                                                           | ~100-140 |
| `packages/core/tests/runtime/external-turn.test.ts`          | regression: multi-tool external turn persists tool parts in stored message                                                                                                                           | ~200-560 |
| `packages/core/tests/extensions/transcript.test.ts`          | regression: rebuilt transcript includes external tool calls and results                                                                                                                              | relevant |

**Verification**:

- Targeted: `bun test packages/core/tests/runtime/external-turn.test.ts packages/core/tests/extensions/transcript.test.ts`
- Full: `bun run gate`
- High risk: `bun run test:e2e`

---

## Commit 7: `fix(storage): add composite FK for task branch and classify keychain errors`

**Justification**: Two storage-layer boundary gaps surfaced in lane 4. Task
rows carry `branch_id` with no composite FK, so a branch delete cascades
messages but not tasks — orphans. Keychain `security` failures all collapse
into "no key", losing the locked-keychain / denied-access signals the rest of
the auth pipeline explicitly expects to surface.

**Principles**:

- `make-impossible-states-unrepresentable`: a task whose branch no longer
  exists should be structurally impossible — not a repair-job concern.
- `boundary-discipline`: the keychain shell boundary must classify
  item-not-found vs real OS failure.
- `fix-root-causes`: add the composite FK + migration; classify at the shell
  boundary, not downstream.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                        | Change                                                                                                              | Lines    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------- |
| `packages/extensions/src/task-tools-storage.ts`             | add `FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE`; validate on create | ~150-210 |
| `packages/extensions/src/task-tools-storage.ts` (migration) | one-shot repair: delete tasks whose `(branch_id, session_id)` is absent                                             | ~1-80    |
| `packages/core/src/domain/auth-storage.ts`                  | classify `security` exit status: only `44` / "item not found" → `undefined`; other failures → `AuthStorageError`    | ~90-140  |
| `packages/core/tests/storage/task-storage.test.ts`          | regression: branch delete cascades tasks; cross-session branch rejected                                             | relevant |
| `packages/core/tests/domain/auth-storage.test.ts`           | regression: locked keychain returns typed error, not `undefined`                                                    | relevant |

**Verification**:

- Targeted: `bun test packages/core/tests/storage/task-storage.test.ts packages/core/tests/domain/auth-storage.test.ts`
- Full: `bun run gate`

---

## Commit 8: `fix(domain): tighten tagged-enum and protocol type guards; dedup ExtensionActorStatusInfo`

**Justification**: Three domain-modeling gaps. `TaggedEnumClass.isAnyOf` /
`match` lie about variant shape (tag-only), `extension-protocol` command/request
`.is` predicates check only envelope and narrow to full payload, and
`ExtensionActorStatusInfo` is forked into two class identities with a mapper
between them. Each is a boundary-discipline miss; together they tempt callers
to treat syntactic checks as validation.

**Principles**:

- `make-impossible-states-unrepresentable`: type guards must not claim what
  they do not verify.
- `derive-dont-sync`: transport DTO and domain class should share the schema
  or declare the difference; do not maintain two identical shapes.
- `boundary-discipline`: predicates are validation contracts; `hasTag` is not
  `isFull`.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                                     | Change                                                                                               | Lines             |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------- |
| `packages/core/src/domain/schema-tagged-enum-class.ts`                   | `isAnyOf` composes per-variant `Schema.is`; `match` validates before dispatch                        | ~320-390          |
| `packages/core/src/domain/extension-protocol.ts`                         | command/request `.is` uses `Schema.is(definition.schema)`; add `hasEnvelopeTag` for the old behavior | ~220-310          |
| `packages/core/src/domain/extension.ts` + `server/transport-contract.ts` | collapse `ExtensionActorStatusInfo` to one source of truth (domain schema reused by transport)       | ~70-90 / ~370-400 |
| `packages/core/src/server/extension-health.ts`                           | drop the identity-mapper; use the unified schema                                                     | ~1-60             |
| `packages/core/tests/domain/schema-tagged-enum-class.test.ts`            | regression: spoofed `{ _tag: "X" }` with wrong payload fails `isAnyOf` and `match`                   | relevant          |
| `packages/core/tests/domain/extension-protocol.test.ts`                  | regression: `.is` rejects tag-only envelope                                                          | relevant          |

**Verification**:

- Targeted: `bun test packages/core/tests/domain/schema-tagged-enum-class.test.ts packages/core/tests/domain/extension-protocol.test.ts`
- Full: `bun run gate`

---

## Commit 9: `refactor(extensions): migrate all RunSpec callers to makeRunSpec`

**Justification**: The smart constructor exists and is compile-locked, but no
production extension uses it. Every new invariant added to `makeRunSpec` will
land in one caller and leak through five others. Finish the migration.

**Principles**:

- `migrate-callers-then-delete-legacy-apis`: the constructor is the API; raw
  literals are the legacy.
- `encode-lessons-in-structure`: lock in the invariant at the call site, not
  in a parallel review discipline.

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`

**Changes**:

| File                                                    | Change            | Lines    |
| ------------------------------------------------------- | ----------------- | -------- |
| `packages/extensions/src/counsel/counsel-tool.ts`       | use `makeRunSpec` | ~55-70   |
| `packages/extensions/src/delegate/delegate-tool.ts`     | use `makeRunSpec` | ~105-120 |
| `packages/extensions/src/handoff-tool.ts`               | use `makeRunSpec` | ~35-50   |
| `packages/extensions/src/research/research-tool.ts`     | use `makeRunSpec` | ~105-120 |
| `packages/extensions/src/session-tools/read-session.ts` | use `makeRunSpec` | ~130-150 |

This is mechanical. If the audit surfaces more call sites during the gate,
delegate the remainder to a `general-purpose` Agent with the pattern + one
worked example per the design-tier / apply-tier split in `~/.claude/CLAUDE.md`.

**Verification**:

- Targeted: `bun run typecheck` catches any mismatches; `bun test` for tool suites
- Full: `bun run gate`

---

## Commit 10: `fix(tui): derive agent model/cost from transport snapshot`

**Justification**: The TUI importing `AllBuiltinAgents` from `@gent/extensions`
to infer model/cost is a boundary leak: a connected/remote server may run
agents the TUI has never seen. UI truth must come from the transport contract,
not from client-side builtin inference. Policy currently misses this because
it only checks `apps/tui/src/main.tsx`.

**Principles**:

- `derive-dont-sync`: UI derives from the transport snapshot; it does not
  sync a local agent registry.
- `boundary-discipline`: remote server contract is authoritative for runtime
  agent identity.

**Skills**: `architecture`, `react`, `test`, `code-style`, `bun`

**Changes**:

| File                                                  | Change                                                                                                                       | Lines                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `packages/core/src/server/transport-contract.ts`      | include resolved agent definition (model, cost, display name) on `runtime.agent`                                             | ~225-260                   |
| `packages/core/src/runtime/agent/agent-loop.state.ts` | populate the new fields on snapshot projection                                                                               | ~265-300                   |
| `apps/tui/src/client/context.tsx`                     | drop `AllBuiltinAgents` / `AgentsByName`; read from snapshot                                                                 | ~15-70, ~480-495, ~795-810 |
| `.oxlintrc.json` (or custom rule)                     | add an import-graph lint rule banning `@gent/extensions` `AllBuiltinAgents` / builtin registry re-exports from `apps/tui/**` | relevant                   |
| `packages/tooling/fixtures/`                          | fixture pair for the new rule                                                                                                | relevant                   |
| `apps/tui/tests/client-context.test.tsx`              | regression: unknown-agent snapshot renders without crashing; cost/model come from snapshot                                   | relevant                   |

**Verification**:

- Targeted: `bun test packages/tooling/tests/fixtures.test.ts apps/tui/tests/client-context.test.tsx`
- Full: `bun run gate`

---

## Commit 11: `fix(boundaries): decode JSON at persistence, OAuth, and ACP boundaries`

**Justification**: Four JSON boundaries still do `JSON.parse(...) as T`:
`auto-journal` replay, OpenAI OAuth JWT claims, Anthropic credential blob, and
ACP line protocol. Parseable-but-wrong JSON crosses into domain types and
defects downstream code.

**Principles**:

- `boundary-discipline`: external JSON is unvalidated input; decode through a
  `Schema`, fail typed.
- `fix-root-causes`: validate once at ingress, not at every downstream access.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                    | Change                                                             | Lines    |
| ------------------------------------------------------- | ------------------------------------------------------------------ | -------- |
| `packages/extensions/src/auto-journal.ts`               | decode `JournalRow` via `Schema`; drop corrupt rows with a warning | ~120-160 |
| `packages/extensions/src/openai/oauth.ts`               | decode JWT payload via `Schema`; typed error on malformed          | ~55-80   |
| `packages/extensions/src/anthropic/oauth.ts`            | decode credential blob via `Schema`                                | ~340-370 |
| `packages/extensions/src/acp-agents/protocol.ts`        | decode child-process JSON via `Schema` before branching on shape   | ~190-230 |
| `packages/extensions/tests/auto-journal.test.ts`        | regression: corrupt row does not cross into replay                 | relevant |
| `packages/extensions/tests/acp-agents-protocol.test.ts` | regression: malformed line rejected before use                     | relevant |

**Verification**:

- Targeted: `bun test packages/extensions/tests/auto-journal.test.ts packages/extensions/tests/acp-agents-protocol.test.ts`
- Full: `bun run gate`

---

## Commit 12: `fix(sdk,tui): identity-probe server stop and enforce idempotent session create/send`

**Justification**: Two SDK/TUI adapter gaps. `server stop` SIGTERMs registry
entries based on PID liveness only — same failure mode Wave 4 closed in the
SDK attach path. `requestId` is exposed on `session.create` /
`message.send` but only forwarded into logs; WS-level retry enabled; retries
can fork state. `/new` in the TUI bypasses the shared client entirely.

**Principles**:

- `boundary-discipline`: `server stop` is the same boundary as SDK attach —
  PID liveness is not identity proof.
- `make-operations-idempotent`: a retried create/send must converge on a
  single session/message id.
- `derive-dont-sync`: `/new` should not have a parallel RPC path.

**Skills**: `architecture`, `effect-v4`, `react`, `test`, `code-style`, `bun`

**Changes**:

| File                                                  | Change                                                                                           | Lines               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------- |
| `apps/tui/src/main.tsx`                               | route `server stop` through the identity-probed helper used by `resolveServer`                   | ~425-460            |
| `packages/sdk/src/server-registry.ts`                 | expose a shared `signalIfIdentityOwned(entry)` helper                                            | ~230-260            |
| `packages/core/src/server/session-commands.ts`        | on repeat `requestId`, return the previously-created session/message id instead of creating anew | ~640-720, ~990-1020 |
| `packages/core/src/runtime/session-runtime.ts`        | preserve `requestId` through `sendUserMessageCommand`                                            | ~325-345            |
| `apps/tui/src/routes/session-controller.ts`           | route `/new` through the shared client (with `requestId`), not raw `session.create`              | ~460-485            |
| `packages/sdk/tests/server-registry.test.ts`          | regression: TUI-path `server stop` refuses to signal PID-reused entries                          | relevant            |
| `packages/core/tests/server/session-commands.test.ts` | regression: duplicate `requestId` converges on single id                                         | relevant            |

**Verification**:

- Targeted: `bun test packages/sdk/tests/server-registry.test.ts packages/core/tests/server/session-commands.test.ts`
- Full: `bun run gate`
- High risk: `bun run test:e2e`

---

## Commit 13: `test(server,extensions): public acceptance for per-cwd auth, event routing, and ACP codemode`

**Justification**: Lane 8's three gaps are coverage, not code — but they gate
regressions on Wave 4 fixes. Prove through the real `ConfigService.Live` + a
distinct session cwd; prove through a worker/RPC session on a secondary cwd;
prove through a real `makeAcpRunTool` executor.

**Principles**:

- `test-through-public-interfaces`: RPC, worker, and real executor paths.
- `prove-it-works`: status is not proof; a test that would catch the
  regression is.
- `encode-lessons-in-structure`: replace `ConfigService.Test` in the
  `auth.listProviders` test with the live variant, so future tests inherit
  the right default.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                | Change                                                                                                        | Lines    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------- |
| `packages/core/tests/server/auth-rpc.test.ts`       | rework to `ConfigService.Live` + a session with a distinct cwd; assert project override is read from that cwd | ~100-180 |
| `packages/core/src/test-utils/e2e-layer.ts`         | option to opt into `ConfigService.Live` for tests that need per-cwd semantics                                 | ~215-240 |
| `packages/e2e/tests/transport-contract.test.ts`     | add a secondary-cwd session; assert events/profile route to the right runtime                                 | relevant |
| `packages/core/tests/extensions/acp-agents.test.ts` | drop the `runTool` stub for the codemode case; drive through `makeAcpRunTool`                                 | ~150-200 |

**Verification**:

- Targeted: `bun test packages/core/tests/server/auth-rpc.test.ts packages/core/tests/extensions/acp-agents.test.ts`
- Full: `bun run gate`
- High risk: `bun run test:e2e`

---

## Commit 14: `chore(audit): rerun recursive verification`

**Justification**: The plan only closes when the same audit surface reports no
P1/P2. Audit output becomes the handoff receipt.

**Principles**:

- `prove-it-works`: final status must be backed by fresh gate/e2e/audit output.
- `test-through-public-interfaces`: final audit checks behavior, not intent.
- `encode-lessons-in-structure`: if P1/P2 remains, archive this plan as
  `plans/WAVE-5.md` and write the next plan to `PLAN.md`.

**Skills**: `planify`, `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                | Change                                                                                                                       | Lines |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----- |
| `plans/WAVE-5.md` (new) + `PLAN.md` | if no P1/P2: archive this as `plans/WAVE-5.md` with final verification receipt; else overwrite `PLAN.md` with next Wave plan | all   |

**Verification**:

- `bun run gate`
- `bun run test:e2e`
- Eight independent audit agents:
  1. runtime ownership / actor-model clarity
  2. extension API boundaries
  3. Effect-native AI integration
  4. storage model
  5. domain modeling / constructor discipline
  6. suppression debt / boundary discipline
  7. SDK/TUI adapter debt
  8. test taxonomy / behavioral coverage

If any P1/P2 remains, overwrite `PLAN.md` with the next recursive Planify plan
and continue.
