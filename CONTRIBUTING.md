# Contributing to gent

## Development Setup

```bash
git clone https://github.com/cevr/gent.git
cd gent
bun install
```

## Commands

```bash
bun run typecheck  # tsgo + @effect/language-service, must pass clean
bun run lint       # oxlint (gent custom rules + oxlint-tsgolint type-aware lints)
bun run test       # product behavior tests, ~2-4s
bun run gate       # typecheck + lint + fmt + build + test
```

## Code Style

- Telegraph style, minimal tokens
- Every service exposes a `Live` layer; `Test` layers only when there is a real
  alternative implementation worth a Tag (e.g. `Provider.Sequence`, `Provider.Debug`)
- Schema validation at boundaries
- Use `Effect.fn(name)` for service methods on hot paths (tracing); plain
  `Effect.gen` is fine elsewhere
- Discriminated unions go through `Schema.TaggedUnion` — never hand-roll
  `{ _tag: "X" } | { _tag: "Y" }` literals. Use `Schema.TaggedStruct`
  composed with `Schema.toTaggedUnion` for kebab-case wire tags, or
  `Schema.TaggedErrorClass` for errors.

## Effect Patterns

```typescript
// Service definition
export class MyService extends Context.Tag("MyService")<MyService, MyServiceImpl>() {
  static Live: Layer.Layer<MyService> = Layer.succeed(MyService, { ... })
}

// Tagged errors
export class MyError extends Schema.TaggedError<MyError>()("MyError", {
  message: Schema.String,
}) {}

// Discriminated union (Schema.TaggedUnion, not literal _tag union)
import { Schema } from "effect"
import { SessionId } from "@gent/core/domain/ids"

export const MyEvent = Schema.TaggedUnion({
  Started: { sessionId: SessionId },
  Completed: { sessionId: SessionId, durationMs: Schema.Number },
})
export type MyEvent = Schema.Schema.Type<typeof MyEvent>

const event = MyEvent.cases.Started.make({ sessionId })

// Domain values
export class MyData extends Schema.Class<MyData>("MyData")({
  id: Schema.String,
  name: Schema.String,
}) {}
```

## Testing

Tests use `effect-bun-test`'s `it.live` / `it.scopedLive`. **No `async`/`await`,
no Promise chains, no hook cleanup patterns** — these are blocked by
`gent/no-promise-control-flow-in-tests`. Scoped resources go through
`Effect.scoped` / `it.scopedLive` so finalizers run under the test runtime.

```typescript
import { it, describe, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { baseLocalLayerWithProvider } from "@gent/core/test-utils/in-process-layer"
import { Provider } from "@gent/core/providers/provider"
import { textStep, toolCallStep } from "@gent/core/debug/provider"

describe("session runtime", () => {
  it.live("emits a TurnCompleted on a single text response", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* Provider.Sequence([textStep("hi")])
      const layer = baseLocalLayerWithProvider(providerLayer, { agents: [] })
      yield* Effect.gen(function* () {
        const runtime = yield* SessionRuntime
        yield* runtime.sendUserMessage({ text: "hello" })
        // assertions on session events…
      }).pipe(Effect.provide(layer))
    }),
  )
})
```

For the default debug provider (no scripted responses), use `baseLocalLayer({ agents: [] })`.

Sequence assertions for event ordering:

```typescript
import { SequenceRecorder, RecordingEventStore, assertSequence } from "@gent/core/test-utils"

assertSequence(calls, [
  { service: "EventStore", method: "publish", match: { _tag: "TurnCompleted" } },
])
```

For RPC acceptance (real per-request scopes), use `createRpcHarness` from the
test helpers next to the test file.

## Pull Requests

1. Fork the repo
2. Create a feature branch
3. Make changes; run `bun run gate`
4. Submit PR — small, reviewable commits preferred over one mega-PR

## Architecture

Read [ARCHITECTURE.md](./ARCHITECTURE.md) before making significant changes.
Update it when diverging from the documented design.
