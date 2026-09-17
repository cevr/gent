# Counsel prompt

One round per pass. Write the prompt to `<scratchpad>/counsel-pass<N>.md`, run in the background:
`okra counsel -f <prompt> -o <scratchpad>/counsel-out<N> > <log> 2>&1; echo "COUNSEL EXIT $?" >> <log>`.
When codex is rate-limited, launch an independent Opus agent with the same prompt.

```
Review commits `<base>..HEAD` on `<rift path>` (gent: Effect 4 agent harness, actor model, Solid TUI). Use `git log --oneline <base>..HEAD` and `git show <hash>`. Read `ARCHITECTURE.md` and `<ledger path>`. Edit nothing. Real defects only, each with file:line and a failing scenario.

<One numbered question per risky commit. Name the invariant that could break: a permit or atomic update lost in a move, a behavior the refactor claims to preserve, a persisted row that must still decode, a guard that could now report live code as dead, a consumer that needs the record but now reads the identity.>

Answer OK or the defect per question. End with the list of files you read.
```
