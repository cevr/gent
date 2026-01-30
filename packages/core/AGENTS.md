# Core Guidelines

## Type Exports

- `MessagePart`, `TextPart`, etc. - Import from here, never redeclare locally
- `ToolDefinition` - `Params` must extend `Schema.Schema.AnyNoContext` (no context for sync decode)
- `AnyToolDefinition` - Use for heterogeneous tool arrays (variance workaround)

## Schema Patterns

- `Schema.Unknown` for dynamic JSON (`ToolCallPart.input`, `ToolResultPart.output.value`)
- Decode with `Schema.decodeUnknownSync(schema)(value)` before use
