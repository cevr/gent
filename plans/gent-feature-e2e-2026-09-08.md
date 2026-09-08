# Gent feature E2E receipt — 2026-09-08

## Result

The full gate passed. All 62 automated E2E tests passed: 26 TUI tests and 36 process/RPC tests.
The configured feature matrix is green after the follow-up fixes. All five workflow recipes have live completion evidence. Review required recovery after a defect. The later sections record each fix and repeat check. This receipt does not claim every provider, input, or configuration was tested.

The run used Herdr 0.9.0, pane `wZ:pH`, `openai/gpt-5.6-luna`, and `openai/gpt-6-astra`.
The test directory was `/tmp/gent-feature-e2e-20260908`.
The first Gent process used `--isolate`. A second process used normal storage to test restart and resume.
Only test sessions and fixture files were changed. The test pane was returned to its shell.

## Initial live feature matrix

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

## Defects from the initial run

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

## Coverage limits from the initial run

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

## Next work from the initial run

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

- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/exec-tools/bash-execution.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/artifacts/store.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/artifacts/artifacts.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/prompt-presenter-live.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/hooks/use-session-feed.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/message-list.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/use-session-feed.test.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/message-list-render.test.tsx`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/interaction-tools/interaction-tools-rpc.test.ts`

Remaining work: complete the coverage limits listed above, verify the new branch identity, and investigate the intermittent fixture failure. The RLM design review identified artifact state duplication. Removal of that extension is a separate design change and is not included in this defect fix.

## Follow-up: fork, theme, and external editor

The initial fork screen capture did not prove success. The server log recorded `NotFoundError: Message not found in branch`. The live transcript uses temporary assistant IDs. The fork picker passed one of those IDs to the server.

Commit `d01af734` loads saved messages before the picker opens. The picker retains those message IDs. The live repeat forked the assistant reply without a reload. The server returned branch `01a082c9-1ea1-74c2-8670-a6f0f3962eaf` from branch `01a082c8-b5b5-70d2-8932-8a969e19abea`. The next user request ran on the new branch.

Evidence:

- `/tmp/gent-e2e-green/fork-saved-picker.txt`
- `/tmp/gent-e2e-green/fork-server.txt`
- `/tmp/gent/logs/dc3dbaab-20260908204945-server.log`
- `/tmp/gent-fork-green-gate.log`: full gate passed.
- `/tmp/gent-fork-green-e2e.log`: all 62 E2E tests passed.
- `/tmp/gent-fork-green-commit.log`: all commit checks passed.

The theme palette selected Light and showed its active marker. Dark was restored after the test. Evidence: `/tmp/gent-e2e-green/theme-light.txt`.

Ctrl+G opened `vi` with `EDITOR-INITIAL`. Saving `EDITOR-CHANGED-GREEN` returned the edited draft to Gent. The draft retained its trailing newline and its full left border. Evidence: `/tmp/gent-e2e-green/editor-return.txt`.

Source files:

- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/message-picker.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-ui-state.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/command-palette.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/utils/external-editor.ts`

## Follow-up: long turns and Astra access

The full review workflow found two more defects.

1. The OAuth filter accepted only GPT-5 names. The local catalog contained `openai/gpt-6-astra`, but the filter removed it. Child review attempts failed before inference with `ModelContextCapabilityError`. Commit `ff284e49` permits that exact model. The driver test sends its model name to the Codex endpoint. A real Luna cell then delegated to Astra and received `ASTRA-GREEN`.
2. Long model calls were interrupted and restarted after roughly one minute. The cluster considered the entity idle after the mailbox request returned, even while its detached turn worker was active. Commit `2479d42f` holds entity keep-alive for the turn and releases it on exit. The RPC regression holds a model call open across two minutes of test time. It failed before the fix and passed after the fix, with one model call and one saved reply. The local test actor has no cluster idle reaper, so that adapter needs no keep-alive.

Evidence:

- `/tmp/gent-e2e-green/review-model-failure.txt`
- `/Users/cvr/.gent/models.json`: cached model metadata only.
- `/tmp/gent-e2e-green/astra-green.txt`
- `/tmp/gent-e2e-green/astra-server.txt`
- `/tmp/gent/logs/dc3dbaab-20260908205752-server.log`: repeated interruptions before the lifetime fix.
- `/tmp/gent-turn-lifetime-repro.log`: model started, then the turn failed to complete after idle expiry.
- `/tmp/gent-turn-lifetime-fixed.log`: regression passed after keep-alive.
- `/tmp/gent-turn-lifetime-green-gate.log`: full gate passed.
- `/tmp/gent-turn-lifetime-green-e2e.log`: all 62 E2E tests passed.
- `/tmp/gent-turn-lifetime-green-commit.log`: commit checks passed.
- `/tmp/gent-astra-green-commit.log`: commit checks passed.

Source files:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/openai/oauth.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/openai/openai-extension-driver.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop/turn-lifetime.test.ts`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`

A full workspace test run with temporary filesystem tracing also passed. Its only removal error was a missing background-test marker, not a GitReader fixture. No GitReader cleanup cause is established. Evidence: `/tmp/gent-workspace-fs-trace-test.log` and `/tmp/gent-fs-trace.log`.

The four Astra review and critique children completed. Long calls now finish without idle expiry. The final artifact save then exposed a decoded-input defect. The next section records the fix and recovery.

## Follow-up: decoded tool inputs and review completion

Commit `8a6107b0` validates the decoded tool input with `Schema.toType`. The toolkit already decodes wire input. The previous second decode rejected transformed metadata objects and ended the turn. The RPC regression sends JSON metadata through a real cell for save and update. It failed before the fix and passed after it.

The four completed child results were recovered with `context.read` and saved to `/tmp/gent-e2e-green/review-results.json`. A fresh process read those results, made the report, saved the artifact, and read it back. No child review was repeated. Artifact `0c688e7d-8aec-4ac8-b574-99fae5822de2` contains one medium finding and metadata for two reviewers and two critics. The fixture file was not changed. This proves the complete workflow with recovery. It does not prove an uninterrupted first attempt.

Commit `dd4648d1` uses the shared scoped fixture helper in the GitReader tests. Its cleanup permits an already absent directory. The earlier source of the missing directory remains unknown. Full gates and both commit checks passed after this change.

Evidence:

- `/tmp/gent-tool-metadata-repro.log`
- `/tmp/gent-tool-metadata-fixed.log`
- `/tmp/gent-e2e-green/review-results-preserved.txt`
- `/tmp/gent-e2e-green/review-complete.txt`
- `/tmp/gent-metadata-cleanup-green-gate.log`: full gate passed.
- `/tmp/gent-tool-metadata-green-commit.log`: commit checks passed.
- `/tmp/gent-git-reader-green-commit.log`: commit checks passed.
- `/tmp/gent-tool-metadata-green-e2e.log`: all 62 E2E tests passed.

Source files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/artifacts/artifacts.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/librarian/git-reader.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/fixtures.ts`

## Follow-up: goal controls and counsel

A one-token goal reached `budget_limited`. Pause changed the status to `paused`. Resume with a new 100,000-token budget started continuations. Pause then stopped further continuations. Clear removed the goal from the status line. The test goal was cleared before the next workflow.

The counsel command delegated to Astra. The parent showed the child opinion verbatim, then its response. It made no file changes.

Evidence:

- `/tmp/gent-e2e-green/goal-budget-limited.txt`
- `/tmp/gent-e2e-green/goal-resumed.txt`
- `/tmp/gent-e2e-green/goal-paused.txt`
- `/tmp/gent-e2e-green/goal-cleared.txt`
- `/tmp/gent-e2e-green/counsel-complete.txt`

Source files:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/goal/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/workflows.ts`

Clipboard image paste is not a current composer feature. The composer accepts text, and its submit callback accepts a string. Transcript image rendering does not add clipboard input. This is outside current feature coverage.

Source files:

- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/composer.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/use-composer-controller.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts`

Remaining live work: plan, audit, research, and repository error handling. Provider coverage uses configured Luna and Astra access. Other provider credentials are not configured for this run.

## Follow-up: research and audit

Research fetched `octocat/Hello-World` through the repository tool. Its cache directory was created during this run. A child read the README. The parent returned its content with a file citation. Audit ran concern detection, two independent audits, and synthesis. It saved artifact `c905c751-3dff-498b-a3b8-d075d47e2e03` and presented one warning without approval. The audit first recovered from model-generated cell syntax with no source change.

Evidence:

- `/tmp/gent-e2e-green/research-complete.txt`
- `/tmp/gent-e2e-green/research-repository-head.txt`
- `/Users/cvr/.cache/repo/octocat/Hello-World/README`
- `/tmp/gent-e2e-green/audit-complete.txt`

Source files:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/workflows.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/librarian/repo-explorer.ts`

## Follow-up: repository download errors

Commit `740a8385` rejects failed npm subprocesses and missing archives. It also rejects PyPI and Crates downloads, which had no implementation but reported success. The tool description now states its supported download types. Cache-directory errors also remain visible.

The RPC regression calls the real repository tool through a cell. Before the fix, all three invalid fetches returned success. After the fix, all three returned errors and the cell completed. The npm case uses an invalid version string and needs no registry response.

Evidence:

- `/tmp/gent-repo-errors-repro.log`: three false success results.
- `/tmp/gent-repo-errors-fixed.log`: regression passed.
- `/tmp/gent-repo-errors-green-gate.log`: full gate passed.
- `/tmp/gent-repo-errors-green-commit.log`: all commit checks passed.
- `/tmp/gent-repo-errors-green-e2e.log`: all 62 E2E tests passed.

Source files:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/librarian/repo-explorer.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/librarian/repo-tool.test.ts`

Remaining work: finish plan approval, repeat repository and network failures in the rebuilt live app, then integrate the verified commits.

## Follow-up: full plan workflow

The plan command ran two independent plans, two cross-reviews, and one synthesis with Astra. It saved artifact `34071e55-db90-418c-b359-520f8235680b`, then requested approval. Selecting No returned that decision to the model. The model stopped without changing the fixture. The artifact badge showed three saved artifacts: review, audit, and plan.

Evidence:

- `/tmp/gent-e2e-green/plan-approval.txt`
- `/tmp/gent-e2e-green/plan-complete.txt`
- `/tmp/gent-e2e-green/plan-target-unchanged.txt`

Source files:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/workflows.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/interaction-tools/prompt.ts`

All five named workflows now have live completion evidence. Review required recovery after a defect; the other workflows completed in one process. The final rebuilt app is checking repository and network error paths before integration.

## Final live result and scope

The rebuilt app returned `REPO-NETWORK-GREEN`. Four invalid or unsupported repository fetches returned errors. The GitHub missing-repository case returned HTTP 404. A valid npm download returned `is-number` version `7.0.0`; its extracted package metadata matched. A local web request returned a transport error. All expected errors were caught in the cell, which continued and completed.

Evidence:

- `/tmp/gent-e2e-green/repo-network-green.txt`
- `/tmp/gent-e2e-green/repo-network-results.json`
- `/Users/cvr/.cache/repo/npm/is-number/7.0.0/package/package.json`

Source files:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/librarian/repo-explorer.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/network-tools/webfetch.ts`

No confirmed defect remains open from this run. The full gate and all 62 automated E2E tests passed on the final code. Live coverage includes both configured models, all five named workflow recipes, goal controls, fresh repository downloads, expected errors, and the earlier UI/runtime matrix. Clipboard image paste and PyPI/Crates downloads have no implementation. Other provider credentials were not configured. These limits are not successful live tests. The unknown cause of the old GitReader fixture disappearance remains a diagnostic limit; cleanup now uses the shared idempotent helper and passes the full gate.

The RLM artifact simplification remains a separate design proposal. This run does not remove the artifact extension.
