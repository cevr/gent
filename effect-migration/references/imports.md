# Import Path Rewrites

## `@effect/platform` → `"effect"` (stable modules)

These modules were promoted to the main `effect` package:

| v3                                                            | v4                                       |
| ------------------------------------------------------------- | ---------------------------------------- |
| `import { FileSystem } from "@effect/platform"`               | `import { FileSystem } from "effect"`    |
| `import { Path } from "@effect/platform"`                     | `import { Path } from "effect"`          |
| `import type { PlatformError } from "@effect/platform/Error"` | `import { PlatformError } from "effect"` |

**PlatformError is now a namespace.** In v4, `import { PlatformError } from "effect"` gives a namespace containing `PlatformError.PlatformError` (the class), `PlatformError.SystemError`, `PlatformError.BadArgument`. Use `PlatformError.PlatformError` in type positions.

```ts
// v3
import type { PlatformError } from "@effect/platform/Error"
const layer: Layer.Layer<Foo, PlatformError, Bar> = ...

// v4
import { PlatformError } from "effect"
const layer: Layer.Layer<Foo, PlatformError.PlatformError, Bar> = ...
```

**Do NOT use `type` import for PlatformError** — it's a namespace (value), not just a type.

## `@effect/platform` → `"effect/unstable/http"`

| v3                                                      | v4                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| `import { HttpClient } from "@effect/platform"`         | `import { HttpClient } from "effect/unstable/http"`            |
| `import { FetchHttpClient } from "@effect/platform"`    | `import { FetchHttpClient } from "effect/unstable/http"`       |
| `import { HttpClientRequest } from "@effect/platform"`  | `import { HttpClientRequest } from "effect/unstable/http"`     |
| `import { HttpRouter } from "@effect/platform"`         | `import { HttpRouter } from "effect/unstable/http"`            |
| `import { HttpServer } from "@effect/platform"`         | `import { HttpServer } from "effect/unstable/http"`            |
| `import { HttpServerResponse } from "@effect/platform"` | `import { HttpServerResponse } from "effect/unstable/http"`    |
| `import { HttpLayerRouter } from "@effect/platform"`    | `import { HttpRouter } from "effect/unstable/http"` (renamed!) |

## `@effect/platform` → `"effect/unstable/httpapi"`

| v3                                                                          | v4                               |
| --------------------------------------------------------------------------- | -------------------------------- |
| `import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform"` | `from "effect/unstable/httpapi"` |
| `import { HttpApiBuilder, HttpApiScalar } from "@effect/platform"`          | `from "effect/unstable/httpapi"` |
| `import { OpenApi } from "@effect/platform"`                                | `from "effect/unstable/httpapi"` |

### HttpApiEndpoint v4 changes

Chaining API → options-based:

```ts
// v3
HttpApiEndpoint.post("create", "/sessions")
  .setPayload(CreateSessionPayload)
  .addSuccess(SessionResult)

// v4
HttpApiEndpoint.post("create", "/sessions", {
  payload: CreateSessionPayload,
  success: SessionResult,
})
```

- `.setPath(Schema.Struct({ id: ... }))` → `params: { id: ... }` in options
- `.addError(E)` → `error: E` in options
- `HttpApiEndpoint.del()` → `HttpApiEndpoint.delete()`
- Handler `{ path }` → `{ params }`

### HttpApiScalar / HttpApiBuilder v4 changes

- `HttpApiScalar.layerHttpLayerRouter({ api, path })` → `HttpApiScalar.layer(api, { path })`
- `HttpLayerRouter.addHttpApi(GentApi)` → `HttpApiBuilder.layer(GentApi)`
- `RpcServer.layerHttpRouter(...)` → `RpcServer.layerHttp(...)`

## `@effect/platform` → `"effect/unstable/process"`

| v3                                           | v4                                                       |
| -------------------------------------------- | -------------------------------------------------------- |
| `import { Command } from "@effect/platform"` | `import { ChildProcess } from "effect/unstable/process"` |

### API renames

| v3                              | v4                                                         |
| ------------------------------- | ---------------------------------------------------------- |
| `Command.make("git", ...args)`  | `ChildProcess.make("git", [...args])` (array, not spread!) |
| `Command.workingDirectory(cwd)` | `ChildProcess.setCwd(cwd)`                                 |
| `Command.start(cmd)`            | `ChildProcess.spawn(cmd)`                                  |
| `Command.string(cmd)`           | `ChildProcess.string(cmd)`                                 |

**Important:** v4 `ChildProcess.make` takes `(command, args[])` — array, not spread args.

## `@effect/sql/*` → `"effect/unstable/sql"`

```ts
// v3
import { SqlClient } from "@effect/sql/SqlClient"
import { SqlError } from "@effect/sql/SqlError"

// v4
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqlError } from "effect/unstable/sql/SqlError"
```

Note: `@effect/sql-sqlite-bun` and `@effect/sql-pg` remain separate driver packages.

## `@effect/rpc` → `"effect/unstable/rpc"`

```ts
// v3
import { Rpc, RpcGroup } from "@effect/rpc"
import { RpcServer } from "@effect/rpc"

// v4
import { Rpc, RpcGroup, RpcServer } from "effect/unstable/rpc"
```

## `@effect/cluster` → `"effect/unstable/cluster"`

```ts
// v3
import * as Entity from "@effect/cluster/Entity"
import type * as Sharding from "@effect/cluster/Sharding"

// v4
import { Entity, Sharding } from "effect/unstable/cluster"
```

## `@effect/cli` → `"effect/unstable/cli"`

```ts
// v3
import { Command, Options, Args } from "@effect/cli"

// v4
import { Command, Flag, Argument } from "effect/unstable/cli"
```

### CLI API renames

| v3                             | v4                                              |
| ------------------------------ | ----------------------------------------------- |
| `Options.text("name")`         | `Flag.string("name")`                           |
| `Options.boolean("flag")`      | `Flag.boolean("flag")`                          |
| `Options.withAlias("x")`       | `Flag.withAlias("x")`                           |
| `Options.withDescription(...)` | `Flag.withDescription(...)`                     |
| `Options.optional`             | `Flag.optional`                                 |
| `Options.withDefault(v)`       | `Flag.withDefault(v)`                           |
| `Args.text({ name: "x" })`     | `Argument.string("x")` (positional, not object) |
| `Args.withDescription(...)`    | `Argument.withDescription(...)`                 |
| `Args.optional`                | `Argument.optional`                             |

### Command.run v4 changes

- `Command.run(cmd, { name, version })` → `Command.run(cmd, { version })` (name removed)
- `Layer.scopedDiscard(Effect.suspend(() => cli(process.argv)))` → `Layer.effectDiscard(cli)` (v4 reads argv internally)
- `BunRuntime.runMain` no longer accepts `disablePrettyLogger`

## `@effect/platform-bun` — stays, minor renames

| v3                                             | v4                  |
| ---------------------------------------------- | ------------------- |
| `BunContext`                                   | `BunServices`       |
| `BunContext.layer`                             | `BunServices.layer` |
| `BunRuntime`, `BunFileSystem`, `BunHttpServer` | Unchanged           |

**Note:** `BunServices.layer` in v4 provides FileSystem, Path, Terminal, ChildProcessSpawner, Stdio — you don't need separate `BunFileSystem.layer`.

## `"effect/ConfigError"` — removed subpath

```ts
// v3
import { ConfigError } from "effect/ConfigError"

// v4
import type { Config } from "effect"
// Use as: Config.ConfigError
```
