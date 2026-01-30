# gent

Minimal, opinionated agent harness.

## Philosophy

- **Minimal**: Small surface area, entire codebase understandable in an afternoon
- **Opinionated**: One way to do things, no configuration bloat
- **Built with Effect**: Services, Layers, Schema, Stream - no wrapper abstractions

## Quick Start

```bash
bun install
bun run typecheck
bun run test
```

### Run the CLI

```bash
# Interactive chat
bun run --cwd apps/cli dev chat

# Single message
bun run --cwd apps/cli dev chat "What is 2+2?"

# List sessions
bun run --cwd apps/cli dev sessions
```

### Run the Server

```bash
bun run --cwd apps/server dev
# Server runs on http://localhost:3000
```

### Run the TUI

```bash
bun run --cwd apps/tui dev
```

## Architecture

```
TUI (@opentui/solid) ←── HTTP ──→ Server (HttpApi)
                                      │
                              ┌───────▼───────┐
                              │    Runtime    │
                              │  AgentLoop    │
                              │  EventStore   │
                              └───────┬───────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
        ┌─────▼─────┐          ┌─────▼─────┐          ┌─────▼─────┐
        │  Storage  │          │   Tools   │          │ Providers │
        │  SQLite   │          │  Effect   │          │  ai-sdk   │
        └───────────┘          │ Services  │          └───────────┘
                               └───────────┘
```

## Packages

| Package            | Purpose                                                    |
| ------------------ | ---------------------------------------------------------- |
| `@gent/core`       | Message schemas, Tool abstraction, EventStore, Permission  |
| `@gent/storage`    | SQLite persistence via bun:sqlite                          |
| `@gent/tools`      | Read, Write, Edit, Bash, Glob, Grep, AskUser, RepoExplorer |
| `@gent/providers`  | Vercel AI SDK adapter with streaming                       |
| `@gent/runtime`    | AgentLoop, Compaction, Telemetry                           |
| `@gent/server`     | GentCore service, RPC/HTTP API definitions                 |
| `@gent/test-utils` | Mock layers, sequence recording                            |

## Apps

| App            | Purpose                                |
| -------------- | -------------------------------------- |
| `@gent/cli`    | Command-line interface via @effect/cli |
| `@gent/server` | HTTP server with SSE streaming         |
| `@gent/tui`    | Terminal UI via @opentui/solid         |

## Configuration

Data stored in `~/.gent/`:

- `data.db` - SQLite database
- `config.json` - Permission rules
- `plans/` - Plan files

## Model Support

Curated per mode. No user-facing model selection. Pricing metadata fetched from models.dev.

## Testing

```bash
bun run test
```

Uses `bun test` directly (not vitest) due to bun:sqlite dependency.

## License

MIT
