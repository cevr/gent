# Sweep prompt

Fill the slots. One agent per area. Send all areas in one message.

```
Read-only architecture sweep, pass <N>, of `<rift or repo path>`. Write one report to `<scratchpad>/pass<N>-<area>.md` and reply once with a summary under 300 words. Finish in one run: no timers, monitors, or sub-agents. Read only; the `gent` binary stays unused.

Scope: <directories>. <Extra weight: ...>

Read first: `ARCHITECTURE.md`, `<ledger path>`, `.claude/skills/architecture-loop/rejected.md`, and the earlier reports <paths>. A done or rejected item returns only with a new receipt.

Vocabulary, used exactly: module, interface, depth, seam, adapter, leverage, locality, deletion test. A candidate is: a shallow module, a pass-through, one concept with two owners, a one-adapter seam with no guard, a single-caller export, dead code, a guard gap (a directory no `packages/tooling/src/` guard scans), a comment that tells history. In the TUI also: state that follows the session identity but reads the session record, and one-shot state held in a component instance.

<Specific questions for this area, numbered>

Every claim carries a receipt: full path and line, plus the grep over `packages/`, `apps/` AND `examples/` that proves the caller count. Per candidate: files, problem, change, lines removed, risk (low/med/high), persisted format yes/no. A candidate that changes a persisted format is rejected by default. Under about 5 lines of pure style: one line in a "not worth a pass" list. An area with nothing to do reports "no findings" with the receipts checked; that is the wanted result of a late pass.
```
