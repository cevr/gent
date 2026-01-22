# Gent Codemap

## Monorepo Structure

```
packages/         # Shared libraries
apps/             # Executables (server, tui, cli)
tests/            # Integration tests (bun test)
```

## Packages

| Package      | Purpose                       | Key Export                                          |
| ------------ | ----------------------------- | --------------------------------------------------- |
| `core`       | Schemas, service interfaces   | `Message`, `EventStore`, `ToolRegistry`, `Permission` |
| `storage`    | SQLite via bun:sqlite         | `Storage.Live(path)`, `Storage.Test()`              |
| `tools`      | File/process tools            | `AllTools`, `defineTool`                            |
| `providers`  | ai-sdk wrapper                | `Provider.Live`, `StreamChunk` variants             |
| `runtime`    | Agent orchestration           | `AgentLoop.Live(config)`                            |
| `server`     | Business logic + RPC handlers | `GentCore`, `RpcHandlersLive`                       |
| `api`        | RPC/HTTP API definitions      | `GentRpcs`, `GentApi`                               |
| `test-utils` | Mock layers                   | `createTestLayer`, `createRecordingTestLayer`       |

## Apps

| App      | Purpose      | Entry                           |
| -------- | ------------ | ------------------------------- |
| `server` | HTTP + SSE   | `bun run --cwd apps/server dev` |
| `tui`    | Terminal UI  | `bun run --cwd apps/tui dev`    |
| `cli`    | CLI commands | `bun run --cwd apps/cli dev`    |

## Data Flow

```
TUI → RpcTest.makeClient(GentRpcs) → RpcHandlersLive → GentCore
                                                         ↓
                                                    AgentLoop.run()
                                                         ↓
                                          Provider.stream() → ai-sdk → LLM
                                                         ↓
                                          EventStore.publish() → Stream to client
```

## Layer Composition

```
CliLayer (TUI entry point)
├── FullLayer
│   ├── RpcHandlersLive (provides RPC handlers)
│   │   └── GentCore (business logic)
│   │       ├── Storage
│   │       ├── AgentLoop
│   │       │   ├── Storage, Provider, ToolRegistry, EventStore, Permission
│   │       └── EventStore
│   └── GentCoreLive (for direct access)
├── BunContext.layer
└── TracerLayer
```

## Testing Layers

```
createTestLayer()           # Simple mocks, no recording
createRecordingTestLayer()  # Mocks + SequenceRecorder for assertions
```
