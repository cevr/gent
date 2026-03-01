# Effect v4 Migration Plan

## Status: Not Started

Target: `effect@4.0.0-beta.5` (or latest beta at time of execution)

## Prerequisites

- [ ] effect-machine v4 support (see `~/Developer/personal/effect-machine/EFFECT-4-MIGRATION.md`)
- [ ] Verify `effect-machine` v4 variant works with gent before starting

## Package Changes

### Root `package.json` catalog updates

```
effect: ^3.19.15 → ^4.0.0-beta.5
@effect/platform-bun: ^0.87.1 → ^4.0.0-beta.5
@effect/sql-sqlite-bun: ^0.50.0 → ^4.0.0-beta.5
@effect/sql-pg: ^0.50.1 → ^4.0.0-beta.5
@effect/vitest: ^0.27.0 → ^4.0.0-beta.5
effect-machine: ^0.3.0 → TBD (v4 variant)
```

### Packages to REMOVE (dissolved into `effect`)

```
@effect/platform        → import from "effect" or "effect/unstable/*"
@effect/sql             → import from "effect/unstable/sql"
@effect/rpc             → import from "effect/unstable/rpc"
@effect/cluster         → import from "effect/unstable/cluster"
@effect/cli             → import from "effect/unstable/cli"
@effect/experimental    → dissolved
@effect/language-service → check v4 compat
```

### Packages that STAY (platform-specific drivers)

```
@effect/platform-bun    → 4.0.0-beta.5
@effect/sql-sqlite-bun  → 4.0.0-beta.5
@effect/sql-pg          → 4.0.0-beta.5
@effect/vitest          → 4.0.0-beta.5
```

## Import Path Changes (37 occurrences, 28 files)

### `@effect/platform` → `effect` (stable modules)

| Old Import                                                    | New Import                               |
| ------------------------------------------------------------- | ---------------------------------------- |
| `import { FileSystem } from "@effect/platform"`               | `import { FileSystem } from "effect"`    |
| `import { Path } from "@effect/platform"`                     | `import { Path } from "effect"`          |
| `import type { PlatformError } from "@effect/platform/Error"` | `import { PlatformError } from "effect"` |

### `@effect/platform` → `effect/unstable/*` (unstable modules)

| Old Import                                                                  | New Import                                                                         |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform"` | `import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"` |
| `import { HttpClient } from "@effect/platform"`                             | `import { HttpClient } from "effect/unstable/http"`                                |
| `import { Command } from "@effect/platform"`                                | `import { ChildProcess } from "effect/unstable/process"`                           |
| `import { FetchHttpClient } from "@effect/platform"`                        | `import { FetchHttpClient } from "effect/unstable/http"`                           |

### `@effect/platform-bun` — stays but verify imports

| Old Import                                             | Status              |
| ------------------------------------------------------ | ------------------- |
| `import { BunRuntime } from "@effect/platform-bun"`    | Unchanged           |
| `import { BunFileSystem } from "@effect/platform-bun"` | Unchanged           |
| `import { BunContext } from "@effect/platform-bun"`    | Verify still exists |

### `@effect/sql` → `effect/unstable/sql` or driver packages

| Old Import                                | New Import                                        |
| ----------------------------------------- | ------------------------------------------------- |
| `import { SqlClient } from "@effect/sql"` | `import { SqlClient } from "effect/unstable/sql"` |

### Files affected

- `packages/core/src/auth-storage.ts` — FileSystem, Path
- `packages/core/src/skills.ts` — FileSystem, Path
- `packages/core/src/link-opener.ts` — (check platform usage)
- `packages/runtime/src/model-registry.ts` — FileSystem, Path
- `packages/runtime/src/config-service.ts` — FileSystem, Path
- `packages/runtime/src/sql-client.ts` — SqlClient, sql-sqlite-bun, sql-pg
- `packages/storage/src/sqlite-storage.ts` — FileSystem, Path, SqlClient
- `packages/server/src/http-api.ts` — HttpApi, HttpApiEndpoint, HttpApiGroup
- `packages/sdk/src/client.ts` — HttpClient, FetchHttpClient
- `packages/tools/src/*.ts` — FileSystem, Path (6 tool files)
- `apps/tui/src/main.tsx` — BunRuntime, BunContext
- `apps/tui/src/utils/shell.ts` — Command
- `apps/tui/src/workspace/context.tsx` — Command
- `apps/server/src/main.ts` — BunRuntime, BunHttpServer

## API Renames

### Services: `Context.Tag` → `ServiceMap.Service` (31 sites, 27 files)

```ts
// v3
class Foo extends Context.Tag("id")<Foo, FooService>() {}

// v4
class Foo extends ServiceMap.Service<Foo, FooService>()("id") {}
```

Also update `import { Context } from "effect"` → `import { ServiceMap } from "effect"` where Context.Tag was the only usage.

**All 27 service files** — see audit in plan for full list.

### Schema: `TaggedError` → `TaggedErrorClass` (20 sites, 14 files)

```ts
// v3
class MyError extends Schema.TaggedError<MyError>()("MyError", { ... }) {}

// v4
class MyError extends Schema.TaggedErrorClass<MyError>()("MyError", { ... }) {}
```

Files: all error classes in core, runtime, storage, providers, tools.

### Schema: `Class` call syntax change (20 sites, 11 files)

```ts
// v3
class Foo extends Schema.Class<Foo>("Foo")({ field: Schema.String }) {}

// v4 — identifier moves to first call, fields to second
class Foo extends Schema.Class<Foo>("Foo")({ field: Schema.String }) {}
// Actually same! v3 already had this form. Verify each site.
```

**Note:** The v3 form `Schema.Class<A>()("Id", {fields})` (two-arg second call) changes to `Schema.Class<A>("Id")({fields})`. But gent may already use the single-arg form. Verify each site.

### Schema: `parseJson` → `fromJsonString` (8 sites, 5 files)

```ts
// v3
const codec = Schema.parseJson(MySchema)

// v4
const codec = Schema.fromJsonString(MySchema)
```

Files: sqlite-storage.ts, model-registry.ts, auth-storage.ts, auth-store.ts, config-service.ts

### Schema: `Union(A, B)` → `Union([A, B])` (9 sites, 8 files)

```ts
// v3
Schema.Union(A, B, C)

// v4
Schema.Union([A, B, C])
```

### Schema: Multi-arg `Literal` → `Literals([...])` (~10 sites)

```ts
// v3
Schema.Literal("a", "b")

// v4 — single literal stays: Schema.Literal("a")
// multi-literal becomes: Schema.Literals(["a", "b"])
```

**Only multi-arg calls need changing.** Single-arg `Schema.Literal("x")` is unchanged.

### Effect: `catchAll` → `catchEager` (90 sites, 33 files)

```ts
// v3
Effect.catchAll((e) => ...)

// v4
Effect.catchEager((e) => ...)
```

This is the highest-volume change. `catchEager` has the exact same signature as `catchAll` — it catches all errors and runs the recovery handler.

### Effect: `catchAllCause` → `catchCause` (15 sites, 6 files)

```ts
// v3
Effect.catchAllCause((cause) => ...)

// v4
Effect.catchCause((cause) => ...)
```

### Effect: `void` constant removed (45 sites, 20 files)

```ts
// v3
Effect.void

// v4 — no direct constant. Options:
Effect.succeed(undefined as void) // or
Effect.asVoid(Effect.succeed(undefined))
// Check if there's a v4 idiom
```

### Layer: `unwrapEffect` → `unwrap` (5 sites, 4 files)

```ts
// v3
Layer.unwrapEffect(effect)

// v4
Layer.unwrap(effect)
```

### Effect: `fork` → `forkChild` (check count)

```ts
// v3
Effect.fork(eff)

// v4
Effect.forkChild(eff)
```

### Effect: `forkDaemon` → `forkDetach` (check count)

```ts
// v3
Effect.forkDaemon(eff)

// v4
Effect.forkDetach(eff)
```

### `Either` → `Result` (if used directly)

Gent doesn't use `Either` directly much. Schema decode return types change but are usually not referenced by name.

## Execution Order

1. **effect-machine v4** — must be done first (separate repo)
2. **Update deps** — root package.json catalog, remove dissolved packages from all package.json files
3. **Fix imports** — `@effect/platform` → `effect` / `effect/unstable/*`
4. **Services** — `Context.Tag` → `ServiceMap.Service` (all 27 files)
5. **Schema renames** — `TaggedError` → `TaggedErrorClass`, `parseJson` → `fromJsonString`, `Union`/`Literal` syntax
6. **Effect renames** — `catchAll` → `catchEager`, `catchAllCause` → `catchCause`, `void`, `fork`, `unwrapEffect`
7. **Typecheck** — `bun run typecheck` and fix remaining issues
8. **Lint + test** — `bun run lint && bun run test`

## Scope Estimate

- ~60 files touched
- ~1400+ lines changed
- All mechanical renames — no architectural changes
- Main risk: `catchAll` removal (90 sites) and `Effect.void` removal (45 sites)

## Beta Caveat

The migration doc says `catchAll` → `catch`, but actual v4 source exports `catchEager` instead. APIs may shift before stable. Consider pinning to exact beta version rather than range.
