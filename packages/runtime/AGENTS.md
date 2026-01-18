# Runtime Guidelines

## AgentLoop

- `runLoop` is recursive - requires explicit type annotation on variable
- Tool inputs decoded via `Schema.decodeUnknownSync(tool.params)` before execution
- All operations traced via `Effect.fn` - no manual debug logging

## Tracing

Spans created automatically by `Effect.fn`:
- `AgentLoop.run`, `AgentLoop.runLoop`, `AgentLoop.executeToolCall`
- `Provider.stream`
- All tool executes

View traces: `cat /tmp/gent-trace.log`
