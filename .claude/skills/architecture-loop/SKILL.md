---
name: architecture-loop
description: Run the gent reduction loop — sweep every package against prior art and per-task token cost, apply, counsel, live-check, until a pass finds polish only.
disable-model-invocation: true
---

# Architecture loop

A **pass** is: coverage audit → read-only sweeps → apply in a rift → one counsel round → live check → ledger rows. Repeat passes until the close rule holds. Vocabulary and the HTML report come from the `improve-codebase-architecture` skill; invoke it once at the start.

The ledger is `plans/architecture-loop-<date>.md`. It is the single source of truth for what is done and what is rejected. Every sweep prompt names it.

## Steps

1. **Open the ledger.** Copy the section layout of the newest `plans/architecture-loop-*.md`. Record the baseline: `find packages/core/src/runtime/agent -name '*.ts' | xargs wc -l | tail -1` and the HEAD hash. Read [`rejected.md`](rejected.md). Done when the ledger file exists with a baseline.

2. **Coverage audit.** List every source directory with line counts:
   `git ls-files 'packages/*/src' 'apps/*/src' | xargs -n1 dirname | sort | uniq -c`.
   Mark each directory that no earlier ledger or report names. Those directories go first. Done when every directory has a mark: swept-before or unswept.

3. **Prior art, first pass only.** Read [`prior-art.md`](prior-art.md). Survey only what it does not already answer. Done when each new idea is a ledger row: adopt, or rejected with a reason.

4. **Sweep.** Launch read-only agents from [`prompts/sweep.md`](prompts/sweep.md), one per area, in one message. Each writes a report file. One more area every pass is **efficiency**: what the harness sends to the model, measured as cost per task. Its prompt adds [`efficiency.md`](efficiency.md) to the read-first list. Done when every area has a report, including the areas that report no findings, and the ledger has an efficiency baseline row.

5. **Apply.** One rift per pass (`rift create --copy-all --name <pass>`). Launch apply agents from [`prompts/apply.md`](prompts/apply.md). Agents that share a rift run one after the other, because the pre-commit hook gates the whole tree. Done when the rift tree is clean and its last gate log ends `GATE EXIT 0`.

6. **Counsel.** One round per pass, from [`prompts/counsel.md`](prompts/counsel.md). Fix each defect with a test that is red first. One fix commit, then move on. Done when every defect has a commit or a written rejection.

7. **Live check.** After each merge, or a small batch of merges, run the gamut through the herdr CLI (`herdr pane`, never `herdr agent`). Write a prompt file whose task drives every ability the batch changed, and drive TUI keys the prompt cannot reach (`/btw`, `/model`, queued follow-ups, Esc, `!cmd`, `gamut restart` for resume) with `herdr pane send-text`. `bun run gamut up <preset> --prompt <file>`, `wait`, `read`, then `bun run gamut status`. `status` prints the stored user messages and the session tree: the pane shows what rendered, `status` shows what happened. Done when `status` matches the intent, then `bun run gamut down`.

8. **Ledger rows.** Every finding gets a row: `done <hash>`, or `rejected: <receipt>`. Add rejected rows to [`rejected.md`](rejected.md) when a later pass could re-propose them.

9. **Merge.** From the warm source: `git fetch <rift path> HEAD:refs/heads/<name>`, `git merge --no-edit <name>`, `bun run gate` into a log, read `GATE EXIT`. Remove the rift by its full path. Push only when asked.

## Close rule

Close when one pass holds all three: the coverage table has no unswept directory, the sweeps report polish only (under about 5 lines of value each), the efficiency sweep has no measured saving left that it can change directly, and the loop reader names no structural change. Then write the HTML report and the final message. A pass that finds a guard blind spot is never the last: close the blind spot, run the guard, and sweep what it reveals.

## What pays late

After pass two, more reading finds little. These three found the rest, so reach for them before another sweep: the coverage audit, guard blind spots (what can the dead-export guard not see?), and live runs checked with `gamut status`.
