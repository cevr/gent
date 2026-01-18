# Contributing to gent

## Development Setup

```bash
git clone https://github.com/cevr/gent.git
cd gent
bun install
```

## Commands

```bash
bun run typecheck  # Must pass clean (no errors, no suggestions)
bun run test       # Run all tests
```

## Code Style

- Telegraph style, minimal tokens
- Every service needs `Live` + `Test` layers
- Schema validation everywhere
- Use `Effect.fn` for all service methods (required for tracing)
- Use `Schema.TaggedClass` for discriminated unions
- Use `export type` for interface re-exports

## Effect Patterns

```typescript
// Service definition
export class MyService extends Context.Tag("MyService")<
  MyService,
  MyServiceImpl
>() {
  static Live: Layer.Layer<MyService> = Layer.succeed(MyService, { ... })
  static Test = (): Layer.Layer<MyService> => Layer.succeed(MyService, { ... })
}

// Errors
export class MyError extends Schema.TaggedError<MyError>()("MyError", {
  message: Schema.String,
}) {}

// Data classes
export class MyData extends Schema.Class<MyData>("MyData")({
  id: Schema.String,
  name: Schema.String,
}) {}
```

## Gotchas

See [AGENTS.md](./AGENTS.md) for known gotchas:

- `bun:sqlite` - Can't use vitest, use `bun test`
- `Schema.Class` JSON roundtrip needs `Schema.decodeUnknownSync`
- `exactOptionalPropertyTypes` - be explicit with interface types
- Effect LSP suggestions (TS41) must be fixed

## Testing

```typescript
import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { createTestLayer, createRecordingTestLayer } from "@gent/test-utils"

// Simple test
test("my test", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      // test code
    }).pipe(Effect.provide(createTestLayer()))
  )
})

// With sequence recording
test("records calls", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const recorder = yield* SequenceRecorder
      // do work
      const calls = yield* recorder.getCalls()
      assertSequence(calls, [
        { service: "Provider", method: "stream" },
      ])
    }).pipe(Effect.provide(createRecordingTestLayer()))
  )
})
```

## Pull Requests

1. Fork the repo
2. Create a feature branch
3. Make changes
4. Run `bun run typecheck && bun run test`
5. Submit PR

## Architecture

Read [ARCHITECTURE.md](./ARCHITECTURE.md) before making significant changes. Update it when diverging from the documented design.
