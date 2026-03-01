# Mechanical API Renames

All renames in this file are safe find-replace. No context needed.

## Effect

| v3                        | v4                            | Notes                                                  |
| ------------------------- | ----------------------------- | ------------------------------------------------------ |
| `Effect.catchAll(`        | `Effect.catchEager(`          | **Do NOT match** `catchAllCause` or `catchAllDefect`   |
| `Effect.catchAllCause(`   | `Effect.catchCause(`          |                                                        |
| `Effect.catchAllDefect(`  | `Effect.catchDefect(`         |                                                        |
| `Effect.either(`          | `Effect.result(`              | Return type changes: Either→Result (see structural.md) |
| `Effect.fork(`            | `Effect.forkChild(`           | **Do NOT match** `forkDaemon`, `forkScoped`, etc.      |
| `Effect.forkDaemon(`      | `Effect.forkDetach(`          |                                                        |
| `Effect.yieldNow()`       | `Effect.yieldNow`             | Drop parens — now a value, not function call           |
| `Effect.dieMessage(`      | `Effect.die(`                 | `die` now accepts `unknown` directly                   |
| `Effect.tapErrorCause(`   | `Effect.tapCause(`            |                                                        |
| `Effect.zipRight(`        | `Effect.andThen(`             |                                                        |
| `Effect.repeatN(n)`       | `Effect.repeat({ times: n })` | Or `Effect.repeat(Schedule.recurs(n))`                 |
| `Effect.runtime<R>()`     | `Effect.services<R>()`        | Returns `ServiceMap<R>` not `Runtime<R>`               |
| `Effect.serviceOptional(` | `Effect.serviceOption(`       | Return type changes (see structural.md)                |

**Unchanged:** `Effect.void`, `Effect.runSync`, `Effect.runFork`, `Effect.try({ try, catch })` (object form stays)

**Removed:** `Effect.try(() => ...)` (single-arg form) — use `Effect.sync` with try/catch, `Effect.forkAll` — removed entirely

## Context → ServiceMap

| v3                             | v4                                    |
| ------------------------------ | ------------------------------------- |
| `Context.Tag("id")<Self, T>()` | `ServiceMap.Service<Self, T>()("id")` |
| `Context.GenericTag<T>("id")`  | `ServiceMap.Service<T>("id")`         |
| `Context.make(tag, value)`     | `ServiceMap.make(tag, value)`         |
| `Context.get(ctx, tag)`        | `ServiceMap.get(ctx, tag)`            |
| `Context.Context<never>`       | `ServiceMap.ServiceMap<never>`        |

**Pattern:** String ID moves from first call to second; type params move from second to first.

```ts
// v3
class Foo extends Context.Tag("@pkg/Foo")<Foo, FooService>() {}

// v4
class Foo extends ServiceMap.Service<Foo, FooService>()("@pkg/Foo") {}
```

Update imports: replace `Context` with `ServiceMap` in `import { ... } from "effect"`.

## Schema

| v3                                    | v4                                 | Notes                                |
| ------------------------------------- | ---------------------------------- | ------------------------------------ |
| `Schema.TaggedError<T>()`             | `Schema.TaggedErrorClass<T>()`     | Same call syntax                     |
| `Schema.parseJson(S)`                 | `Schema.fromJsonString(S)`         |                                      |
| `Schema.Union(A, B, C)`               | `Schema.Union([A, B, C])`          | Wrap args in array                   |
| `Schema.Literal("a", "b")`            | `Schema.Literals(["a", "b"])`      | Multi-arg only; single-arg unchanged |
| `Schema.encode(s)(v)`                 | `Schema.encodeEffect(s)(v)`        | Effectful encode                     |
| `Schema.decode(s)(v)`                 | `Schema.decodeEffect(s)(v)`        | Effectful decode                     |
| `Schema.decodeUnknown(s)(v)`          | `Schema.decodeUnknownEffect(s)(v)` | Effectful decode                     |
| `.annotations({`                      | `.annotate({`                      | On ALL schema types                  |
| `Schema.pattern(regex)`               | `Schema.isPattern(regex)`          | Used with `.check()`                 |
| `Schema.maxLength(n)`                 | `Schema.isMaxLength(n)`            | Used with `.check()`                 |
| `Schema.minItems(n)`                  | `Schema.isMinLength(n)`            | Used with `.check()`                 |
| `Schema.maxItems(n)`                  | `Schema.isMaxLength(n)`            | Used with `.check()`                 |
| `Schema.int()`                        | —                                  | Use `Schema.Int` (pre-built)         |
| `Schema.positive()`                   | `Schema.isGreaterThan(0)`          | Used with `.check()`                 |
| `Schema.Record({ key: K, value: V })` | `Schema.Record(K, V)`              | Positional args                      |

**Schema filters in v4:** Filters return `AST.Filter<T>`, applied via `.check()`:

```ts
// v3
Schema.Number.pipe(Schema.int(), Schema.positive()).annotations({ title: "Count" })

// v4
Schema.Int.check(Schema.isGreaterThan(0)).annotate({ title: "Count" })
```

**Unchanged:** `Schema.encodeSync`, `Schema.decodeUnknownSync`, `Schema.optional`, `Schema.Class`, `Schema.Struct`, `Schema.Array`, `Schema.String`, `Schema.Number`, `Schema.Boolean`

## Layer

| v3                          | v4                                      | Notes                         |
| --------------------------- | --------------------------------------- | ----------------------------- |
| `Layer.scoped(tag, effect)` | `Layer.effect(tag, effect)`             | v4 strips Scope automatically |
| `Layer.unwrapEffect(e)`     | `Layer.unwrap(e)`                       |                               |
| `Layer.die(msg)`            | `Layer.effectServices(Effect.die(msg))` | `Layer.die` removed           |
| `Layer.setTracer(t)`        | `Layer.succeed(Tracer.Tracer, t)`       | `setTracer` removed           |
| `Layer.scopedDiscard(e)`    | `Layer.effectDiscard(e)`                |                               |

### Logger Layer changes

```ts
// v3
Logger.replace(Logger.defaultLogger, myLogger)
Logger.zip(loggerA, loggerB)
Logger.minimumLogLevel(LogLevel.Info)

// v4
Logger.layer([myLogger])
Logger.layer([loggerA, loggerB])
Layer.effectServices(Effect.succeed(ServiceMap.make(MinimumLogLevel, level)))
```

## Cause

| v3                           | v4                                                       |
| ---------------------------- | -------------------------------------------------------- |
| `Cause.isInterruptedOnly(c)` | `Cause.hasInterruptsOnly(c)`                             |
| `Cause.isFailure(c)`         | `Cause.hasFails(c)`                                      |
| `Cause.isEmpty(c)`           | `c.reasons.length === 0`                                 |
| `Cause.failures(c)` (→Chunk) | `c.reasons.filter(Cause.isFailReason).map(r => r.error)` |

## Schedule

| v3                          | v4                                       |
| --------------------------- | ---------------------------------------- |
| `Schedule.stop`             | `Schedule.recurs(0)`                     |
| `Schedule.driver(s)`        | `Schedule.toStep(s)`                     |
| `Schedule.intersect(a, b)`  | `Schedule.both(a, b)`                    |
| `Schedule.whileInput(pred)` | Moved to `Effect.retry({ while: pred })` |

## Stream

| v3                        | v4                                                      |
| ------------------------- | ------------------------------------------------------- |
| `Stream.unwrapScoped(e)`  | `Stream.unwrap(e)` (strips Scope automatically)         |
| `Stream.filterMap(f)`     | `Stream.filter(Filter.fromPredicateOption(f))`          |
| `Stream.fromQueue(q)`     | `Stream.fromSubscription(q)` (for PubSub subscriptions) |
| `Stream.runFold(init, f)` | `Stream.runFold(() => init, f)` (lazy initial)          |

## Scope

| v3                     | v4                |
| ---------------------- | ----------------- |
| `Scope.CloseableScope` | `Scope.Closeable` |

## Fiber

| v3                       | v4                                      |
| ------------------------ | --------------------------------------- |
| `Fiber.interruptFork(f)` | `Fiber.interrupt(f)` (now non-blocking) |
| `Fiber.RuntimeFiber`     | `Fiber.Fiber`                           |

## Runtime

| v3                         | v4                                  |
| -------------------------- | ----------------------------------- |
| `Runtime.Runtime<R>`       | `ServiceMap.ServiceMap<R>`          |
| `Runtime.runFork(rt)(eff)` | `Effect.runForkWith(services)(eff)` |
| `Runtime.defaultRuntime`   | `ServiceMap.empty()`                |

## Ref

| v3                  | v4                  |
| ------------------- | ------------------- |
| `Ref.unsafeMake(v)` | `Ref.makeUnsafe(v)` |

## SubscriptionRef

| v3                       | v4                             |
| ------------------------ | ------------------------------ |
| `ref.changes`            | `SubscriptionRef.changes(ref)` |
| `ref.get` / `yield* ref` | `SubscriptionRef.get(ref)`     |

`SubscriptionRef` no longer implements `Effect` — all access via static functions.

## Brand

| v3                           | v4                    |
| ---------------------------- | --------------------- |
| `Brand.Brand<unique symbol>` | `Brand.Brand<string>` |
