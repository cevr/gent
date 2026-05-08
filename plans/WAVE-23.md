# Planify: Wave 23 — Durable Operations And Minimal Extension Authority

## Thesis

Wave 22 closed the core public export leak, scoped model resolution, read-service
membrane, typed extension failures, and the first runtime composition cleanup.
The recursive verification batch at `2ae1dd53` still found P1s, so Wave 22 is
not closeable. The remaining failures are not Effect primitive misuse; the
Effect/STM lane found no P0/P1. The failures are ownership failures: operations
are not all durably idempotent, extension contexts still carry too much host
authority, and production/test composition still has duplicate roots.

Wave 23 is done only when a fresh six-lane recursive audit reports no P0/P1.
Scope is not a constraint. No backwards compatibility layers.

## Principles Applied

- `/Users/cvr/.brain/principles/never-block-on-the-human.md`
- `/Users/cvr/.brain/principles/redesign-from-first-principles.md`
- `/Users/cvr/.brain/principles/subtract-before-you-add.md`
- `/Users/cvr/.brain/principles/small-interface-deep-implementation.md`
- `/Users/cvr/.brain/principles/boundary-discipline.md`
- `/Users/cvr/.brain/principles/use-the-platform.md`
- `/Users/cvr/.brain/principles/serialize-shared-state-mutations.md`
- `/Users/cvr/.brain/principles/make-operations-idempotent.md`
- `/Users/cvr/.brain/principles/prove-it-works.md`

## Recursive Verification Result

Current audited HEAD: `2ae1dd5317b8f1cedd436c7e2597f98ec6368ab7`.

Clean lanes:

- Effect/AI/STM usage: no P0/P1. Gent is intentionally using Effect AI
  `Toolkit`, not its built-in tool resolver, because Gent owns durable tool
  events, permissions, and cold interactions.
- Upstream owned libraries: no Gent P0/P1 blocked on `effect-machine`,
  `effect-encore`, or `effect-wide-event`. P2 DX opportunities remain.

Blocking lanes:

- Actor/durability: three P1s.
- Architecture/platform/composition: two P1s.
- Extension authority: two P1s.
- Tests/guardrails: two P1s.

## P1 Findings To Close

### P1 — `createSession` Idempotency Is Process-Local

`createSession` request dedup is explicitly in-memory, while session and branch
ids are randomly generated before persistence. A crash after durable creation
and before client acknowledgement can make a retry with the same `requestId`
create a second session.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts:581`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts:604`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts:710`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts:736`
- `/Users/cvr/.brain/principles/make-operations-idempotent.md:3`

Fix direction:

- Add durable operation-id records keyed by workspace, operation, and request id,
  or derive created ids deterministically from the request id.
- Store enough result payload to return the same session/branch ids on retry.
- Treat initial prompt submission as a separate durable child operation.
- Add crash/restart-style regression around create-session retry.

### P1 — Follow-Up Queue Entries Lack Deterministic Identity

`queueFollowUp` creates a random message id. Actor dedup keys off that id, so a
replayed hook, retried background worker, or resumed turn can enqueue the same
logical follow-up more than once.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:607`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:619`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:299`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts:132`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto/index.ts:91`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:217`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop-stm-queue.test.ts:250`
- `/Users/cvr/.brain/principles/make-operations-idempotent.md:16`

Fix direction:

- Extend internal `queueFollowUp` with required deterministic source identity.
- Derive visible message id from source identity.
- Persist queue entries by deterministic key with upsert semantics.
- Add replay/retry regressions for auto and background command producers.

### P1 — Background Bash Workers Are Detached From Actor Lifecycle

Background bash forks scoped process work with `Effect.forkDetach`, so the child
process and completion follow-up are not owned by the session/actor lifecycle.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:94`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:191`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:217`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:225`
- `/Users/cvr/Developer/personal/effect-machine/src/internal/runtime.ts:5`
- `/Users/cvr/Developer/personal/effect-machine/src/cluster/entity-machine.ts:5`
- `/Users/cvr/.brain/principles/serialize-shared-state-mutations.md:3`

Fix direction:

- Replace detached workers with a host-owned resource/supervisor.
- Key background jobs by session, branch, and tool call.
- Let the supervisor own process scope, cancellation, restart reconciliation,
  and idempotent completion follow-up.

### P1 — Production Server Entrypoints Duplicate The Composition Root

`apps/server` and `packages/sdk` assemble the same server dependency graph and
route layer. The SDK path uses `GentPlatform` for process facts; the standalone
server still reads raw `process`/`os` values directly.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/gent-platform.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/gent-platform-bun.ts:74`
- `/Users/cvr/Developer/personal/gent/apps/server/src/main.ts:29`
- `/Users/cvr/Developer/personal/gent/apps/server/src/main.ts:56`
- `/Users/cvr/Developer/personal/gent/apps/server/src/main.ts:62`
- `/Users/cvr/Developer/personal/gent/apps/server/src/main.ts:100`
- `/Users/cvr/Developer/personal/gent/apps/server/src/main.ts:166`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/server.ts:179`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/server.ts:181`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/server.ts:212`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/server.ts:280`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/core/src/cross-spawn-spawner.ts:97`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/core/src/filesystem.ts:10`

Fix direction:

- Extract one core-internal server bootstrap/root builder.
- Make `apps/server` and SDK server call it.
- Keep CLI/env parsing at the edge; all process identity defaults come from
  `GentPlatform` or explicit config.
- Extend platform guard to flag raw app/server `process.platform`, `process.pid`,
  `process.execPath`, `os.hostname`, and similar host facts.

### P1 — Test Harnesses Compose Parallel App Roots

`in-process-layer`, `e2e-layer`, and `rpc-harness` hand-compose variants of the
runtime graph instead of presetting the production dependency root. RPC
acceptance tests can pass while production wiring drifts.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts:103`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts:215`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts:261`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts:402`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/in-process-layer.ts:61`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/in-process-layer.ts:123`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/e2e-layer.ts:104`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/e2e-layer.ts:384`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/rpc-harness.ts:58`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/rpc-harness.ts:70`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/profile.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/profile.ts:20`

Fix direction:

- Make production dependency construction parameterizable for memory storage,
  debug providers, test extensions, identity, and approval overrides.
- Rewrite `baseLocalLayer`, `createE2ELayer`, and `createRpcHarness` as thin
  presets over the same root.
- Add acceptance tests proving production/server and harness paths share the
  same service availability.

### P1 — Read/Minimal Extension Contexts Expose Process Authority

Read-intent requests and default tool contexts still receive `host`, and `host`
contains `runProcess`, `signalPid`, and `parentEnv`. A read request can execute
or signal processes without opting into write authority.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability.ts:63`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability.ts:72`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:391`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:405`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:91`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:102`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:59`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:66`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts:174`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts:189`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:543`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:547`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:629`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:638`

Fix direction:

- Split host into facts-only and process-authority facets.
- Keep facts in default/read contexts.
- Move `runProcess`, `signalPid`, and `parentEnv` behind explicit write-capable
  context leaves or resource services.
- Add compile locks proving read requests/default tools cannot access process
  execution/signaling.

### P1 — `@gent/extensions` Exports Shipped Internals As A Second Authoring Surface

The shipped extension package exports deep implementation/protocol/storage
subpaths, including task internals. That makes builtins privileged by package
surface even though builtins are meant to be only the starting extension set.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/extensions/package.json:5`
- `/Users/cvr/Developer/personal/gent/packages/extensions/package.json:198`
- `/Users/cvr/Developer/personal/gent/packages/extensions/package.json:142`
- `/Users/cvr/Developer/personal/gent/packages/extensions/package.json:151`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/task-widget.tsx:1`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/task-widget.tsx:3`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/background-tasks-dialog.tsx:14`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/background-tasks-dialog.tsx:17`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/tool-renderers.client.tsx:31`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/tool-renderers.client.tsx:34`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/package.json:14`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/package.json:23`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/package.json:11`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/package.json:15`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/specs/tui-plugins.md:42`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/specs/tui-plugins.md:48`

Fix direction:

- Make `@gent/extensions` an internal composition package or reduce it to a
  tiny public surface.
- Move implementation/test-only internals behind `@gent/extensions-internal` or
  relative/internal imports.
- For TUI/client needs, expose stable extension-owned client contracts instead
  of deep imports into shipped implementation files.
- Add an extensions package export guard.

### P1 — Test Guard Allows Raw Promise Test Bodies

The repo bans raw Promise-returning test bodies, but `Effect.runPromise` is
exempted from one boundary rule and not caught by the test-control-flow rule.
Current HEAD still has many tests returning `Effect.runPromise`.

Receipts:

- `/Users/cvr/Developer/personal/gent/AGENTS.md:57`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:453`
- `/Users/cvr/Developer/personal/gent/lint/no-direct-env.ts:481`
- `/Users/cvr/Developer/personal/gent/lint/no-direct-env.ts:919`
- `/Users/cvr/Developer/personal/gent/packages/e2e/tests/e2e.test.ts:37`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/resource-host.test.ts:80`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/plan.test.ts:14`

Fix direction:

- Extend `gent/no-promise-control-flow-in-tests` to flag `Effect.runPromise`,
  `Effect.runPromiseWith`, `Effect.runPromiseExit`, and runtime `.runPromise*`
  in test files.
- Migrate tests to `it.live` / `it.scopedLive`.
- Convert hook cleanup patterns to scoped fixtures or explicit helper boundaries.

### P1 — `@gent/core-internal` Imports Are Not Forbidden In Extensions

Core public exports are locked down, but the lint rule only rejects forbidden
`@gent/core/*` imports. It does not reject `@gent/core-internal/*` from shipped
extension source, and `@gent/extensions` still declares a runtime dependency on
`@gent/core-internal`.

Receipts:

- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:305`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:343`
- `/Users/cvr/Developer/personal/gent/packages/tooling/tests/core-public-exports.test.ts:69`
- `/Users/cvr/Developer/personal/gent/packages/extensions/package.json:203`
- `/Users/cvr/Developer/personal/gent/lint/no-direct-env.ts:421`
- `/Users/cvr/Developer/personal/gent/packages/tooling/fixtures/.oxlintrc.json:10`

Fix direction:

- Extend `gent/no-extension-internal-imports` to reject `@gent/core-internal/*`
  in extension authoring surfaces.
- Add custom-rule fixtures for forbidden `@gent/core-internal/domain/...` and
  forbidden non-API `@gent/core/...` paths.
- Move `@gent/core-internal` out of `@gent/extensions` runtime dependencies if
  only tests need it.

## Positive Findings To Preserve

- Product/task work items are extension-owned. Core `MachineTaskSucceeded` and
  `MachineTaskFailed` are machine/runtime telemetry, not product task domain.
  Receipts:
  - `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event.ts:143`
  - `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event.ts:155`
  - `/Users/cvr/Developer/personal/gent/packages/extensions/src/task-tools/domain.ts`
  - `/Users/cvr/Developer/personal/gent/packages/extensions/src/task-tools-service.ts`
- Builtins are structurally only the starting extension set. Receipts:
  - `/Users/cvr/Developer/personal/gent/packages/extensions/src/index.ts:58`
  - `/Users/cvr/Developer/personal/gent/packages/extensions/src/index.ts:86`
  - `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/profile.ts:216`
  - `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/profile.ts:237`
- `TaggedEnumClass` is a watchlist item, not a P1. It duplicates some native
  Effect Schema affordances but currently preserves stable wire-tag mapping,
  direct constructors, and payload guards. Receipts:
  - `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/Schema.ts:4588`
  - `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/Schema.ts:4679`
  - `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/Schema.ts:4798`
  - `/Users/cvr/Developer/personal/gent/packages/core/src/domain/schema-tagged-enum-class.ts:84`
  - `/Users/cvr/Developer/personal/gent/packages/core/src/domain/schema-tagged-enum-class.ts:205`
  - `/Users/cvr/Developer/personal/gent/packages/core/src/domain/schema-tagged-enum-class.ts:350`

## Batches

### W23.1 — Guard Extension/Core-Internal Boundaries

Status: committed and pushed in `33f158ca`.

Work:

- Extend `gent/no-extension-internal-imports` to forbid `@gent/core-internal/*`
  from shipped extension authoring source.
- Add fixture coverage for forbidden `@gent/core-internal/*` and forbidden
  non-API `@gent/core/*`.
- Remove `@gent/core-internal` from `@gent/extensions` runtime dependencies
  unless a real runtime use remains.

Implementation notes:

- `@gent/core-internal` remains available as a devDependency for extension
  package tests, but shipped extension source is now locked to
  `@gent/core/extensions/api`.

Validation:

- `bun packages/tooling/src/check-core-public-exports.ts`
- `bun run --cwd packages/tooling test`
- `bun run lint`
- `bun run fmt:check`

### W23.2 — Convert Promise Test Bodies To Effect Test Control Flow

Status: implemented locally; ready for commit.

Work:

- Added `Effect.runPromise*` and runtime `.runPromise*` detection to
  `gent/no-promise-control-flow-in-tests` for `.test.ts` / `.test.tsx` files.
- Migrated current raw `runPromise` test bodies to `it.live` /
  `it.scopedLive` or explicit `*-boundary.ts` helpers where a Bun hook,
  runtime adapter, or transform instance extraction must return a Promise.
- Preserved real async boundaries inside `Effect.promise`; boundary helpers are
  now named and searchable instead of hidden inside test bodies.

Validation:

- `bun run --cwd packages/tooling test`
- `bun run lint`
- `bun run typecheck`
- Focused converted test files:
  `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/domain/file-lock.test.ts packages/core/tests/runtime/resource-manager.test.ts packages/core/tests/providers/provider-auth.test.ts packages/core/tests/runtime/agent-loop-streaming.test.ts packages/core/tests/runtime/agent-runner.test.ts packages/core/tests/extensions/extension-surface-locks.test.ts packages/e2e/tests/e2e.test.ts packages/extensions/tests/anthropic/anthropic-keychain-transform.test.ts packages/extensions/tests/openai/openai-codex-transform.test.ts apps/tui/tests/autocomplete-effect-items.test.ts apps/tui/tests/headless-cli-exit.test.ts apps/tui/tests/widgets-render.test.tsx`
- `bun run test`

### W23.3 — Split Host Facts From Process Authority

Status: planned.

Work:

- Define facts-only host view for default/read extension contexts.
- Move process execution, process signaling, and parent env behind explicit
  write-capable facets/resources.
- Migrate shipped extensions to request/write facets explicitly.
- Add compile locks for read requests and default tools.

Validation:

- `cd packages/core && bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/extensions/extension-surface-locks.test.ts tests/runtime/tool-runner.test.ts tests/server/extension-commands-rpc.test.ts`
- `cd packages/extensions && bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/exec-tools tests/anthropic tests/acp-agents`
- `bun run typecheck`
- `bun run lint`

### W23.4 — Close `@gent/extensions` Public Internals

Status: planned.

Work:

- Introduce internal import lane for first-party extension implementation/test
  internals if needed.
- Shrink `@gent/extensions` package exports to the minimal composition/client
  surface.
- Replace TUI/client deep imports with extension-owned stable client contracts.
- Add package export guard for `@gent/extensions`.

Validation:

- `bun packages/tooling/src/check-extension-public-exports.ts`
- `bun run --cwd packages/tooling test`
- TUI focused tests for task widgets/background tasks/tool renderers.
- `bun run typecheck`
- `bun run lint`

### W23.5 — Durable Operation Idempotency

Status: planned.

Work:

- Add durable operation/request-id records for create-session.
- Preserve initial-prompt behavior as a deterministic child operation.
- Add retry/restart regressions.

Validation:

- `cd packages/core && bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/server/session-idempotency.test.ts tests/server/session-commands/*.test.ts tests/runtime/session-runtime.test.ts`
- `bun run typecheck`
- `bun run lint`

### W23.6 — Deterministic Follow-Up Identity

Status: planned.

Work:

- Require deterministic identity for internal follow-up producers.
- Derive message ids from identity and persist queue entries by key.
- Update auto/background command producers.

Validation:

- `cd packages/core && bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/runtime/agent-loop-queue.test.ts tests/runtime/session-runtime.test.ts`
- Focused extension tests for auto and exec-tools background follow-up.
- `bun run typecheck`
- `bun run lint`

### W23.7 — Resource-Owned Background Bash Supervisor

Status: planned.

Work:

- Replace `Effect.forkDetach` background bash execution with a host/resource
  supervisor.
- Key jobs by session, branch, and tool call.
- Own cancellation, restart reconciliation, and completion follow-up in the
  supervisor.

Validation:

- Focused exec-tools tests for background lifecycle and cancellation.
- RPC/runtime regression proving deleted/closed sessions do not receive stale
  background completions.
- `bun run typecheck`
- `bun run lint`

### W23.8 — One Production Server Root

Status: planned.

Work:

- Extract a core-internal server bootstrap/root builder.
- Rewire `apps/server` and SDK server to call it.
- Route process identity through `GentPlatform`.
- Strengthen platform guard for app/server host fact reads.

Validation:

- SDK server tests.
- App server smoke or route construction test.
- `bun run typecheck`
- `bun run lint`
- `bun run build`

### W23.9 — Test Harnesses Use Production Root Presets

Status: planned.

Work:

- Parameterize production dependency construction for test storage, providers,
  identity, extension presets, and approval overrides.
- Rewrite in-process, e2e, and RPC harness layers as presets over that root.
- Delete duplicate graph composition.

Validation:

- `cd packages/core && bun test --preload ../../packages/tooling/src/test-log-preload.ts --reporter=dots tests/test-utils tests/server tests/runtime`
- `bun run test`
- `bun run typecheck`
- `bun run lint`

### W23.10 — Recursive Verification

Status: planned.

Work:

- Launch independent verification agents against the original six lanes:
  Effect/AI/STM, actor/durability, architecture/platform, extension authority,
  tests/guardrails, upstream owned library DX.
- Use `~/.brain/principles`,
  `/Users/cvr/.cache/repo/effect-ts/effect-smol`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono`,
  `/Users/cvr/.cache/repo/anomalyco/opencode`,
  `/Users/cvr/Developer/personal/effect-machine`,
  `/Users/cvr/Developer/personal/effect-encore`, and
  `/Users/cvr/Developer/personal/effect-wide-event`.
- If any P0/P1 remains, synthesize Wave 24 and continue.

Validation:

- No P0/P1 findings.
- `bun run gate`
- `bun run test:e2e`
- `bun run smoke`

## P2 Upstream DX Queue

These do not block Gent correctness but should be upstreamed after the P1 queue:

- `effect-wide-event`: value-level outcome classification for semantic turn
  statuses. Receipts:
  - `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:197`
  - `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:214`
  - `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:891`
- `effect-encore`: stateful actor cell protocol and captured state client.
  Receipts:
  - `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:461`
  - `/Users/cvr/Developer/personal/effect-encore/src/actor-state.ts:87`
  - `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:260`
  - `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:388`
- `effect-machine`: do not reintroduce it for Gent agent loop; consider only a
  smaller schema/reducer helper. Receipts:
  - `/Users/cvr/Developer/personal/effect-machine/src/internal/runtime.ts:190`
  - `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts:249`
