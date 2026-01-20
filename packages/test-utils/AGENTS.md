# Test Utils Guidelines

## Two Layer Types

| Layer                        | Use Case                                  |
| ---------------------------- | ----------------------------------------- |
| `createTestLayer()`          | Simple mocks, no call tracking            |
| `createRecordingTestLayer()` | Mocks + `SequenceRecorder` for assertions |

## Recording Pattern

```typescript
const layer = createRecordingTestLayer({
  providerResponses: [mockTextResponse("Hello")],
  askUserResponses: ["yes"],
})

Effect.gen(function* () {
  const recorder = yield* SequenceRecorder
  // ... do work ...
  const calls = yield* recorder.getCalls()
  assertSequence(calls, [
    { service: "Provider", method: "stream" },
    { service: "EventBus", method: "publish", match: { _tag: "StreamStarted" } },
  ])
}).pipe(Effect.provide(layer))
```

## Mock Helpers

- `mockTextResponse(text)` - Returns `[TextChunk, FinishChunk]`
- `mockToolCallResponse(id, name, args)` - Returns `[ToolCallChunk, FinishChunk]`

## Gotchas

- Recording layers use `Effect.fn` for tracing - required by Effect LSP.
- `assertSequence` matches in order but allows gaps (finds next matching call).
