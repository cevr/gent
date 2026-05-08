# Planify: Wave 29 - Extension Services Instead Of Authority Metadata

## Context

Wave 28 reduced public surface, but its final audit still found P1 extension
authority leaks. The old remediation path was to make `needs` more exact. That
is the wrong direction now: extension authors should not spell `read`/`write`
authority metadata to access host capabilities.

The collapsed model is Effect-native:

- Extension code imports constrained services such as `ExtensionSession`,
  `ExtensionAgent`, and `ExtensionInteraction`.
- Runtime provides those services at extension execution boundaries.
- Public extension setup receives only public facts; host-owned bundled
  extensions use internal APIs for process/platform authority.
- `needs` remains only as a temporary runtime scheduling/tool-context detail
  until migrated call sites are gone.

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

**Status**: In progress.

First collapse removes `ToolNeeds` from extension-owned local service tools
where the actual authority is already carried by Effect services/storage:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/artifacts/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto/checkpoint.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/memory/tools.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/search-skills.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/skills-tool.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/tools.ts`

The next collapse should either remove `ToolNeeds` from read-only platform tools
or replace process/session/interaction authority in host-heavy tools with
constrained imported services. Do not reintroduce public `read`/`write`
metadata.

After all public extension call sites yield services instead of requesting
authority metadata:

- Remove `ToolNeeds` from the public authoring API.
- Remove privileged action/request/reaction overloads.
- Remove `ModelCapabilityContext` from public exports.
- Keep scheduling/serialization concerns internal if still needed by runtime.

## Batch 4: refactor(extensions): physically prune setup context

**Status**: Pending.

Split public extension setup from host-owned bundled setup:

- Public `defineExtension` factories receive a physically pruned setup object,
  not a type-only narrowed object.
- Builtin provider/executor/acp extensions move to an internal host extension
  factory or internal resource wrapper.

## Final Verification Audit

Run this exact lane independently:

> Audit Gent for extension API simplicity and authority leaks. The public
> extension API should have no private or privileged API. Builtins are only the
> starting set of extensions, not a privileged extension class. Extension code
> should import constrained services instead of spelling `read`/`write`
> authority metadata. Verify setup context is physically pruned, runtime
> execution seams provide only intentional services, and no public `needs`
> carveout remains.

Close this wave only when the independent audit reports no P0/P1.
