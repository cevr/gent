---
name: architecture-loop
description: Run the gent reduction loop — sweep every package against prior art and per-task token cost, apply, counsel, live-check, until a pass finds polish only.
disable-model-invocation: true
---

# Architecture loop

A **pass** is: coverage audit → read-only sweeps → triage into batches → per batch: apply in its own rift, one counsel round, merge → live check. Repeat passes until the close rule holds. Vocabulary and the HTML report come from the `improve-codebase-architecture` skill; invoke it once at the start.

The ledger is `plans/architecture-loop-<date>.md`. It is the single source of truth for what is done and what is rejected. Every sweep and apply brief names it. Pass files (briefs, reports, counsel prompts) live in `~/.cache/gent-pass<N>/`.

Decide by the principles in `~/Developer/personal/dotfiles/principles/` and write "decided by <principle>" in the ledger; the loop runs without owner check-ins.

The SAFETY rules live once, in `.claude/skills/architecture-loop/safety.md` ([`safety.md`](safety.md)). Every prompt the loop writes (the sweep brief and area prompts, apply, counsel, the live-check task file) starts by telling the agent to read that file in full before any action. Edit the rules there, never in a prompt.

## Steps

1. **Open the ledger.** Copy the section layout of the newest `plans/architecture-loop-*.md`. Record the HEAD hash and the baseline table (TypeScript source lines and files per package):
   `git ls-files ':(glob)packages/*/src/**/*.ts' ':(glob)packages/*/src/**/*.tsx' ':(glob)apps/*/src/**/*.ts' ':(glob)apps/*/src/**/*.tsx' | xargs wc -l | awk '$2 != "total" { split($2, p, "/"); n[p[2]] += $1; f[p[2]]++ } END { for (k in n) print n[k], f[k], k }' | sort -rn`.
   The `:(glob)` magic keeps `*` inside one path segment; a plain pathspec `*` crosses `/` and counts the lint fixtures under `packages/tooling/fixtures/` as source.
   Read [`rejected.md`](rejected.md). Done when the ledger file exists with a baseline.

2. **Coverage audit.** List every source directory with its file count:
   `git ls-files ':(glob)packages/*/src/**/*.ts' ':(glob)packages/*/src/**/*.tsx' ':(glob)apps/*/src/**/*.ts' ':(glob)apps/*/src/**/*.tsx' | xargs -n1 dirname | sort | uniq -c`.
   Mark each directory that no earlier ledger or report names. Those directories go first. Done when every directory has a mark: swept-before or unswept.

3. **Prior art, first pass only.** Read [`prior-art.md`](prior-art.md). Survey only what it does not already answer. Done when each new idea is a ledger row: adopt, or rejected with a reason.

4. **Sweep.** Fill the brief template in [`prompts/sweep.md`](prompts/sweep.md) into `~/.cache/gent-pass<N>/pass<N>-sweep-brief.md`, then launch one read-only agent per area in one message. One area every pass is **efficiency**: what the harness sends to the model, measured as cost per task; its agent also reads [`efficiency.md`](efficiency.md). Done when every area has a report, including the areas that report no findings, and the ledger has an efficiency baseline row.

5. **Triage.** Group the findings into batches, one per set of files (core, extensions, guard, TUI, tooling, efficiency, live fixes). Write the pass section of the ledger: the verdict, the decisions, and a triage table (batch, rift, items). Done when every finding is in a batch or rejected with a receipt.

6. **Apply.** Each batch gets its own rift from the warm source at main: `rift create --name p<N>-<batch> --copy-all <warm source>`, then create branch `p<N>-<batch>` inside it. Rift needs a filesystem with reflinks; where it has none, a git worktree on a new branch `p<N>-<batch>` from main is the fallback, with `bun install` and `bun run build` run in it, and "rift" in the steps below means that worktree. Launch one apply agent per batch from [`prompts/apply.md`](prompts/apply.md). Batches that touch disjoint files run in parallel; a batch that needs another batch's files starts from main after that batch merges. Done per batch when the rift tree is clean and its last commit passed the hook.

7. **Counsel.** One round per batch, from [`prompts/counsel.md`](prompts/counsel.md). The apply agent fixes each defect with a test that is red first, in one fixup round, then moves on. Done when every defect has a commit or a written rejection.

8. **Merge.** Per batch, in its rift: merge main, resolve conflicts there, run `bun run gate` into a log and read `GATE EXIT`. Then from the warm source: `git fetch <rift path> HEAD:refs/heads/p<N>-<batch>`, `git merge --no-edit p<N>-<batch>`, gate into a log, read `GATE EXIT`. Write the batch's ledger row (`done <hash> … <hash>, merged <hash>`, decisions, counsel result, open items), add re-proposable rejections to [`rejected.md`](rejected.md), and remove the rift by its full path. Push only when asked. Done when the gate on main is green, the row is written and the rift is gone.

9. **Live check.** The orchestrator runs this step itself; `safety.md` allows the gamut to it alone. After each merge, or a small batch of merges, run the gamut through the herdr CLI (`herdr pane`, never `herdr agent`). Write a prompt file whose first line sends the agent to read `<warm source>/.claude/skills/architecture-loop/safety.md` in full before any action, and whose task drives every ability the batches changed (each apply report names them), and drive TUI keys the prompt cannot reach (`/btw`, `/model`, queued follow-ups, Esc, `!cmd`, `gamut restart` for resume) with `herdr pane send-text`. `bun run gamut up <preset> --prompt <file>`, `wait`, `read`, then `bun run gamut status`. `status` prints the stored user messages and the session tree: the pane shows what rendered, `status` shows what happened. A defect found here becomes a live-fix batch (step 6). Done when `status` matches the intent, the ledger has a live-check row, and `bun run gamut down` ran.

## Close rule

Close when one pass holds all four: the coverage table has no unswept directory, the sweeps report polish only (under about 5 lines of value each), the efficiency sweep has no measured saving left that it can change directly, and the loop reader names no structural change. Then write the HTML report and the final message. A pass that finds a guard blind spot is never the last: close the blind spot, run the guard, and sweep what it reveals.

## What pays late

After pass two, more reading finds little. These three found the rest, so reach for them before another sweep: the coverage audit, guard blind spots (what can the dead-export guard not see?), and live runs checked with `gamut status`.
