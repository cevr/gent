# gent

Minimal, opinionated agent harness — built on Effect.

## Philosophy

- **Minimal**: small surface area, codebase understandable in an afternoon
- **Opinionated**: one way to do things, no configuration bloat
- **Effect-native end-to-end**: services, layers, schema, streams — no Promise edges in the public surface

## Quick Start

```bash
bun install
bun run gate       # typecheck + lint + fmt + build + test
```

### Run the TUI

```bash
bun run --cwd apps/tui dev          # default mode
bun run --cwd apps/tui dev -p "..." # one-shot prompt → session view
bun run --cwd apps/tui dev -H "..." # headless: stream to stdout, exit
bun run --cwd apps/tui dev -c       # continue last session for cwd
bun run --cwd apps/tui dev sessions # list sessions
```

### Run the standalone server

```bash
bun run --cwd apps/server dev
```

`gent` defaults to a server-per-DB topology: one server owns the SQLite store
and accepts multiple clients. The TUI binary embeds a server by default; a
standalone `apps/server` is only needed for remote topologies.

## Architecture

```
TUI / SDK / HTTP client
          │
          ▼
   transport contract
          │
   ┌──────┴──────┐
   ▼             ▼
direct        RPC / HTTP
adapter        adapter
          │
          ▼
   app services (commands / queries / events)
          │
          ▼
   runtime + platform boundaries
```

See `ARCHITECTURE.md` for the full noun model (`Server`, `Profile`,
`SessionRuntime`, `Tool`/`Request`/`Action`, `Resource`, `Reaction`).

## Layout

```
apps/
├── tui/        OpenTUI client over the shared transport contract
└── server/     HTTP + RPC adapter

packages/
├── core/       domain, storage, providers, runtime, server, extensions/api, test-utils
├── extensions/ all 27 builtin extensions (imports only @gent/core/extensions/api)
├── sdk/        direct + RPC transports over one client contract
├── tooling/    custom oxlint rules, fixtures, build/test diagnostics
└── e2e/        PTY/transport/supervisor end-to-end tests
```

`@gent/core` uses subpath exports — no barrels. Import from specific files
(`@gent/core/domain/event`, `@gent/core/runtime/agent/agent-loop.actor`, etc.).

## Configuration

Data lives under `~/.gent/`:

- `data.db` — SQLite database (sessions, branches, events, interactions, tasks)
- `auth.json` — auth keys (KeyValueStore-backed)
- `plans/` — plan files

## Testing

```bash
bun run test       # ~2-4s product behavior tests
bun run test:diagnose # print slowest test chunks without failing on duration
bun run test:e2e   # ~60-120s PTY + supervisor + worker-http
bun run gate       # full pre-commit gate
```

`bun:test` directly (not vitest) — `bun:sqlite` requires the Bun runtime.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for code style, Effect patterns, and
test conventions.

## License

MIT
