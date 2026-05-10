# Planify: Wave 33 — Runtime Authority Closure (yield-don't-thread + dead surface)

## Context

Wave 32 closed the **extension-author-facing** authoring contract: shipped
extensions go through `defineExtension`, reactions are nullary, host services
arrive through `ExtensionContext` facades, and the public barrel hides
`FileIndex`/`FileLockService`/`ExtensionStatePublisher` behind `ctx.Files` /
`ctx.FileLock` / `ctx.State`.

The Wave 32 final independent recursive audit (8 lanes, HEAD `e859ab31`) reports
that contract is internally consistent, but the **runtime layer immediately
behind it** still violates the same spirit:

- `ExtensionContext` is itself threaded as a struct field through one
  background-job supervisor (P0), and 18+ runtime helpers thread other
  Effect-resolvable Tags as parameters instead of yielding them.
- 6 reaction slots and 7 standalone facet Tags are wired in the runtime but
  have zero authors and zero readers (P0 dead surface).
- Core runtime has one synchronous `node:fs.mkdirSync` fallback that breaks
  portability + test isolation (P0).
- Several smaller P1s around hand-rolled tagged-union literals, duplicated
  PubSub primitives, triple-truth cancellation handles, node-builtin imports
  bypassing the suppression inventory, micro-files with single importers, one
  shipped extension still bypassing `defineExtension`, and one unsynchronized
  per-entity actor handle rebuild.

Wave 33 closes those findings before the next independent audit may pass.

## Scope

**In**

- Migrate `BackgroundBashJob` (and the 18 runtime helper sites) from
  context-as-parameter to `yield* Tag` inside the function body, surfacing
  requirements on `R`.
- Delete the 6 unauthored reaction slots and the 7 unyielded `ExtensionXxx`
  standalone Tags; collapse `extensionServicesFromHostContext` to one
  `Context.add(ExtensionContext, …)`.
- Remove `node:fs` synchronous fallback from `runtime/log-paths.ts`; route
  through `FileSystem`. Replace `process.stderr.write` in `runtime/logger.ts`
  with the host-injected `Console`. Add inventory entries (or facade) for the
  remaining `node:crypto`/`node:url`/`node:buffer` imports in core/extensions.
- Replace hand-rolled tagged-union literals in
  `executor/mcp-bridge.ts` and `delegate/delegate-tool.ts` with the schema
  constructors.
- Collapse the duplicated session-PubSub coordination across
  `domain/event.ts` + `runtime/event-store-live.ts` into one shared registry.
- Reduce `ActiveStreamHandle` triple to one `Deferred`-derived source of truth.
- Synchronize the per-entity `handle` rebuild in `agent-loop.actor.ts`.
- Migrate `AnthropicExtension` to `defineExtension`.
- Inline the 11 micro-cohesion files identified in Lane 6 (one canonical
  source for `SCOPE_PRECEDENCE` / `ExtensionScope` is the highest-leverage
  fix).
- Collapse `request` vs `action` capability factories into one `command(...)`
  primitive (or pick one and delete the other). Drop `resource(...)` widener,
  `ExtensionReactionFailureMode` modes, and unused `ExtensionFiles`/
  `ExtensionSession` methods.
- Close upstream `effect-encore` DX gaps that gent demonstrably hits at every
  call site: typed actor state, sender-context bundle, per-handler context
  builder, entityId codec, `waitForState`.
- Rerun the same 8-lane independent audit.

**Out**

- Rewriting the actor protocol or persistence model.
- Touching `effect-machine` (retired) or `effect-wide-event` (no findings).
- Touching legitimate app-boundary Node/Bun usage in `apps/tui` /
  `apps/server`.

## Constraints

- Correctness over pragmatism.
- No backwards compatibility for parameter-threaded Tags, dead reaction slots,
  or the `request`/`action` split.
- Each commit compiles + passes `bun run gate` standalone.
- High-blast-radius commits (e.g. C1 yield-don't-thread sweep, C2 reaction-slot
  deletion) must split into reviewable sub-commits.
- Wave 33 cannot close until a fresh independent audit reports no P0/P1.

## Applicable Skills

- `planify`
- `effect-v4`
- `architecture`
- `test`

## Gate Command

- Standard: `bun run gate`
- Platform-import commits: `bun packages/tooling/src/check-guardrails.ts`
  plus focused tooling tests and `bun run gate`
- Reaction/Tag deletion commits: focused extension surface/reaction tests
  plus `bun run gate`

## Audit Receipts (Wave 32 final, HEAD `e859ab31`)

### P0

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:84-93,155-213,217-223,297-339,405-406`
  — `BackgroundBashJob.ctx: ExtensionContextService` threaded through 7
  helpers + supervisor entry point.
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:225-274`
  — 6 reaction slots (`messageInput`, `contextMessages`, `permissionCheck`,
  `toolExecute`, `turnBefore`, `messageOutput`) wired in
  `runtime/extensions/extension-reactions.ts:253-310` but **zero** shipped
  authors.
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts:130-258,427-451`
  — 7 standalone `ExtensionSession`/`ExtensionAgent`/`ExtensionInteraction`/
  `ExtensionProcess`/`ExtensionFiles`/`ExtensionFileLock`/`ExtensionState`
  Tags added to context on every call but never yielded anywhere.
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/log-paths.ts:14,80-88`
  — synchronous `mkdirSync` from `node:fs` in core.

### P1 — context-as-parameter (Lane 8)

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:238-265,343-349`
  — `AgentLoopBehaviorDeps` bag carries 10 banned Tags as fields.
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-helpers.ts:329-339,377-390,547-587,589-605,625-635,791-808`
  — `resolveDriverToolSurface`, `resolveTurnContext`, `executeToolCalls`,
  `runTurnBeforeHook`, `resolveTurnSource`, `invokeTool` all thread Tag values.
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ts:329-333,517-534`
  — `makeSharedRunnerHelpers` + `runEphemeralAgent` thread `EventPublisher`,
  `GentPlatform`, `EventStore`, `ExtensionRegistry`.
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/ephemeral-root.ts:136-141`
  — `makeEphemeralAgentRootLayer` takes `extensionRegistry` flat alongside
  the `parentServices` snapshot.
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:78-107,131,153,303,442,498,588,659-686`
  — `RpcHandlerDeps` bag for 4 builders + 1 stream helper.
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:52-67,401`
  — `MakeExtensionHostContextDeps` aggregates 7+ Tag values.
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/approval-service.ts:118-134`
  — `makeApprovalInteractionService` accepts `EventPublisher`.
- `/Users/cvr/Developer/personal/gent/packages/core/src/providers/model-resolver.ts:43-47,155`
  — `resolveProviderModel(authStore, defaultRegistry, …)`.
- `/Users/cvr/Developer/personal/gent/packages/core/src/providers/provider-auth.ts:43-45`
  — `makeProviderAuth(driverRegistry)`.
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/model-registry.ts:82-99,101-123`
  — `readCachedModels(fs, …)` / `writeCachedModels(fs, path, …)`.
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/librarian/repo-explorer.ts:308-320,370-378`
  — `getCachePath(path, …)` (exported) + `ensureCached(fs, …)`.
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/memory/vault.ts:463-464`
  — `defaultVaultPath(path, home)`.
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/oauth.ts:17-18`
  — `credentialsFilePath(path, home)`.
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/file-index/native-adapter.ts:53-59,65-69`
  — `toIndexedFile(path, …)` / `makeNativeService(…, path)`.
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts:170-177,179-183`
  — `restoreSessionRuntimeState({ sessionRuntime })` /
  `forgetDeletedSessionRuntimeState({ eventStore })`.
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime-context.ts:119-127,175-180`
  — `resolveExistingSessionBranch({ sessionStorage, branchStorage, … })`.
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-profile.ts:233-250`
  — `sessionProfileFromRuntime({ permissionService, registryService, driverRegistryService, … })`.

### P1 — simplification & schema discipline (Lane 1)

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/mcp-bridge.ts:41-159`
  — 10 hand-rolled `{ _tag: "form" | "url" | … }` literals bypassing
  `ExecutorStructuredContent`/`ExecutorInteraction` schema constructors.
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:285-289`
  — `Effect.succeed<AgentRunResult>({ _tag: "error", … })` bypasses
  `AgentRunResult.Failure.make`.
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event.ts:357-397,485-570`
  - `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/event-store-live.ts:20-131`
    — duplicated per-session PubSub registry.
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response/collectors.ts:27-31,50-72`
  — `ActiveStreamHandle` triple (`AbortController` + `Deferred` + `Ref<boolean>`)
  has three sources of truth for cancellation.

### P1 — actor model adherence (Lane 2)

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:520-738`
  — per-entity `handle` rebuild is unsynchronized; `concurrency: "unbounded"`
  - let-bound `handle` + `Ref` reopen gate races on error recovery.

### P1 — platform abstraction (Lane 3)

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/logger.ts:146`
  — `process.stderr.write` bypasses `Console`/`Logger` injection.
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite/rows.ts:1,156`
  — `node:crypto.createHash` unsuppressed in core storage.
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/memory/vault.ts:10,138`
  — `node:crypto.createHash` unsuppressed in extension.
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/signing.ts:24,61,73`
  — `node:crypto.createHash` unsuppressed in Anthropic provider.
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/sidecar.ts:33,357`
  — `node:url.fileURLToPath` unsuppressed; bypasses `ExecutorPlatform` adapter.
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/openai/oauth.ts:1,83,100,112,117`
  — `node:buffer.Buffer` + global `crypto.getRandomValues` /
  `crypto.subtle.digest` bypass `Random` and platform crypto facades.
- `/Users/cvr/Developer/personal/gent/apps/tui/src/utils/mermaid.ts:9,113`
  — `node:crypto.createHash` deep in TUI utils.
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts:206,291,317`
  — `process.cwd()` defaults at SDK entrypoint instead of yielding `GentPlatform`.

### P1 — extension minimalism (Lane 4)

- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts`
  - `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/action.ts`
  - `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:160-178,290-307`
    — `request({ slash })` and `action({ surface })` are the same primitive.
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/contribution.ts:134-138`
  - `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/index.ts:209-218`
    — `resource(...)` widener used by exactly one call site.
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:208-214`
  - `/Users/cvr/Developer/personal/gent/packages/extensions/src/{handoff.ts:147,auto/index.ts:261}`
    — `ExtensionReactionFailureMode` defines `"continue"` and `"halt"` but only
    `"isolate"` is ever authored.
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:236-274`
  — `PublicExtensionSetupContext.host` re-exposes `commandCandidates`/
  `isPortFree`/`isPidAlive`/`homeDirectory` that already exist on `Process`.
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts:215-230`
  — `ExtensionFiles.searchFiles` / `trackSelection` have zero consumers.
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts:60-128`
  — `ExtensionSession` exposes 9 CRUD methods (`forkBranch`, `createBranch`,
  `switchBranch`, `createChildSession`, `getChildSessions`,
  `getSessionAncestors`, `deleteSession`, `deleteBranch`, `deleteMessages`)
  with zero consumers.

### P1 — upstream library DX (Lane 5)

- `effect-encore`: `getState`/`watchState` lose actor state type; gent
  re-supplies 4 generics at every call site
  (`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:441-456`).
- `effect-encore`: producer-side ops require raw cluster Tags
  (`MessageStorage`, `ActorAddressResolver`, `Sharding`) instead of one
  `Actor.SenderContext` bundle
  (`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:196-217`).
- `effect-encore`: per-handler entityId-decode + storage-facade rewrap is
  hand-rolled (~60 lines) — no `Actor.toLayer({ withScope })`
  (`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:449-516`).
- `effect-encore`: multi-key entityId codec is hand-rolled with collision-
  prone `:` separator
  (`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.entity-id.ts`).
- `effect-encore`: no `Actor.waitForState(predicate)` — gent polls in test
  helpers
  (`/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop/helpers.ts:469-486`).

### P1 — file cohesion (Lane 6)

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/disabled.ts:40-41`
  - `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:131`
  - `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:67`
    — `SCOPE_PRECEDENCE` / `ExtensionScope` redeclared in 3 places. **Highest
    leverage fix in this lane.**
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-protocol.ts`
  — 19 lines, 2 importers, all in `server/`.
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/agent-loop-queue-state.ts`
  — 18 lines, fully re-exported by `runtime/agent/agent-loop.state.ts:15`.
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/projection-error.ts`
  — 7 lines, 1 importer.
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/scope-brand.ts`
  — 18 lines, 1 importer.
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response/collectors.ts`
  — single-file subdirectory.
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto/checkpoint.ts`
  — 43 lines, 1 importer.
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/memory/{agents,dreaming,state}.ts`
  — micro-files; `state.ts` may be dead (no source consumer).
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/{config,executor-boundary,claude-code-auth}.ts`
  — micro-files; each has 1-2 importers.
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/identity.ts`
  — 30 lines; circular-import worry was unfounded.
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash-guardrails.ts`
  — 79 lines, 1 importer.
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/run-with-built-layer.ts`
  — 20 lines, 2 importers.

### P1 — extension authoring spirit (Lane 7)

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/index.ts:254-283`
  — `AnthropicExtension` bypasses `defineExtension` and reaches into the
  privileged runtime `ExtensionSetupContext` (`host.runProcess`,
  `host.parentEnv`).

## Commit 1: refactor(runtime): collapse dead reaction slots and standalone Tags

**Justification**: Six reaction slots and seven standalone facet Tags are
wired but have zero authors and zero readers across all shipped extensions.
A "minimal yet expressive" surface cannot ship six speculative seams or
seven duplicate-of-`ExtensionContext` Tags that only inflate per-call cost.

**Principles**

- `subtract-before-you-add`
- `redesign-from-first-principles`

**Changes**

| File                                                                                                | Change                                                                                                                                                                                                                                                   | Lines              |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts`                          | Delete `messageInput`, `contextMessages`, `permissionCheck`, `toolExecute`, `turnBefore`, `messageOutput` reaction fields + their inputs.                                                                                                                | ~225-274           |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts`    | Delete the matching runtime branches.                                                                                                                                                                                                                    | ~253-310           |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts`                 | Delete `ExtensionSession`, `ExtensionAgent`, `ExtensionInteraction`, `ExtensionProcess`, `ExtensionFiles`, `ExtensionFileLock`, `ExtensionState` standalone Tags. Collapse `extensionServicesFromHostContext` to one `Context.add(ExtensionContext, …)`. | ~130-258, ~427-451 |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/extension-reactions.test.ts`     | Drop deleted-reaction coverage; lock surface against accidental re-introduction.                                                                                                                                                                         | ~1                 |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/extension-surface-locks.test.ts` | Lock 7-Tag deletion + 6-slot deletion.                                                                                                                                                                                                                   | ~500               |

**Verification**

- focused reaction/registry tests
- `bun run typecheck`
- `bun run gate`

## Commit 2: refactor(runtime): remove sync mkdirSync + stderr write from core

**Justification**: Core libraries cannot run on a non-Bun/Node platform or
under `MemoryFileSystem` once a caller hits `getLogPaths()`'s sync path or
`prettyLogger`'s `process.stderr.write`. Both are the only direct platform
reads in `packages/core/src/runtime/`.

**Principles**

- `use-the-platform`
- `boundary-discipline`

**Changes**

| File                                                                            | Change                                                                                           | Lines      |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/log-paths.ts`     | Delete `mkdirSync` fallback; expose only `resolveLogPaths` Effect that yields `FileSystem`.      | ~14, 80-88 |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/logger.ts`        | Replace `process.stderr.write(...)` with `Effect.Console.error(...)` (or Logger-formatted sink). | ~146       |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/utils/client-logger.ts`        | Move sync `mkdirSync` into the TUI entrypoint adapter if still needed at startup.                | ~1         |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/logger.test.ts` | Cover Console-injected output capture.                                                           | ~1         |

**Verification**

- focused logger/log-paths tests
- `bun run gate`

## Commit 3: refactor(runtime): yield don't thread (banned-Tag sweep)

**Justification**: 18 runtime helpers thread Effect-resolvable Tags as struct
fields or positional parameters. Standing rule: yield via `yield* Tag` and
surface on `R`. Threading creates parallel sources of truth, prevents
test-time injection, and inflates every call site with `provideService`
ceremony.

**Principles**

- `effect-v4/no-context-params`
- `boundary-discipline`

**Sub-commit shape** (high blast radius — 6 sub-commits):

- **C3.1 — `BackgroundBashJob` (P0)**: `bash.ts:84-93,155-213,217-223,297-339,405-406`
  drop `ctx: ExtensionContextService` field; supervisor helpers `yield* ExtensionContext`
  inside their Effects. Ship as P0 fix first.
- **C3.2 — `agent-loop.behavior.ts`**: collapse `AgentLoopBehaviorDeps` (10
  Tag fields) into `Effect.gen` body that yields each Tag.
- **C3.3 — `turn-helpers.ts`**: convert
  `resolveDriverToolSurface`, `resolveTurnContext`, `executeToolCalls`,
  `runTurnBeforeHook`, `resolveTurnSource`, `invokeTool` to yield-inside.
- **C3.4 — `agent-runner.ts` + `ephemeral-root.ts`**:
  `makeSharedRunnerHelpers` becomes generator factory; `runEphemeralAgent`
  resolves registry/event-store from `parentServices` snapshot.
- **C3.5 — `rpc-handlers.ts`**: convert 4 `buildXxxRpcHandlers` factories +
  `watchRuntimeStream` to Effect.gen yielding their own Tags.
- **C3.6 — remaining sites** (DONE, commits `a5f975d2` + `f3520cf5`):
  - Sub-batch 1 (`a5f975d2`) — `provider-auth.ts`:
    `makeProviderAuth(driverRegistry)` collapsed into the `Live` body;
    yields `DriverRegistry`, `Auth`, `GentPlatform` inside.
    `model-resolver.ts`: `resolveProviderModel(authStore, defaultRegistry,
request)` reduced to `(request)`; yields `Auth` + `DriverRegistry`
    inside. `Live` snapshots that pair via `Effect.context<...>()` and
    closes per-call resolve effects with `Effect.provideContext`.
  - Sub-batch 2 (`f3520cf5`) — 11 receipt-listed helpers converted to
    yield Tags inside:
    `approval-service.ts` (yields `EventPublisher`),
    `model-registry.ts` (`readCachedModels`/`writeCachedModels` yield
    `FileSystem`+`Path`; layer snapshots `FileSystem | Path` for per-call
    `provideContext`),
    `repo-explorer.ts` (`getCachePath` yields `Path`; `ensureCached`
    yields `FileSystem`),
    `vault.ts` (`defaultVaultPath` yields `Path`),
    `oauth.ts` (`credentialsFilePath` yields `Path`),
    `native-adapter.ts` (`ensureDbDir` yields `FileSystem`+`Path`),
    `session-commands.ts` (`cleanup`/`restore`/`forgetDeleted`
    `SessionRuntimeState` yield `SessionRuntime`/`EventStore`; mutation
    callers use snapshot+`provideContext`),
    `session-runtime-context.ts` (`resolveExistingSessionBranch` yields
    `SessionStorage`+`BranchStorage`),
    `session-runtime.ts` (`requireSessionBranch` provides snapshot),
    `interaction-commands.ts` (provides snapshot to call site).

  **Retained (counsel-validated resolved-snapshot boundaries)**:
  `MakeExtensionHostContextDeps` in `make-extension-host-context.ts`,
  `ResolveSessionEnvironmentParams` in `session-runtime-context.ts`,
  `sessionProfileFromRuntime` in `session-profile.ts`,
  `makeNativeServiceFromModule(dbDir, path)` in `native-adapter.ts`
  (Path captured inside synchronous FFI-returning closures). These
  carry already-resolved service snapshots, not Tag-resolvable services.
  Same boundary pattern as the `provideRuntime` snapshot used by
  `agent-loop.behavior.ts:288-353`. Counsel verdict at `f3520cf5`: PASS.

**Verification per sub-commit**

- focused tests for the touched module
- `bun run typecheck`
- `bun run gate`

## Commit 4: refactor(extensions): migrate Anthropic to defineExtension

**Justification**: 24/25 shipped extensions go through `defineExtension`. The
Anthropic provider is the lone holdout, reaching `host.runProcess` /
`host.parentEnv` from the privileged runtime ctx; this contradicts the public
authoring contract.

**Principles**

- `redesign-from-first-principles`
- `make-the-right-thing-easy`

**Changes**

| File                                                                                                        | Change                                                                                                                                                                                           | Lines    |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/index.ts`                             | Convert to `defineExtension({ id, modelDrivers: () => Effect.gen(function*() { const ctx = yield* ExtensionSetupContext; const platform = AnthropicPlatform.fromSetup(ctx); return [...] }) })`. | ~254-283 |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/platform-adapter.ts`                  | Collapse to a single `fromSetup(ctx: PublicExtensionSetupContext)` that reads `host.homeDirectory` internally; delete dead `fromHost`/`Live`. ACP call site also updated to `fromSetup(ctx)`.    | ~1-30    |
| `/Users/cvr/Developer/personal/gent/packages/extensions/tests/anthropic/anthropic-platform-adapter.test.ts` | New: regression lock that `fromSetup` sources `home` from `host.homeDirectory`, not `ctx.home` (the OS-vs-Gent-home distinction is what the credential-file path depends on).                    | ~1       |
| `/Users/cvr/Developer/personal/gent/packages/extensions/tests/anthropic/*.test.ts`                          | Update setup-time fixtures to the public surface (`AnthropicPlatform.of(...)` direct construction).                                                                                              | ~1       |

**Sub-commits**: `f9d7c51b` (initial migration to `defineExtension`), `66ddbe7b` (delete dead `fromHost`/`Live`; restore OS-home semantics in index.ts), `3f41a12c` (close `fromSetup` over full setup-ctx; ACP call site fixed; counsel-driven structural fix). Counsel verdicts: revise → revise → pass-equivalent (process advisories only).

**Verification**

- focused anthropic + define-extension tests
- `bun run gate`

## Commit 5: refactor(domain): collapse hand-rolled tagged-union literals

**Justification**: `executor/mcp-bridge.ts` and `delegate/delegate-tool.ts`
construct tagged-union variants as `{ _tag: "X", … } satisfies Union` instead
of via the schema constructors. CLAUDE.md rule: construct via
`Variant.make({...})`.

**Changes**

| File                                                                                   | Change                                                                                                                                                  | Lines    |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/mcp-bridge.ts`    | Replace 10 literal sites with `ExecutorCompleted.make`/`ExecutorFailed.make`/`ExecutorWaitingForInteraction.make`/`ExecutorInteraction{Form,Url}.make`. | ~41-159  |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts` | Replace `Effect.succeed<AgentRunResult>({ _tag: "error", … })` with `AgentRunResult.Failure.make({ … })`.                                               | ~285-289 |

**Verification**

- focused executor + delegate tests
- `bun run gate`

**Status (2026-05-10)**: `f1e7d2b8` + fixup `6f8f01f9`. Counsel verdict
`revise` flagged a behavioral regression in the collapsed
`normalizeInteraction` (single computed-kind selector no longer
fell through `_tag` → `kind` for malformed tagged branches);
fixup restored the two-pass form via a `tryInteraction` helper.
Gate green at `6f8f01f9` (typecheck cached, lint clean, build 0.13s,
561 ext + 50 core + tui + sdk + tooling pass). Per
`feedback_one_revision_per_commit`, no second counsel pass.

## Commit 6: refactor(runtime): collapse duplicated PubSub coordination

**Justification**: `domain/event.ts` (`makeSerializedEventDelivery` +
`makeMemoryEventStore`) and `runtime/event-store-live.ts` independently
hand-roll the same per-session PubSub registry. Two implementations of one
primitive drift independently.

**Changes**

| File                                                                                            | Change                                                          | Lines              |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------ |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-pubsub-registry.ts` (new) | Extract `SessionPubSubRegistry` (PubSub + Ref<HashMap>) helper. | new                |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event.ts`                          | Consume the shared registry; drop in-file duplicate.            | ~357-397, ~485-570 |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/event-store-live.ts`              | Consume the shared registry; drop in-file duplicate.            | ~20-131            |

**Verification**

- focused event-store + session-pubsub tests
- `bun run gate`

## Commit 7: refactor(runtime): one truth for ActiveStreamHandle cancellation

**Justification**: `ActiveStreamHandle` carries `AbortController` +
`Deferred<void>` + `Ref<boolean>` for the same concept. Authors must keep
all three in lockstep; divergence is a latent correctness bug.

**Changes**

| File                                                                                             | Change                                                                                                          | Lines          |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response/collectors.ts` | Reduce to `Deferred<void>`; derive a finalizer that aborts the underlying `AbortController` for AI SDK interop. | ~27-31, ~50-72 |

**Verification**

- focused turn-response tests
- `bun run gate`

## Commit 8: refactor(actor): synchronize per-entity handle rebuild

**Justification**: `agent-loop.actor.ts` actor mailbox is `concurrency: "unbounded"`,
but `ensureStarted`/`openLoop` reassigns the per-entity `handle` let-binding
from any caller without serialization. Concurrent error-recovery races leak
fibers and produce torn reads of `loopRef`/`turnWorkerQueue`.

**Changes**

| File                                                                                                    | Change                                                                                                                                        | Lines    |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts`                | Wrap `openLoop` + `ensureStarted` reopen branch in `Semaphore.withPermits(1)`, OR move `let handle` into a `SynchronizedRef` for atomic swap. | ~520-738 |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop/recovery-race.test.ts` (new) | Empirically prove concurrent error-recovery does not race (driver: parallel `submit` after forced crash, assert single `loopRef`).            | new      |

**Verification**

- focused agent-loop recovery test
- `bun run gate`

## Commit 9: refactor(domain): collapse capability primitives + dead surface

**Justification**: `request({ slash })` and `action({ surface })` are the
same primitive with two ergonomic shapes; `resource(...)` widener has one
call site; `ExtensionReactionFailureMode` ships unused `"continue"`/`"halt"`
modes; `ExtensionFiles.searchFiles`/`trackSelection` and 9
`ExtensionSession.*` CRUD methods have zero consumers; `host.commandCandidates`/
`isPortFree`/`isPidAlive`/`homeDirectory` overlap with `Process` on
`PublicExtensionSetupContext`.

**Changes** (multiple sub-commits; high blast radius):

- **C9.1**: Collapse `request`/`action` into one `command({ id, audience: "model" | "user" | "ext", slash?, surface?, … })` factory (or pick `request` and delete `action`). Migrate `PlanAction`/`AuditAction`/`HandoffAction`.
- **C9.2**: Delete `resource(...)` widener; fix `acp-agents/index.ts:209-218` call site.
- **C9.3**: Delete `failureMode` from `ExtensionReaction<>`; runtime always uses isolate semantics.
- **C9.4**: Delete unused `ExtensionFiles.searchFiles` + `trackSelection`.
- **C9.5**: Delete 9 unused `ExtensionSession.*` CRUD methods.
- **C9.6**: Drop `host.commandCandidates`/`isPortFree`/`isPidAlive`/`homeDirectory` from `PublicExtensionSetupContext`.

**Verification**

- focused capability/registry/setup tests per sub-commit
- `bun run gate`

## Commit 10: refactor(platform): cover remaining node-builtin imports

**Justification**: 7 unsuppressed `node:*` imports in core/extensions. Either
push behind a `GentPlatform.hash` / `GentPlatform.fileURLToPath` /
`GentPlatform.randomBytes` facade (preferred — keeps core node-free), or add
explicit suppression-inventory entries.

**Changes**

| File                                                                              | Change                                                                                                               | Lines                    |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------- | --- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/platform/gent-platform.ts`  | Add `hash(algorithm: "sha256"                                                                                        | "md5", input: Uint8Array | string)`, `randomBytes(n)`, `fileURLToPath` capabilities. | ~1  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite/rows.ts`     | Replace `createHash` with `GentPlatform.hash`.                                                                       | ~1, 156                  |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/memory/vault.ts`      | Replace `createHash` with `ctx.host`-routed hash (or yield `GentPlatform`).                                          | ~10, 138                 |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/signing.ts` | Replace `createHash` calls.                                                                                          | ~24, 61, 73              |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/sidecar.ts`  | Move `fileURLToPath` into existing `ExecutorPlatform` adapter.                                                       | ~33, 357                 |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/openai/oauth.ts`      | Replace `crypto.getRandomValues` with `Random.nextBytes`; route SHA-256 + base64url through platform/Effect helpers. | ~1, 83, 100, 112, 117    |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/utils/mermaid.ts`                | Inject hash via `useEnv()`/`GentPlatform`, or use a non-crypto cache key (length+first-32-chars).                    | ~9, 113                  |
| `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts`                   | Take `cwd` from `GentPlatform.cwd`; fall back to `process.cwd()` only inside Bun adapter.                            | ~206, 291, 317           |

**Verification**

- `bun packages/tooling/src/check-guardrails.ts`
- `bun run gate`

## Commit 11: refactor(files): collapse micro-cohesion files

**Justification**: 11 single-importer / micro files exist below the threshold
where a separate file pays for itself. Highest leverage: 3-place
`SCOPE_PRECEDENCE` / `ExtensionScope` redeclaration is silent drift surface.

**Sub-commit shape** (low risk, can batch):

- **C11.1**: Single source of truth for `SCOPE_PRECEDENCE` / `ExtensionScope` in `domain/extension.ts`; delete duplicate in `disabled.ts`; replace inline `SCOPE_ORDER` in `extension-reactions.ts`.
- **C11.2**: Inline `domain/extension-protocol.ts` → `server/errors.ts`.
- **C11.3**: Inline `domain/agent-loop-queue-state.ts` → `runtime/agent/agent-loop.state.ts`.
- **C11.4**: Inline `domain/projection-error.ts` and `domain/scope-brand.ts`.
- **C11.5**: Flatten `runtime/agent/turn-response/collectors.ts` → `runtime/agent/turn-response.ts` (or absorb into `turn-helpers.ts`).
- **C11.6**: Inline `extensions/auto/checkpoint.ts`, `extensions/memory/{agents,dreaming,state}.ts`, `extensions/acp-agents/{config,executor-boundary,claude-code-auth}.ts`, `extensions/todo/identity.ts`, `extensions/exec-tools/bash-guardrails.ts`, `runtime/run-with-built-layer.ts`.

**Verification per sub-commit**

- `bun run gate`

## Commit 12: chore(upstream): close encore DX gaps

**Justification**: Five DX paper-cuts that compound across every gent call
site. Lift them upstream into `effect-encore` so gent and any future encore
user benefits.

**Changes** (in `/Users/cvr/Developer/personal/effect-encore/`):

| Library change                                                                                                                             | Change                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `defineActor` / `Actor.fromEntity` carries optional `state: { schema; error? }`; `getState`/`watchState` return typed `Effect<State, ...>` | Resolves the gent generic-erasure leak.                                                           |
| `Actor.SenderContext` Tag bundles `MessageStorage \| ActorAddressResolver \| Sharding`                                                     | Producer-side ops require the bundle, not the raw cluster Tags.                                   |
| `Actor.toLayer({ withScope: (address) => Effect<Context<S>, ...> })`                                                                       | Per-actor-instance scope context builder; gent `agent-loop.actor.ts:449-516` becomes a one-liner. |
| `Actor.entityIdCodec(schema: Schema<Tuple>)` + `Actor.fromEntity({ key: schema })`                                                         | Multi-key entityId becomes typed + collision-safe; gent's hand-rolled codec deletes.              |
| `Actor.waitForState(entityId, predicate, options?)`                                                                                        | Streaming bound to actor `State`; replaces gent's `waitForPhase` polling helper.                  |

After upstream lands, gent migrates the corresponding sites in:

- `packages/core/src/runtime/session-runtime.ts:196-217,441-456`
- `packages/core/src/runtime/agent/agent-loop.actor.ts:449-516`
- `packages/core/src/runtime/agent/agent-loop.entity-id.ts`
- `packages/core/tests/runtime/agent-loop/helpers.ts:469-486`

**Verification**

- `effect-encore` library tests + gent `bun run gate`

## Final Batch: Independent Recursive Audit

Same 8 lanes as Wave 32 final batch (verbatim — DO NOT alter the questions):

1. How can we simplify and minimize our codebase while maintaining features? how can we reduce code as much as possible? are we using effect properly? are we redeclaring types, schemas, features that effect natively provides via effect/unstable/ai or STM with txQueue etc?
2. are we following the actor model properly?
3. are we using bun/node platform code directly and not creating service layers for maximum portability and testability? GentPlatform etc?
4. is our extension system as minimal yet expressive as can be? compared to other harnesses that i mentioned - expressive enough to implement our current extensions, but more minimal? rearchitetcing completely is acceptable. this codebase is experimental, complete rerwites are fine of our schemas, types, assumptions - correctness, minimalism, is the goal within the effect ecosystem.
5. we own effect-machine, effect-encore, effect-wide-event - can we improve these upstream so that DX is better? are there other libraries we can make to abstract certain concepts that better align with our north star (actor model).
6. do files merit their existence? prefer bigger cohesive files when a split does not encode a real boundary, public entrypoint, platform boundary, independently testable domain, generated fixture, or meaningful multi-import reuse.
7. does the extension authoring experience follow this spirit: it should be simple to author extensions by creating facades over private things through `yield* ExtensionContext`; no ctx parameters, no privileged builtin API, and no capability/read/write ceremony when access can be expressed in code by accessing what is needed from ctx.
8. are any helpers, resource layers, or service factories accepting Effect-context-resolvable values (ExtensionContext, ExtensionContext.Process, ExtensionProcess, ExtensionSession, FileSystem, etc.) as **parameters** instead of yielding them from context? Threading context as parameters is a P1 — services and helpers must yield via `yield* Tag` and surface the requirement in their `R` channel.

Close Wave 33 only after this independent audit reports no P0/P1. If it finds
P1s, synthesize the next wave and continue.
