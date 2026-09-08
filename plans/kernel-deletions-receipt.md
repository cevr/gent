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

## Remaining work

1. Replace artifact state and UI with saved files and kernel working values.
2. Remove model-facing skill search/load wrappers. Preserve discovery, scope, and TUI insertion.

Run the full gate and live Herdr checks for each logical commit. Complete review and the final goal audit before integration.
