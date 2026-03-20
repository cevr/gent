# Server Guidelines

## Purpose

Business logic layer. `GentCore` is the primary service; `GentServer` is deprecated wrapper.

## Architecture

```
GentCore (business logic)
├── Storage
├── ActorProcess  (routes to AgentLoop via LocalActorProcessLive)
├── EventStore
└── Dependencies from createDependencies()

RpcHandlersLive (RPC layer)
└── GentCore
```

## Key Files

| File              | Purpose                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `core.ts`         | `GentCore` service - session/message management, event streaming |
| `rpc-handlers.ts` | `RpcHandlersLive` - `GentRpcs.toLayer()` implementation          |
| `index.ts`        | Exports, `GentServer.Dependencies()` for layer composition       |

## Patterns

- **GentCore.Live** - requires `Storage | ActorProcess | EventStore | Provider | CheckpointService | PermissionHandler | PlanHandler | HandoffHandler | Permission | ConfigService`
- **RpcHandlersLive** - requires `GentCore`, provides RPC handlers
- **GentServer.Dependencies(config)** - builds full dependency layer from config

## Gotchas

- **exactOptionalPropertyTypes** - Can't do `{ name: input.name }` when `input.name: string | undefined`. Use ternary: `input.name !== undefined ? { name: input.name } : {}`
- **Handler errors** - RPCs defined without error schema. Use `Effect.orDie` to convert `GentCoreError` to defects.
- **Layer inference** - Let TypeScript infer `RpcHandlersLive` type; explicit annotation caused context mismatch.
