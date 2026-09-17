# Apply prompt

Fill the slots. The **work rules** block goes in verbatim; it is the single copy.

```
Work in the rift `<rift path>` (branch `<name>`). Read `CLAUDE.md` there first. The warm source `/Users/cvr/Developer/personal/gent` stays untouched. Apply the findings in `<report path>`; verify each receipt yourself, line numbers move.

<Commit plan: one numbered item per commit, with the commit subject. Order: compiler-adjudicated cleanup, then comment truth, then each behavior change alone with its regression test first.>

Work rules:
- Live binary: only through `bun run gamut`, which isolates the database. `GENT_LINK` stays unset. No push.
- Deletes use `trash`. Stage exact files by path.
- Probes: snapshot the file with `/bin/cp` into `<scratchpad>`, break the code, run the test, restore with `/bin/cp`. Git restores (`stash`, `checkout`, `reset`) lose real edits and are out.
- A regression test is red before the fix: run it against the unfixed code and quote the failure. A test that passes both ways proves nothing; find the path it misses.
- Sync tests use `test(...)`; effect tests use `it.live`. After adding tests, check the pass count rose.
- Caller-count greps cover `packages/`, `apps/` and `examples/`. Before a deletion, disable the code and run the suite (the deletion test).
- Inside `packages/core/src/` imports are relative. Services are yielded, never passed as parameters. Tagged unions use Effect Schema. `Option` where `effect/noNullish` or `effect/noTernary` fire.
- One file per concern: new code goes into the concern's existing file under a section banner. A split into `x-part.ts` fragments is a finding, not a fix.
- Comments describe today's behavior.
- Commit through the hook with output to a log: `git commit -qm "..." > <scratchpad>/commit.log 2>&1; echo EXIT $?`, then grep the log for ` error `, `(fail)`. A test that fails once under load and passes on one retry is a flake: retry once and name it in the reply.
- Finish in one run: no timers or monitors left behind.
- A file that does not fit the description: stop and report.

Final reply under 300 words: hashes, what was skipped and why, flake names, the last gate result.
```
