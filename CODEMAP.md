# Gent Codemap

## Monorepo Structure

```
packages/         # Shared libraries
apps/             # Executables (server, tui, cli)
tests/            # Integration tests (bun test)
```

## Packages

| Package | Purpose | Key Export |
|---------|---------|------------|
| `core` | Schemas, service interfaces | `Message`, `EventBus`, `ToolRegistry`, `Permission` |
| `storage` | SQLite via bun:sqlite | `Storage.Live(path)`, `Storage.Test()` |
| `tools` | File/process tools | `AllTools`, `defineTool` |
| `providers` | ai-sdk wrapper | `Provider.Live`, `StreamChunk` variants |
| `runtime` | Agent orchestration | `AgentLoop.Live(config)` |
| `api` | HttpApi definitions | `GentApi` |
| `test-utils` | Mock layers | `createTestLayer`, `createRecordingTestLayer` |

## Apps

| App | Purpose | Entry |
|-----|---------|-------|
| `server` | HTTP + SSE | `bun run --cwd apps/server dev` |
| `tui` | Terminal UI | `bun run --cwd apps/tui dev` |
| `cli` | CLI commands | `bun run --cwd apps/cli dev` |

## Data Flow

```
User Input → TUI/CLI
     ↓
HTTP POST /messages → Server
     ↓
AgentLoop.run() → Storage.createMessage()
     ↓
Provider.stream() → ai-sdk → LLM
     ↓
Stream chunks → EventBus.publish()
     ↓
Tool calls → ToolRegistry.get() → tool.execute()
     ↓
Results → Storage.createMessage() → loop continues
```

## Layer Composition

```
AgentLoop.Live
├── Storage
├── Provider
├── ToolRegistry
├── EventBus
├── Permission
└── AskUserHandler (for tools needing user input)
```

## Testing Layers

```
createTestLayer()           # Simple mocks, no recording
createRecordingTestLayer()  # Mocks + SequenceRecorder for assertions
```
