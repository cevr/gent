# Wave 42 plan

## Frame

- **Source**: opens from `plans/WAVE-41-audit-receipt.md`.
- **Start HEAD**: `22e23c41` (`refactor(runtime): isolate agent loop
context adapter`).
- **W41 status**: implementation complete; `bun run gate` passed at
  `22e23c416251db2df219ae1b4674e1aee2b7259a`.
- **P0**: none.
- **P1**: 25 findings across the W41 closing audit. W42 exists because
  W41's final verification found P1s.
- **Rule**: fix by causal depth, not by local convenience. Owned
  upstream packages are editable design surfaces. If `effect-wide-event`
  or `effect-encore` forces Gent into workarounds, redesign upstream
  first, add changesets/version flow there, then consume the improved
  API in Gent.
- **Upstream release rule**: do not manually update upstream package
  versions. Add a changeset, test Gent against the upstream checkout
  with `file:..`, merge the generated changeset release PR, wait for
  npm `latest` to reflect the published version, then consume that
  published package in Gent.
- **Batching**: sub-commit by architecture seam. Run gate between
  logical units. Use focused upstream package gates before consuming
  upstream changes in Gent.

## Spines

## Progress

### S1 status - complete

- `effect-wide-event@0.3.0` published and consumed. Gent now uses
  upstream semantic outcomes plus `WideEventBoundary.rpc/tool/provider`
  instead of local boundary/result metadata conventions.
- Verification:
  `bun run gate` in `/Users/cvr/Developer/personal/effect-wide-event`
  passed before publish; GitHub Release run `25801820614` succeeded;
  `npm view effect-wide-event version --json` returned `"0.3.0"`;
  Gent `bun run gate` passed after consuming the package.
- Evidence:
  `/Users/cvr/Developer/personal/effect-wide-event/src/wide-event.ts`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts`,
  `/Users/cvr/Developer/personal/effect-wide-event/v3/src/wide-event.ts`,
  `/Users/cvr/Developer/personal/effect-wide-event/v3/src/boundary.ts`,
  `/Users/cvr/Developer/personal/effect-wide-event/test/wide-event.test.ts`,
  `/Users/cvr/Developer/personal/effect-wide-event/v3/test/wide-event.test.ts`,
  `/Users/cvr/Developer/personal/effect-wide-event/.changeset/tall-walls-serve.md`,
  `/Users/cvr/Developer/personal/gent/package.json`,
  `/Users/cvr/Developer/personal/gent/bun.lock`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/wide-event-boundary.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/wide-event-boundary.test.ts`,
  `/Users/cvr/Developer/personal/gent/packages/tooling/tests/platform-duplication-guards.test.ts`.

### S2 status - complete

- **C5 complete**: `effect-encore@0.12.2` published and consumed. Encore
  now exposes actor-specific `State` services from `Actor.toLayer` and
  `Actor.toTestLayer`, mirrored in v3. Gent now reads/watches/list actor
  state through `AgentLoopActor.State` instead of reconstructing
  `ActorAddressResolver | ActorStateRegistry | ActorClientService`.
- **C4 complete for the Gent-local workaround**: `effect-encore@0.12.3`
  published and consumed. Encore now exposes `Actor.provideLayerBuildContext`,
  mirrored in v3, so Gent deleted its local `provideLayerBuildContext`
  helper and uses the upstream API at actor construction.
- **C6 complete after the requirement-leak correction**:
  `effect-encore@0.12.7` is published and consumed. The upstream bug was
  caller actor context precedence, not a need for Gent to pass cluster
  protocol services as public parameters. Encore now preserves caller
  services over actor-layer services in both v4 and v3; Gent verifies this
  through local `file:../effect-encore` first, then consumes the published
  package.
- **Changed finding**: service-owned hidden requirements are allowed when
  the service itself captures and internally provides the actor protocol
  context. `SessionRuntime` now captures `ActorAddressResolver`,
  `AgentLoopActor.Context`, cluster `MessageStorage`, and `Sharding` once
  at construction and provides that internal context only around actor
  protocol operations. That keeps public `SessionRuntime` methods clean
  without forcing callers to pass requirements as parameters.
- **Rejected upstream direction**: cold persisted actor commands are durable,
  but they do not by themselves guarantee local actor assignment/startup for
  synchronous result delivery. Gent therefore warms/materializes the actor
  where synchronous observation is required instead of asking Encore to make
  every persisted send behave like a direct in-memory execute.
- Verification:
  `bun run gate` in `/Users/cvr/Developer/personal/effect-encore`
  passed before each publish; GitHub Release runs `25802698340` and
  `25803441319` succeeded; `npm view effect-encore version --json`
  returned `"0.12.3"`; Gent `bun run typecheck`, `bun run lint`, and
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/core/tests/runtime/session-runtime.test.ts packages/core/tests/runtime/agent-runner.test.ts`
  passed after consuming `0.12.2`; Gent `bun run typecheck` passed after
  consuming `0.12.3`. For `0.12.7`, upstream `bun run gate` passed before
  release, release PR #29 (`changeset-release/main`) was merged, GitHub CI
  run `25810527884` and Release run `25810532320` both passed, and
  `npm view effect-encore version` returned `0.12.7`. Gent verified the
  published package with
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/core/tests/runtime/session-runtime.test.ts packages/core/tests/runtime/agent-loop/actor-command.test.ts packages/core/tests/runtime/agent-loop/recovery-race.test.ts`
  (17 pass) and `bun run gate` (pass).
- Evidence:
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts`,
  `/Users/cvr/Developer/personal/effect-encore/src/index.ts`,
  `/Users/cvr/Developer/personal/effect-encore/test/actor-state.test.ts`,
  `/Users/cvr/Developer/personal/effect-encore/test/types.test.ts`,
  `/Users/cvr/Developer/personal/effect-encore/test/actor-with-scope.test.ts`,
  `/Users/cvr/Developer/personal/effect-encore/v3/src/actor.ts`,
  `/Users/cvr/Developer/personal/effect-encore/v3/src/index.ts`,
  `/Users/cvr/Developer/personal/effect-encore/v3/test/actor-state.test.ts`,
  `/Users/cvr/Developer/personal/effect-encore/v3/test/types.test.ts`,
  `/Users/cvr/Developer/personal/effect-encore/v3/test/actor-with-scope.test.ts`,
  `/Users/cvr/Developer/personal/effect-encore/CHANGELOG.md`,
  `/Users/cvr/Developer/personal/gent/package.json`,
  `/Users/cvr/Developer/personal/gent/bun.lock`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.runtime-context.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/session-runtime.test.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-runner.test.ts`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1816`,
  `/Users/cvr/Developer/personal/effect-encore/v3/src/actor.ts:1877`,
  `/Users/cvr/Developer/personal/effect-encore/test/actor-with-scope.test.ts:119`,
  `/Users/cvr/Developer/personal/effect-encore/test/actor-with-scope.test.ts:123`,
  `/Users/cvr/Developer/personal/effect-encore/v3/test/actor-with-scope.test.ts:121`,
  `/Users/cvr/Developer/personal/effect-encore/v3/test/actor-with-scope.test.ts:125`,
  `/Users/cvr/Developer/personal/gent/package.json:59`,
  `/Users/cvr/Developer/personal/gent/bun.lock:685`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:254`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:276`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:282`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:514`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:577`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:626`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:10`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:26`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop/actor-command.test.ts:242`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop/actor-command.test.ts:255`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop/actor-command.test.ts:287`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop/actor-command.test.ts:305`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop/actor-command.test.ts:353`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop/actor-command.test.ts:369`.

### S4 status - complete

- **C10 complete**: external-driver tool execution now preserves
  `InteractionPendingError` as a typed external-turn failure instead of
  dying or becoming a generic MCP tool error. `ExternalToolRunner.runTool`
  exposes the pending error, the agent loop converts it to
  `InteractionRequested`, and both ACP protocol and Claude Code codemode
  executors record pending interactions across the Promise/MCP boundary
  before failing their external stream.
- **C11 complete**: cached ACP and Claude Code codemode sessions no
  longer retain the first turn's `runTool` callback authority. The
  codemode MCP server now reads a mutable `CodemodeConfig` per request,
  and both session managers refresh that config on cache hits before
  reusing the external session.
- **C12 complete for captured authority**: background bash jobs now
  capture a narrow target (`sessionId`, `branchId`, `toolCallId`, and
  the specific `Session` methods they need) and run the long-lived fork
  under an explicitly replaced process/filesystem context. Background
  delegate jobs now move the durable todo runner out of the tool closure
  and pass only the resolved agent plus `toolCallId`/`Agent.run` target
  into the background runner. Delegate keeps the existing child-fiber
  inheritance semantics; the fixed bug class is the closure over the
  whole request `ExtensionContext`, not a new independent scope model.
- **C13 complete**: stale external tool authority, external interactive
  tool parking, background authority scope, and recovery-start failure
  deadlock now have targeted regressions. Recovery cleanup now has an
  already-held-startup-permit path so startup failure cleanup does not
  re-enter `startupSemaphore`.
- Verification:
  For C13 recovery-start failure, `bun run typecheck` passed and
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/core/tests/runtime/agent-loop/recovery-race.test.ts packages/core/tests/runtime/agent-loop/queue.test.ts`
  passed.
  For C10, `bun run typecheck` passed and
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/core/tests/runtime/agent-loop/external-turn.test.ts packages/extensions/tests/acp-agents/acp-agents.test.ts packages/extensions/tests/acp-agents/claude-sdk-lifecycle.test.ts`
  passed.
  `bun run typecheck` passed; `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/extensions/tests/acp-agents/acp-agents.test.ts packages/extensions/tests/acp-agents/claude-sdk-lifecycle.test.ts`
  passed for C11. For C12, `bun run typecheck` passed and
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/extensions/tests/delegate/delegate-background.test.ts packages/extensions/tests/delegate/delegate-tool.test.ts packages/extensions/tests/exec-tools/bash-execution.test.ts`
  passed.
- Evidence:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:146`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:156`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:212`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:223`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:371`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:388`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop/recovery-race.test.ts:105`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop/recovery-race.test.ts:121`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop/recovery-race.test.ts:126`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop/recovery-race.test.ts:184`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/driver.ts:221`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/driver.ts:241`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:94`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts:96`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts:100`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response.ts:362`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response.ts:395`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.turn-execution.ts:441`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode.ts:51`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode.ts:134`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/executor-boundary.ts:25`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/executor.ts:252`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/executor.ts:259`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/executor.ts:345`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/claude-code-executor.ts:490`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/claude-code-executor.ts:497`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/claude-code-executor.ts:538`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop/external-turn.test.ts:335`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/tests/acp-agents/acp-agents.test.ts:538`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode.ts:41`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode.ts:233`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode.ts:244`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode.ts:279`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/session-manager.ts:127`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/claude-code-executor.ts:378`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/tests/acp-agents/acp-agents.test.ts:342`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:161`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:228`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:245`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:266`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:317`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:376`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:400`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:408`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:413`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:20`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:34`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:44`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:169`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:175`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/tests/exec-tools/bash-execution.test.ts:165`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/tests/exec-tools/bash-execution.test.ts:210`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/tests/exec-tools/bash-execution.test.ts:257`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/tests/exec-tools/bash-execution.test.ts:286`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/tests/exec-tools/bash-execution.test.ts:363`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/tests/exec-tools/bash-execution.test.ts:419`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/tests/delegate/delegate-background.test.ts:8`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/tests/delegate/delegate-tool.test.ts:1`.

### S5 status - partial

- **C18 complete**: SDK package export shape is now guarded by repo
  lint, and the SDK public-surface test asserts the exact stable runtime
  value exports. Internal RPC graph/handler/client construction symbols
  (`GentRpcs`, `RpcHandlersLive`, `makeRpcClient`) remain absent from
  the public runtime surface.
- **C17 docs subfinding complete**: `docs/extensions.md` no longer
  teaches the unpublished `action(...)` callable or `actions` bucket as
  part of the public extension authoring API. The guide now matches the
  current exported surface: `tool(...)`, `request(...)`, `ref`, resources,
  reactions, agents, policies/errors, host facts, and serialization
  helpers.
- **C17 complete**: `defineStateResource(...)` adds a low-ceremony
  `ExtensionState<Value>` service helper that lowers directly to the
  existing Resource primitive. Stateful extension examples now yield a
  scoped service Tag instead of teaching module-scope mutable state.
- **C16 complete for request identity**: `request(...)` no longer
  requires authors to repeat `extensionId`; `defineExtension({ id })`
  binds request refs to the enclosing extension during setup while
  preserving stable exported refs captured before setup. Client-only
  protocol modules that need refs before server setup use
  `defineRequests(extensionId, requestMap)`, so the id is still written
  once per request group rather than once per request.
- **C14-C15 still open**: loop interception and dynamic registration
  have not landed yet. The simple UI action half of C16 remains folded
  into C15's dynamic command/action design because there is no exported
  action primitive today.
- Verification:
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/tooling/tests/core-public-exports.test.ts packages/sdk/tests/public-surface.test.ts`
  passed with 10 tests; `bun run lint` and `bun run typecheck` passed.
  `rg -n "\baction\b|actions|action\(" docs/extensions.md` now only
  finds generic English/reaction wording plus the invariant explicitly
  saying unpublished `actions` buckets are not part of authoring.
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/core/tests/extensions/resource-host.test.ts`
  passed with 10 tests; `bun run typecheck` passed after adding
  `defineStateResource`.
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/core/tests/domain/capability-ref.test.ts packages/core/tests/extensions/define-extension.test.ts packages/extensions/tests/auto/auto-rpc.test.ts packages/extensions/tests/artifacts/artifacts.test.ts packages/extensions/tests/todo/todo-rpc.test.ts packages/extensions/tests/executor/executor-rpc.test.ts packages/extensions/tests/skills/skills-rpc.test.ts`
  passed with 43 tests;
  `bun test --preload ./packages/tooling/src/test-log-preload.ts --preload ./apps/tui/node_modules/@opentui/solid/scripts/preload.ts apps/tui/tests/extension-lifecycle.test.ts`
  passed with 11 tests; `bun run typecheck`, `bun run lint`, and
  `bun run fmt:check` passed after request identity binding.
- Evidence:
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:37`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:66`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:122`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:155`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:165`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:344`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/domain/capability-ref.test.ts:111`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/define-extension.test.ts:207`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto/protocol.ts:36`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/requests.ts:228`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:196`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:219`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:221`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts:140`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts:160`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/contribution.ts:108`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:148`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/resource-host.test.ts:75`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/resource-host.test.ts:115`,
  `/Users/cvr/Developer/personal/gent/examples/extensions/turn-counter.ts:8`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:69`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:260`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:38`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:68`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:225`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:350`,
  `/Users/cvr/Developer/personal/gent/packages/tooling/src/core-public-exports.ts:22`,
  `/Users/cvr/Developer/personal/gent/packages/tooling/src/core-public-exports.ts:136`,
  `/Users/cvr/Developer/personal/gent/packages/tooling/src/check-guardrails.ts:54`,
  `/Users/cvr/Developer/personal/gent/packages/tooling/src/check-guardrails.ts:60`,
  `/Users/cvr/Developer/personal/gent/packages/tooling/tests/core-public-exports.test.ts:195`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/tests/public-surface.test.ts:5`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/tests/public-surface.test.ts:24`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/package.json:5`.

### S6 status - partial

- **C19 complete**: agent-loop queue rows and durable session-operation
  rows now participate in SQLite referential integrity. Queue rows carry
  session/branch foreign keys and cascade with the owning branch/session.
  Durable operation rows now persist the subject session/branch alongside
  result JSON and cascade when the subject is deleted, so idempotency
  replay cannot resurrect deleted session results.
- **C19 migration hardening complete**: the two idempotent `ALTER TABLE`
  helpers now catch only known already-applied SQLite cases (`duplicate
column name` / `already exists`) instead of swallowing every ALTER
  failure.
- **C21 wrapper-call guardrail complete**: `withX(innerCall(...))` and
  `withX(...)(innerCall(...))` now fail custom lint, and existing
  pipeable call sites were migrated to `.pipe(...)`. Non-pipe adapter
  factories such as `withWideEvent(boundaryFactory(...))` stay allowed.
- **C20 client/controller split complete**: `ClientProvider` now
  delegates session/extension event subscriber fan-out to a focused
  client event hub, and the session route controller delegates builtin,
  extension-command, and slash-autocomplete registration to a focused
  command registry. Public hooks and command IDs stay unchanged while the
  oversized route/client modules shed behavior-specific implementation
  detail.
- **C21 cleanup complete**: actor mailbox handlers no longer wrap
  simple workspace-provided operations in outer generator shells, ACP
  executors share one finish-reason normalizer, and workflow helper
  process output projection is a pure map instead of a flatMap wrapper.
- Verification:
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/core/tests/storage/sqlite-session-storage.test.ts`
  passed with 20 tests, the focused interaction/external-turn regression
  files passed with 20 tests, and `bun run gate` passed. For C21,
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/tooling/tests/fixtures.test.ts packages/core/tests/utils/run-process.test.ts packages/extensions/tests/research/research-tool.test.ts packages/sdk/tests/server-lock.test.ts packages/extensions/tests/exec-tools/bash-execution.test.ts`
  passed with 72 tests; `bun run lint`, `bun run typecheck`, and the
  pre-commit gate passed. For C20, focused TUI checks
  `bun test --preload ./packages/tooling/src/test-log-preload.ts --preload ./apps/tui/node_modules/@opentui/solid/scripts/preload.ts apps/tui/tests/client-session-state.test.tsx apps/tui/tests/extension-lifecycle.test.ts apps/tui/tests/composer-render.test.tsx`,
  `bun run typecheck`, `bun run lint`, and `bun run fmt:check` passed.
  For C21 cleanup, focused turn/ACP checks
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/core/tests/runtime/agent-turn-response.test.ts packages/extensions/tests/acp-agents`,
  `bun run typecheck`, `bun run lint`, and `bun run fmt:check` passed.
- Evidence:
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:203`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:219`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:223`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:248`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:295`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:348`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/session-operation-storage.ts:106`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/session-operation-storage.ts:138`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/storage/sqlite-session-storage.test.ts:202`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/storage/sqlite-session-storage.test.ts:268`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/storage/sqlite-session-storage.test.ts:302`,
  `/Users/cvr/Developer/personal/gent/lint/no-direct-env.ts:206`,
  `/Users/cvr/Developer/personal/gent/lint/no-direct-env.ts:234`,
  `/Users/cvr/Developer/personal/gent/lint/no-direct-env.ts:573`,
  `/Users/cvr/Developer/personal/gent/.oxlintrc.json:41`,
  `/Users/cvr/Developer/personal/gent/packages/tooling/fixtures/.oxlintrc.json:24`,
  `/Users/cvr/Developer/personal/gent/packages/tooling/tests/fixtures.test.ts:190`,
  `/Users/cvr/Developer/personal/gent/packages/tooling/fixtures/no-with-wrapper-call.invalid.ts:1`,
  `/Users/cvr/Developer/personal/gent/packages/tooling/fixtures/no-with-wrapper-call.valid.ts:1`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.worker.ts:127`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/message-storage.ts:113`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/event-hub.ts:14`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/event-hub.ts:32`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:328`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:557`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:596`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-command-registry.ts:76`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-command-registry.ts:176`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts:453`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:583`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:613`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:675`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/response-finish.ts:3`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/executor.ts:124`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/claude-code-executor.ts:64`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/workflow-helpers.ts:18`.

### S1 - Upstream wide-event outcome and boundary API

Fix `effect-wide-event` so Gent stops hand-modeling domain outcomes and
boundary ceremony.

- **C1**: Add typed semantic outcome support upstream. The API should
  represent domain failures/warnings separately from transport
  interruption/defect failure, so Gent tools do not encode semantic
  failure as ad hoc envelope metadata.
- **C2**: Add boundary-aware helpers/adapters for RPC, actor, provider,
  and tool scopes. Gent should not remember `WideEvent.set` ordering at
  every call site.
- **C3**: Consume the upstream API in Gent by deleting local workaround
  conventions from wide-event/tool/RPC boundaries.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/wide-event-boundary.ts:24`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/wide-event-boundary.ts:53`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts:238`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts:315`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:256`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:639`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:42`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:56`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:197`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:215`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/wide-event.ts:18`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/wide-event.ts:33`,
  `/Users/cvr/Developer/personal/effect-wide-event/test/wide-event.test.ts:38`,
  `/Users/cvr/Developer/personal/effect-wide-event/test/wide-event.test.ts:53`.

### S2 - Upstream actor layer/state redesign

Fix `effect-encore` so Gent does not rebuild or snapshot actor runtime
internals.

- **C4**: Redesign `Actor.toLayer` around first-class entity build
  dependencies and child override semantics. Delete Gent's local
  `provideLayerBuildContext` workaround after the upstream API lands.
- **C5**: Expose a bound actor state facade/client from `Actor.toLayer`
  so Gent can watch/read/redeliver through the actor surface, not by
  reconstructing `ActorAddressResolver`, `ActorStateRegistry`,
  `ActorClientService`, storage, and sharding context.
- **C6**: Evaluate declaring entity identity once on the actor
  definition and hiding dual cluster/Encore storage tags behind one
  actor runtime storage layer.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.runtime-context.ts:24`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.runtime-context.ts:30`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:14`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:30`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:255`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:456`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.entity-id.ts:1`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.protocol.ts:180`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts:5`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts:80`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:974`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:982`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1066`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1118`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1300`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1328`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1404`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1414`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:419`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:425`,
  `/Users/cvr/Developer/personal/effect-encore/test/actor-with-scope.test.ts:52`,
  `/Users/cvr/Developer/personal/effect-encore/test/actor-with-scope.test.ts:91`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor-state.ts:35`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor-state.ts:84`,
  `/Users/cvr/Developer/personal/effect-encore/src/storage.ts:1`,
  `/Users/cvr/Developer/personal/effect-encore/src/storage.ts:145`.

### S3 - Collapse Gent runtime ownership into the actor

After upstream Encore support exists, delete Gent's duplicated runtime
ownership.

- **C7**: Reduce `SessionRuntime` to a thin actor gateway plus boundary
  validation. Move completion, state reads, queue reads, redelivery,
  diagnostics, and branch termination behind actor messages or generated
  actor client methods.
- **C8**: Collapse AgentLoop helper scopes into one actor-owned entity
  state/service object. Helpers can remain modules, but ownership should
  live in the actor entity.
- **C9**: Move run-bound extension host context construction under actor
  ownership. The actor owns `(workspaceId, sessionId, branchId, agent)`
  and profile, so host context should not be rebuilt by an external
  runtime facade.
- **C7 progress**: Runtime metrics now flow through an `AgentLoop.GetMetrics`
  actor operation. The metrics schema lives with runtime state, the actor
  handler owns event-log projection, and `SessionRuntime.getMetrics`
  validates the durable branch boundary before dispatching to the actor
  instead of reading `EventStorage` directly.
- **C8 complete**: `AgentLoopQueueScope`, `AgentLoopTurnExecutionScope`,
  and `AgentLoopWorkerScope` were deleted. The actor behavior now owns the
  refs, semaphores, queues, and branch/session identity directly, then
  constructs queue, turn execution, and worker helpers with private
  actor-owned context objects. Real Effect requirements still bubble from
  the helper effects; actor-private construction state no longer masquerades
  as Context services.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:152`,
  `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:376`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:166`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:255`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:292`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:458`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:660`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts:326`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.protocol.ts:76`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.protocol.ts:296`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:677`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:101`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:142`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:106`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:288`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:352`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:362`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.queue.ts:36`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.queue.ts:85`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.worker.ts:18`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.worker.ts:42`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.turn-execution.ts:62`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.turn-execution.ts:74`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:46`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:469`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime-context.ts:63`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime-context.ts:78`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:234`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/session.ts:510`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/session.ts:812`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/processor.ts:86`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/processor.ts:807`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/agent-session.ts:1`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/agent-session.ts:313`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/runner.ts:266`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/runner.ts:636`.

### S4 - External driver and background authority correctness

Fix authority lifetime bugs introduced by external driver and background
job boundaries.

- **C10**: Preserve `InteractionPendingError` through external driver
  tool calls so interactive tools park/resume instead of becoming MCP
  text errors.
- **C11**: Make cached external codemode sessions refresh or avoid
  retaining request-scoped tool authority across later turns.
- **C12**: Replace background bash/delegate closures over
  `ExtensionContext` with narrow background job input plus runner
  services.
- **C13**: Add targeted regressions for recovery-start failure deadlock,
  external interactive tool parking, stale external tool authority, and
  background authority scope.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:148`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:219`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:363`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:408`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts:42`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts:92`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts:106`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts:99`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode.ts:212`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode.ts:228`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode.ts:234`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/executor.ts:252`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/executor.ts:260`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/claude-code-executor.ts:486`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/claude-code-executor.ts:492`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/session-manager.ts:48`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/session-manager.ts:132`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:384`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:421`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:78`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:231`.

### S5 - Extension API and SDK public surface

Make authoring expressive without ceremony and make client/public
surfaces explicit.

- **C14**: Add first-class loop interception for input, context,
  tool-call preflight, and tool result handling. Keep named reactions as
  sugar over a typed event/hook model.
- **C15**: Add a session/process-scoped dynamic registration facet for
  tools/commands/actions where static buckets are too rigid.
- **C16**: Derive request/action identity from the enclosing extension
  and split simple UI actions from RPC capability ceremony.
- **C17**: Add low-ceremony scoped state helpers that lower to resources
  internally, and fix docs that mention unexported `action`.
- **C18**: Replace SDK internal RPC graph/transport exports with a
  stable client contract and exact public allow-list tests.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:179`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:199`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:156`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:274`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:332`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:359`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:52`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:78`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:39`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:319`,
  `/Users/cvr/Developer/personal/gent/examples/extensions/turn-counter.ts:1`,
  `/Users/cvr/Developer/personal/gent/examples/extensions/turn-counter.ts:25`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/namespaced-client.ts:4`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/namespaced-client.ts:58`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/index.ts:1`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/index.ts:8`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs.ts:49`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs.ts:181`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:37`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:338`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:222`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:280`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/tool.ts:46`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/tool.ts:55`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1084`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1127`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/test/agent-session-dynamic-tools.test.ts:37`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/test/agent-session-dynamic-tools.test.ts:89`.

### S6 - Durable integrity and cohesion cleanup

Close the remaining P1s and ride along P2s only when the same files are
already open.

- **C19**: Add durable foreign-key/integrity coverage for agent-loop
  queue and session operation rows. Make idempotent migrations swallow
  only known already-applied cases.
- **C20**: Split TUI client context and session controller along
  behavior boundaries after runtime/SDK shape settles.
- **C21**: Apply L1 trace/composable-method cleanup where touched:
  turn response collectors, handler nested gens, pure registry reads,
  dead wrappers, and duplicated finish-reason helpers.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:203`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:306`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/agent-loop-queue-storage.ts:89`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/session-operation-storage.ts:93`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts:218`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts:243`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/event-hub.ts:14`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:328`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:557`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-command-registry.ts:76`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-command-registry.ts:176`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts:453`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:583`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:613`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:675`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response.ts:176`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response.ts:361`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/driver-registry.ts:40`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/response-finish.ts:3`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/executor.ts:124`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/claude-code-executor.ts:64`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/workflow-helpers.ts:18`.

## Closing audit

After S6 lands and all touched upstream packages have published/consumed
changes, run the same 9-lane audit from W41 against fresh HEAD. The
wave closes only when the closing audit reports no P0/P1. Any P2s become
the next ride-along bucket.
