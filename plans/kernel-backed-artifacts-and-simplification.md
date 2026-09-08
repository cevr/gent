# Kernel-backed work and a smaller Gent

Status: proposed storage and architecture plan. The workflow changes passed the full gate, E2E tests, and live Herdr checks. Commits: `fdba7a8d` and `c234f400`. See [validation receipt](kernel-workflow-receipt-2026-09-08.md). Artifact storage is not changed by these commits.

## Decision

Use the kernel for working values and composition. Use files for saved results. Keep the host in charge of durable operations, approval decisions, child execution, budgets, and recovery.

An ordinary kernel binding is useful working state. It is not a publication receipt. Gent can omit a binding from its snapshot, fail to save a snapshot, or clear it on reset. Do not move the artifact Ref into one large binding and call that durable storage.

Use the existing cell and file operations. Do not add a workflow engine, artifact actor, generic state service, or `context.publish` wrapper. The current `context.*` path bypasses recorded tool admission and is not the right place to hide a new durable write operation.

## Current state

| Area             | Verified state                                                                                                        | Consequence                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Agents           | Gent ships one general-purpose agent, `main`.                                                                         | There is no specialist roster left to delete. Roles can remain prompts.                                     |
| Workflows        | Five slash requests queue prompts. There is no workflow runtime.                                                      | Remove fixed child choreography, not an imaginary engine.                                                   |
| Kernel           | Branch bindings survive successful cells. SQLite stores the last good snapshot per session and branch.                | Reuse this for scratch work and small result handles.                                                       |
| Snapshot bounds  | 256 KiB per binding; 768 KiB total; depth 64. Unsupported values are omitted.                                         | Large reports and datasets belong in files. Do not increase limits merely to absorb the artifact extension. |
| Snapshot failure | Saving a snapshot logs a warning. It does not fail the completed cell.                                                | A completed cell does not prove its binding was saved.                                                      |
| Approval         | Suspension loses the worker. Recovery restores the previous successful snapshot without replaying the source.         | End the result-producing cell before asking for approval.                                                   |
| Artifacts        | A process-scoped Ref owns records. Four tools and five RPC requests expose them. The TUI shows an active-count badge. | This duplicates result state, but clients still depend on its API.                                          |
| Fork             | The fork operation copies messages through the selected message. It does not copy a historical kernel snapshot.       | Never copy the parent's latest namespace into an earlier fork point.                                        |
| Children         | `delegate` has foreground and background paths. Background work returns durable handles and host completion delivery. | Keep those owners. A Promise or kernel variable is not a child supervisor.                                  |
| Cell authority   | The cell has Bun, process, filesystem access, and imports.                                                            | A read-only prompt or tool allow-list does not create OS isolation.                                         |

Source paths:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/agents.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/workflows.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-tool.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-execution.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-snapshot.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/cell-namespace-storage.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-tool-host.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-context-host.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/bun-evaluator-boundary.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-mutations-live.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/artifacts/store.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/artifacts/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/artifacts-protocol.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/artifacts.client.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/child-agent-tools.ts`

## Immediate workflow change

Keep `/plan`, `/review`, `/audit`, `/counsel`, and `/research`. Keep their registered command IDs and the plan key binding. Give each invocation its own follow-up source ID so repeated calls cannot reuse an earlier message.

Replace mandatory child counts, cross-review rounds, and the one-cell mandate with the intended result and constraints. Independent child work is optional when it helps. Counsel still requests an independent opinion. Research still requires primary sources and citations. Review and audit remain read-only instructions.

Keep artifact save/read for final results until the replacement below passes. Keep plan approval. Save the plan and complete that cell before asking for approval in another cell. This allows the host to snapshot working data before suspension.

This is a reduction in prompt policy and required work. It is not an artifact migration or a new kernel API.

## Artifact replacement

### Working values

Use ordinary bindings for intermediate plans, observations, comparisons, and small structured results. Avoid putting every result in one object: one oversized member can cause the whole binding to be omitted. Treat restored/omitted names as part of the execution result.

### Saved results

Write accepted plans and reports to files through the existing file path. Prefer existing host file tools when locks, typed results, or recorded calls matter. Use direct Bun for temporary data processing. Check that a save completed before reporting a saved result. Keep a small binding with the path and useful summary; the file owns the full content.

The workflow request already has the session and branch address. It can include a stable branch-local output path in its prompt without adding a new kernel method. Proposed default: `.gent/results/<session-id>/<branch-id>/<kind>.md` under the resolved workspace cwd. The canonical branch path owns the saved result. A user-selected destination is an explicit export, not a replacement for the canonical plan path. This keeps empty `/plan` deterministic after reset without another locator database. Resolve and escape paths at the host boundary. Add `.gent/results/` to the ignore rules and confirm remote-host path behavior before cutover.

For `/plan` with no input, read that branch's plan file. Do not depend on a surviving variable. A fork starts with no implicit plan file. Historical transcript links show the current file contents, not a historical version. The first cutover does not add document version history. Explicit adoption copies the selected current file into the new branch and states that fact; it never claims to recover a plan as it existed at an earlier message.

A shared output uses an explicit file path. Sharing a path is an explicit choice to share that document; it is not isolated branch state. Cells and child prompts must state which paths they own.

### UI choice

The recommended minimal UI is the existing transcript with the saved path and a short summary. Remove the artifact-count badge with the artifact RPC. There is currently no full artifact browser to preserve.

This is an explicit product change in the proposed plan. If a dedicated result browser is needed, define that need before deleting the old RPC. Build a read-only file view over the chosen file layout. Do not create a second mutable catalog or expose every kernel variable to the UI.

### Failure rules

- Reset clears scratch bindings. It must not delete saved files.
- A failed or interrupted cell can have written a file. Inspect the file or the stored tool receipt. Do not replay unknown effects.
- Approval reads the saved plan. A lost worker must not require another write or another child run.
- Large reports stay outside snapshot limits.
- Branch deletion does not silently delete user-selected files.
- Paths in a remote session refer to the server filesystem. The TUI must not claim they are local files.
- Published results require a sibling temporary file and atomic rename under the existing file lock. The current write tool writes directly and does not provide this guarantee. Add an explicit atomic write mode before cutover. A process stop must leave either the old complete file or the new complete file. Test cleanup and symlink behavior. Do not claim power-loss durability or a multi-file transaction. An export is a separate operation; its failure does not undo the canonical save.

Relevant file owners:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/write.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/read.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/edit.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-recovery.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/cell-tool-operation-storage.ts`

## Commit plan for the artifact replacement

Each logical change, including a fix within a commit, must pass `bun run gate` and a live Herdr TUI check before the next change. Run `bun run test:e2e` for the final UI cutover. Use the Effect skill for runtime changes. Count deleted production code separately from tests and documentation.

1. **`feat(files): support atomic result replacement`**. Add an explicit atomic mode to the existing write tool and its owning file adapter. Keep existing default write semantics. Use a sibling temporary file, the existing path lock, and rename. Define cleanup and symlink handling. Test process interruption before replacement and failure on replacement. Herdr must replace one saved result and show that a failed replacement leaves the prior file intact.
2. **`feat(workflows): save results to branch-local files`**. Add the output-path convention in the existing workflow module. Save files and display their paths while the existing artifact adapter still works. Use one short transition; set the adapter deletion in commit 4. RPC acceptance must verify a saved file, an explicit export, and whitespace-only `/plan`. Herdr must show the saved path and the approval result. Do not start a second background service.
3. **`refactor(workflows): resume plans from saved files`**. Switch empty `/plan` to the file. Test worker loss, process restart, explicit reset, a report above the snapshot cap, and a fork at an earlier message. Verify no extra child call or duplicate write on approval recovery. Keep the latest snapshot out of historical forks. Herdr must close/reopen the session and retrieve the plan.
4. **`refactor(artifacts): remove the duplicate result store`**. Remove the four tools, five RPC requests, Ref service, exports, and badge after all consumers use files. Remove artifact tests that only serve the deleted API. Keep file/recovery acceptance tests. Update architecture and extension author docs. Herdr must show plan/review/audit file links and no stale counter. Generic extension `artifactIdentity` is code provenance and is unrelated; do not delete it by name matching.
5. **`test(workflows): verify saved-result recovery end to end`**. Close any remaining acceptance gaps for unavailable files, remote paths, approval denial, and child cancellation. Record the live run and net deletion count. Remove transition text and old-only adapters. No permanent dual store remains.

Expected deletion owners in commit 4:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/artifacts/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/artifacts/store.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/artifacts-protocol.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/artifacts.client.ts`

Expected integration owners:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/write.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts`
- `/Users/cvr/Developer/personal/gent/.gitignore`

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/workflows.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/client.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/ids.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/workflows.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/artifacts/artifacts.test.ts`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`

## Further simplification, in order

| Candidate                                         | Proposed action                                                                                                                                            | Evidence or boundary to preserve                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Fixed workflow policy                             | Ship the current prompt reduction. Put optional specialist methods in skills.                                                                              | Five commands remain useful human entry points.                                                                   |
| Artifact CRUD and badge                           | Execute the file-backed cutover above.                                                                                                                     | Preserve saved content, `/plan`, approval, and restart.                                                           |
| Repository wrapper                                | Compare the library wrapper with the installed repository CLI. Prefer calling a proven CLI from the cell if packaging and headless operation are reliable. | Keep Git refs, cache semantics, errors, and auth. Do not add an undeclared dependency on a developer's local CLI. |
| Pure file/data helpers                            | Use native Bun and imports for parsing and transformations. Remove a host helper only after proving its extra behavior is unnecessary.                     | File locks, redaction checks, typed errors, and transcript receipts are real behavior.                            |
| Foreground shell adapter                          | Assess overlap with awaited Bun processes.                                                                                                                 | Keep bounded output, interruption, process-tree cleanup, and diagnostics.                                         |
| Background shell and child work                   | Share reusable lifetime or receipt code only at its actual owner. Keep separate product behavior when required.                                            | A live Promise does not survive worker loss. Host delivery must still wake an idle parent.                        |
| Skill/principle discovery                         | Prefer lazy loading into the current context. Avoid another in-memory copy of source text.                                                                 | Keep discovery, project trust, and user policy precedence.                                                        |
| Kernel helper libraries                           | Import reusable pure helpers as modules; rebuild nonserializable functions after restart.                                                                  | Snapshot omission is expected. Do not serialize executable authority.                                             |
| Extension surface                                 | Audit unused declarations after the above deletions. Keep one public extension entry point.                                                                | The recent API collapse already removed much of the old surface. Do not repeat it from old plans.                 |
| Goal, context, session, approvals, drivers, Herdr | Keep as host or client services.                                                                                                                           | These own durable state, projection, credentials, or UI lifetime. They are not kernel scratch values.             |

Do not add a generic host-call framework to combine these candidates. Prototype one deletion at a time against its real acceptance path. Upstream reusable lifecycle gaps to owned libraries only when they belong there; do not wrap AgentLoop in another actor.

Additional inventory paths:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/librarian/repo-explorer.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/principles/principles-tool.ts`
- `/Users/cvr/Developer/personal/gent/plans/extension-api-verification-2026-09-08.md`
- `/Users/cvr/Developer/personal/gent/plans/bun-rlm-and-harness-reduction.md`

## Principles and prior art

Apply “Redesign From First Principles”: one owner for each result, then delete the duplicate path. Apply “Never Block on the Human”: deliver reversible, testable changes in small commits; do not ask the user to resolve implementation naming.

Principle sources:

- `/Users/cvr/Developer/personal/dotfiles/principles/redesign-from-first-principles.md`
- `/Users/cvr/Developer/personal/dotfiles/principles/never-block-on-the-human.md`

The independent source review is in `plans/kernel-prior-art-2026-09-08.md`. It pins Prime Agent revisions and compares them with the RLM reference and Code Mode. The comparison informs the ownership split; it does not prove Gent has another project's recovery contract.

## Independent review decisions

The review accepted the immediate workflow scope. It found three gaps in this storage proposal. The plan now has one canonical branch file plus explicit exports, states that old path links show current content, and requires atomic replacement before cutover. The review suggested a durable artifact record if the dedicated artifact UI remains. This plan chooses the smaller file-only result path and proposes removing the count badge. That UI choice remains part of the unimplemented artifact plan.
