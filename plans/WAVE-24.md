# Planify: Wave 24 — Close Recursive P1s

## Context

Wave 23 fixed durable session creation, deterministic follow-up identity,
background bash process ownership, server root sharing, and root-backed test
harnesses. W23.10 recursive verification at `b822fcf4` found no P0s, but W23
cannot close because three lanes still found P1 blockers:

- actor/durability: two P1s
- architecture/platform/composition: two P1s
- tests/guardrails: three P1s

Effect/AI/STM, extension authority/API, and upstream owned library lanes found
no P0/P1. Scope remains correctness-first; no compatibility carveouts.

## Scope

**In**

- Make all request-id-bearing session/branch operations crash-safe or remove
  misleading request ids where not semantically durable.
- Make background bash supervision restart-durable or explicitly durable in
  its terminal reconciliation semantics.
- Collapse ephemeral child-agent composition into the production root/preset
  path or delete the duplicated graph by introducing a first-class child-root
  preset.
- Move concrete Bun platform provisioning out of `createDependencies` so the
  server root owns platform capabilities.
- Tighten guardrails for test Promise control flow, extension import/export
  boundaries, and exact suppression inventory.
- Re-run recursive verification until no P0/P1 remains.

**Out**

- P2-only upstream DX: `TaggedEnumClass` native-schema migration,
  `effect-wide-event` semantic outcome API, `effect-encore` stateful actor DX,
  and `effect-wide-event` peer-only packaging.
- P2 test timing cleanup for background bash sleeps unless naturally touched by
  the durable supervisor work.

## Gate Command

Primary gate:

```bash
bun run typecheck && bun run lint && bun run fmt:check && bun run build
```

Behavioral gates are listed per batch. `bun run test` remains useful evidence
but currently hits a Bun 1.3.13 signal-5 crash in the concurrent core xargs
shard; isolated package/focused suites must be used as closure evidence until
the runner is changed or Bun stops crashing.

## P1 Findings

### P1 — Branch Request IDs Are Process-Local

`createBranch`, `switchBranch`, and `forkBranch` expose `requestId` in the
transport contract but only dedupe through the process-local request cache.
Branch/fork paths allocate random durable ids, so crash-after-commit retry can
duplicate branch effects.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:52`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:77`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/session-operation-storage.ts:8`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/session-operation-storage.ts:30`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts:357`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts:420`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts:601`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts:884`
- `/Users/cvr/.brain/principles/make-operations-idempotent.md:3`
- `/Users/cvr/.brain/principles/make-operations-idempotent.md:16`

### P1 — Background Bash Supervision Is Not Restart-Durable

The new supervisor owns process lifetime in the current process, but `active`
and `completed` job dedupe are stored only in `Ref`s. A restart loses started
job facts and terminal reconciliation state.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:197`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:206`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:253`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:274`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/exec-tools/bash-execution.test.ts:130`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/exec-tools-background.test.ts:14`
- `/Users/cvr/.brain/principles/make-operations-idempotent.md:3`
- `/Users/cvr/.brain/principles/serialize-shared-state-mutations.md:3`

### P1 — Ephemeral Child Runs Still Hand-Compose A Runtime Root

`buildEphemeralLayer` reconstructs storage, cluster runner, event store,
approval, prompt presenter, tool runner, extension resource layers, and
`SessionRuntime` outside the production/test root path.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ts:171`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ts:204`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ts:596`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ts:685`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/server-root.ts:47`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts:344`
- `/Users/cvr/.brain/principles/boundary-discipline.md:3`
- `/Users/cvr/.brain/principles/subtract-before-you-add.md:3`

### P1 — `createDependencies` Owns Concrete Bun Platform Layers

`server-root.ts` now owns `ServerRootPlatformLayer`, but `dependencies.ts` still
imports and installs `BunPlatformLive`, `BunGentPlatformLive`, and
`BunCronRuntimeLive` internally. The root cannot fully swap platform
capabilities.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/server/server-root.ts:41`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/server-root.ts:52`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts:28`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts:172`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts:422`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/gent-platform.ts:1`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:210`
- `/Users/cvr/.brain/principles/use-the-platform.md:14`

### P1 — Test Promise-Control Guard Misses Test Helper Files

The rule only activates for `*.test.ts(x)` and exempts `*-boundary.ts(x)`, so
helper files under test directories can still use raw `Effect.runPromise` /
runtime Promise exits.

Receipts:

- `/Users/cvr/Developer/personal/gent/lint/no-direct-env.ts:125`
- `/Users/cvr/Developer/personal/gent/lint/no-direct-env.ts:940`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/render-harness.tsx:178`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-test-harness.ts:59`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/helpers.ts:45`
- `/Users/cvr/.brain/principles/prove-it-works.md:17`

### P1 — Extension Internal-Import Guard Misses Re-Exports And Dynamic Imports

`gent/no-extension-internal-imports` only visits `ImportDeclaration`. Shipped
extension source could still re-export or dynamically import
`@gent/core-internal/*` or non-API `@gent/core/*`.

Receipts:

- `/Users/cvr/Developer/personal/gent/lint/no-direct-env.ts:399`
- `/Users/cvr/Developer/personal/gent/lint/no-direct-env.ts:421`
- `/Users/cvr/Developer/personal/gent/packages/tooling/fixtures/packages/extensions/src/no-extension-internal-imports.invalid.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/tooling/tests/fixtures.test.ts:109`
- `/Users/cvr/.brain/principles/boundary-discipline.md:3`
- `/Users/cvr/.brain/principles/prove-it-works.md:19`

### P1 — Suppression Inventory Allows File-Level Carveouts

The suppression guard approves broad files rather than exact reviewed
suppression lines/diagnostics/reasons, so new suppressions in an approved file
can pass without review.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/tooling/src/suppression-inventory.ts:16`
- `/Users/cvr/Developer/personal/gent/packages/tooling/src/suppression-inventory.ts:51`
- `/Users/cvr/Developer/personal/gent/packages/tooling/src/suppression-inventory.ts:80`
- `/Users/cvr/Developer/personal/gent/packages/tooling/tests/suppression-inventory.test.ts:46`
- `/Users/cvr/.brain/principles/prove-it-works.md:3`

## Batches

### W24.1 — Durable Branch Operations

Status: done.

Work:

- Generalized durable operation storage beyond `session.create` with typed
  `branch.create`, `branch.fork`, and `branch.switch` result codecs.
- Moved RPC request-id branch create/fork/switch bodies into
  `SessionCommands` so the storage mutation, event append, and durable
  operation row commit in one transaction.
- Added restart-style regressions for branch create/fork/switch retries over a
  file-backed SQLite database. The retry layers have fresh in-process request
  caches, proving durability comes from SQLite instead of `Ref` state.

Validation:

- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/server/session-idempotency.test.ts packages/core/tests/server/session-commands` — 16 pass, 0 fail
- `bun run typecheck` — pass
- `bun run lint` — pass, 0 warnings/errors
- `bun run fmt:check` — pass

### W24.2 — Durable Background Bash Reconciliation

Status: done.

Work:

- Added `background_bash_jobs` owned by the exec-tools extension, keyed by
  `(session_id, branch_id, tool_call_id)`.
- Background supervisor now claims starts durably, persists completion/failure
  terminal state, and resource startup reconciles pre-restart `running` rows to
  `interrupted`.
- A retry of the same interrupted background tool call emits one deterministic
  failure follow-up instead of spawning duplicate process work.
- Replaced the core deleted-session background assertion's fixed sleep with a
  shell marker + `waitFor` polling path.

Validation:

- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/extensions/tests/exec-tools/bash-execution.test.ts packages/core/tests/extensions/exec-tools-background.test.ts` — 9 pass, 0 fail
- restart-style background bash regression with file-backed storage — covered by `background job interrupted by restart is reconciled once`
- `bun run typecheck` — pass
- `bun run lint` — pass, 0 warnings/errors
- `bun run fmt:check` — pass

### W24.3 — Platform-Owned Dependency Root

Status: done.

Work:

- Removed concrete `BunPlatformLive`, `BunGentPlatformLive`, and
  `BunCronRuntimeLive` provisioning from `createDependencies`.
- `server-root` now owns production FileSystem/Path/ChildProcess/GentPlatform
  and CronRuntime provisioning through `ServerRootPlatformLayer`.
- Added a platform duplication guard that rejects reintroduced Bun platform
  layer provisioning outside approved platform roots/test root presets/app
  shells.

Validation:

- `bun packages/tooling/src/check-platform-duplication-guards.ts` — pass
- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/tooling/tests/platform-duplication-guards.test.ts packages/sdk/tests/server-lock.test.ts packages/e2e/tests/server-lifecycle.test.ts` — 45 pass, 0 fail
- `bun run typecheck` — pass
- `bun run lint` — pass, 0 warnings/errors
- `bun run fmt:check` — pass

### W24.4 — Ephemeral Runs Use A Root Preset

Status: done in `refactor(agent-runner): use ephemeral root preset`.

Work:

- Replace `buildEphemeralLayer`’s hand-built graph with a child-run root preset
  over `createDependencies` / `makeServerRootLayer`, or extract a shared
  dependency-root builder that both server and child runs consume.
- Preserve parent-context forwarding semantics and `Layer.CurrentMemoMap`
  isolation.
- Add guard/test coverage preventing a second app/runtime root in
  `agent-runner.ts`.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/ephemeral-root.ts`
  owns the child-run root preset: child storage, cluster runner, event store,
  local event publisher, approval, prompt presenter, resource manager, tool
  runner, session runtime, extension layer reuse, and fresh memoization.
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ts`
  now consumes `makeEphemeralAgentRootLayer` and no longer hand-composes the
  ephemeral runtime graph.
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts`
  re-exports root-provided platform services into the built core context so
  captured parent contexts can seed child-run roots without Bun-layer
  provisioning in dependency code.
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/profile.ts`
  documents `ephemeral-root.ts` as the child-run caller of the shared extension
  layer builder.
- `/Users/cvr/Developer/personal/gent/packages/tooling/src/platform-duplication-guards.ts`
  and
  `/Users/cvr/Developer/personal/gent/packages/tooling/tests/platform-duplication-guards.test.ts`
  reject reintroduced child-root primitives inside `agent-runner.ts`.
- `/Users/cvr/Developer/personal/gent/packages/tooling/src/suppression-inventory.ts`
  moves the existing extension-layer diagnostic membrane approval from
  `agent-runner.ts` to the extracted root file.

Validation:

- `bun packages/tooling/src/check-platform-duplication-guards.ts` — pass
- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/extensions/executor-integration.test.ts -t "public executor commands"` — 1 pass, 17 filtered, 0 fail
- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/runtime/agent-runner.test.ts packages/core/tests/runtime/external-turn.test.ts packages/core/tests/runtime/session-runtime.test.ts packages/core/tests/extensions/executor-integration.test.ts packages/tooling/tests/platform-duplication-guards.test.ts` — 90 pass, 0 fail
- `bun run typecheck` — pass
- `bun run lint` — pass, 0 warnings/errors
- `bun run fmt:check` — pass

### W24.5 — Strict Guardrail Closure

Status: done in `test(tooling): tighten strict guardrails`.

Work:

- Extend test Promise-control lint to all test-directory helpers that can
  execute tests, while preserving explicit non-test boundaries only where
  justified.
- Extend extension internal-import lint to `ExportNamedDeclaration`,
  `ExportAllDeclaration`, and dynamic `ImportExpression`.
- Replace file-level suppression inventory with exact reviewed suppression
  entries and red fixtures proving new unlisted suppressions fail.

Receipts:

- `/Users/cvr/Developer/personal/gent/lint/no-direct-env.ts` now applies
  `gent/no-promise-control-flow-in-tests` to every TypeScript file under a
  `/tests/` directory, except explicit `*-boundary` files, and extends
  `gent/no-extension-internal-imports` to `ExportNamedDeclaration`,
  `ExportAllDeclaration`, and `ImportExpression`.
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/render-harness-boundary.tsx`,
  `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-test-harness-boundary.ts`,
  and `/Users/cvr/Developer/personal/gent/apps/tui/tests/helpers-boundary.ts`
  make the TUI test Promise adapters explicit boundary files; imports were
  updated to those names.
- `/Users/cvr/Developer/personal/gent/packages/tooling/fixtures/packages/extensions/src/no-extension-internal-imports.invalid.ts`
  now includes import, re-export, export-all, and dynamic import violations.
- `/Users/cvr/Developer/personal/gent/packages/tooling/src/suppression-inventory.ts`
  replaced file-level Effect diagnostic approvals with exact reviewed
  file/line/kind/text entries.
- `/Users/cvr/Developer/personal/gent/packages/tooling/tests/suppression-inventory.test.ts`
  proves an approved file at an unapproved line is still rejected.

Validation:

- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/tooling/tests/fixtures.test.ts packages/tooling/tests/suppression-inventory.test.ts` — 32 pass, 0 fail
- `bun packages/tooling/src/check-suppression-inventory.ts` — pass
- `bun packages/tooling/src/check-core-public-exports.ts` — covered by `bun run lint`, pass
- `bun run typecheck` — pass
- `bun run lint` — pass, 0 warnings/errors
- `bun run fmt:check` — pass

### W24.6 — Recursive Verification

Status: planned.

Work:

- Re-run the same six W23.10 lanes independently.
- If any P0/P1 remains, synthesize Wave 25 and continue.

Validation:

- No P0/P1 findings.
- `bun run typecheck`
- `bun run lint`
- `bun run fmt:check`
- `bun run build`
- `bun run smoke`
- `bun run test:e2e`
- Isolated package/focused test evidence if `bun run test` still hits the Bun
  signal-5 runner crash.
