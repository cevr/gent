# gent

Minimal, opinionated agent harness — built on Effect.

## Philosophy

- **Minimal**: small surface area, codebase understandable in an afternoon
- **Opinionated**: one way to do things, no configuration bloat
- **Effect-native end-to-end**: services, layers, schema, streams — no Promise edges in the public surface

## Quick Start

```bash
bun install
bun run gate                # typecheck + lint + fmt + build + test
bun run --cwd apps/tui dev  # TUI
```

`gent` runs one server per database. The TUI binary starts a server or
attaches to the one that already owns the database; `gent server start` runs
a standalone server in the foreground; its flags (`--port`, `--isolate`, `--mock`)
are the one way to choose how it launches. `GENT_DATA_DIR` names the directory that
holds `data.db` (default `~/.gent`). The server listens on `127.0.0.1` only: its
RPC has no auth. To use a server on another machine, tunnel to it
(`ssh -L 3000:127.0.0.1:3000 <host>`) and pass `--connect http://127.0.0.1:3000/rpc`.

## Goals

`/goal <objective>` starts a persistent goal on the current branch. Add
`--budget N` before the objective to limit its token usage.

- `/goal status` shows the objective and usage.
- `/goal pause` keeps the objective and usage, removes its pending continuation,
  and lets work already in flight finish. That work is charged once.
- `/goal resume` continues the same goal. A spent budget requires
  `/goal resume --budget N`, which gives it a fresh N-token allowance beyond usage so far.
- `/goal clear`, `/goal cancel`, and `/goal stop` remove the goal and its pending
  continuation. Work already in flight finishes; these commands do not mark the goal complete.

Interrupting a turn pauses its goal. Unrelated turns leave a paused goal paused.
Only the goal tool's completion action marks it achieved.

## Where to Read Next

- [AGENTS.md](./AGENTS.md) — commands, CLI usage, gotchas, code style, and test conventions.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — the noun model, invariants, and package structure.
- [docs/extensions.md](./docs/extensions.md) — the extension authoring guide.
- [CONTRIBUTING.md](./CONTRIBUTING.md) — how to send a change.

## License

MIT
