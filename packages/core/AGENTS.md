# Core Guidelines

## Type Exports

- `MessagePart`, `TextPart`, etc. - Import from here, never redeclare locally
- `ToolDefinition` - `Params` must extend `Schema.Schema.AnyNoContext` (no context for sync decode)

## Schema Patterns

- `Schema.Unknown` for dynamic JSON (`ToolCallPart.input`, `ToolResultPart.output.value`)
- Decode with `Schema.decodeUnknownSync(schema)(value)` before use
