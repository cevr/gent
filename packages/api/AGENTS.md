# API Guidelines

## Purpose

Defines RPC and HTTP API contracts. Single source of truth for both transports.

## Structure

| File | Purpose |
|------|---------|
| `operations.ts` | Shared schemas for payloads/responses |
| `rpcs.ts` | `GentRpcs` - RpcGroup for in-memory RPC |
| `http-api.ts` | `GentApi` - HttpApi for HTTP (legacy, will derive from operations) |

## @effect/rpc Patterns

- `Rpc.make(tag, { payload, success, error?, stream? })` - define RPC
- `stream: true` - returns `Stream` directly, not `Effect<Stream>`
- `RpcGroup.toLayer(Effect<handlers>)` - create handler layer
- `RpcTest.makeClient(group)` - in-memory client, requires `Rpc.ToHandler<Rpcs>` in context

## Gotchas

- **Stream RPCs** - Handler returns `Stream`, client gets `Stream` (no `yield*` needed)
- **Payload fields** - Use `Schema.Struct.fields` to extract, not full struct
- **Error handling** - Use `Effect.orDie` in handlers if RPC has no error schema
