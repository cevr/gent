# SAFETY

Every loop agent (sweep, apply, counsel, live check) reads this file in full before any action and follows it. It is the one copy; each prompt template points here instead of carrying the rules.

SAFETY (mandatory; on 2026-09-23 a heredoc of guard probe text ran `rm -rf ~`):

- Create every file with the Write tool, never through a shell heredoc (`cat > f <<EOF`, quoted or not), `python3 -c`, `python3 - <<X` or `bun -e`.
- A destructive command string (rm, git reset, git clean, git push -f, dd, mkfs, chmod -R, find -delete, kill and similar) lives only as a string literal in a .ts file created with the Write tool, run with `bun <file>`. It stays out of every shell command line, heredoc, `echo`, `python3 -c`, `bun -e`, stdin heredoc and commit message; commit with `-m "..."` or `git commit -F <file written with Write>`.
- Probe strings target only harmless paths such as `/nonexistent/gent-probe-x`; never `~`, `$HOME`, `/`, `.` or a real repo path.
- To unstage, use `git restore --staged <file>`. Delete with `trash`.
- Live binary. This file is the one owner of the rule; prompts and work rules point here and never restate it.
  - A live gent run uses `--debug` only, with `GENT_DATA_DIR` under the scratch directory your prompt names. Never `bun run install:global`.
  - Exception 1, the efficiency measurement only: a run under the in-repo capture preload `.claude/skills/architecture-loop/fetch-capture.ts` (never a copy outside the repo) with fake provider keys and no `--debug`, with `HOME`, `GENT_AUTH_DIRECTORY` and `GENT_DATA_DIR` under the scratch directory (the preload refuses to start otherwise). The preload answers every provider request itself, so no request leaves the box but the model catalog read (`GET https://models.dev/api.json`), which it forwards.
  - Exception 2, the orchestrator's live check only (`SKILL.md` step 9): `bun run gamut`, on real models with the owner's login, its data directory under `$TMPDIR/gent-gamut-*`. It is the only run that calls a paid model. No other agent (sweep, apply, counsel, or the agent inside the gamut session) runs `bun run gamut`.
  - Every other run never calls a paid model.
- The owner's database `~/.gent/data.db` is read only as a copy: `/bin/cp` the database and its `-wal` file, then open the copy with `sqlite3 -readonly`, or as `file:<copy>?immutable=1` when that fails with code 14. Never write to the owner's database, and never commit, publish or attach it or a copy of it.
