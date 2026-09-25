# SAFETY

Every loop agent (sweep, apply, counsel, live check) reads this file in full before any action and follows it. It is the one copy; each prompt template points here instead of carrying the rules.

SAFETY (mandatory; on 2026-09-23 a heredoc of guard probe text ran `rm -rf ~`):

- Create every file with the Write tool, never through a shell heredoc (`cat > f <<EOF`, quoted or not), `python3 -c`, `python3 - <<X` or `bun -e`.
- A destructive command string (rm, git reset, git clean, git push -f, dd, mkfs, chmod -R, find -delete, kill and similar) lives only as a string literal in a .ts file created with the Write tool, run with `bun <file>`. It stays out of every shell command line, heredoc, `echo`, `python3 -c`, `bun -e`, stdin heredoc and commit message; commit with `-m "..."` or `git commit -F <file written with Write>`.
- Probe strings target only harmless paths such as `/nonexistent/gent-probe-x`; never `~`, `$HOME`, `/`, `.` or a real repo path.
- The classifier is a pure function: call it with the probe strings. Probe text never reaches a shell.
- To unstage, use `git restore --staged <file>`. Delete with `trash`.
- A live gent run uses `--debug` only, with `GENT_DATA_DIR` under the scratch directory your prompt names. One exception, for the efficiency measurement only: a run under the efficiency capture preload (`efficiency.md` names its path) with fake provider keys and no `--debug`, also with `GENT_DATA_DIR` under the scratch directory. The preload answers every provider request itself, so no request leaves the box but the model catalog read (`GET https://models.dev/api.json`). A run never calls a paid model. The owner's database `~/.gent/data.db` is read only as a copy: `/bin/cp` the database and its `-wal` file, then open the copy with `sqlite3 -readonly`, or as `file:<copy>?immutable=1` when that fails with code 14. Never write to the owner's database, and never commit, publish or attach it or a copy of it.
