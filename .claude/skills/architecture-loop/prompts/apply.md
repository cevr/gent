# Apply prompt

One agent per batch, in the batch's own rift. Fill the slots. The **work rules** block goes in verbatim; it is the single copy. The SAFETY rules live in one file, [`safety.md`](../safety.md), which the prompt's first line sends the agent to read; edit the rules there, never in a prompt.

```
Read `<rift path>/.claude/skills/architecture-loop/safety.md` in full before any action, and follow it.

Pass-<N> apply batch `p<N>-<batch>`. Rift <rift path> (branch p<N>-<batch>, base main <hash>). Read CLAUDE.md and ARCHITECTURE.md there first. The warm source <warm source> stays untouched. Apply <item ids> from <report paths>; re-verify each receipt in the source first, line numbers move. Reject a finding that does not hold, and say why.

<Decisions the orchestrator already made, with their principle.>
<Files other batches own: report a fix there as a decision; leave the file unedited.>

Commit plan: <one numbered item per commit, with the commit subject. Order: compiler-adjudicated cleanup, then comment truth, then each behavior change alone with its regression test first.>

Work rules:
- Bugs are red first: the test fails on the unfixed code, quoted. Prove each fix with a probe: `/bin/cp <file> <scratchpad>/<name>.snap`, break the fix, see the test go red, `/bin/cp` back, `cmp`. Git restores (`stash`, `checkout`) lose real edits and are out.
- Reductions use the deletion test: delete the code, and let typecheck and tests name the real consumers. Caller-count greps cover `packages/`, `apps/` and `examples/`.
- Stored formats (SQLite rows, event tags, state files) stay as they are; an additive optional field is acceptable, named in the reply.
- Dependency edits (package.json dependencies, the catalog, bun.lock) may be denied by the permission check. When one is denied, stop that item and report it.
- Sync tests use `test(...)`; effect tests use `it.live`, with `Effect.timeout` inside the Effect; state changes wait on a `Deferred` or `waitFor`, never `Effect.sleep`. After adding tests, check the pass count rose.
- Inside `packages/core/src/` imports are relative; extensions import only the public entries. Services are yielded, never passed as parameters. Tagged unions use Effect Schema. `Option` where `effect/noNullish` or `effect/noTernary` fire.
- One file per concern: new code goes into the concern's existing file under a section banner. A split into `x-part.ts` fragments is a finding, not a fix.
- Comments describe today's behavior.
- Decide by the principles in ~/Developer/personal/dotfiles/principles/ and write "decided by <principle>"; the batch runs without check-ins. Owner rules: children wake, never block; the cell runs in full Bun; docked panes; a shipped extension is never more privileged than a user extension; personal library, no shims.
- Gate: `bun run typecheck`, `bun run lint`, focused `bun test`, then commit through the hook, which runs the full gate, with output to a log: `git commit -qm "..." > <scratchpad>/commit.log 2>&1; echo EXIT $?`, then grep the log for ` error `, `(fail)`. A test that fails once under load and passes on one retry is a flake: retry once, name it, and keep its assertions.
- Commits: Conventional Commits, one logical unit each, staged by exact path. Deletes use `trash`. No push, no rift creation or removal, no edits under `plans/`.
- Live binary: as `safety.md` says, with <scratchpad> as the scratch directory.
- Before the report: merge main into the rift, resolve conflicts there, run `bun run gate` into a log and read `GATE EXIT`.
- Finish in one run: no timers or monitors left behind. A file that does not fit the description: stop and report.

Report (final message, ASD-STE100 style): commits (hash + subject), `git diff --stat <base>..HEAD | tail -1`, per-item result with file:line receipts, a probe table, flake names, the last `GATE EXIT`, decisions for the orchestrator, and the abilities the batch changed with the TUI steps that show them in a gamut run.
```
