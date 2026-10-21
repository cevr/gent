# Server, storage and transport

## Package Map

```text
apps/
├── tui/       # OpenTUI client over the shared transport contract
└── site/      # gent.cvr.im: landing page and install.sh, an Alchemy stack: one Cloudflare Worker

packages/
├── core/          # entries: extensions/api, extensions/branch-tools, protocol, host, host-bun, test-utils
│   ├── domain/    # Schemas, ids, events, service tags, pure domain helpers
│   ├── storage/   # Storage tags, schema ownership, SQLite assembler, focused repositories
│   ├── runtime/   # SessionRuntime, agent-loop internals, provider stack and scripted model
│   ├── extensions/# api.ts public extension surface
│   ├── server/    # transport contract, handlers, commands, queries, startup wiring
│   └── test-utils/# test layers, recorders, fixtures
├── extensions/    # shipped extension set
└── sdk/           # direct + RPC transports over one client contract
```

`@gent/core/protocol` contains shared client schemas, message projections, and the RPC contract. The SDK uses this entry point for client data. It does not expose server storage or runtime service tags. Core implementation files keep relative imports; they do not import through the public protocol entry point.

`@gent/core/host` is what a host composes, and it loads on a hosted root (a Worker or a Durable Object) without Bun. `@gent/core/host-bun` is the Bun host: `BunPlatformLive`, `BunSqlite`, `BunHostModules`, `bindBunModules`. The SDK server and the TUI compose both.

## System Shape

```text
TUI / SDK / HTTP client
          │
          ▼
  transport contract
          │
   ┌──────┴──────┐
   │             │
   ▼             ▼
direct        RPC / HTTP
adapter        adapter
   │             │
   └──────┬──────┘
          ▼
   app services
          │
   ┌──────┴──────┐
   ▼             ▼
commands      queries/events
          │
          ▼
   runtime + boundaries
```

Process topology is secondary. Default CLI topology is not.

Default `gent` resolves a shared server via `Gent.server({ cwd, state: Gent.state.sqlite() })`. SQLite-backed local clients share one server per database, decided by the lock files beside `data.db` (see Shared Server Discovery); workspace routing is carried by the `x-gent-workspace-id` RPC header. Topology derives from configuration: `Gent.state.memory()` for in-process owned, `Gent.state.sqlite()` for shared local server, `Gent.client({ url })` for remote.

## Transport Boundary

Source of truth:

- `packages/core/src/server/rpc.ts`

That module owns:

- client-facing types
- queue/session/message projections
- contract semantics

Adapters:

- `packages/sdk/src/client.ts`
- `packages/core/src/server/rpc.ts`
- `packages/core/src/server/server.ts`

Rule:

- no client-specific DTO remodeling
- no parallel application contract surfaces
- handlers and adapters derive from the same contract types

## App Services

The app surface is split by concern:

- `SessionMutations` (`packages/core/src/domain/extension.ts`; `SessionMutationsLive` in `packages/core/src/server/server.ts`) — every durable session/branch mutation, including `createSession`; request-id-bearing mutations replay their durable operation row and collapse concurrent same-request fibers in-process
- `SessionQueries`
- `InteractionCommands`

`message.send` request-id dedup lives in `server/server.ts` next to the handler; the runtime keys the actor command on the same request id.

The app services are one layer, `createDependencies` in `packages/core/src/server/server.ts`; no separate app-services layer exists. It is one stack of levels, each provided once to every level above it (host, storage, kernel, launch profile, models, tools, sessions, actor), so each layer in it builds once: Effect memoizes only leaf layers, and a composite named on several paths built once per path. The storage entry builds its SQL client once under every repository; the root takes no other storage, and an extension's tables belong to its own process Resource. The root takes that client as a layer (`createDependencies({ sql })`, `SqliteStorage.WithSql`): the Bun host's `BunSqlite.file(path)` and `BunSqlite.memory` open a Bun SQLite connection and set its PRAGMAs in that client layer; a hosted root passes a `Layer<SqlClient>` that it opens and owns (a Durable Object's storage through `@effect/sql-sqlite-do`), and the root sets no PRAGMA on it. Storage init is portable DDL under the generic `Migrator` for each client. The portable graph (`@gent/core/host`, `protocol`, the extension entries and the shipped extensions) imports no Bun module at its top level: the Bun pieces (`BunPlatformLive`, `BunSqlite`, the module binding, the loopback listener behind `GentPlatform.loopbackServer`, and the provider lock file) live in `packages/core/src/runtime/gent-platform-bun.ts` behind `@gent/core/host-bun`. A guard (`findHostOnlyImports`) and a bundle check (`packages/tooling/tests/portable-graph.test.ts`) hold that line. The guard also reports a read of the global `Bun` in portable source, which imports nothing and fails on a hosted root all the same; the skills extension parses frontmatter with the `yaml` package for this reason. One read is kept by name: the workspaces extension's `Bun.TOML` parse of a `.rift.toml`, which runs only beside rift's spawned hooks. The auth store serializes writes to one provider through `ProviderLock`, a host service: `BunPlatformLive` provides the lock file under `<auth dir>/.locks` that excludes other processes, and `ProviderLock.InProcess` serves a hosted root that is the only writer of its store. A SQL list binds as one JSON parameter through `sqlInList` (`storage.ts`, exported to extensions from `@gent/core/extensions/api`), never as one parameter per item through `sql.in` (a guard), because a hosted SQLite refuses more than 100 bound parameters. One runner owns a root's storage on every host (the SDK server holds the database's kernel lock), so the cluster's shard locks live in memory (`SingleRunner` with `runnerStorage: "memory"`) and a boot writes no lock row. Effect's `SqlMessageStorage` reads the cluster's snowflake ids under `SqlClient.SafeIntegers`, which a Durable Object's SQL API cannot honour: it returns each integer as a JavaScript number, and a default snowflake is past 2^53, so a reply would name its request by the nearest double. The root therefore builds under `withClusterIdSpace` (`storage.ts`), a memo map that answers every build of Effect's `Snowflake.layerGenerator` with one generator per root; `Sharding`, the runners, the message storage and effect-encore's actor transport each provide that layer to themselves, so no service from outside reaches them. On a client that reads 2^53 + 1 back exactly (Bun SQLite) the generator is Effect's own. On any other it mints ids under 2^53, the milliseconds since 2026 times 2048 or one past the last id, whichever is larger, from the largest stored id up, so a clock that steps back or a new activation never reuses or reorders one; before that it moves the ids an earlier build left past 2^53 under the bound, in their order and through one map for every column. A boot with no such id reads four indexes and renumbers nothing. The cluster reads no part of a snowflake (timestamp, machine, sequence) and delivers by rowid, which is the id, so only the order counts. The id holds no machine: it assumes one runner owns the storage, as above, and two live roots on one storage would mint the same ids. A link the old ids already broke stays broken: a reply written under a request id read as its nearest double keeps that value through the move, so it names no request (or, rarely, another one the rounding hit); its request stays unprocessed, is delivered again, and its entity runs it again and writes a reply that names it exactly, while the orphan reply stays in the table, read by nothing. The swap reaches the root's own build, nested builds included; a layer built after the root through another memo map (an extension resource that `extension-host.ts` builds) gets Effect's generator, and no cluster layer is built that way today. The root fails loudly instead of running with lossy ids: on a client that reads integers as numbers, it fails its build when no build of the generator reached the swap, or when its `Sharding` mints an id past 2^53 - 1. Reported upstream as https://github.com/Effect-TS/effect/issues/9483. `packages/core/tests/server/hosted-storage.test.ts` runs the root on Durable-Object-shaped storage. A test in `packages/core/tests/server/server.test.ts` counts the builds. The SDK builds it in the server scope, builds the RPC handlers over it once, and hands the handler context to `buildServerRoutes` and to its in-process clients, so one request deduper and one login-lease map serve both transports; the test harness provides it as a layer.

`packages/core/src/server/server.ts` owns startup wiring:

- runtime platform
- storage/event store
- auth/config/model registry
- provider stack
- extension loading and live Profile ownership
- actor/runtime services

It is the composition boundary. Not the domain boundary.

## Platform Boundaries

Core runtime should not reach for ambient process state unless the app shell is the real owner.

Explicit platform/runtime seams:

- `GentPlatform` owns host capabilities such as process identity, signals, env,
  executable path, ids, hashing, the image codec, and OS info. Time comes from Effect's `Clock`,
  so a test can drive it.
- `RuntimeEnvironment` carries launch/session configuration values:
  `cwd`, `home`, and platform name.
- tracer/logger services
- file system / path / OS services

App entrypoints bind concrete Bun/OS behavior:

- `apps/tui/src/main.tsx`

Production rule:

- `apps/tui/src/main.tsx` resolves a server via `Gent.server()` + `Gent.client()`
- `--connect <url>` attaches to a remote server via `Gent.client({ url })`
- `gent server start` (`apps/tui/src/ops.ts`) runs a standalone durable server in the foreground. Its flags (`--port`, `--isolate`, `--mock`) are the one way to choose how it launches; the environment names only where its data lives (`GENT_DATA_DIR`, `GENT_AUTH_DIRECTORY`). A signal stops it with exit 130 (SIGINT) or 143 (SIGTERM).
- Every listener gent opens binds `127.0.0.1`, never every interface (Bun's default when no hostname is given): the server's RPC (`LISTEN_HOST` in `packages/sdk/src/server.ts`, the address it binds and the url it names), the OpenAI browser login's redirect listener (`packages/extensions/src/openai.ts`) and the MCP one (`packages/extensions/src/mcp.ts`). The RPC has no auth and runs bash, so a peer on the LAN or the tailnet that reached it would run commands as the owner. A server on another machine is reached only through a tunnel: `ssh -L 3000:127.0.0.1:3000 <host>`, then `--connect http://127.0.0.1:3000/rpc`. Receipts: "the owned server listens on loopback only" in `packages/sdk/tests/server.test.ts` and "the redirect listener answers on loopback and refuses another address" in `packages/extensions/tests/openai.test.ts`; each also sends a request to the host's own non-loopback IPv4 address (the test preload lets a request to this machine's interface addresses through) and expects it refused.

## Shared Server Discovery

`packages/sdk/src/discovery.ts` owns shared-server discovery: the data paths, the build fingerprint, the lock, and the decision to attach or to start. The server root that composes the server stack (`packages/sdk/src/server.ts`: the shipped extensions, the dependency graph, the HTTP listener) is a separate module that `resolveServer` imports only when this process builds a server; a launch that attaches, and a command that only reads the data directory, never evaluate it (an attach launch to its composer, median of 7 interleaved runs: compiled 278 ms to 194 ms, source 704 ms to 490 ms). `packages/sdk/tests/index.test.ts` imports the SDK entry in a fresh process and fails when a module of the shipped extensions, the server root or the OpenTelemetry SDK loads. Two files sit beside `data.db` in the data directory (`GENT_DATA_DIR`, else `~/.gent`):

- `server.lock.db` is the kernel lock. The owning server holds an exclusive SQLite lock on it (`BEGIN EXCLUSIVE`, `busy_timeout` 0) for the life of its scope. The OS releases it when the process exits. A server is alive exactly when this lock cannot be taken, so a crash, a reboot, or a reused pid cannot leave a live-looking lock, and two concurrent starts give one owner: the other waits for the owner's entry and attaches.
- `server.lock` is the discovery entry the owner writes once it listens: url, pid, and the identity tuple. Clients attach only after `/_gent/identity` confirms the full tuple. An entry whose kernel lock is free names a server that is gone. Only the holder of the kernel lock removes the entry, whatever server it names: under the lock, the entry is the holder's own or a gone server's. Taking the lock (`serverLock.hold`, by a start, by `gent storage reset`, or by `gent server stop`) removes that entry at once, so a start that waits on the new owner never probes it, and a server removes its own entry before its scope releases the lock. `gent server stop` sends SIGTERM only after the identity probe; `--all` removes an entry whose kernel lock is free by taking the lock and letting it go, and when a new owner holds the lock first, the entry is the new owner's and stays. `gent storage reset` takes the kernel lock as a server start does (`serverLock.hold`) and holds it from the first look at the database files to the last move, so no server opens them mid-move; it refuses while a server holds the lock.

A start that finds a confirmed server of another build on the database fails with a message that names its pid; it never signals it. `gent server stop` is the explicit way to stop it. The build fingerprint (`buildFingerprint` in `packages/sdk/src/discovery.ts`, read once per start, so the lock entry and the identity endpoint name one build) is `<version>+<build id>` for the compiled gent, wherever it is installed (`GentPlatform.build`, read from the build's `__GENT_BUILD__` define), and the checkout's git hash for a source run. A file's mtime names no build: an archive or a package keeps the mtimes it was packed with, so two versions' binaries can share one. A build neither names is `unknown`, and `unknown` matches no build, itself included: such a start never attaches.

A fixed port (`gent server start --port`) changes only the attach decision. A SQLite server on a fixed port still takes the kernel lock and writes its entry, so the TUI finds and attaches to it; it never attaches to another server itself, and fails with the holder's pid when the database is owned. The standalone server runs until a signal stops it: there is no idle shutdown and no shared launch mode.

`packages/sdk/src/discovery.ts` resolves SQLite-backed clients through this single shared server record. Workspace isolation comes from the `x-gent-workspace-id` RPC header and workspace-prefixed AgentLoop actor entity IDs, not from per-workspace server processes.

E2E coverage that needs process boundaries uses focused server-process fixtures; transport contract tests run through the in-process direct transport.

## Distribution

gent ships as one pair of compiled files, `gent` and `gent-cell`, per platform: `darwin-arm64`, `darwin-x64`, `linux-x64` and `linux-arm64` (glibc). The pair stays together: `gent` starts the cell worker from the directory of its real executable.

- **Release.** `.github/workflows/release.yml` runs on a `v<version>` tag that matches `apps/tui/package.json`. Each platform builds on its own runner, because `bun install` puts only that platform's OpenTUI and fff libraries on disk and the build embeds them; x64 embeds Bun's baseline runtime (`GENT_COMPILE_TARGET`), which runs without AVX2. macOS signs the pair ad hoc. Each runner runs the release smoke, then packs `gent-<platform>.tar.gz`. The last job adds `install.sh`, writes `SHA256SUMS` over the archives and `install.sh`, and drafts the GitHub release; every action is pinned to a full commit SHA; the owner checks the draft and publishes it. https://gent.cvr.im/install.sh serves the latest release's `install.sh`.
- **Release smoke.** `packages/e2e/src/release-smoke.ts <dir>` runs a built pair the way an install runs it: no Bun on `PATH`, no keys, a model catalog address that refuses, a scratch home. It checks `--version` against the manifest and `--help`, reports the median `--version` start, runs a scripted turn whose steps are cells through a link in another directory, loads a user TypeScript extension and one with its own `node_modules`, refuses an import that nothing binds, and proves that the working directory's `.env` sets nothing. `bun run test:e2e` runs it on the local build ("passes the release smoke" in `apps/tui/tests/headless-cli-exit.test.ts`), so each change proves the script.
- **Install.** `curl -fsSL https://gent.cvr.im/install.sh | sh` runs `install.sh` (POSIX `sh`, at the repo root). It refuses Windows and musl, picks the arm64 build under Rosetta, resolves the latest release from the redirect of `<releases>/latest` (or takes `--version`), downloads `gent-<platform>.tar.gz` and `SHA256SUMS` from https://github.com/cevr/gent/releases (`GENT_RELEASES_URL` names a mirror), checks the digest, and runs the new `gent --version` before anything points at it. The layout, under `${XDG_DATA_HOME:-~/.local/share}/gent`, is `versions/<version>/{gent,gent-cell}`, the current link `gent -> versions/<version>/gent`, and `~/.local/bin/gent` linked once to that current link. The current link changes by one rename of a link made under a temporary name. One install at a time holds `<root>/.lock` (a `mkdir` lock directory with the owner's PID; no waiter takes it over, because no check tells a crashed owner from a live one or a reused PID for certain: after 60 seconds a waiter stops nonzero and names the lock, its PID, and that a person removes it when no install runs) from reading the current version through placing, switching and pruning, so two updates never interleave a switch and a prune. A version directory never changes once it is in place: a reinstall reuses a directory whose pair is byte-identical (`cmp`), and puts any other pair under a fresh name, `<version>_<suffix>`, so the directory the current link names is never moved. A running gent keeps the version it started from, because it resolves its real path at start, and marks it in use: a compiled gent in an install writes `<version>/.in-use/<pid>` at start and removes it at exit (`markVersionInUse` in `apps/tui/src/ops.ts`, opened by `apps/tui/src/main.tsx`). Each install keeps the version it places, the one it replaces, and every version with a live marker (`kill -0`), removes stale markers, and removes the other versions. Marker and prune meet in a handshake with no lock at start: prune moves a candidate aside in one rename (`versions/.prune-<version>-<pid>`), looks for markers again, and puts the version back when it finds a live one; a starting gent writes its marker (never recreating a removed directory), then checks that its `gent` and `gent-cell` are still in place, and refuses to start ("this version of gent was removed during start; run gent again") when they are not, or when the marker cannot be written. Either prune sees the marker or the gent sees its pair gone. It adds `~/.local/bin` to `PATH` in the login shell's startup file only when `PATH` lacks it (`--no-modify-path` skips that), and reports another `gent` earlier on `PATH`. `--from <dir>` installs a local pair as `dev-<first 12 hex of the SHA-256 of its gent>`; `bun run install:global` is `install.sh --from bin`, so a dev install and a release install share one layout. Receipts: `apps/tui/tests/install.test.ts`, against a release host on loopback.
- **Upgrade.** `gent upgrade [version]` (`upgradeInstall` in `apps/tui/src/ops.ts`) runs only when asked; gent never checks for a new version at launch. It finds its channel from `GentPlatform.execPath`. Under `<XDG_DATA_HOME>/gent/versions/<version>/gent` it resolves the version (asked for, or the redirect of `<releases>/latest`), downloads that release's `install.sh`, checks it against the release's `SHA256SUMS` like any other asset, and runs it with `sh` (`--version <v> --no-modify-path`, `XDG_DATA_HOME` set to the root's parent, `GENT_RELEASES_URL` set to the release host). `install.sh` is the one owner of placing, switching and pruning; the upgrade keeps no copy of them. The version asked for, or the latest, that the running build already is gives "Already at". Under a `node_modules` tree it changes nothing and names the package manager as the way to upgrade. A source run (`GentPlatform.build` is `Source`) and any other path are refused with the install command. Its last line says that a gent of the old version that still runs keeps its server, so a new launch on the same database fails until that gent closes or `gent server stop` stops it.

## Observability

Wide event boundaries (one structured log per unit of work) via `effect-wide-event`:

| Boundary     | Service       | File                    |
| ------------ | ------------- | ----------------------- |
| Agent turn   | `agent-loop`  | `runtime/agent-loop.ts` |
| Tool call    | `tool-runner` | `runtime/tools.ts`      |
| Model stream | `provider`    | `runtime/turn.ts`       |
| RPC request  | `rpc`         | `server/server.ts`      |

Logging conventions:

- Structured annotations: `Effect.logInfo("noun.verb").pipe(Effect.annotateLogs({ key: value }))`
- Never `Effect.logWarning("msg", error)` — always `.pipe(Effect.annotateLogs({ error: String(e) }))`
- Tool-level errors captured via `WideEvent.set({ toolError: "..." })` (value-level, not effect failures)

Log destinations:

- One directory, `<GENT_DATA_DIR or ~/.gent>/logs` (`dataPaths(home).logDir` in `packages/sdk/src/discovery.ts`): logs follow the data directory, so an isolated run keeps its logs beside its database. Startup (`ensureLogDir`) removes gent logs last written more than 14 days ago
- `<hash>-<ts>-server.log` — server-side JSON lines (via the SDK's `GentObservability`)
- `<hash>-<ts>-client.log` — TUI-side JSON lines (`clientLog` and `clientTraceLogger` in `apps/tui/src/client.tsx`); `<hash>` names the cwd, `<ts>` the process start
- Spans go to an OTLP endpoint when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (`GentTracerLive`), and the OpenTelemetry SDK loads only then; no trace file is written

Request-ID correlation: TUI generates a request id with `randomId` (`apps/tui/src/utils.ts`, Effect `Random`) at `sendMessage`/`createSession`, passes via `requestId` field in transport contract. Server threads into log annotations and RPC wide event boundaries.
