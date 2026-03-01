# Structural Changes

These changes require reading surrounding code — not safe as blind find-replace.

## Schema Type System

v4 splits the schema hierarchy:

| Type                         | Purpose                          | Has                                                           |
| ---------------------------- | -------------------------------- | ------------------------------------------------------------- |
| `Schema.Top`                 | Base constraint for all schemas  | `ast`                                                         |
| `Schema.Schema<T>`           | Decoded type only (1 param)      | `.Type`                                                       |
| `Schema.Codec<T, E, RD, RE>` | Full encode/decode with services | `.Type`, `.Encoded`, `.DecodingServices`, `.EncodingServices` |
| `Schema.Decoder<T, RD>`      | Decode-only view                 | `.Type`, `.DecodingServices`                                  |
| `Schema.Encoder<E, RE>`      | Encode-only view                 | `.Encoded`, `.EncodingServices`                               |

### When to use what

```
Schema.Schema<T>              — function signatures that only care about decoded type
Schema.Codec<T, E, RD, RE>   — persistence adapters, serialization
Schema.Decoder<any, never>    — replaces Schema.Schema.AnyNoContext
Schema.Top                    — replaces Schema.Schema.All / Schema.Schema.Any
```

### The `unknown` leak problem

`Schema.Schema<T>` leaves `DecodingServices` and `EncodingServices` as `unknown`. Functions that call `encodeSync`/`decodeUnknownSync` require `{ DecodingServices: never }` — `unknown` won't satisfy this.

**Fix:** Use `Schema.Codec<T, unknown, never, never>` for schemas that need sync encode/decode.

```ts
// v3
const schema: Schema.Schema<MyType, unknown, never> = ...
Schema.encodeSync(schema)(value) // worked

// v4
const schema: Schema.Schema<MyType> = ... // DecodingServices = unknown
Schema.encodeSync(schema)(value) // ERROR: unknown not assignable to never

// Fix
const schema: Schema.Codec<MyType, unknown, never, never> = ...
Schema.encodeSync(schema)(value) // works
```

## Schema.DateFromNumber Removed

Define locally:

```ts
import { Schema, SchemaGetter as Getter } from "effect"

export const DateFromNumber = Schema.Number.pipe(
  Schema.decodeTo(Schema.DateValid, {
    decode: Getter.transform((n: number) => new Date(n)),
    encode: Getter.transform((d: Date) => d.getTime()),
  }),
)
```

`decodeTo` transformations require `Getter` instances, not plain functions. Use `Getter.transform(fn)`.

## Either → Result

`Either` module removed. `Effect.result(e)` returns `Result<A, E>`.

```ts
// v3
const r = yield * Effect.either(myEffect)
if (r._tag === "Left") handleError(r.left)
else handleSuccess(r.right)

// v4
const r = yield * Effect.result(myEffect)
if (r._tag === "Failure") handleError(r.failure)
else handleSuccess(r.success)
```

| v3                 | v4                      |
| ------------------ | ----------------------- |
| `Left` / `Right`   | `Failure` / `Success`   |
| `.left` / `.right` | `.failure` / `.success` |
| `Either.isLeft(r)` | `Result.isFailure(r)`   |

## Runtime Removal

`Runtime.Runtime<R>` is gone. Use `ServiceMap.ServiceMap<R>` for passing service context.

```ts
// v3
const runtime = yield * Effect.runtime<MyServices>()
Runtime.runFork(runtime)(someEffect)

// v4
const services = yield * Effect.services<MyServices>()
Effect.runForkWith(services)(someEffect)

// For no services
Effect.runFork(someEffect) // no services needed
```

`Fiber.interruptFork(fiber)` → `Fiber.interrupt(fiber)` (now non-blocking by default).

```ts
// v3
Runtime.runFork(runtime)(Fiber.interruptFork(fiber))

// v4
Effect.runFork(Fiber.interrupt(fiber))
```

## Cause Flattening

Cause is no longer a tree. It's flat: `cause.reasons: ReadonlyArray<Reason>`.

```ts
// v3 — pattern match on _tag
switch (cause._tag) {
  case "Fail": ...
  case "Die": ...
  case "Interrupt": ...
  case "Sequential": ...
  case "Parallel": ...
}

// v4 — filter reasons
const fails = cause.reasons.filter(Cause.isFailReason).map(r => r.error)
const dies = cause.reasons.filter(Cause.isDieReason).map(r => r.defect)
const interrupts = cause.reasons.filter(Cause.isInterruptReason)
```

## Logger Interface

v4 Logger completely rewritten:

- `LogLevel` is now a string union (`"Trace" | "Debug" | "Info" | "Warn" | ...`), not a tagged object
- `Logger.Options` no longer has `.annotations` / `.spans` — access via fiber refs from `"effect/References"`
- `logLevel.label` → just `logLevel` (it IS the label string)

```ts
// v3
import { Logger, LogLevel, HashMap, List } from "effect"
Logger.make(({ logLevel, message, annotations, cause }) => {
  console.log(`[${logLevel.label}] ${message}`)
  if (!Cause.isEmpty(cause)) ...
  HashMap.forEach(annotations, (v, k) => ...)
})

// v4
import { Logger, ServiceMap } from "effect"
import { CurrentLogAnnotations, CurrentLogSpans, MinimumLogLevel } from "effect/References"
Logger.make(({ logLevel, message, cause, fiber }) => {
  console.log(`[${logLevel}] ${message}`)
  if (cause.reasons.length > 0) ...
  const annotations = fiber.getRef(CurrentLogAnnotations)
  // annotations is Map<string, unknown>
})
```

## Tracer.Span Interface

```ts
// v3
interface Span {
  parent: Option<AnySpan>
  annotations: Context.Context<never>
  sampled: boolean
  // ...
}

// v4
interface Span {
  parent: AnySpan | undefined // Option removed
  annotations: ServiceMap.ServiceMap<never> // Context → ServiceMap
  sampled: boolean
  // ...
}
```

`Tracer.make({ span, context })` — the `context` callback signature changed. It's optional; omit to use default.

```ts
// v3
Tracer.make({
  span: (name, parent, context, links, startTime, kind) => new MySpan(...),
  context: (f) => f(),
})

// v4
Tracer.make({
  span: (options) => new MySpan(options),
  // context omitted — uses default
})
```

`Layer.setTracer(t)` → `Layer.succeed(Tracer.Tracer, t)`

## Effect.serviceOption behavior change

```ts
// v3 — service stays in R
Effect.serviceOptional(Tag) // Effect<S, NoSuchElementException, Tag>

// v4 — service NOT in R, returns Option
Effect.serviceOption(Tag) // Effect<Option<S>>
```

## Config.option yield pattern

`Config` is `Yieldable` in v4 but NOT an `Effect`. Can't pipe Effect combinators on it.

```ts
// v3 (broken in v4)
const home =
  yield *
  Config.option(Config.string("HOME")).pipe(
    Effect.catchEager(() => Effect.succeed(Option.none())),
    Effect.map(Option.getOrElse(() => os.homedir())),
  )

// v4 — yield first, then handle
const maybeHome = yield * Config.option(Config.string("HOME"))
const home = Option.getOrElse(maybeHome, () => os.homedir())

// v4 — or just use process.env / os.homedir() directly
const home = os.homedir()
```

## HttpApiEndpoint (chaining → options)

```ts
// v3
HttpApiEndpoint.post("create", "/sessions")
  .setPayload(CreatePayload)
  .setPath(Schema.Struct({ id: Schema.String }))
  .addSuccess(SuccessType)
  .addError(ErrorType)

// v4
HttpApiEndpoint.post("create", "/sessions", {
  payload: CreatePayload,
  params: { id: Schema.String },
  success: SuccessType,
  error: ErrorType,
})
```

Handler `{ path }` → `{ params }`.

## Entity / RPC (cluster)

Entity handler receives `Envelope.Request<Current>` in v4, not the raw payload:

```ts
// v3
handler: (request) => request.payload.message

// v4
handler: (envelope) => envelope.payload.message
```

`Entity.make(...)` → `Entity.fromRpcGroup("Name", rpcGroup)`.

## Schedule.whileInput removed

```ts
// v3
Effect.retry(makeSchedule().pipe(Schedule.whileInput(isRetryable)))

// v4
Effect.retry({ schedule: makeSchedule(), while: isRetryable })
```

## Testing

```ts
// v3
import { TestContext, TestClock } from "effect"
Effect.provide(TestContext.TestContext)

// v4
import { TestClock } from "effect/testing"
Effect.provide(TestClock.layer())
```

No unified `TestContext` in v4. Provide test layers individually.
