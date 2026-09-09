# Smaller core through extensions

Status: research proposal. No core rewrite is implemented by this document.

## Decision

Make product behavior an extension over one actor-owned execution loop. Keep execution ownership in the host. Remove `@gent/core-internal`. Replace its wildcard imports with a few explicit package entry points. Reduce files by combining code that changes for the same reason. Measure deleted code separately from moved code.

The target is a core that can run with no coding tools, no cell kernel, no workflow commands, and no shipped model choice. Its tests must prove this. The shipped Gent preset adds these features through the same extension system that outside authors use.

## Prior projects

The [source review](core-extension-priors-2026-09-08.md) checks pinned current Prime Agent and pi code. Both separate model/tool iteration from coding-session policy. Both retain host duties for resources or child runs. Their small loop files exclude large session implementations and imported services. Use their separation of duties. Do not use a loop file's size as a whole-core target.

pi provides explicit context and tool hooks and exact package exports. Prime keeps child creation, completion, and disposal in its RLM host. These support small typed extension seams and host-owned lifetimes. They do not support replacing host state with kernel variables. See the full review for revisions, file paths, and limitations.

## Current source inventory

Measured in `/Users/cvr/Developer/personal/.rifts/gent/kernel-deletions` at `bfc03d7577f8941b69d4c59f749f0a4e8069938b`. Source links use the matching warm-source paths after delivery. Counts include physical TypeScript lines, comments, and blank lines. They exclude Markdown. The source tree contains debug and test utilities; these are listed separately.

| Directory under core/src | Files |  Lines |
| ------------------------ | ----: | -----: |
| runtime                  |    98 | 25,822 |
| domain                   |    50 |  7,806 |
| storage                  |    18 |  4,479 |
| server                   |    19 |  4,176 |
| test-utils               |     9 |  1,832 |
| providers                |     3 |    503 |
| debug                    |     2 |    416 |
| extensions               |     1 |    228 |
| utils                    |     1 |    157 |
| Total                    |   201 | 45,419 |

Runtime includes 34 agent files (10,503 lines), 18 cell files (2,645 lines), and 18 extension files (4,909 lines). These are parts of the runtime total, not extra code.

`packages/core-internal/src` is a symlink to `../core/src`. The private package gives workspace consumers wildcard access to that tree. It does not duplicate the implementation. Removing the alias removes a package concept and related rules. It does not remove 201 source files.

Sources:

- `/Users/cvr/Developer/personal/gent/packages/core-internal/package.json`
- `/Users/cvr/Developer/personal/gent/packages/core-internal/src` (symlink)
- `/Users/cvr/Developer/personal/gent/packages/core/package.json`
- `/Users/cvr/Developer/personal/gent/packages/core/src` (inventory root)
- `/Users/cvr/Developer/personal/gent/packages/tooling/src/core-public-exports.ts`

## The important gaps

1. `selectModelToolSurface` looks for a tool named `cell`. It selects that tool for native model turns. This is product policy inside the loop. Give a registered extension an explicit tool-surface selection seam. The host must validate the selected tools against the admitted bindings. Preserve the full host tool catalog for calls inside cells.
2. `makeAgentLoopBehavior` builds `CellExecution.Branch` and `ModelContextLedger.Branch`. It connects `cells.cancel` to the worker. The kernel is therefore not an ordinary extension yet. The resource API supports only process scope. Add a real actor-owned branch scope before moving kernel lifecycle out of core. Do not add scope names without their implementation.
3. The TUI and SDK import private core modules directly. Add explicit client contracts before removing the alias. Moving the alias to another wildcard path would leave this dependency problem intact.
4. Live and legacy turn profiles still use different admission paths. Audit every caller. Move tests to the real profile path where possible. Delete the legacy path only when all supported compositions can use the same path.

Sources:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-resolve.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-extension.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.turn-profile.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.turn-execution.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/index.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx`

## Keep one owner

| Keep in the host                                            | Supply through extensions                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| Actor mailbox, queue, cancellation, and operation admission | Coding tools, workflows, prompts, skills, model defaults        |
| Stable call identities and durable result receipts          | Cell language, evaluation, retained values, and snapshot format |
| Approval decision enforcement and recovery                  | Permission policy and approval presentation                     |
| Scope creation, resource cleanup, generation leases         | Branch resources and their implementations                      |
| Transcript persistence and event ordering                   | Context selection and compaction policy                         |
| Schema validation and transport dispatch                    | Model providers, external drivers, extension requests           |

A cell worker cannot own the record that prevents replay after that worker dies. A policy hook cannot replace the host's approval decision check. Keep these duties explicit. Do not add a second actor around AgentLoop.

Sources:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/current-tool-call.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-recovery.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-tool-host.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/approval-service.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-host.ts`

## Remove core-internal

Use explicit entry points in the existing core package:

- Extension authoring: retain `@gent/core/extensions/api` during the change.
- Host construction: `@gent/core/runtime` exposes supported composition, not actor implementation files.
- Shared schemas: `@gent/core/protocol` exposes transport and client data. The SDK can re-export these for clients.
- Test construction: `@gent/core/testing` exposes the real test harnesses and controlled model providers. Keep implementation tests inside core on relative imports.

These names are proposed surfaces, not four new packages. Keep the implementation private through explicit exports. Update import guards to enforce the new contract. Do not export the whole tree. Do not move all existing private symbols into one public barrel. Migrate callers to the owning contract and remove unused imports or wrappers.

This has a tradeoff: supported host and test entry points become contracts that Gent must maintain. The benefit is that callers can name what they need without knowing source file locations.

## Five reviewable units

1. **Remove the private package.** Define the smallest runtime, protocol, and testing surfaces required by real callers. Migrate consumers. Delete the symlink package, dependencies, path aliases, and obsolete guard rules. Preserve the extension authoring import.
2. **Remove cell-specific surface policy.** Implement a typed tool-surface selection seam. Run the same loop with direct host tools and with the cell extension. Validate all selected bindings in the host.
3. **Make the kernel a real extension.** Add branch resource ownership under the existing actor scope. Move kernel evaluation, snapshot policy, and declarations to the extension. Keep generic admission and durable effect receipts in the host. Prove reset, interrupt, crash, restart, and branch isolation.
4. **Move remaining product policy.** Remove shipped model defaults from the loop. Place context/compaction choices in an extension over durable history. Check file-index ownership at its actual consumers. Retain generic host file locking and edit validation.
5. **Reduce internal files and paths.** Collapse single-owner forwarding modules and duplicate context provision. Audit the legacy profile path. Group schemas with their owner when there is no independent contract. Keep actor protocol, state, persistence, and execution responsibilities clear. Do not merge unrelated code to meet a file quota.

Units 2 and 3 form one design. Do not ship a generic seam with no real consumer. If a unit crosses 20 files or several subsystems, split it into compiling sub-commits. Each logical code commit must pass the full gate and live Herdr checks. Record the exact features exercised. Mechanical import propagation can be delegated only after the new contract is established.

## Acceptance

- A bare loop completes a turn without the cell extension or coding tools.
- An outside extension can select a tool surface and own a branch resource without core-internal imports.
- The shipped kernel uses the same API and lifecycle rules.
- Tool approval, identity, replay, and finalization tests remain green.
- Resource replacement rejects stale contexts and releases old subscriptions. Failed setup releases partial resources.
- SDK and TUI consumers use supported contracts.
- `core-internal` has no active package, imports, aliases, or guard rules.
- Report source files, source lines, exported symbols, and packages before and after each unit.
- Count moved lines separately from deleted lines. The kernel's 2,645 lines do not vanish when moved.
- Do not promise a final LOC target before the caller and lifecycle audit.
