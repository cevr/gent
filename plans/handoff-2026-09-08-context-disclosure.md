# Context and disclosure handoff

Prepared: 2026-09-08.

Update: The deferred items and UI defects are complete at `b150215a`.
The live checks passed. See `plans/disclosure-fixes-receipt-2026-09-08.md`.
The rest of this file records the original starting state.

## Request

Read the last Claude session. Prepare to do these three tasks:

1. Run Gent with Luna. Open a long transcript. Press `ctrl+o` three times. Check preview and full output.
2. Ask Luna to call `context.status()` and `context.newWindow()` in a cell. Check the status line and the window marker.
3. Read the deferred counsel findings. Decide whether the revision label needs a small change.

The two live checks have not run in this handoff pass. No model request was sent. No code changed. No commit or push was made.

## Verified starting state

- Checkout: `/Users/cvr/Developer/personal/gent`.
- Branch: `main`.
- HEAD: `dd517c29` (`fix(runtime): close counsel findings on the context plan`).
- The worktree was clean before this file was added.
- Claude session: `17f27525-938e-4ff3-bd2f-e538f846be84`.
- Claude gave its last work report at `2026-09-08T08:57:09.295Z`.
- Later session entries only show a local model selection command.
- Herdr shows this Codex session in `wZ:pG`. It shows no live Claude pane in Gent. Discover pane IDs again before control operations.
- Claude reported a green full gate and a push to main. This pass verified local HEAD. It did not verify the remote or run the gate again.
- The old `fx-ui` Rift note is historical. The current Claude transcript and local HEAD identify this checkout as the source of this handoff.

## First live check: disclosure

Read the TUI instructions before starting. Use an isolated Rift for code changes. Use `rift create --copy-all`. Keep the warm source free of feature changes. Check CLI help before choosing model flags.

Use Gent with `gpt-5.6-luna` at max reasoning. This is a Gent product check. It is not a request to start a separate implementation agent.

Open a long transcript with completed cell and bash output. If no suitable transcript exists, create a test session with harmless numbered output of more than 20 lines. Include enough turns to require scrolling.

Record the Gent session ID, branch ID, model, command, and terminal captures. Start with disclosure collapsed.

1. Press `ctrl+o`. Expect preview. All tool rows must be visible. The last output must show its first 20 lines and the hidden-line count.
2. Press `ctrl+o`. Expect full output. Check the text beyond the preview boundary.
3. Press `ctrl+o`. Expect collapsed output. Check that the header text stays the same.
4. Open preview again. Press `esc`. Expect collapsed output when no overlay takes the key first.
5. Scroll up. Check that the transcript stays at the selected position during output and disclosure changes.

Check `ctrl+shift+o` separately. It opens the transcript view. It is not a disclosure level.

Current code uses one disclosure value in session UI state. Do not assume each group has its own level.

## Second live check: context calls

Use a dedicated test session. A new window changes the model projection for that branch.

Ask Luna: "In a cell, call context.status() and print the returned object. Then call context.newWindow() and print its reply. After the next model step, use a second cell to call context.status() again. Report both status objects. Do not change files."

Verify actual tool calls. Model prose alone is insufficient evidence.

- `context.status()` returns `projected`, `tokens`, `limit`, `available`, `percent`, `omittedMessages`, and `compactedRevision` after a projection exists.
- Before a projection exists, it returns `{ projected: false }`.
- `context.newWindow()` returns `{ scheduled: "newWindow" }`.
- The host schedules the change. The next successful projection applies it. A status call in the same cell is not proof of the new projection.
- Expect a durable `context-window` message. The TUI label is `⇣ new context window`.
- Check the next status line against the next status result. Do not require an exact token decrease. The retained user unit and new cell output affect the count.
- Confirm that old transcript content remains available. A new window changes the projection; it does not delete history.

Capture the screen before and after the next projection. Save the cell results and marker evidence with the test session IDs.

## Deferred counsel findings

The final Claude report lists three deferred items. The plan's Status section does **not** list them. Use the report and counsel file below as the source.

1. Summary source selection does not include the optional compaction instructions or retained-binding note in its input budget.
2. The status line shows `compacted ×N`. The plan asks for `compacted r2`. The event carries a Boolean and the snapshot carries a count. The ledger has the latest summary revision string.
3. The interrupted-turn directive rule lacks a full runtime test. Ledger tests cover the rule. Check the current runtime tests before adding coverage.

Counsel also suggested one shared projection receipt schema. This is a design suggestion, not a requirement for the three live checks.

The original counsel file describes defects before `dd517c29`. Claude reports that the four P0 findings and the missing cell-receipt path case were fixed. Do not reopen those findings without checking current code.

## Initial decision on the revision label

Do not change `×N` to `rN` using the existing count. They have different meanings.

The ledger gets `sourceRevision` from the newest summary in the projection. The TUI gets a cumulative count. A text-only change would be incorrect.

Keep the count for the live checks. A follow-up is useful if the UI must identify the summary that the model currently sees. Carry the actual optional revision through the projection event and snapshot first. Choose its display format after checking the revision value. Do not assume it is an integer.

Prioritize the summary input budget and interrupted-turn runtime test above this label change. Record the final decision after the live checks.

## Validation and completion

- Read `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md` before implementation.
- Read `/Users/cvr/Developer/personal/gent/apps/tui/AGENTS.md` before TUI work.
- Apply the Effect skill for runtime changes.
- Run `bun run gate` after each code unit and before code handoff. Use `bun run test`, not bare `bun test`, for the workspace gate.
- Save live terminal evidence separately from test results. A green test run does not prove the live UI check passed.
- Do not install packages unless the lock file changes.
- Do not push without a user request in the active task.
- Do not expose provider credentials in captures or logs.

## Sources read in this pass

- `/Users/cvr/.claude/projects/-Users-cvr-Developer-personal-gent/17f27525-938e-4ff3-bd2f-e538f846be84.jsonl` — final work report at line 15992; earlier checkpoint at line 15514.
- `/tmp/counsel/personal-gent-860892a9/20260908-083902-claude-to-codex-624583/codex.md` — original review and deferred findings. This temporary file may not survive a restart.
- `/Users/cvr/Developer/personal/gent/plans/context-and-disclosure.md` — intended behavior and shipped Status.
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-ui-state.ts` — disclosure transitions.
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/message-list.tsx` — preview limit and window label.
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/message-list-utils.ts` — preview text and footer.
- `/Users/cvr/Developer/personal/gent/apps/tui/src/utils/session-labels.ts` — current count label.
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/model-context-ledger.ts` — status and directive state.
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-context-host.ts` — status reply and scheduled window call.
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/model-compaction.ts` — revision source and summary input selection.
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts` — ledger receipt and projection event.
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event.ts` — projection event definition.
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts` — snapshot metrics definition.
- `/Users/cvr/Developer/personal/gent/package.json` — gate commands.
- `/Users/cvr/Developer/personal/dotfiles/principles/never-block-on-the-human.md` — execution rules.
- `/Users/cvr/Developer/personal/dotfiles/principles/redesign-from-first-principles.md` — design rules.

Read-only live commands also supplied evidence: `git status --short`, `git log -4 --oneline`, `git branch --show-current`, `herdr --skill`, `herdr --help`, `herdr agent list`, and `herdr workspace list`.
