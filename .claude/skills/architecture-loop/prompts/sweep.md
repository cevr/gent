# Sweep brief

Fill the slots into `~/.cache/gent-pass<N>/pass<N>-sweep-brief.md`. Each area agent gets a short prompt: read the brief, sweep `<area>` (`<directories>`, `<extra weight>`), write the report to `~/.cache/gent-pass<N>/pass<N>-<area>.md`, reply once with a summary under 300 words, finish in one run with no timers, monitors or sub-agents. The **SAFETY** block goes in verbatim; the same block is in [`apply.md`](apply.md), so edit both together; the guards fail when the two copies differ.

```
# Pass-<N> sweep brief (read-only)

Repo: <warm source>, branch main, HEAD <hash>. Edit, commit and create nothing in the repo; write only your report.

Goal: fewer concepts, less code, fewer files (one file per concern), with every valuable feature kept. North stars: effect-native, actor-model, a lean core with maximal expressiveness through extensions. Read CLAUDE.md, ARCHITECTURE.md, <ledger path> (the whole ledger: decisions, rejected rows, every pass's results) and .claude/skills/architecture-loop/rejected.md first. A done or rejected item returns only with a new receipt. Prior art: <repo paths from prior-art.md>.

Pass <N-1> changed <stat of `git diff --stat <prev base>..HEAD`>. Weigh every addition by the deletion test: code a smaller shape could carry is a reduction finding. Review these pass-<N-1> changes hardest for regressions:
<per area: the named mechanisms each batch added>

In flight, do not report: <batch: items>.

Known open items; report again only with new evidence:
<the ledger's open items, accepted over-asks, known flakes>

New evidence to check (from live runs): <questions>

Owner rules (propose nothing against them): children wake, never block; the cell runs in full Bun, with no sandbox; effect-wide-event stays; no persisted-format change unless it is additive and optional; docked panes, not modal overlays; a shipped extension is never more privileged than a user extension; personal library, no shims.

Vocabulary, used exactly: module, interface, depth, seam, adapter, leverage, locality, deletion test. A candidate is: a shallow module, a pass-through, one concept with two owners, a one-adapter seam with no guard, a single-caller export, dead code, a guard gap (a directory or file kind no `packages/tooling/src/` guard scans), a comment that tells history, a concern spread over `x-part.ts` fragment files. In the TUI also: state that follows the session identity but reads the session record, and one-shot state held in a component instance.

Find, with receipts:
- Bugs: a concrete input or state that gives a wrong result, with file:line and the failure scenario, verified by reading the path end to end. When cheap, run a focused `bun test` or a scratch script under <scratchpad>.
- Reductions: a concept, file, export, option or second path that the deletion test shows is a pass-through or has no product consumer. Caller-count greps cover `packages/`, `apps/` and `examples/`.
- Structural: a place where an extension could own what core owns, or where the actor model or Effect idiom is bypassed.

Classes:
- P1: wrong behavior users hit.
- P2: wrong behavior at an edge, or a real reduction (more than 100 lines, or one concept).
- P3: polish (naming, comments, small dead code).
Under about 5 lines of value: one line in a "not worth a pass" list. An area with only polish says "only polish", with the receipts checked; that is the wanted result of a late pass.

Report: a table (id, class, title, file:line, evidence, proposed change, TUI steps that show it in a herdr gamut run, or none), then the items checked and found sound.

SAFETY (mandatory; on 2026-09-23 a heredoc of guard probe text ran `rm -rf ~`):
- Create every file with the Write tool, never through a shell heredoc (`cat > f <<EOF`, quoted or not), `python3 -c`, `python3 - <<X` or `bun -e`.
- A destructive command string (rm, git reset, git clean, git push -f, dd, mkfs, chmod -R, find -delete, kill and similar) lives only as a string literal in a .ts file created with the Write tool, run with `bun <file>`. It stays out of every shell command line, heredoc, `echo`, `python3 -c`, `bun -e`, stdin heredoc and commit message; commit with `-m "..."` or `git commit -F <file written with Write>`.
- Probe strings target only harmless paths such as `/nonexistent/gent-probe-x`; never `~`, `$HOME`, `/`, `.` or a real repo path.
- The classifier is a pure function: call it with the probe strings. Probe text never reaches a shell.
- To unstage, use `git restore --staged <file>`. Delete with `trash`.
- A live gent run uses `--debug` only, with `GENT_DATA_DIR` under <scratchpad>. The owner's database `~/.gent/data.db` is read only as a copy: `/bin/cp` the database and its `-wal` file, then open the copy with `sqlite3 -readonly`, or as `file:<copy>?immutable=1` when that fails with code 14. Never write to the owner's database, and never commit, publish or attach it or a copy of it.
```
