# Gent feature E2E receipt — 2026-09-08

## Result

The full gate passed. All 62 automated E2E tests passed: 26 TUI tests and 36 process/RPC tests.
The first live Herdr run found three defects. The follow-up fixed all three and repeated their live checks. Broader coverage remains open; do not describe all features as verified.

The run used Herdr 0.9.0, pane `wZ:pH`, and `openai/gpt-5.6-luna`.
The test directory was `/tmp/gent-feature-e2e-20260908`.
The first Gent process used `--isolate`. A second process used normal storage to test restart and resume.
Only test sessions and fixture files were changed. The test pane was returned to its shell.

## Live feature matrix

| Feature                | Result                                                                                                               | Evidence                                                                                                                                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Herdr lifecycle        | Pass: idle, working, blocked, done, and release                                                                      | `/tmp/gent-herdr-live-20260908/repeat-1-idle.json` through `/tmp/gent-herdr-live-20260908/repeat-5-done.json`; `/tmp/gent-herdr-live-20260908/11-released.json`                                                                                                                                                        |
| Missing auth           | Pass: OpenAI methods and manual key entry opened; no key saved                                                       | `/tmp/gent-feature-e2e-20260908/auth-manual.txt`                                                                                                                                                                                                                                                                       |
| Cell execution         | Pass: output, retained variable, tool search/description, sequential and parallel calls                              | `/tmp/gent-feature-e2e-20260908/session-export.md`                                                                                                                                                                                                                                                                     |
| Cell recovery          | Pass with a product limit: a suspended cell loses its worker; prior saved bindings return; source does not run again | `/tmp/gent-feature-e2e-20260908/question-result-before.txt`; `/tmp/gent-feature-e2e-20260908/artifacts-transcript.txt`                                                                                                                                                                                                 |
| Recovery error display | Fixed: error text now appears in the transcript                                                                      | `/tmp/gent-feature-e2e-20260908/recovery-full.txt`; render regression test below                                                                                                                                                                                                                                       |
| File tools             | Pass: write, read, edit, glob, grep                                                                                  | `/tmp/gent-feature-e2e-20260908/files-transcript.txt`; `/tmp/gent-feature-e2e-20260908/sample.txt` contains `alpha` and `gamma`                                                                                                                                                                                        |
| Foreground shell       | Pass: `printf` returned output and exit code 0                                                                       | `/tmp/gent-feature-e2e-20260908/files-transcript.txt`                                                                                                                                                                                                                                                                  |
| Background shell       | Fail: start succeeded; completion notice did not arrive                                                              | `/tmp/gent-feature-e2e-20260908/session-export.md`                                                                                                                                                                                                                                                                     |
| Questions              | Pass: selected answer returned to the model                                                                          | `/tmp/gent-feature-e2e-20260908/question-pending.txt`; `/tmp/gent-feature-e2e-20260908/question-result-before.txt`                                                                                                                                                                                                     |
| Prompt present         | Fail: informational content required a Yes/No answer                                                                 | `/tmp/gent-feature-e2e-20260908/prompt-present.txt`                                                                                                                                                                                                                                                                    |
| Prompt review          | Pass: review file saved; No returned as the decision                                                                 | `/tmp/gent-feature-e2e-20260908/review-pending.txt`; `/tmp/gent-feature-e2e-20260908/.gent/prompts/gent-e2e-review-cell:3664d9e80d9888d603656aaf58b3277126c6d14c254df823ef1249a11c0a27ea.md`                                                                                                                           |
| Artifacts              | Data calls passed: save, read, update, clear. Status label failed to refresh after clear                             | `/tmp/gent-feature-e2e-20260908/artifacts-transcript.txt`; `/tmp/gent-feature-e2e-20260908/goal-full.txt`; `/tmp/gent-feature-e2e-20260908/window-result.txt`                                                                                                                                                          |
| Foreground child       | Pass with the full model ID                                                                                          | `/tmp/gent-feature-e2e-20260908/session-export.md`                                                                                                                                                                                                                                                                     |
| Background child       | Pass: handle, inspect, list, and completion message                                                                  | `/tmp/gent-feature-e2e-20260908/session-export.md`                                                                                                                                                                                                                                                                     |
| Child cancellation     | Pass: child status became interrupted; parent received its result                                                    | `/tmp/gent-feature-e2e-20260908/child-cancel-progress.txt`                                                                                                                                                                                                                                                             |
| Session tools          | Pass: rename, search, and read                                                                                       | `/tmp/gent-feature-e2e-20260908/session-export.md`                                                                                                                                                                                                                                                                     |
| Skills and principles  | Pass: skill content, skill search, and principle content                                                             | `/tmp/gent-feature-e2e-20260908/session-export.md`; live compact turn in server log below                                                                                                                                                                                                                              |
| Network                | Pass: example.com fetch and IANA web search                                                                          | `/tmp/gent-feature-e2e-20260908/artifacts-transcript.txt`; `/tmp/gent-feature-e2e-20260908/session-export.md`                                                                                                                                                                                                          |
| Repository tool        | Pass: cached Prime Agent path lookup                                                                                 | Live compact turn in `/tmp/gent/logs/1812e000-20260908180640-server.log`                                                                                                                                                                                                                                               |
| Context                | Pass: status, durable read, compaction, revision label, new window marker                                            | `/tmp/gent-feature-e2e-20260908/window-start.txt`; `/tmp/gent-feature-e2e-20260908/window-result.txt`; `/tmp/gent-feature-e2e-20260908/goal-start.txt`                                                                                                                                                                 |
| Goal                   | Pass: create with budget, read, complete                                                                             | `/tmp/gent-feature-e2e-20260908/goal-preview.txt`; `/tmp/gent-feature-e2e-20260908/goal-full.txt`                                                                                                                                                                                                                      |
| Side question          | Pass: `/btw` opened and returned `BTW-PASS`                                                                          | `/tmp/gent-feature-e2e-20260908/btw-result.txt`                                                                                                                                                                                                                                                                        |
| Workflow command       | Pass: empty `/plan` queued the recipe and reported no saved plan                                                     | `/tmp/gent-feature-e2e-20260908/plan-result.txt`                                                                                                                                                                                                                                                                       |
| Handoff                | Pass after a delay: approval opened a new session; it returned `HANDOFF-PASS`                                        | `/tmp/gent-feature-e2e-20260908/handoff-pending.txt`; `/tmp/gent-feature-e2e-20260908/handoff-stalled.txt` contains the later successful result                                                                                                                                                                        |
| Session UI             | Pass: command list, tree, fork picker, permission panel, new session, branch creation                                | `/tmp/gent-feature-e2e-20260908/sessions-live.txt`; `/tmp/gent-feature-e2e-20260908/tree-live.txt`; `/tmp/gent-feature-e2e-20260908/fork-live.txt`; `/tmp/gent-feature-e2e-20260908/permissions-live.txt`; `/tmp/gent-feature-e2e-20260908/new-created.txt`; `/tmp/gent-feature-e2e-20260908/persistent-branches.json` |
| Reasoning level        | Pass: high and max appeared in the status line                                                                       | `/tmp/gent-feature-e2e-20260908/think-high.txt`; `/tmp/gent-feature-e2e-20260908/think-max.txt`                                                                                                                                                                                                                        |
| Transcript and input   | Pass: multiline rail, collapsed/preview/full cycle, output expansion, interruption, queued child result              | `/tmp/gent-feature-e2e-20260908/files-transcript.txt`; `/tmp/gent-feature-e2e-20260908/goal-preview.txt`; `/tmp/gent-feature-e2e-20260908/goal-full.txt`; `/tmp/gent-feature-e2e-20260908/child-cancel-progress.txt`                                                                                                   |
| Persistence and CLI    | Pass: start, close, `gent -c`, session list, doctor                                                                  | `/tmp/gent-feature-e2e-20260908/persistence-first.txt`; `/tmp/gent-feature-e2e-20260908/persistence-resumed.txt`; `/tmp/gent-feature-e2e-20260908/cli-sessions.txt`; `/tmp/gent-feature-e2e-20260908/doctor.txt`                                                                                                       |

## Open defects

1. `prompt` with `mode: "present"` blocks for an answer. Its description says no response is needed. `PromptPresenterLive.present` calls the approval service. The TUI renderer gives present mode the same Yes/No list as confirm mode.
2. A cell called `bash` with `run_in_background: true` and `sleep 2; printf BACKGROUND-SHELL-PASS`. The tool returned the start receipt. No completion message arrived before the test process closed. The full cause remains unconfirmed. The completion path can suppress follow-up errors.
3. `artifact_clear` removed the artifact. Two later reads returned `found: false`. The TUI still showed `1 artifact`. Artifact mutations do not call `ctx.State.changed`, but the status widget listens for that event.

Defect source files:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/interaction-tools/prompt.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/prompt-presenter-live.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/interaction-renderers/prompt.tsx`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/artifacts/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/artifacts-protocol.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/artifacts/store.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/artifacts.client.ts`

## Fixes made during this run

- `a411aa5f`: Update the auth E2E checks for the current OpenAI menu. The old tests expected Claude Code and one Down press.
- `60a11adc`: Show recovery results that use the `error` field. Decode error data separately from operation receipts. Recovery receipts have a different shape.
- `099ffb7e`: Show the error once in preview mode. Failed rows already show their details.

Fix source files:

- `/Users/cvr/Developer/personal/gent/packages/e2e/tests/e2e.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/auth.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/message-list.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/tool-renderers/cell.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/message-list-render.test.tsx`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-recovery.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-execution.ts`

## Coverage limits

This is a feature matrix, not every possible input or configuration.
Live provider inference used Luna. No new OAuth login was completed. Google, Mistral, and external ACP drivers were not exercised live.
The live run opened the fork picker but did not complete a message fork. The automated suite covers the underlying session paths.
Full multi-child `/plan`, `/audit`, `/review`, `/research`, and `/counsel` recipes were not run live. Their command tests and their shared tool paths passed separately.
Live testing did not cover clipboard image input, an external editor, theme changes, all goal pause/resume/budget transitions, fresh repository downloads, or every network failure path.
The invalid foreground model ID `Luna` and a wrong session ID produced errors. Correct IDs passed on retry. These input errors are not evidence of a failed valid operation.
Handoff initially appeared stuck. It later completed. Its successful capture has the earlier diagnostic filename `/tmp/gent-feature-e2e-20260908/handoff-stalled.txt`.
The final preview duplicate fix has a render regression test. The rebuilt live run verified the error text before that final two-line fix.

## Validation and inventory sources

- `/tmp/gent-feature-final-e2e.log`: 62 E2E tests passed.
- `/tmp/gent-cell-recovery-final-gate.log`: full gate passed after the final code change.
- `/tmp/gent-cell-recovery-render-test.log`: focused render tests passed.
- `/tmp/gent-feature-warm-final-build.log`: warm source binary rebuilt and the global symlink restored.
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/index.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/index.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-command-registry.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/workflows.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/handoff-tool.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/interaction-renderers/handoff.tsx`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/goal/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/goal/goal-store.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-context-host.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/interaction-tools/interaction-tools-rpc.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/workflows.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/exec-tools/bash-execution.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/delegate/delegate-foreground-child.test.ts`
- `/Users/cvr/Developer/personal/gent/plans/herdr-plugin-receipt-2026-09-08.md`
- `/Users/cvr/Developer/personal/gent/plans/extension-api-verification-2026-09-08.md`

## Next work

Fix the three open defects above. Add RPC tests that call each tool through a real cell. Native-tool tests alone did not detect these live failures.
Use the existing fixture directory and receipts to repeat each failed path. Do not rerun successful paid model checks without a new reason.

## Follow-up: three live defects fixed

The follow-up used Rift `/Users/cvr/Developer/personal/.rifts/gent/e2e-green` and Herdr pane `wZ:pH`.
The earlier matrix records the first run. These results replace its three failed rows.

- `f3fe3e76`: Background shell results retain their owning workspace. A queued result wakes an idle parent actor. The RPC test checks completion during a turn and after the parent becomes idle. The live check waited for the parent to become idle before it released the shell process. Evidence: `/tmp/gent-e2e-green/background-before-release.txt` and `/tmp/gent-e2e-green/background-delivered.txt`.
- `c114911f`: Artifact save, update, and clear publish state changes from the store. The RPC test checks all three notifications. The live badge appeared after save and disappeared after clear. Evidence: `/tmp/gent-e2e-green/artifact-saved.txt` and `/tmp/gent-e2e-green/artifact-cleared.txt`.
- `4b1286bc`: Present mode saves an informational transcript message without an approval request. The TUI shows the message and keeps later model output separate. Tool results still update the original cell when a notice follows it. The RPC test checks that the same cell continues. Feed and render tests check visibility. The live run showed the notice, cell output, and final reply without user input. Evidence: `/tmp/gent-e2e-green/present-green.txt`.

Validation: `/tmp/gent-present-green-gate.log` passed the full gate. `/tmp/gent-present-green-e2e.log` passed all 62 automated E2E tests. An earlier gate attempt and a later receipt commit hook failed in GitReader with ENOENT during scoped temporary-directory cleanup. A full gate passed between those failures. The receipt commit was rejected by its test hook. The cause is not established. Focused repetition passed 200 tests; the full extension process passed 366 tests in isolation and again beside the core test process. Temporary filesystem tracing found no failed or duplicate fixture removal in the passing run. Evidence: `/tmp/gent-e2e-green-receipt-commit.log`, `/tmp/gent-git-reader-repeat.log`, `/tmp/gent-extension-repro.log`, `/tmp/gent-extension-contention.log`, and `/tmp/gent-fs-trace.log`.

The live fork picker accepted a message and returned to the transcript. Capture: `/tmp/gent-e2e-green/fork-completed.txt`. This capture alone does not prove the new branch identity.

Source files for these conclusions:

- `/Users/cvr/Developer/personal/.rifts/gent/e2e-green/packages/core/src/domain/extension-services.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/e2e-green/packages/core/src/runtime/agent/agent-loop.handlers.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/e2e-green/packages/extensions/tests/exec-tools/bash-execution.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/e2e-green/packages/extensions/src/artifacts/store.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/e2e-green/packages/extensions/tests/artifacts/artifacts.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/e2e-green/packages/core/src/runtime/prompt-presenter-live.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/e2e-green/apps/tui/src/hooks/use-session-feed.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/e2e-green/apps/tui/src/components/message-list.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/e2e-green/apps/tui/tests/use-session-feed.test.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/e2e-green/apps/tui/tests/message-list-render.test.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/e2e-green/packages/extensions/tests/interaction-tools/interaction-tools-rpc.test.ts`

Remaining work: complete the coverage limits listed above, verify the new branch identity, and investigate the intermittent fixture failure. The RLM design review identified artifact state duplication. Removal of that extension is a separate design change and is not included in this defect fix.
