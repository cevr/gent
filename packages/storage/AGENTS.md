# Storage Guidelines

## Gotchas

- **JSON→Schema roundtrip** - `JSON.parse` returns plain objects. Must use `decodeMessageParts(JSON.parse(row.parts))` to reconstruct `MessagePart` class instances.
- **bun:sqlite scoped** - DB opened in `Layer.scoped`, closed via `Effect.addFinalizer`.
- **Test layer** - `Storage.Test()` uses `:memory:` SQLite. Each test gets fresh DB. No platform deps needed.
- **Live layer requires platform** - `Storage.Live(path)` needs `FileSystem | Path` context. Provide via `Layer.provide(BunFileSystem.layer, BunContext.layer)`.
- **Directory auto-creation** - `Storage.Live` creates parent directory if missing using Effect FileSystem.

## Schema

```sql
sessions(id, name, created_at, updated_at)
branches(id, session_id, parent_branch_id, parent_message_id, name, created_at)
messages(id, session_id, branch_id, role, parts, created_at)  -- parts is JSON
compactions(id, branch_id, summary, message_count, token_count, created_at)
```
