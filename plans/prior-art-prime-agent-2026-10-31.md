# Prime Agent source study, 2026-10-31

Prime Agent (PA): `/Users/cvr/.cache/repo/primeintellect-ai/prime-agent` at `c6d4da9`. That is 69 commits after the `8aac869` that the last study read.
gent: `/Users/cvr/Developer/personal/gent` at `899784b3d`.
Prior study: `plans/prior-art-prime-agent-2026-10-22.md`. This study does not repeat its settled verdicts. Those verdicts cover round-end coalescing, the per-row model, effort and cost, the zero-count tray, and park-until-reset.
Method: I read the source only. I did not run PA, gent or any model.
Labels: **measured** means I read it in source or commit text. **inferred** means it follows from the source but I did not run it. **guess** means I have no direct evidence.
PA paths are relative to the PA root. gent paths are relative to the gent root.

---

## A. RLM tool calling

### Prime Agent

- **One tool.** The harness gives the model one tool, `python_repl`. Every other tool is a Python function inside the REPL (`crates/pa-core/src/prompts/layers/core.md:3`). measured.
- **The kernel.** `python -m rlm.repl` uses protocol v3. It is NDJSON on fd 0/1 with one persistent `__main__` and top-level `await`. Output is tagged per cell. `result` is the `repr`, capped at 1 MiB. The kernel supports interrupt (SIGINT, or a cancel on Windows) and a `host_request` bridge. It does dill snapshot and restore, and `list_names`. `bash_activity` (list, tail, kill) runs out of band while a cell runs (`prime-agent-runtime/src/rlm/repl.md`). measured.
- **bash() from Python.** `bash(command, persistent=False)` returns a `BashHandle` at once and runs the command in the background. A `[bash-done]` notice arrives if the command ends outside the cell that started it (`core.md:9-10`). measured.
- **98bf740, await and yield.** `await handle` waits at most `_YIELD_AFTER_SECONDS = 1.0` (`prime-agent-runtime/src/rlm/bash.py:60-66`), and only when completion notices are wired. After that it returns `BashSnapshot(output, exit_code=None, running=True, handle)` (`bash.py:1050-1101`). The command keeps running (`_bounded_wait`, `bash.py:101-129`). A stderr hint tells the model to "End the turn — a [bash-done] notification arrives", at most 3 times per kernel (`bash.py:83-98`). A result the model consumes withdraws the notice; a degraded await keeps it. The system prompt states the 1 s contract (`crates/pa-core/src/prompts/system_prompt.rs:313`). measured.
- **f070998, the watchdog.** A `python_repl` cell has a default 60 s watchdog (`pythonCellTimeoutMs`; 0 turns it off). On overrun it does not kill. It adds a teaching stderr note that points to `bash()`, and it keeps the `ok` status, the kernel and the namespace. It arms only in daemon sessions, and the window does not count the queue wait. measured (commit text).
- **Busy kernel.** A second call while the kernel is busy offers "Wait and preserve state" or "Kill kernel and restart", then sends an `<ipython_kernel_reset>` notice (`crates/pa-core/src/tools/ipython.rs:205-216`). measured.
- **e2bcc6a, [python-state].** After a compaction with a live kernel, the harness appends a hidden `[python-state]` notice. It lists the names that are still defined, capped at 200 names or 4 KB with `+N more` (`crates/pa-core/src/session_engine/ipython_state.rs:119-144`). The built context keeps only the newest copy, and the summarizer never sees it. Before the fix, one notice was 273 KB with 14k globals, and copies stacked until the context overflowed. measured (commit text and source).
- **What the model sees.** `format_execute_text` sends plain text: stdout, stderr, the `repr` result, the traceback, and `[background output (unattributed)]` (`ipython.rs:246-270`). A kernel restart adds a notice; images go as image blocks (`ipython.rs:427-438`). `details` holds status, durationMs, stdout, stderr, bashCommands `{first,count,lines}`, error, diffs and sentAgentMessages. It is for the UI only and never reaches the model (`ipython.rs:440-499`). measured.
- **10f646d, edit diffs on the row.** The kernel's file edits go onto the python result. The row shows one `<path> +N -M` line per file, and numbered diff rows when you expand it (`crates/pa-tui/src/tool_card/ipython/diffs.rs`, `crates/pa-core/src/tools/ipython/diff/`). measured.
- **b8591c5, live timer.** A running tool card shows a live elapsed timer in the bash panel, the generic panel and the ipython duration slot. It ticks on the 80 ms spinner repaint that already runs, and the preview shrinks so the timer stays in view. measured (commit text).
- **Prompt size.** `core.md` is about 15.3 KB. Lines 90-135 hold a large harness-memory API, and line 177 lists the skills again in the dynamic tail. measured.

### gent

- **One tool, too.** `cell` runs TypeScript in full Bun with fd 3/4 frames and keeps a persistent namespace (`cell_namespaces`). It restores after a fault. Host tools are `tools.<id>`, and the catalog is capped at 8,000 chars (`docs/architecture/cell.md`; `packages/extensions/src/cell.ts:3335`). measured.
- **Deadline.** `CELL_COMPUTE_DEADLINE_MS = 30_000` (`cell.ts:1249`). Past it, gent kills the worker and reports "Cell deadline exceeded; working state was lost" (`cell.ts:1365-1407`). Awaited host calls stop the clock (`cell.ts:1395`). measured. PA keeps the namespace and teaches; gent loses it.
- **Receipts reach the model.** `withCellOperationReceipts` adds an `operations` array of `{toolCallId, tool, outcome, summary}` to the tool result (`cell.ts:2073-2134`; called at `cell.ts:2982`). Nothing between it and the provider strips it. `boundToolResultForModel` only cuts by size (`packages/core/src/runtime/model-context.ts:227-260`). measured. Each inner `toolCallId` is `cell:` plus 64 hex chars of SHA-256 (`cell.ts:249`). measured. That is about 30-40 tokens for the id alone, plus the tool, outcome and summary, on every inner call, paid again in every later request until compaction. inferred. The model already has the same facts from its own code and `display`. inferred.
- **JSON envelope.** The model gets `CellEvaluation {display, bindings, bindingCount, truncated, restored?, images?}` as JSON (`packages/extensions/src/cell-protocol.ts:250-267`). The 8,000-char bound keeps the JSON shape (`model-context.ts:152, 227-260`), so the newlines and quotes in `display` reach the model escaped. measured. The provider encodes the JSON a second time (`model-context.ts:225` comment). measured. PA sends plain text. The token cost of the escapes and keys is inferred, not measured.
- **Compaction already does PA's fix better.** `referencedBindings` and `bindingsNote` ask the summarizer to record what the retained names hold, and only the names the kept window references (`packages/extensions/src/compaction.ts:163-188`). Nothing stacks. measured. The name list has no count or byte cap. measured; minor.
- **Bash.** The timeout defaults to 120000 ms, with a max of 600000 (`packages/extensions/src/exec-tools.ts:601-627`). A foreground timeout interrupts the process and fails with `Command timed out after ${timeout}ms`, so the output is lost from the result (`exec-tools.ts:2051-2161`). measured. `run_in_background` returns at once with an output file and queues a follow-up (`exec-tools.ts:690-718, 2067-2081`). Job notices are projected per turn and marked read after it (`exec-tools.ts:2181-2200`). measured. A cell cannot hold a handle to a background job or wait on it. measured (no such API in `cell.ts`).
- **Row rendering.** Inner edit ops already carry `diff {added, removed}` on the cell row (`apps/tui/src/tool-renderers.tsx:818-821`). measured. So 10f646d is already done. A running tool row shows `· running` with no clock. It shows a duration only after it ends (`apps/tui/src/message-list.tsx:1490-1494`). measured. The status line already has a turn clock (`apps/tui/src/session.tsx:3519-3534`). measured.

### Verdict

| Item                                                                                              | Verdict                                                             |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| UI-only details, outside the model view (`ipython.rs:440-499`) vs gent receipts sent to the model | **copy**                                                            |
| Plain-text model view (`format_execute_text`) vs gent's JSON envelope                             | **adapt**                                                           |
| bash degrade: keep the process and the output, notify later                                       | **adapt** for the foreground timeout; **avoid** the fixed 1 s yield |
| Cell watchdog that teaches and keeps state (f070998) vs the 30 s kill                             | **adapt**                                                           |
| `[python-state]` after compaction                                                                 | **already better** (`compaction.ts:163-188`)                        |
| Edit diffs on the row (10f646d)                                                                   | **already done** (`tool-renderers.tsx:818-821`)                     |
| Live timer on a running tool row (b8591c5)                                                        | **copy**                                                            |
| Busy-kernel choice                                                                                | **avoid**: gent cells are serial per branch. inferred               |
| 15 KB tool-doc layer and skills listed twice                                                      | **avoid**                                                           |

---

## B. The agents view

### Prime Agent (changes since `8aac869`)

- **69a826f.** The agents view and the activity dock count persistent shells per session (`crates/pa-tui/src/agents_view/persistent_shells.rs`, `session_activity.rs`, `agents_view_forest/rows.rs`, `chrome.rs`, `bash_view.rs`). measured.
- **6852cb0.** → opens the selected row; on a shell row it opens the bash panel. A generic `app.modal.open` pairs with `app.modal.back`. measured.
- **c971d48.** This is a perf bench, not a view change. It records two marks for the agents view (first usable paint, then settled) and adds transcript paging, a paint-gap gauge and the idle cost (`crates/pa-perf/src/bench/runner.rs`). measured.
- **80a0d9c.** The session you left keeps the focus when you come back. The fix arms the anchor wait on every open, keeps paging until the anchor row lands, and expands a nested anchor's ancestors (`crates/pa-tui/src/agents_view/data_input.rs`, `agents_view_forest/lineage.rs`). The old test "carried selection wins" is deleted as a wrong premise. measured.

### gent

- **Keys.** ← closes the pane, → opens the row as ↵ does, and Ctrl+X arms a two-press delete with a count hint. Esc disarms (`apps/tui/src/extensions/agents.client.tsx:1531-1551, 988-989`). measured. This is the same grammar PA uses.
- **Return focus.** The pane marks and preselects the loop the shell is on (`agents.client.tsx:342`). measured. I did not trace whether a late-landing row or a nested anchor is found again. guess: the risk is lower because gent lists live rows and pages less.
- **Cost on rows.** The tray sums the cost of its rows (`agents.client.tsx:256-285`). measured.
- **Shell count.** The rows carry no count of background jobs. measured (no `shell` or `job` count in the row code). gent's background bash is per turn, and its follow-up is queued (`exec-tools.ts:690-718`). It has no persistent shell. measured.
- **Perf marks.** gent has no first-paint-then-settled mark for the pane. guess (I found no such bench).

### Verdict

| Item                                        | Verdict                                                         |
| ------------------------------------------- | --------------------------------------------------------------- |
| → opens, ← closes, two-press delete         | **already so**                                                  |
| Focus returns to the session left (80a0d9c) | **adapt only if a test fails**: write the round-trip test first |
| Shell count on rows (69a826f)               | **adapt** as a running-background-job count, small              |
| Two-mark paint bench (c971d48)              | **adapt** later, as a guard on pane open latency                |

---

## C. The factory and its view

### Prime Agent

- **Definition.** A machine is a `MACHINE.md` with frontmatter and spec blocks (`prime-agent-runtime/src/rlm/factory.py:4492-4673`). It ships `builder`, `pr-manager` and `review-sweep` (`prime-agent-runtime/src/rlm/machines/`). States have typed ports (`inputs`, `outputs`), `when` guards, `foreach` fan-out, `max_parallel` (default 8), `retries`, `failure_policy` (default `escalate`) and `budget_ms` (`factory.py:179-245, 854-904, 1341`). measured.
- **fc52926, Python nodes.** A state can carry `python: {import, callable}`. It runs in a new `python -I -c` subprocess in the cwd. Inputs go in as a dict on stdin, and the outputs come back as one JSON object on stdout (`factory.py:1144, 1399-1487`). It uses the state's retries and failure_policy. The time limit is the state's `budget_ms`, then the run's, else 60 s. measured.
- **e08c542.** Entry inputs can be optional. measured (commit title only).
- **Run.** `FactoryExecutor` (`factory.py:1655`) holds runs in kernel memory. **Runs do not survive a kernel restart.** The children keep running and `rlm.list_subagents` can still see them (`factory.py:24-26, 1596, 1675-1677`). States: running, stopping, paused, done, failed, stopped (`factory.py:1608`). A pause (escalate, budget, max_transitions) waits for an operator `resume` (`factory.py:1858-1883`). measured.
- **8a912af.** A factory child's end notice no longer reaches the parent; the factory reads settles through `rlm.collect`. The child's prompt says "do not message the parent" (`system_prompt.rs:89-91, 330-332`). measured.
- **ec3feb6.** `/context` groups the cost by factory run and keeps the spend of deleted agents (`pa-daemon/src/context_tree_cache.rs`, `context_tree_children.rs`, `rlm_ledger.rs`). measured.
- **407aa2b, the view.** `/factory` shows one panel per live run, newest first. Each panel draws the machine graph: every state as a glyph row with its occupancy (`reviewing (3 run · 2 queued)`), the edges below it, back edges marked, and the last-fired edges marked. It also shows the budget used and the last 3 milestones (`crates/pa-tui/src/factory_view.rs:1-26, 47-50`; graph in `factory_view/diagram.rs`, 462 lines). The arrows walk run headers and the states that ran a session. Enter or → opens that state's latest child session, and a state opened from the page returns to it. ← or Esc closes. Ctrl+X, two presses, stops a run or a child, and `r` resumes a paused run (`factory_view.rs:564-607, 798`). The view refreshes every 2 s (`FACTORY_WATCH_TICK_MS`, `factory_view.rs:47`). measured.

### gent

- **Definition.** It is JSON in `.gent/machines/<name>.json`, written by `machine.define`, which lists every problem at once. It has `thread`, `run`, `integrate`, `ask` and `final` states (`docs/architecture/machines.md:3-11`). measured. It has no `foreach` fan-out in the definition. measured (`packages/extensions/src/machines.ts` has no hit for foreach or parallel).
- **Code nodes.** A `run` state is a shell command (`machines.md:105-114`). It can already run `bun script.ts` with any language. inferred. That covers what fc52926 adds, except PA's typed stdin/stdout JSON contract.
- **Durability.** One `machine_runs` row and an append-only `machine_steps` log. Every write compares and sets on `seq`, and `Dispatched`/`Recorded` steps stop a restart from repeating an effect (`machines.md:12-26`). measured. PA loses runs on a kernel restart. **gent is better.**
- **No wake per round.** A round goes out with `notify: "none"`. The owner wakes only on an ask, a final state or a failure (`machines.md:33, 99-101`). measured. PA added the same thing only in 8a912af. **gent is better or equal.**
- **Model picks.** Roles, `rank: "cheapest"`, patience moves after 10 minutes, lane and quota waits, and quality counts (`machines.md:49-98`). PA has none of these. measured.
- **Cost.** Every `RoundEnded` keeps `costUsd` and tokens (`machines.md:91-93`). `machine.status` and `MachinesRpc.Quality` show it per state and model. measured. The TUI shows no cost grouped by run. The lanes band has no cost (`apps/tui/src/extensions/machines.client.tsx:74-91`), and the agents tray sums rows, not runs (`agents.client.tsx:256-285`). measured.
- **View.** The lanes band shows one line per active run: `<machine> <state> r<visits> <age>`, with `· wait <clock>` while a round waits (`machines.client.tsx:74-91`; `machines.md:122-130`). It has no per-run state view and no key to open a round's thread from the run. measured. The round threads do appear in the agents pane as threads. inferred.

### Verdict

| Item                                                                                      | Verdict                                                                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Durable runs, no-wake rounds, role picks, patience                                        | **already better**                                                                                      |
| A run page: states that ran, Enter opens the round's thread, return to the page (407aa2b) | **adapt** as a mode of the agents pane, not a new page                                                  |
| Cost grouped by run (ec3feb6)                                                             | **adapt**: one line in the run page or in `machine.status`                                              |
| Python nodes (fc52926)                                                                    | **avoid** as a new node kind; a `run` state covers it. Maybe adapt the stdin/stdout JSON contract later |
| `foreach` fan-out, `max_parallel`                                                         | **avoid for now**: no gent machine needs it yet. guess                                                  |
| A full graph diagram with occupancy                                                       | **avoid**: 462 lines of drawing for a list that the state log already gives                             |
| In-memory runs, operator `resume` for a pause                                             | **avoid**                                                                                               |

---

## Ranked candidates

### 1. Keep the cell receipts out of the model view

- **Change:** `packages/extensions/src/cell.ts:2122-2134` (`withCellOperationReceipts`); the TUI reader in `apps/tui/src/tool-renderers.tsx:896-905`; `docs/architecture/cell.md`.
- **Shape:** keep the receipts on the saved result for the transcript and the UI, as PA keeps `details` (`ipython.rs:440-499`). The model sees receipts only for `failed` or `incomplete` ops, without the 69-char ids. A cell that ends without its result (`cell.ts:2137` on) keeps its full receipts, because the model needs them to know what acted.
- **North star:** cheap per task.
- **Evidence:** measured that receipts reach the model (`cell.ts:2133`, no strip in `model-context.ts`). The size per op is inferred (about 50-70 tokens). The saving grows with inner calls per cell and with the number of later requests.
- **Check first:** count `operations` bytes in real cell results in the gent database (`cell_tool_operations` and the stored tool results) over a week of sessions. Read whether recovery or replay reads `operations` back from the model-facing result. The memory note "a model view that shows less needs a separate field" applies: add one `modelView` projection; do not fork the stored shape.
- **Outcome (2026-11-01):** built as queue row 47 (numbers and design there). Two departures from this shape. Failed and incomplete receipts keep their ids, so `context.read` can name them; the 40 failed and 12 incomplete receipts in the measure are too few for the ids to matter. The projection is core's, a pure function of the stored part (`operationReceiptsForModel`), not a per-tool `modelView` hook: the prompt build has no registry, and a view keyed on the advertised tools would change earlier results' bytes when the tool set flips.

### 2. Show a cell result to the model as plain text

- **Change:** `packages/extensions/src/cell-protocol.ts:250-267`, the cell tool's result encoding in `cell.ts`, and `packages/core/src/runtime/model-context.ts:227-260` if the bound must cut text, not JSON.
- **Shape:** `display` as raw text, then one `bindings:` line, then the flags (`truncated`, `restored`) only when set. Images stay as image parts.
- **North star:** cheap per task.
- **Evidence:** measured that gent sends JSON and PA sends text (`ipython.rs:246-270`). The token gain is inferred. Multi-line output is the case where escaping costs most.
- **Check first:** tokenize 20 real cell results both ways with the provider's counter. Do this only if the gain is above about 10%. Check that the TUI and compaction read the stored result, not the model text.

### 3. A foreground bash timeout keeps the process

- **Change:** `packages/extensions/src/exec-tools.ts:2051-2161` (the timeout branch) and `exec-tools.ts:690-718` (the background follow-up).
- **Shape:** when the timeout fires, move the process to the background path and keep its output so far. Return that output with "still running, a notice follows" and queue the same `background-bash` follow-up. Do not kill it. **Avoid** PA's fixed 1 s yield. That yield ends nearly every long call early and costs an extra wake turn each time. inferred.
- **North star:** one interaction model (one background path, not a kill and a retry). It is also cheap per task: the model does not run the command again.
- **Evidence:** measured that gent kills and loses the output; measured that PA degrades and keeps the process (`bash.py:101-129, 1050-1101`).
- **Check first:** confirm that a killed long run is followed by a rerun in real transcripts (search tool results for `Command timed out`). Check that the owner's interrupt still kills a foreground run at once.

### 4. A live timer on a running tool row

- **Change:** `apps/tui/src/message-list.tsx:1490-1494`. Use the spinner clock that already ticks (`machines.client.tsx:214` uses it; `session.tsx:3519-3534` for the status line).
- **Shape:** `· running 0:42`, from `call.startedAt`, which the row already has (`tool-renderers.tsx:57`).
- **North star:** one interaction model (the row, the status line and the lanes band read the same clock).
- **Evidence:** measured that gent shows only `· running` (`message-list.tsx:1491`); measured that PA ticks on the spinner repaint (b8591c5).
- **Check first:** confirm that `startedAt` is set for live calls, not only for replayed ones. Run the verify-gent live check at normal and narrow widths. The label must not push the row past the width.

### 5. A run page inside the agents pane

- **Change:** `apps/tui/src/extensions/agents.client.tsx` (a run mode), `apps/tui/src/extensions/machines.client.tsx` (the band row opens it), `packages/extensions/src/machines.ts` (`MachinesRpc.Status` already returns the steps).
- **Shape:** one list per run: each state visit with its round, model, verdict, cost and age, newest last, and a total cost line. Enter or → opens the round's thread session, and ← returns to the run page. Ctrl+X, two presses, stops the run, reusing the pane's delete grammar (`agents.client.tsx:1531-1551`). Do not draw a graph.
- **North star:** one interaction model (one pane, one key grammar); lean core with extensions (all in `@gent/machines` and its client).
- **Evidence:** measured that gent has only the one-line band (`machines.client.tsx:74-91`); measured that PA's page walks states and opens children (`factory_view.rs:1-26, 564-607`). This also covers candidate 6.
- **Check first:** read `MachinesRpc.Status` to see that it carries each round's thread session id and `costUsd`. Ask whether `gent ctl status --run` already prints enough. If so, the page is only a view over it.

### 6. Cost grouped by machine run

- **Change:** `packages/extensions/src/machines.ts` (`machine.status` total), the run page from candidate 5.
- **Shape:** a sum of `RoundEnded.costUsd` per run. A round with no price is shown as "not measured", as `machines.md:59-62` already rules.
- **North star:** cheap per task (you can see what a run cost).
- **Evidence:** measured that each round keeps its cost; measured that no view sums it by run.
- **Check first:** confirm whether `machine.status` already prints a run total. Then this is only the TUI line.

### 7. A cell over its deadline teaches before it kills

- **Change:** `packages/extensions/src/cell.ts:1249, 1365-1407`, the guideline at `cell.ts:3213`.
- **Shape:** at 30 s, write a note on the cell's output that points to `run_in_background` or `tools.bash` with `run_in_background`. Kill only at a hard cap, for example 120 s. Keep the namespace when the worker can be stopped without a crash.
- **North star:** cheap per task (no lost namespace, no rebuild turns).
- **Evidence:** measured that gent kills and loses the state; measured that PA keeps the state (f070998).
- **Check first:** count "Cell deadline exceeded" in real tool results. If it is rare, drop this candidate. The Bun worker may not allow a soft stop. Read the worker kill path before you decide.

### 8. A round-trip test for pane focus

- **Change:** an agents-pane test next to `apps/tui/src/extensions/agents.client.tsx`.
- **Shape:** open a child from the pane, switch sessions in it (`/new` or a fork), come back, and assert that the focus is on the session you left, also when its row lands late.
- **North star:** one interaction model.
- **Evidence:** measured PA bug and fix (80a0d9c). gent's behavior here is a guess.
- **Check first:** write the test. Fix the code only if the test fails.

### 9. A running background-job count on rows

- **Change:** `packages/extensions/src/agents-view.ts` (the row data), `apps/tui/src/extensions/agents.client.tsx` (the row).
- **North star:** one interaction model.
- **Evidence:** measured PA (69a826f); measured that gent has no count. The value is a guess: gent jobs are short-lived and per turn.
- **Check first:** decide whether the job notices in `exec-tools.ts:2181-2200` already show enough.

### Avoid

- PA's always-1 s `await` yield (`bash.py:60-66`). It costs a wake turn per long call. inferred.
- PA's 15 KB tool-doc prompt layer and the skills listed twice (`core.md`, line 177).
- A `[python-state]` style notice. gent's bindings note already does the job without stacking (`compaction.ts:163-188`).
- In-memory factory runs and an operator resume for a pause (`factory.py:24-26, 1858-1883`).
- A Python node kind and a graph diagram for machines.
- A busy-kernel restart choice.
