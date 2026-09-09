# Kernel deletions: validation record

Status: work in progress. The full goal has five deletion areas.

## Handoff

Removed the second model call that rewrote handoff text above 2,000 characters. The existing approval and new-session creation remain.

The RPC acceptance test now checks the full supplied text through real runtime services. The full gate passed. Live Herdr checks used Luna in pane `wZ:pH` with more than 2,000 characters of supplied context.

The first live check found stale activity after session creation. The snapshot could include the completed event while runtime finalization still reported Running. Historical replay then skipped that lifecycle event. The existing runtime stream only updated queues. It now also updates activity for the current session and branch. Idle updates preserve error status. A client test covers current-branch recovery and rejection of stale branch updates.

The repeated live check opened approval, accepted Yes, created the new session, returned `HANDOFF-IDLE-GREEN`, and showed no Generating line. The source test covers the decline result too.

Evidence:

- `/tmp/gent-handoff-deletion-tests.log`: focused RPC and tool tests, 3 passed.
- `/tmp/gent-handoff-deletion-gate.log`: full gate after summary removal, passed.
- `/tmp/gent-handoff-deletion-approval.txt`: first live approval.
- `/tmp/gent-handoff-deletion-new-session.txt`: stale activity reproduction.
- `/tmp/gent/logs/046a399a-20260908224004-client.log`: snapshot cursor and session transition.
- `/tmp/gent/logs/046a399a-20260908224004-server.log`: both turns completed.
- `/tmp/gent-handoff-runtime-gate.log`: full gate after activity fix, passed.
- `/tmp/gent-handoff-runtime-approval.txt`: repeated live approval.
- `/tmp/gent-handoff-runtime-new-session.txt`: new-session reply and settled activity.

Source files:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/handoff-tool.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/handoff/handoff-rpc.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/hooks/use-session-feed.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/client-session-state.test.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/use-session-feed.test.tsx`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`

## Principles as a skill

Removed the dedicated principles extension, tool, and TypeScript text registry. The 27 principle texts now live in Markdown reference files under one ordinary `principles` skill. A mechanical extraction check compared all 27 runtime strings byte-for-byte before removal.

The skill installer publishes a content-addressed directory of real files. This supports compiled binaries and separate cell workers. The existing discovery service reads the bundle after user global sources. Local-first and explicit-global selection remain. The read-only skill list now uses a plain captured value instead of a mutable Ref.

The focused tests passed: 30 tests, including concurrent installation, complete file reads, local/global selection, and real-service RPC discovery. The live compiled TUI found the skill and read its index plus one reference with `Bun.file`. It returned `PRINCIPLES-FILES-GREEN` and reached idle.

Evidence:

- `/tmp/gent-principles-tests.log`
- `/tmp/gent-principles-gate.log`
- `/tmp/gent-principles-herdr.txt`

Source files:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/bundled/principles/SKILL.md`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/bundled-sources.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/bundled-skills.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/markdown.d.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/skills.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/skills/bundled-skills.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/skills/skills-rpc.test.ts`
- `/Users/cvr/Developer/personal/gent/.gitignore`

## Native repository commands

Removed the repository extension, GitReader service, repo tool, native es-git dependency, and obsolete formatter. Removed tests that only exercised the deleted service. Removed GitReader test overrides from the remaining runtime and TUI tests. The platform guard still checks the same forbidden import against a current source path.

The bundled repositories skill documents executable checks, existing credential use, cache ownership, exact revision reads, npm archive inspection, and error codes. Research prompts now refer to this skill and supervised native commands.

The full gate passed. Live Herdr checks cloned a local two-version fixture without checkout, resolved v1, listed and read its file, and returned commit `3e1be432bd1095772732f3ef6e731ce5e86ad419` with `REPO-PIN-ONE`. The source remained clean at `REPO-PIN-TWO`. No matches returned 1; an invalid revision returned 128. A second live turn packed and extracted is-number@7.0.0 without installation and read cevr/gent metadata with existing gh authentication. Both turns reached idle.

Evidence:

- `/tmp/gent-repository-remove.log`
- `/tmp/gent-repository-gate.log`
- `/tmp/gent-repository-herdr-git.txt`
- `/tmp/gent-repository-herdr-package.txt`
- `/tmp/gent-repository-fixture-check.txt`

Source files:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/bundled/repositories/SKILL.md`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/bundled-sources.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/workflows.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/package.json`
- `/Users/cvr/Developer/personal/gent/bun.lock`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/utils/format-tool.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/format-tool.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/helpers/test-preset.ts`
- `/Users/cvr/Developer/personal/gent/packages/e2e/tests/transport-harness-boundary.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/integration/app-bootstrap.test.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/integration/session-lifecycle.test.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/integration/session-feed-boundary.test.tsx`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/agent.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/extension-harness.ts`
- `/Users/cvr/Developer/personal/gent/packages/tooling/tests/platform-duplication-guards.test.ts`

## Atomic saved-result writes

Added `atomic: true` to the existing write tool and file facade. The production facade and tool test harness use one file-writer implementation. The existing path lock still owns serialization. Default writes retain their prior behavior. Atomic replacement replaces a symlink itself, preserves its target, and creates a new inode with temporary-file permissions.

Eight focused tests passed. They cover complete replacement above the kernel snapshot limit, failed rename, temporary cleanup, symlinks, normal writes, and RPC execution. The full gate passed. Live Herdr replaced one result, observed the expected directory-target rename failure, read the preserved old file, checked cleanup, and reached idle.

A real subprocess test used the production file writer. It stopped the process after the temporary path appeared and before rename, then sent SIGKILL. The destination still contained the previous complete result. A hard kill can leave a staging directory. No power-loss guarantee is claimed.

Evidence:

- `/tmp/gent-atomic-tests.log`
- `/tmp/gent-atomic-gate.log`
- `/tmp/gent-atomic-herdr.txt`
- `/tmp/gent-atomic-process-crash.txt`

Source files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/file-writer.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/extension-harness.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/write.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/fs-tools/write.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/fs-tools/fs-tools-model-turn.test.ts`

## Workflow saved files

Workflow recipes now save branch-local results under `.gent/results/<session>/<branch>/<kind>.md` in the server working directory. The existing write tool performs atomic replacement. Explicit exports follow the canonical save. Empty `/plan` reads that file without kernel bindings. Review and audit may save reports but must leave source files unchanged.

The full gate passed. The RPC test checks canonical save, export, and a later empty-plan read through real file tools. The first test draft sent two 410 KB direct tool inputs and reached the model context limit after both writes succeeded. The workflow test uses a smaller document. The separate atomic-write tests cover large results without expanding the model transcript.

Live Herdr saved the plan, exported an identical copy, read the canonical result, and presented approval in a later cell. The test selected No. No source changes occurred. The live model first tried absent files and emitted one invalid cell; it recovered before saving. The initial parallel missing-file read closed the cell worker pipe. Final recovery checks must review this failure path. A second isolated session reported its own saved plan missing and did not adopt the previous session file. The original plan and export remained unchanged after process exit. This is not a persistent-session restart test; `--isolate` uses in-memory session storage.

Evidence:

- `/tmp/gent-saved-workflows-gate.log`
- `/tmp/gent-saved-workflows-events-detail.log`
- `/tmp/gent-saved-workflows-approval.txt`
- `/tmp/gent-saved-workflows-declined.txt`
- `/tmp/gent-saved-workflows-empty-new-session.txt`
- `/tmp/gent-saved-workflows-files.txt`

Source files:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/workflows.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/workflows.test.ts`
- `/Users/cvr/Developer/personal/gent/.gitignore`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`

## Artifact store removal

Removed the artifact Ref store, four model tools, five request RPCs, client schemas, count widget, and unused ArtifactId. Removed tests that only exercised those deleted surfaces. Kept build artifact identity and host recovery contracts unchanged. Updated extension API and TUI documentation.

The full gate passed. Live Herdr ran `/review` and `/audit`, saved both reports, showed their server file paths, and left `discount.ts` unchanged. `tools.search("artifact_")` returned an empty catalog page. No artifact count appeared. The full transcript exposed a model syntax error: the failed report template used double backslashes before backticks. The model corrected its source and saved the report. No parser change was needed.

Evidence:

- `/tmp/gent-artifact-removal-gate.log`
- `/tmp/gent-artifact-removal-review.txt`
- `/tmp/gent-artifact-removal-audit.txt`
- `/tmp/gent-artifact-removal-idle.txt`
- `/tmp/gent-artifact-removal-transcript.txt`
- `/tmp/gent-artifact-removal-files.txt`

Source files:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/client.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/artifact-identity.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/ids.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/index.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-lifecycle.test.ts`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`
- `/Users/cvr/Developer/personal/gent/docs/extensions.md`
- `/Users/cvr/Developer/personal/gent/apps/tui/AGENTS.md`

## Skill wrapper removal

Removed the model-facing `skills` and `search_skills` tools and the dedicated skill-call renderer. Skill discovery still loads the same local, global, and bundled sources. The model prompt now lists server file paths with scope selectors and relative-reference rules. Existing typed RPCs and TUI insertion remain.

The full gate passed. Live Herdr selected the local principles skill through `$princ` completion and inserted `$principles`. The model read the local file and returned its marker. Tool search returned neither removed wrapper. An explicit `$principles:global` request read the bundled skill and its reference file. The model first guessed an absent conventional path, then used the installed cache path and reached idle. The complete e2e suite also passed.

Evidence:

- `/tmp/gent-skill-wrapper-removal-gate.log`
- `/tmp/gent-skill-wrapper-autocomplete.txt`
- `/tmp/gent-skill-wrapper-insertion.txt`
- `/tmp/gent-skill-wrapper-local.txt`
- `/tmp/gent-skill-wrapper-global.txt`
- `/tmp/gent-kernel-deletions-e2e.log`

Source files:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/skills.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/protocol.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/skills/skills.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/index.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/tool-renderers/index.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/utils/format-tool.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/compile-tool-policy.test.ts`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`

## Approval recovery across workspaces

A live process-crash check found a startup defect. The pending approval remained in SQLite and the TUI replayed its form, but responding failed with `InteractionRequestMismatchError`. Startup had scanned only the default workspace. The TUI uses a workspace id derived from its directory. The prior restart tests injected that workspace into startup and hid the failure.

Startup now enumerates workspace ids that own pending approvals. It restores each workspace under its own scope. Normal interaction reads and writes retain their existing workspace filter. Removed the startup workspace override from the restart tests. The pending-approval test failed before the fix and passed after it. The stored-decision restart test also passes without that override. The full gate passed.

Live Herdr crashed the fixed Gent process while a fresh confirmation was pending, reopened the same session, and selected No. The server accepted the response, SQLite marked the request resolved, the cell reported state loss without source replay, and Luna reached idle. The original saved plan content and modification time remained unchanged during the first crash check.

Evidence:

- `/tmp/gent-recovery-before-crash.txt`
- `/tmp/gent-recovery-restored-approval.txt`
- `/tmp/gent-recovery-file-baseline.json`
- `/tmp/gent/logs/046a399a-20260908234041-server.log`
- `/tmp/gent-approval-workspace-before.log`
- `/tmp/gent-approval-workspace-after.log`
- `/tmp/gent-approval-workspace-gate.log`
- `/tmp/gent-approval-fixed-before-crash.txt`
- `/tmp/gent-approval-fixed-restored.txt`
- `/tmp/gent-approval-fixed-completed.txt`
- `/tmp/gent/logs/046a399a-20260908234820-server.log`
- `/tmp/gent-deletions-host-contracts.log` (eight tests, 154 assertions)

Source files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/interaction-storage.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/server/interaction-commands.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-recovery.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/interaction-commands.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/approval-service.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/interaction-request.ts`

## Saved-plan reset, restart, and fork acceptance

Live Herdr wrote a 900,000-byte plan through the atomic write tool. A later cell used reset and observed `typeof scratchResetProbe` as undefined. The saved namespace was empty, while the file still contained all 45,000 marker lines. After process exit and session reopen, empty `/plan` read the same file and showed a bounded preview with a truncation notice.

The test then forked from the earlier final answer, before the plan write. Empty `/plan` on the new branch reported its own file missing. It did not adopt the parent plan. The parent file remained byte-for-byte unchanged. Source inspection confirms that `forkSessionBranch` copies messages and creates a new branch id; it does not copy namespace rows or result files.

The initial 2 MB host-call probe exceeded the existing 1 MiB transport frame limit. The corrected 900,000-byte probe fits that frame and exceeds both snapshot limits (256 KiB per binding and 768 KiB total). The transport limit was retained. This test does not claim unbounded host-call payloads.

Evidence:

- `/tmp/gent-saved-plan-reset.txt`
- `/tmp/gent-saved-plan-reset-transcript.txt`
- `/tmp/gent-saved-plan-reset-files.txt`
- `/tmp/gent-saved-plan-cold-read.txt`
- `/tmp/gent-saved-plan-fork.txt`
- `/tmp/gent-saved-plan-fork-files.txt`

Source files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-protocol.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-snapshot.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-execution.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-mutations-live.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/workflows.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/write.ts`

## Remaining work

The source review and requirement audit found no further change needed for these five removals. The review covered the implementation, removed registrations and consumers, storage recovery scope, tests, and documentation. The two defects found by live checks are fixed: session activity after handoff and pending approvals after restart. Their receipts appear above.

The final end-to-end run after the approval fix passed both tasks: 26 TUI tests and 36 runtime/transport tests. Evidence: `/tmp/gent-deletions-final-e2e.log`. The full gate passed for each logical code commit. The final audit also checked `git diff --check` and searched active app/package source for removed artifact tools, repository/principles registrations, skill wrappers, and es-git. No references remained.

The host retains operation receipts, approval decisions, actor ownership, child/process lifetimes, file locks, and edit checks. The existing focused host tests passed (eight tests, 154 assertions). Saved files carry final workflow output. Kernel values carry working data. No replacement artifact catalog, RPC, or actor was added.

Delivery: commits through `bfc03d7577f8941b69d4c59f749f0a4e8069938b` are on `origin/main`. The direct warm-source build passed. The installed command points to `/Users/cvr/Developer/personal/gent/apps/tui/bin/gent`. Live Herdr ran that build and received DELIVERY-GREEN at idle. Evidence: `/tmp/gent-deletions-warm-build.log` and `/tmp/gent-deletions-delivered-herdr.txt`.

The next research is in `plans/core-extension-reduction-2026-09-08.md`. It does not implement a core rewrite.
