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
holds `data.db` (default `~/.gent`).

## Where to Read Next

- [AGENTS.md](./AGENTS.md) — commands, CLI usage, gotchas, code style, and test conventions.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — the noun model, invariants, and package structure.
- [docs/extensions.md](./docs/extensions.md) — the extension authoring guide.
- [CONTRIBUTING.md](./CONTRIBUTING.md) — how to send a change.

## License

MIT
