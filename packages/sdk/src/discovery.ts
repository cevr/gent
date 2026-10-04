import { Effect, Exit, FileSystem, Match, Option, Path, Predicate, Schema, Scope } from "effect"
import type { Context, Layer } from "effect"
import { join as pathJoin, resolve as pathResolve } from "node:path"
import { Database } from "bun:sqlite"
import type { ChildProcessSpawner } from "effect/process"
import { GentConnectionError } from "@gent/core/protocol"
import {
  GentPlatform,
  type BranchStorage,
  type MessageStorage,
  type SessionStorage,
  workspaceIdForCwd,
  BunPlatformLive,
  type RpcHandlersLive,
  resolveDataDir,
} from "@gent/core/host"
import { runProcess, type GentExtension } from "@gent/core/extensions/api"
import { FetchHttpClient, HttpClient } from "effect/http"
import type { BranchToolFeature } from "@gent/core/extensions/branch-tools"
import type { buildOwnedServer, startOwnedServer } from "./server.js"

/**
 * Shared-server discovery: where gent keeps its durable state, the lock that
 * names the one server on a database, and the decision to attach to that
 * server or to start one. The server root (`server.ts`) writes what this
 * file reads; a client reads it to attach, and the doctor and `gent server`
 * commands read it to inspect. Nothing here imports the server stack: a
 * launch that attaches never evaluates it, and `resolveServer` loads the
 * server root only when this process builds a server.
 */

// ── data-paths ──────────────────────────────────────────────────────────────

/**
 * The files gent keeps in its data directory.
 *
 * `GENT_DATA_DIR` names the directory holding `data.db`; without it the
 * directory is `<home>/.gent` (core's `resolveDataDir` owns that rule). Every
 * reader — the server that writes the database, and the `doctor` and
 * `storage reset` commands that inspect and archive it — resolves through
 * here, so an operator who redirects the database does not get tools that
 * look somewhere else.
 */

const DB_FILE = "data.db"

/** The database file plus the sidecars SQLite writes beside it. */
interface DataPaths {
  readonly dataDir: string
  readonly dbPath: string
  /** `dbPath` and its `-shm`/`-wal` sidecars, in that order. */
  readonly files: ReadonlyArray<string>
  /** Where `storage reset` moves the files it clears. */
  readonly archiveDir: string
  /** The shared-server identity record. One server per database, so it sits beside it. */
  readonly serverLock: string
  /** The SQLite file whose exclusive lock the owning server holds for its life. */
  readonly serverKernelLock: string
  /**
   * Where the server and the client write their logs. They follow the data
   * directory, so an isolated run keeps its logs beside its database and its
   * `doctor` reads the logs that run wrote.
   */
  readonly logDir: string
}

/** The paths inside an already-resolved data directory. */
const dataPathsIn = (dataDir: string): DataPaths => {
  const resolvedDir = pathResolve(dataDir)
  const dbPath = pathJoin(resolvedDir, DB_FILE)
  return {
    dataDir: resolvedDir,
    dbPath,
    files: [dbPath, `${dbPath}-shm`, `${dbPath}-wal`],
    archiveDir: pathJoin(resolvedDir, "storage-archive"),
    serverLock: pathJoin(resolvedDir, "server.lock"),
    serverKernelLock: pathJoin(resolvedDir, "server.lock.db"),
    logDir: pathJoin(resolvedDir, "logs"),
  }
}

/**
 * Resolve the paths from the environment through core's `resolveDataDir`,
 * the rule the extensions' state files follow too. `home` names the fallback
 * root; a caller without one passes `HOME`.
 */
export const dataPaths = (home: string): Effect.Effect<DataPaths> =>
  Effect.map(resolveDataDir(home), dataPathsIn)

// ── build-fingerprint ───────────────────────────────────────────────────────

/**
 * Build fingerprint — identifies gent executable/source version.
 * Used by the server identity and the data-directory lock, so a client attaches
 * only to a server of its own build.
 */

/** The fingerprint of a build that cannot be named. It matches no build, itself included. */
const UNKNOWN_BUILD = "unknown"

/** Whether two fingerprints name one build. An unknown build is never the same build. */
const sameBuild = (a: string, b: string): boolean => a === b && a !== UNKNOWN_BUILD

type BuildFingerprintServices = Path.Path | ChildProcessSpawner.ChildProcessSpawner | GentPlatform

/**
 * This process's build fingerprint, from local sources (no env). A compiled
 * gent names its build by the version and the id its build drew
 * (`GentPlatform.build`, `0.1.0+<id>`), wherever it is installed: an archive
 * or a package keeps the mtimes it was packed with, so a file's dates name no
 * build. A source run names it by the checkout's git hash. A build neither
 * names is `"unknown"`. `resolveServer` reads it once, so the lock entry and
 * the identity endpoint name one build.
 */
export const buildFingerprint: Effect.Effect<string, never, BuildFingerprintServices> = Effect.gen(
  function* () {
    const path = yield* Path.Path
    const platform = yield* GentPlatform

    const build = yield* platform.build
    if (build._tag === "Compiled") return `${build.version}+${build.id}`

    const here = yield* path.fromFileUrl(new URL(import.meta.url)).pipe(Effect.option)
    if (Option.isNone(here)) return UNKNOWN_BUILD
    const gentRoot = path.resolve(here.value, "../../../..")
    const result = yield* runProcess("git", ["rev-parse", "--short", "HEAD"], {
      cwd: gentRoot,
      stdout: "pipe",
      stderr: "pipe",
    }).pipe(
      Effect.map((r) => {
        if (r.exitCode === 0) {
          return r.stdout.trim()
        }
        return ""
      }),
      Effect.catchTag("ProcessError", () => Effect.succeed("")),
    )
    if (result.length > 0) return `src-${result}`

    return UNKNOWN_BUILD
  },
)

// ── server-lock ─────────────────────────────────────────────────────────────

/**
 * Single shared server per database.
 *
 * Two files sit beside `data.db`. `server.lock.db` is the kernel lock: the
 * owning server holds an exclusive SQLite lock on it for its whole life, and
 * the OS drops that lock when the process exits. A server is alive exactly
 * when that lock cannot be taken, so a crash, a reboot, or a reused pid never
 * leaves a lock that looks alive, and two starts cannot both own the database.
 *
 * `server.lock` is the discovery record the owner writes once it listens: url,
 * pid for `gent server stop`, and the identity a client confirms through the
 * server's identity endpoint before it attaches.
 */

export class ServerLockEntry extends Schema.Class<ServerLockEntry>("ServerLockEntry")({
  serverId: Schema.String,
  pid: Schema.Finite,
  hostname: Schema.String,
  rpcUrl: Schema.String,
  dbPath: Schema.String,
  buildFingerprint: Schema.String,
  startedAt: Schema.Finite,
}) {}

const ServerLockEntryJson = Schema.fromJsonString(ServerLockEntry)

/**
 * The lock sits in the data directory `dataPaths` resolves, beside the
 * database it guards, so each `GENT_DATA_DIR` has its own server. Only a
 * write creates the directory: a read of a missing one finds no server.
 */
const writableLockPaths = (home: string): Effect.Effect<DataPaths, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* dataPaths(home)
    yield* fs.makeDirectory(paths.dataDir, { recursive: true }).pipe(Effect.ignore)
    return paths
  })

/** SQLite reports a lock another connection holds as `SQLITE_BUSY`. */
const isSqliteBusy = Schema.is(Schema.Struct({ code: Schema.Literal("SQLITE_BUSY") }))

const kernelLockError = (path: string, reason: string) =>
  new GentConnectionError({ message: `server lock ${path} failed: ${reason}` })

/**
 * Take the kernel lock without waiting. `None` means another connection holds
 * it — in another process, or in this one. The caller owns the returned
 * connection and releases the lock by closing it.
 */
const tryKernelLock = (path: string): Effect.Effect<Option.Option<Database>, GentConnectionError> =>
  Effect.gen(function* () {
    const db = yield* Effect.try({
      try: () => new Database(path, { create: true }),
      catch: (error) => kernelLockError(path, String(error)),
    })
    const taken = yield* Effect.try({
      try: () => {
        db.exec("PRAGMA busy_timeout = 0")
        db.exec("BEGIN EXCLUSIVE")
      },
      // A busy lock is an answer, not a failure: `None` carries it out of the catch.
      catch: (error) => {
        if (isSqliteBusy(error)) return Option.none<GentConnectionError>()
        return Option.some(kernelLockError(path, String(error)))
      },
    }).pipe(
      Effect.as(true),
      Effect.catch(
        Option.match({
          onNone: () => Effect.succeed(false),
          onSome: (error) => Effect.fail(error),
        }),
      ),
      Effect.onError(() => releaseKernelLock(db)),
    )
    if (!taken) {
      yield* releaseKernelLock(db)
      return Option.none()
    }
    return Option.some(db)
  })

/** Closing the connection rolls the transaction back and drops the lock. */
const releaseKernelLock = (db: Database): Effect.Effect<void> =>
  Effect.sync(() => {
    db.close()
  })

/**
 * Take the kernel lock for the life of the current scope. False when another
 * connection holds it. The scope's close releases it; a process exit releases
 * it too, which is what makes the lock proof of life.
 */
const holdKernelLock = (
  home: string,
): Effect.Effect<boolean, GentConnectionError, Scope.Scope | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const path = (yield* writableLockPaths(home)).serverKernelLock
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const lock = yield* tryKernelLock(path)
        if (Option.isNone(lock)) return false
        yield* Effect.addFinalizer(() => releaseKernelLock(lock.value))
        return true
      }),
    )
  })

/**
 * Remove the entry on disk, whatever server it names. Only the holder of the
 * kernel lock calls it: under the lock, the entry is the holder's own or one
 * a server that is gone left. A removal that fails leaves the entry, and the
 * next holder removes it.
 */
const removeEntry = (home: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const entry = (yield* dataPaths(home)).serverLock
    yield* fs.remove(entry).pipe(Effect.ignore)
  })

/**
 * Own the database for the life of the current scope: take the kernel lock,
 * then remove the entry on disk. Holding the lock proves no server runs on
 * the database, so the entry names a server that is gone; removed at once, it
 * is never probed by a start that waits on this owner. False when another
 * connection holds the lock, and the entry is left to its holder.
 */
const holdServerLock = (
  home: string,
): Effect.Effect<boolean, GentConnectionError, Scope.Scope | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (!(yield* holdKernelLock(home))) return false
    yield* removeEntry(home)
    return true
  })

/**
 * True while some connection holds the kernel lock. The probe releases what it
 * takes. A holder creates the lock file before it locks it, so no file means
 * no holder, and the probe creates nothing.
 */
const kernelLockHeld = (
  home: string,
): Effect.Effect<boolean, GentConnectionError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = (yield* dataPaths(home)).serverKernelLock
    if (!(yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false)))) return false
    return yield* Effect.acquireUseRelease(
      tryKernelLock(path),
      (lock) => Effect.succeed(Option.isNone(lock)),
      (lock) => Option.match(lock, { onNone: () => Effect.void, onSome: releaseKernelLock }),
    )
  })

/** What the two lock files say about the server on this database. */
export const ServerLockStatus = Schema.Union([
  /** The kernel lock is free and no entry names a server. */
  Schema.TaggedStruct("None", {}),
  /** A process holds the kernel lock, and the entry names it. */
  Schema.TaggedStruct("Alive", { entry: ServerLockEntry }),
  /** A process holds the kernel lock but no entry names it yet: a server still starting. */
  Schema.TaggedStruct("Unnamed", {}),
  /** The kernel lock is free, so the server the entry names is gone, whatever its pid is now. */
  Schema.TaggedStruct("Stale", { entry: ServerLockEntry }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ServerLockStatus = Schema.Schema.Type<typeof ServerLockStatus>

/** What `serverLock.stop` did. */
const ServerStopResult = Schema.Union([
  Schema.TaggedStruct("None", {}),
  /** A process holds the kernel lock but names no pid to signal. */
  Schema.TaggedStruct("Unnamed", {}),
  /**
   * The server is gone and its entry stays: the caller did not ask to remove
   * it, or a new owner took the kernel lock first and the entry is its own.
   */
  Schema.TaggedStruct("NotRunning", { entry: ServerLockEntry }),
  /** The server is gone; its entry is removed. */
  Schema.TaggedStruct("Removed", { entry: ServerLockEntry }),
  /** The server is alive but its identity endpoint does not confirm the entry, so no signal. */
  Schema.TaggedStruct("NotOwned", { entry: ServerLockEntry }),
  /**
   * SIGTERM sent and the server released the kernel lock. Its entry is
   * removed, unless a new owner took the lock first.
   */
  Schema.TaggedStruct("Stopped", { entry: ServerLockEntry }),
  /** SIGTERM sent, but the server still held the kernel lock when the wait ended. */
  Schema.TaggedStruct("StillRunning", { entry: ServerLockEntry }),
]).pipe(Schema.toTaggedUnion("_tag"))
type ServerStopResult = Schema.Schema.Type<typeof ServerStopResult>

/** An entry written by another host is invisible here, so every entry read is local. */
const readLock = (
  home: string,
): Effect.Effect<Option.Option<ServerLockEntry>, never, FileSystem.FileSystem | GentPlatform> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = (yield* dataPaths(home)).serverLock
    const osInfo = yield* (yield* GentPlatform).osInfo
    const content = yield* fs.readFileString(path).pipe(Effect.option)
    return Option.flatMap(content, Schema.decodeOption(ServerLockEntryJson)).pipe(
      Option.filter((entry) => entry.hostname === osInfo.hostname),
    )
  })

/**
 * Name the server in its entry. A failed write fails the start: a server
 * that holds the kernel lock with no entry leaves every client waiting for
 * a name that never comes.
 */
const writeLock = (
  home: string,
  entry: ServerLockEntry,
): Effect.Effect<void, GentConnectionError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = (yield* writableLockPaths(home)).serverLock
    const json = yield* Schema.encodeEffect(ServerLockEntryJson)(entry).pipe(Effect.orDie)
    yield* fs.writeFileString(path, json).pipe(
      Effect.mapError(
        (error) =>
          new GentConnectionError({
            message: `cannot write the server lock entry ${path}: ${error.message}`,
          }),
      ),
    )
  })

/**
 * Remove an entry proved stale: take the server lock for the removal and let
 * it go. The kernel lock is held through the removal, so no new owner can
 * write its entry in between. False when the lock cannot be taken: a new
 * owner holds it, and the entry is its own.
 */
const removeStaleEntry = (
  home: string,
): Effect.Effect<boolean, GentConnectionError, FileSystem.FileSystem> =>
  Effect.scoped(holdServerLock(home))

const lockStatus = (
  home: string,
): Effect.Effect<ServerLockStatus, GentConnectionError, FileSystem.FileSystem | GentPlatform> =>
  Effect.gen(function* () {
    const entry = yield* readLock(home)
    const held = yield* kernelLockHeld(home)
    if (Option.isNone(entry)) {
      if (held) return ServerLockStatus.cases.Unnamed.make({})
      return ServerLockStatus.cases.None.make({})
    }
    if (held) return ServerLockStatus.cases.Alive.make({ entry: entry.value })
    return ServerLockStatus.cases.Stale.make({ entry: entry.value })
  })

/** `stop` polls a signalled server this many times, 100 ms apart, before it gives up. */
const STOP_WAIT_ATTEMPTS = 20

/** Gone means the kernel lock is free and the entry's endpoint no longer answers. */
const serverGone = (
  home: string,
  entry: ServerLockEntry,
): Effect.Effect<boolean, GentConnectionError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (yield* kernelLockHeld(home)) return false
    return !(yield* probeServerLockEntryIdentity(entry))
  })

const goneWithin = (
  home: string,
  entry: ServerLockEntry,
): Effect.Effect<boolean, GentConnectionError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < STOP_WAIT_ATTEMPTS; attempt++) {
      if (yield* serverGone(home, entry)) return true
      yield* Effect.sleep("100 millis")
    }
    return yield* serverGone(home, entry)
  })

/**
 * Stop the server the entry names. SIGTERM goes out only after the identity
 * endpoint confirms every field of the entry, so a reused pid is never signalled.
 * An entry whose kernel lock is free is stale, and `removeStale` removes it.
 */
const stopLocked = (
  home: string,
  options?: { readonly removeStale?: boolean },
): Effect.Effect<ServerStopResult, GentConnectionError, FileSystem.FileSystem | GentPlatform> =>
  Effect.gen(function* () {
    const status = yield* lockStatus(home)
    if (status._tag === "None") return ServerStopResult.cases.None.make({})
    if (status._tag === "Unnamed") return ServerStopResult.cases.Unnamed.make({})
    const { entry } = status
    if (status._tag === "Stale") {
      if (options?.removeStale !== true) return ServerStopResult.cases.NotRunning.make({ entry })
      if (!(yield* removeStaleEntry(home))) {
        return ServerStopResult.cases.NotRunning.make({ entry })
      }
      return ServerStopResult.cases.Removed.make({ entry })
    }
    if (!(yield* probeServerLockEntryIdentity(entry))) {
      return ServerStopResult.cases.NotOwned.make({ entry })
    }
    const platform = yield* GentPlatform
    yield* platform.signal(entry.pid, "SIGTERM").pipe(Effect.ignore)
    if (!(yield* goneWithin(home, entry)))
      return ServerStopResult.cases.StillRunning.make({ entry })
    yield* removeStaleEntry(home)
    return ServerStopResult.cases.Stopped.make({ entry })
  })

/**
 * The discovery-entry verbs `Gent.server` runs on its own lock. The server
 * root and the SDK tests read it; the public surface does not export it.
 */
export const serverLockFile = {
  read: readLock,
  write: writeLock,
  remove: removeEntry,
}

/**
 * What runs against the database's lock: status, probe and stop for the server
 * that holds it, and `hold`, the ownership a server start takes for its life
 * and `storage reset` takes while it moves the database away.
 */
export const serverLock = {
  status: lockStatus,
  probe: (entry: ServerLockEntry) => probeServerLockEntryIdentity(entry),
  stop: stopLocked,
  hold: holdServerLock,
}

// ── server handle ───────────────────────────────────────────────────────────

/**
 * What `Gent.server` takes and returns. Two server topologies:
 * - owned: in-process handler context + HTTP listener (primary client gets direct RPC)
 * - attached: the server that holds the data directory's lock (client connects via WS)
 */

const StateSpec = Schema.Union([
  Schema.TaggedStruct("Sqlite", {
    /** The fallback root for the data directory when `GENT_DATA_DIR` is unset. */
    home: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("Memory", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type StateSpec = Schema.Schema.Type<typeof StateSpec>

const ProviderSpec = Schema.Union([
  Schema.TaggedStruct("Live", {}),
  Schema.TaggedStruct("Mock", {
    /** Finish every step having produced nothing — drives the unanswered turn. */
    empty: Schema.optional(Schema.Boolean),
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ProviderSpec = Schema.Schema.Type<typeof ProviderSpec>

/** What a startup `seed` reads and writes: the server's storage and its platform. */
type ServerSeedServices = SessionStorage | BranchStorage | MessageStorage | GentPlatform

export interface GentServerOptions {
  readonly cwd: string
  /** Extension declarations for this server. Defaults to the builtins. */
  readonly extensions?: ReadonlyArray<GentExtension>
  /**
   * The branch-tool feature these extensions run on -- storage plus the
   * per-branch kernel. A server naming its own `extensions` names this too;
   * a tool surface whose feature is missing fails on first use.
   */
  readonly branchTools?: BranchToolFeature<never>
  readonly state?: StateSpec
  readonly provider?: ProviderSpec
  readonly authDirectory?: string
  /**
   * Runs once against a new owned server's storage, in the server's
   * workspace, before `Gent.server` returns. The seed handles its own
   * failures. The TUI's `--debug` seeds its sample session here.
   */
  readonly seed?: Effect.Effect<void, never, ServerSeedServices>
  /**
   * Bind this TCP port on 127.0.0.1 instead of an ephemeral one. A SQLite server still
   * takes the database lock and writes its entry, so other clients find it;
   * a fixed port only means it never attaches to another server.
   */
  readonly port?: number
  /** Login shell for extension process launches. */
  readonly shell?: string
}

/** Public opaque server handle. */
export const GentServer = Schema.Union([
  Schema.TaggedStruct("Owned", {
    url: Schema.String,
    workspaceId: Schema.String,
  }),
  Schema.TaggedStruct("Attached", {
    url: Schema.String,
    workspaceId: Schema.String,
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type GentServer = Schema.Schema.Type<typeof GentServer>

/**
 * The RPC handlers of each server this process built, keyed by its handle's
 * identity, so the handle stays opaque. The server root writes an entry when
 * it builds a server; `Gent.client` reads it to serve the owned server in
 * process, without loading the server root again.
 */
export const ownedHandlers = new WeakMap<
  GentServer,
  Context.Context<Layer.Success<typeof RpcHandlersLive>>
>()

export const state = {
  sqlite: (options?: { readonly home?: string }): StateSpec =>
    StateSpec.cases.Sqlite.make(options ?? {}),
  memory: (): StateSpec => StateSpec.cases.Memory.make({}),
}

export const provider = {
  live: (): ProviderSpec => ProviderSpec.cases.Live.make({}),
  mock: (options?: { readonly empty?: boolean }): ProviderSpec =>
    ProviderSpec.cases.Mock.make(options ?? {}),
}

/** Built once per `resolveServer`; the owned server's root and listener share it. */
const LocalPlatformLayer = BunPlatformLive
export type LocalPlatform = Layer.Success<typeof LocalPlatformLayer>

/** The data directory's fallback root: a SQLite spec's own `home`, else the user's. */
export const resolveHome = (stateSpec: StateSpec, homeDirectory: string): string =>
  Match.value(stateSpec).pipe(
    Match.tagsExhaustive({
      Memory: () => Option.none<string>(),
      Sqlite: (sqliteSpec) => Option.fromNullishOr(sqliteSpec.home),
    }),
    Option.getOrElse(() => homeDirectory),
  )

// ── server root load ────────────────────────────────────────────────────────

/** What `resolveServer` calls on the server root (`server.ts`). */
interface ServerRoot {
  readonly buildOwnedServer: typeof buildOwnedServer
  readonly startOwnedServer: typeof startOwnedServer
}

/**
 * The server root, loaded only when this process builds a server: it imports
 * the shipped extensions and the HTTP listener, which a launch that attaches
 * never evaluates. Each run imports again: the module registry keeps a module
 * that loaded, and nothing here keeps a failed or interrupted load.
 */
const loadServerRoot: Effect.Effect<ServerRoot, GentConnectionError> = Effect.tryPromise({
  // oxlint-disable-next-line effect/noDynamicImports -- the server stack loads when this process builds a server, not at launch
  try: (): Promise<ServerRoot> => import("./server.js"),
  catch: (error) =>
    new GentConnectionError({ message: `server root failed to load: ${String(error)}` }),
})

// ── Probe an existing server via identity endpoint ──

/**
 * Ask the lock's `/_gent/identity` endpoint who it is, and confirm every field.
 * Server id, db and build prove the endpoint; pid and host prove signal
 * ownership, so a pid reused after a crash is never attached to or signalled.
 */
const IDENTITY_PROBE_TIMEOUT = "3 seconds"

const probeServerLockEntryIdentity = (entry: ServerLockEntry): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const baseUrl = entry.rpcUrl.replace("/rpc", "")
    const response = yield* http.get(`${baseUrl}/_gent/identity`)
    if (response.status >= 400) return false
    const identity = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        serverId: Schema.String,
        pid: Schema.Finite,
        hostname: Schema.String,
        dbPath: Schema.String,
        buildFingerprint: Schema.String,
      }),
    )(yield* response.json)
    return (
      identity.serverId === entry.serverId &&
      identity.pid === entry.pid &&
      identity.hostname === entry.hostname &&
      identity.dbPath === entry.dbPath &&
      identity.buildFingerprint === entry.buildFingerprint
    )
  }).pipe(
    // One bound over the request and the body: a server can send headers and stall its body.
    Effect.timeout(IDENTITY_PROBE_TIMEOUT),
    // @effect-diagnostics-next-line strictEffectProvide:off -- self-contained probe, no scope lifetime
    Effect.provide(FetchHttpClient.layer),
    Effect.catchEager(() => Effect.succeed(false)),
  )

// ── Main server resolver ──

/** A new start polls a lock holder this many times, 100 ms apart, for it to name itself. */
const HOLDER_WAIT_ATTEMPTS = 300

/**
 * Why a live holder blocks a new server. A holder of another build, or of a
 * build either side cannot name, is never signalled from here: it may be a TUI
 * that is open, with a turn in flight.
 */
const holderBlocksMessage = (
  holder: ServerLockEntry,
  ownBuild: string,
  ownDbPath: string,
): string => {
  const held = `PID ${holder.pid} holds ${holder.dbPath}`
  if (!sameBuild(holder.buildFingerprint, ownBuild)) {
    return `${held} with gent build ${holder.buildFingerprint}, and this is build ${ownBuild}; close that gent first, or run \`gent server stop\`, then retry`
  }
  return `${held} under the lock for ${ownDbPath}; stop it with \`gent server stop\`, then retry`
}

export const resolveServer = (
  options: GentServerOptions,
): Effect.Effect<GentServer, GentConnectionError, Scope.Scope> =>
  // @effect-diagnostics-next-line strictEffectProvide:off -- the public entry point provides the local platform it resolves on.
  Effect.provide(resolveServerInternal(options), LocalPlatformLayer)

const resolveServerInternal = (
  options: GentServerOptions,
): Effect.Effect<GentServer, GentConnectionError, Scope.Scope | LocalPlatform> =>
  Effect.gen(function* () {
    const stateSpec = options.state ?? state.sqlite()
    const providerSpec = options.provider ?? provider.live()
    // Read once: the lock entry and the identity endpoint name one build.
    const fingerprint = yield* buildFingerprint

    // Memory state has nothing to share: owned outright, no lock.
    if (stateSpec._tag === "Memory") {
      const root = yield* loadServerRoot
      return (yield* root.buildOwnedServer(options, stateSpec, providerSpec, fingerprint)).server
    }

    // SQLite state: one server per database, decided by the kernel lock. A
    // fixed port changes only the attach decision: the caller asked to serve
    // on that port, so it owns the database or fails; it never attaches.
    const mayAttach = Predicate.isNullish(options.port)
    const platform = yield* GentPlatform
    const home = resolveHome(stateSpec, yield* platform.homeDirectory)
    const paths = yield* dataPaths(home)
    const dbPath = paths.dbPath

    // An entry that failed the identity probe once. The holder removed any
    // older entry when it took the lock and writes its own only after it
    // listens, so a second failure on the same entry is final.
    let unanswered = Option.none<string>()
    const attachOrBlock = (holder: ServerLockEntry) => {
      if (!mayAttach) {
        return Effect.fail(
          new GentConnectionError({
            message: `PID ${holder.pid} holds ${holder.dbPath}; a server on a fixed port does not attach to it. Stop it with \`gent server stop\`, then retry`,
          }),
        )
      }
      if (sameBuild(holder.buildFingerprint, fingerprint) && holder.dbPath === dbPath) {
        return Effect.succeed(
          GentServer.cases.Attached.make({
            url: holder.rpcUrl,
            workspaceId: workspaceIdForCwd(options.cwd),
          }),
        )
      }
      return Effect.fail(
        new GentConnectionError({ message: holderBlocksMessage(holder, fingerprint, dbPath) }),
      )
    }
    const scope = yield* Effect.scope
    for (let attempt = 0; attempt < HOLDER_WAIT_ATTEMPTS; attempt++) {
      // The lock is taken in a child scope, so a start that does not own can let it go.
      const lockScope = yield* Scope.fork(scope)
      if (yield* serverLock.hold(home).pipe(Scope.provide(lockScope))) {
        const root = yield* loadServerRoot
        return yield* root.startOwnedServer(
          options,
          stateSpec,
          providerSpec,
          home,
          dbPath,
          fingerprint,
        )
      }
      yield* Scope.close(lockScope, Exit.void)
      const entry = yield* serverLockFile.read(home)
      if (Option.isSome(entry)) {
        const holder = entry.value
        if (yield* probeServerLockEntryIdentity(holder)) return yield* attachOrBlock(holder)
        if (Option.contains(unanswered, holder.serverId)) {
          return yield* new GentConnectionError({
            message: `PID ${holder.pid} holds ${paths.serverKernelLock} but does not answer as a gent server at ${holder.rpcUrl}; stop it, then retry`,
          })
        }
        unanswered = Option.some(holder.serverId)
      }
      yield* Effect.sleep("100 millis")
    }
    return yield* new GentConnectionError({
      message: `a process holds ${paths.serverKernelLock} but never named itself in ${paths.serverLock}; stop it, then retry`,
    })
  })
