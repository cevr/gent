# Gotchas — Things That Bit Us

Hard-won lessons from migrating gent (11-package monorepo, ~100 files).

## 1. PlatformError is a Namespace

**Symptom:** `Cannot use namespace 'PlatformError' as a type`

In v4, `import { PlatformError } from "effect"` gives a **namespace** (via `export * as PlatformError`), not a class. The actual error type is `PlatformError.PlatformError`.

```ts
// WRONG
import type { PlatformError } from "effect" // type-only import of a namespace
Layer.Layer<Foo, PlatformError, Bar> // namespace in type position

// RIGHT
import { PlatformError } from "effect" // value import (it's a namespace)
Layer.Layer<Foo, PlatformError.PlatformError, Bar> // access the class
```

**Also:** `PlatformError` is no longer a Schema — it's a `Data.TaggedError`. If you need it in a `Schema.Union`, create a wrapper `Schema.TaggedErrorClass`.

## 2. ServiceMap is Contravariant

**Symptom:** `Type 'ServiceMap<never>' is not assignable to type 'ServiceMap<any>'`

`ServiceMap<in Services>` — the `in` means contravariant. `ServiceMap<never>` (provides nothing) is NOT a subtype of `ServiceMap<any>` (can provide anything). Variance flips the direction.

```ts
// This breaks
const services: ServiceMap<any> = ServiceMap.empty() // ServiceMap<never>

// Fix: cast at the boundary
const services: ServiceMap<any> = ServiceMap.empty() as ServiceMap<any>
```

## 3. Config.option Can't Be Piped with Effect Combinators

**Symptom:** Type errors when piping `Config.option(Config.string("X"))` with `Effect.catchEager` etc.

`Config` is `Yieldable` but NOT an `Effect`. You can `yield*` it in `Effect.gen`, but you can't `.pipe(Effect.catchEager(...))` on it.

```ts
// BROKEN in v4
yield *
  Config.option(Config.string("HOME")).pipe(
    Effect.catchEager(() => Effect.succeed(Option.none())),
    Effect.map(Option.getOrElse(() => os.homedir())),
  )

// FIX 1: yield first, handle after
const maybeHome = yield * Config.option(Config.string("HOME"))
const home = Option.getOrElse(maybeHome, () => os.homedir())

// FIX 2: just use os.homedir() directly
const home = os.homedir()
```

## 4. Schema.DateFromNumber Removed

No built-in number↔Date transform. Define locally:

```ts
import { Schema, SchemaGetter as Getter } from "effect"

const DateFromNumber = Schema.Number.pipe(
  Schema.decodeTo(Schema.DateValid, {
    decode: Getter.transform((n: number) => new Date(n)),
    encode: Getter.transform((d: Date) => d.getTime()),
  }),
)
```

`decodeTo` requires `Getter` instances, not plain functions. `Getter.transform(fn)` wraps a pure function.

## 5. ChildProcess.spawn + Stream.runFold Deadlocks

**Symptom:** Test hangs or times out when reading large output from spawned process.

In v4, `ChildProcess.spawn` returns streams tied to the scope. Reading both stdout and stderr concurrently via `Stream.runFold` can deadlock with large output — the process waits for buffers to drain, but the scope hasn't released.

```ts
// DEADLOCKS with large output
Effect.scoped(Effect.gen(function*() {
  const handle = yield* ChildProcess.spawn(cmd)
  const stdout = yield* Stream.runFold(handle.stdout, ...)  // hangs
}))

// FIX: use Bun.spawn directly
Effect.tryPromise({
  try: async () => {
    const proc = Bun.spawn(["bash", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    return { stdout, stderr }
  },
  catch: (e) => e as Error,
}).pipe(Effect.orDie)
```

## 6. .annotations() Silently Returns `any`

**Symptom:** `Struct` not assignable to `Decoder<any, never>`

`.annotations()` doesn't exist in v4 — it's `.annotate()`. The old method returns `any` instead of erroring, which propagates through all containing types.

```ts
// BROKEN — returns any, infects parent types
Schema.String.annotations({ title: "Name" })

// FIXED
Schema.String.annotate({ title: "Name" })
```

## 7. Schema Filter API Changed

**Symptom:** `Schema.int()`, `Schema.positive()`, `Schema.pattern()` don't exist

Filters are now standalone functions applied via `.check()`:

```ts
// v3
Schema.Number.pipe(Schema.int(), Schema.positive())
Schema.String.pipe(Schema.pattern(/^https?:\/\//))

// v4
Schema.Int.check(Schema.isGreaterThan(0))
Schema.String.check(Schema.isPattern(/^https?:\/\//))
```

## 8. `new TaggedErrorClass()` Needs `{}`

**Symptom:** `Expected 1 arguments, but got 0`

Empty-field errors require `{}` in v4:

```ts
// v3
throw new MyError()

// v4
throw new MyError({})
```

## 9. Effect.try (single-arg) Removed

**Symptom:** `Effect.try is not a function` or wrong overload

The single-arg form `Effect.try(() => expr)` is gone. The object form `Effect.try({ try, catch })` still works.

```ts
// BROKEN
Effect.try(() => JSON.parse(str))

// FIX
Effect.try({ try: () => JSON.parse(str), catch: (e) => e as Error })
// or
Effect.sync(() => {
  try {
    return JSON.parse(str)
  } catch {
    return {}
  }
})
```

## 10. Stale Build Artifacts

**Symptom:** Tests fail with `Effect.runtime is not a function` but grep shows no `Effect.runtime` in source

Compiled `.js` files from pre-migration may shadow `.ts` files. Bun prefers `.js` over `.ts`.

```bash
# Find and remove stale artifacts
find . -name "*.test.js" -path "*/tests/*" -delete
find . -name "*.test.d.ts" -path "*/tests/*" -delete
```

## 11. Stream.filterMap Removed

```ts
// v3
Stream.filterMap(fn) // fn: (a) => Option<B>

// v4
import { Filter } from "effect"
Stream.filter(Filter.fromPredicateOption(fn))
```

## 12. Schedule.whileInput Removed

Move input filtering to `Effect.retry` options:

```ts
// v3
Effect.retry(schedule.pipe(Schedule.whileInput(isRetryable)))

// v4
Effect.retry({ schedule, while: isRetryable })
```

## 13. Layer.Layer.Context<T> Removed

No `Layer.Layer` namespace in v4. Define your own utility type:

```ts
type LayerContext<T> = T extends Layer.Layer<infer A, infer _E, infer _R> ? A : never
```

## 14. `globalValue` from "effect/GlobalValue" Removed

```ts
// v3
import { globalValue } from "effect/GlobalValue"
const singleton = globalValue("key", () => new Foo())

// v4 — use module-level lazy singleton
let _singleton: Foo | undefined
const getSingleton = () => (_singleton ??= new Foo())
```

## 15. Effect.tap Requires Effect Return

In v4, `Effect.tap` callback must return an `Effect`, not `void`.

```ts
// BROKEN in v4
Effect.tap(() => {
  sideEffect()
})

// FIX
Effect.tap(() =>
  Effect.sync(() => {
    sideEffect()
  }),
)
```

## 16. FileSystem.File.Info.mtime Changed

```ts
// v3
Option.getOrElse(stat.mtime, () => new Date(0))

// v4
stat.mtime ?? new Date(0) // now Date | undefined, not Option<Date>
```

## 17. Index Signature Property Access

With `noPropertyAccessFromIndexSignature`, Schema.Struct decoded types require bracket notation:

```ts
// ERROR
config.maxRetries

// FIX
config["maxRetries"]
```

## Migration Checklist (post-typecheck)

After typecheck passes, verify:

- [ ] No stale `.js` artifacts shadowing `.ts` test files
- [ ] No `import type { PlatformError }` (must be value import)
- [ ] All `.annotations(` → `.annotate(`
- [ ] All `Schema.decodeUnknown(` → `Schema.decodeUnknownEffect(`
- [ ] No `Config.option(...).pipe(Effect.` patterns
- [ ] Tests actually run (not just typecheck)
- [ ] Large-output shell tests don't timeout
