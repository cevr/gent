# Planify: Wave 29 - Extension Services Instead Of Authority Metadata

## Context

Wave 28 reduced public surface, but its final audit still found P1 extension
authority leaks. The old remediation path was to make `needs` more exact. That
is the wrong direction now: extension authors should not spell `read`/`write`
authority metadata to access host capabilities.

The collapsed model is Effect-native:

- Extension code imports one constrained service, `ExtensionContext`.
- Tool bodies receive decoded params only. They do not receive or thread `ctx`.
- Runtime provides those services at extension execution boundaries.
- Public extension setup receives only public facts; host-owned bundled
  extensions use internal APIs for process/platform authority.
- Capability metadata remains only where it models a real product surface
  (`tool`, `action`, `request`), not as a private authority channel.

## Audit Receipts

The current design was informed by:

- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-host-context.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/action.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/plan.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/handoff.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/index.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/Context.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/http/HttpClient.ts`

## Batch 1: refactor(extensions): introduce extension services

**Status**: Completed in `f53f5daa`.

Add public Effect services for constrained extension authority and provide them
from all runtime extension execution seams:

- RPC/action registry execution.
- Tool execution.
- Lifecycle reactions.

Migrate the smallest session-command call sites from `ctx.session + ToolNeeds`
to `yield* ExtensionSession`.

**Verification**

- `bun run typecheck`
- Focused RPC/surface/tool-runner tests
- `bun run lint`
- `bun run fmt:check`
- `bun run gate`

## Batch 2: refactor(extensions): migrate remaining builtin host consumers

**Status**: Completed in `bf4cd769`.

Migrate builtin tools/actions/reactions from `ModelCapabilityContext` to
`ExtensionSession`, `ExtensionAgent`, and `ExtensionInteraction`. Keep process
platform access internal to bundled host-owned extensions.

Completed:

- Session slash commands and `rename_session`.
- Interaction tools.
- Session search/read tools.
- Counsel, research, handoff, auto, and handoff-threshold reactions.

Remaining host/process-heavy targets moved to Batch 4:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/audit/audit-tool.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/plan-tool.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/review/review-tool.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/session-tools/read-session.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/session-tools/search-sessions.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/interaction-tools/ask-user.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/interaction-tools/prompt.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/handoff.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts`

## Batch 3: refactor(extensions): delete public needs authority

**Status**: Completed in current batch.

Removed `ToolNeeds`, public `needs`, privileged authoring overloads, and local
capability-access grants. Extension-owned local service tools now rely on Effect
services/storage for real authority:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/artifacts/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto/checkpoint.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/memory/tools.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/search-skills.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/skills-tool.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/tools.ts`

Platform/repo tools no longer spell authority metadata where safety is already
owned by constrained services such as `FsRead`, `FileLockService`, `HttpClient`,
and `GitReader`:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/read.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/write.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/edit.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/glob.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/grep.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/network-tools/webfetch.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/network-tools/websearch.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/librarian/repo-explorer.ts`

Host-heavy tools now use `yield* ExtensionContext`. Public `tool({...}).execute`
receives decoded params only; tool authors no longer receive or thread `ctx`.
Individual authority facades (`ExtensionSession`, `ExtensionAgent`,
`ExtensionInteraction`, `ExtensionProcess`) and internal runtime context types
are no longer public exports. Scheduling/serialization concerns stay internal.

## Audit Lane: Extension Authoring Simplicity

**Status**: Added.

Audit and simplify against this north star:

- A tool body should look like ordinary Effect code: `execute: (params) =>
Effect.gen(function* () { const ctx = yield* ExtensionContext; ... })`.
- `ctx` must not be threaded through helper calls or function parameters.
- `capability`, `needs`, and `read`/`write` authority metadata must not be used
  as private access control. If code needs a host primitive, expose the narrow
  accessor on `ExtensionContext` and let the host provide it.
- The remaining capability terms should name product surfaces only: tools,
  actions, requests, reactions, resources.
- Effect-smol evidence: `Context.Service` gives lazy `.asEffect()` / `.use(...)`
  access in `Context.ts`; upstream modules such as `HttpClient.ts` hand-write
  module-level method accessors when that improves DX. Gent should avoid
  bespoke ceremony unless it clearly simplifies authoring.

## Batch 4: refactor(extensions): physically prune setup context

**Status**: Completed in current batch.

Split public extension setup from host-owned bundled setup:

- Public `defineExtension` factories receive a physically pruned setup object,
  not a type-only narrowed object.
- Builtin provider/executor/acp extensions move to an internal host extension
  factory or internal resource wrapper.

Implemented:

- `defineExtension` now constructs a fresh `PublicExtensionSetupContext` before
  invoking bucket factories. Process authority fields are not present on the
  object, even if a caller casts the type.
- Anthropic and Executor setup are explicit host-owned `GentExtension` values,
  matching the existing ACP host-owned extension shape.
- Public setup lock tests assert `parentEnv`, `signalPid`, and `runProcess` are
  absent from the runtime object passed to bucket factories.

**Verification**

- `bun run typecheck`
- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/extensions/define-extension.test.ts packages/core/tests/extensions/extension-surface-locks.test.ts packages/core/tests/extensions/executor-integration.test.ts packages/extensions/tests/anthropic/anthropic-keychain-transform.test.ts packages/extensions/tests/acp-agents/acp-extension-state.test.ts`
- `bun run lint`
- `bun run fmt`

## Batch 5: refactor(extensions): close runtime authority leaks

**Status**: Completed in current batch.

Independent audit found two remaining P1 leaks:

- Read-only reaction handlers were typed with `ReadOnlyExtensionHostContext`,
  but runtime execution still passed the full `ExtensionHostContext` and
  provided full `ExtensionContext` services.
- Runtime execution for read-intent tools/RPCs still provided full
  `ExtensionContext`, so read capabilities could reach session mutation,
  interaction, agent-run, process-run, and parent environment authority.
- Raw runtime-loaded extension setup still had a builtin-only privileged setup
  class, which treated builtins as more than the starting extension set.

Fixed:

- `ExtensionSetupContext` is now the only setup surface and is physically
  facts-only for every extension scope. The `HostGentExtension` /
  `RuntimeGentExtension` split is gone.
- `setupExtension` always passes a fresh facts-only host object. Builtins are
  just the initial extension set.
- Reaction handler parameters now derive `readOnlyExtensionHostContext(ctx)` at
  runtime. Prompt/context/permission/tool-execute rewrites receive only the
  read-only capability context. Lifecycle hooks (`turnBefore`, `turnAfter`,
  `messageOutput`, `toolResult`) may still import constrained mutation through
  `yield* ExtensionContext`; they no longer receive raw host/process authority
  as a function parameter.
- `toolExecute` follows the same read-only host-context rule as the other
  reaction wrappers; ordinary host authority belongs in tools/actions via
  `yield* ExtensionContext`.
- `provideExtensionServices(..., { intent: "read" })` now supplies a read-intent
  facade: mutation methods, `Agent.run`, interaction prompts, process run,
  process signal, and parent environment are unavailable while read methods
  remain available.
- Read-request authoring no longer requires branded read-only service ceremony.
  Authors can `yield* ExtensionContext`; the host-provided facade enforces the
  intent at runtime.
- Bundled Anthropic/ACP/Executor internals now use internal platform services
  and `GentPlatform.env` when available, without exposing those process
  primitives through public setup.
- Public RPC dispatch now passes the full host context to the registry and lets
  the registry apply the read-intent facade. This preserves the direct handler
  parameter as facts-only while making `yield* ExtensionContext` work through
  the real transport path.
- The stale `publicSlashCommands` duplicate was removed. Slash commands now
  have one resolved list; palette-only actions remain omitted by construction.

Regression coverage:

- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/loader.test.ts`
  asserts runtime-loaded setup receives host facts only.
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/extension-reactions.test.ts`
  asserts system prompt and lifecycle handler parameters see no process
  authority while lifecycle hooks still run inside the extension service
  context required by auto/handoff-style loops.
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/extension-surface-locks.test.ts`
- locks the simpler authoring surface: tools receive params only, read
  requests may yield `ExtensionContext`, private host/setup helpers are not
  public exports.
- `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/tool-runner.test.ts`
  asserts read tools receive an `ExtensionContext` facade that denies process,
  follow-up, and interaction authority.
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/capability-host.test.ts`
  asserts read RPC handlers receive the same read-intent `ExtensionContext`
  facade.
- `/Users/cvr/Developer/personal/gent/packages/core/tests/server/extension-commands-rpc.test.ts`
  asserts public read RPC transport provides a read-intent `ExtensionContext`
  facade while keeping the handler parameter read-only.

**Verification**

- `bun run typecheck`
- `bun test packages/core/tests/runtime/tool-runner.test.ts packages/core/tests/extensions/capability-host.test.ts packages/core/tests/extensions/extension-surface-locks.test.ts packages/core/tests/extensions/loader.test.ts packages/core/tests/extensions/extension-reactions.test.ts`
- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/server/extension-commands-rpc.test.ts packages/core/tests/extensions/registry.test.ts`
- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/extensions/tests/anthropic/anthropic-keychain-transform.test.ts packages/extensions/tests/anthropic/anthropic-credential-service.test.ts packages/extensions/tests/acp-agents/acp-extension-state.test.ts packages/core/tests/extensions/executor-integration.test.ts`
- `bun run gate`

## Batch 6: test(runtime): remove unstable timing/native-test paths

**Status**: Completed in current batch.

While running the full gate, two unrelated test-stability issues surfaced:

- `agent-loop-concurrency.test.ts` used a tiny sleep to infer overlap. It now
  uses a `Deferred` barrier: both tool calls must start before either can
  finish, so the test measures concurrency directly.
- `file-index.test.ts` repeatedly crashed Bun 1.3.13 through the native FFF
  adapter even when assertions passed. `FileIndexLive` now uses the pure
  fallback when `RuntimeEnvironment.platform === "test"`, keeping production
  native-first behavior while making the test runtime deterministic.

**Verification**

- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/runtime/agent-loop-concurrency.test.ts`
- `for i in 1 2 3; do bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/runtime/file-index/file-index.test.ts || exit $?; done`

## Final Verification Audit

Run this exact lane independently:

> Audit Gent for extension API simplicity and authority leaks. The public
> extension API should have no private or privileged API. Builtins are only the
> starting set of extensions, not a privileged extension class. Extension code
> should import constrained services instead of spelling `read`/`write`
> authority metadata. Tool bodies should receive params only and yield
> `ExtensionContext` for host access. Verify setup context is physically pruned,
> runtime execution seams provide only intentional services, and no public
> `needs` carveout remains.

Close this wave only when the independent audit reports no P0/P1.

First independent audit found one P1: public read RPC transport used
`readOnlyExtensionHostContext(hostCtx)`, so direct registry tests passed but
transport handlers could not `yield* ExtensionContext`. Fixed in Batch 5 and
covered by `extension-commands-rpc.test.ts`.

Second independent audit found no P0/P1/P2/P3 findings:

- Prior P1 fixed: public read RPC transport dispatches with full host context
  so the registry can install the read-intent `ExtensionContext` facade, while
  the handler parameter remains facts-only.
- Prior P3 fixed: `publicSlashCommands` / `publicOnly` duplicate command
  surface removed.
- Verification receipts from the audit: `bun run typecheck`, `bun run test`,
  and focused extension-authority suites all passed.
