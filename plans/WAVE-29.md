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
