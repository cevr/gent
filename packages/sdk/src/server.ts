import {
  Clock,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  Predicate,
  Schema,
  Scope,
} from "effect"
import { join as pathJoin, resolve as pathResolve } from "node:path"
import { Database } from "bun:sqlite"
import type { ChildProcessSpawner } from "effect/process"
import { dateFromMillis, GentConnectionError } from "@gent/core/protocol"
import {
  GentPlatform,
  type BranchStorage,
  type MessageStorage,
  type SessionStorage,
  RpcHandlersLive,
  provideWorkspaceIdHeader,
  workspaceHeadersForCwd,
  workspaceIdForCwd,
  buildServerRoutes,
  createDependencies,
  BunPlatformLive,
  ModelResolver,
  resolveDataDir,
  ScriptedLanguageModel,
  StateLocation,
} from "@gent/core/host"
import { runProcess, type GentExtension } from "@gent/core/extensions/api"
import { BunHttpServer } from "@effect/platform-bun"
import { FetchHttpClient, Headers, HttpClient, HttpRouter, HttpServer } from "effect/http"
import {
  BuiltinExtensionModules,
  BuiltinExtensions,
  CellBranchTools,
  isCompiledBuild,
} from "@gent/extensions"
import type { BranchToolFeature } from "@gent/core/extensions/branch-tools"
import type { LanguageModel } from "effect/ai"
import { GentLogLevel, GentObservability } from "./logger.js"

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

type BuildFingerprintServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | GentPlatform

/**
 * Compute a build fingerprint from local sources (no env). A compiled gent,
 * as `compiled` reports it, names its build by the binary's mtime, wherever
 * the binary is installed; a source run by the checkout's git hash. A build
 * neither names is `"unknown"`. `resolveServer` reads it once, so the lock
 * entry and the identity endpoint name one build.
 */
export const buildFingerprint = (
  compiled: Effect.Effect<boolean>,
): Effect.Effect<string, never, BuildFingerprintServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const platform = yield* GentPlatform

    if (yield* compiled) {
      const info = yield* fs.stat(yield* platform.execPath).pipe(Effect.option)
      if (Option.isNone(info)) return UNKNOWN_BUILD
      const mtime = Option.getOrElse(info.value.mtime, () => dateFromMillis(0))
      return `bin-${mtime.getTime().toString(36)}`
    }

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
  })

/** This process's fingerprint: compiled-ness is the build's own define (`isCompiledBuild`). */
export const ownBuildFingerprint: Effect.Effect<string, never, BuildFingerprintServices> =
  buildFingerprint(isCompiledBuild)

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
    const lock = yield* tryKernelLock(path)
    if (Option.isNone(lock)) return true
    yield* releaseKernelLock(lock.value)
    return false
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

/** Removes the entry only while it still names `serverId`. */
const removeLock = (
  home: string,
  serverId: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem | GentPlatform> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const current = yield* readLock(home)
    if (Option.isNone(current) || current.value.serverId !== serverId) return false
    const path = (yield* dataPaths(home)).serverLock
    return yield* fs.remove(path).pipe(
      Effect.as(true),
      Effect.catchEager(() => Effect.succeed(false)),
    )
  })

/**
 * Remove an entry proved stale. The kernel lock is held from the read through
 * the removal, so no new owner can write its entry in between. A lock that
 * cannot be taken means a new owner holds it: its entry is not ours to remove.
 */
const removeStaleEntry = (
  home: string,
  serverId: string,
): Effect.Effect<boolean, GentConnectionError, FileSystem.FileSystem | GentPlatform> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (!(yield* holdKernelLock(home))) return false
      return yield* removeLock(home, serverId)
    }),
  )

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
      if (!(yield* removeStaleEntry(home, entry.serverId))) {
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
    yield* removeStaleEntry(home, entry.serverId)
    return ServerStopResult.cases.Stopped.make({ entry })
  })

/**
 * The lock verbs `Gent.server` runs on its own lock: the discovery entry and
 * the kernel lock. The SDK tests import it by relative path; the public
 * surface does not export it.
 */
export const serverLockFile = {
  read: readLock,
  write: writeLock,
  remove: removeLock,
  hold: holdKernelLock,
}

/** What a client runs against the server that holds the lock: status, probe, and stop. */
export const serverLock = {
  status: lockStatus,
  probe: (entry: ServerLockEntry) => probeServerLockEntryIdentity(entry),
  stop: stopLocked,
}

// ── server ──────────────────────────────────────────────────────────────────

/**
 * Gent server primitive — resolves or starts a server, always has a URL.
 *
 * Two server topologies:
 * - owned: in-process handler context + HTTP listener (primary client gets direct RPC)
 * - attached: the server that holds the data directory's lock (client connects via WS)
 */

// ── Types ──

type BuiltRpcHandlers = Layer.Success<typeof RpcHandlersLive>

const StateSpec = Schema.Union([
  Schema.TaggedStruct("Sqlite", {
    /** The fallback root for the data directory when `GENT_DATA_DIR` is unset. */
    home: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("Memory", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
type StateSpec = Schema.Schema.Type<typeof StateSpec>

const ProviderSpec = Schema.Union([
  Schema.TaggedStruct("Live", {}),
  Schema.TaggedStruct("Mock", {
    /** Finish every step having produced nothing — drives the unanswered turn. */
    empty: Schema.optional(Schema.Boolean),
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
type ProviderSpec = Schema.Schema.Type<typeof ProviderSpec>

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
   * Bind this TCP port instead of an ephemeral one. A SQLite server still
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

// ── Internal state for owned servers ──

interface OwnedServerInternal {
  readonly handlerContext: Context.Context<BuiltRpcHandlers>
  readonly serverId: string
}

/** WeakMap keyed by GentServer object identity — keeps handler context private */
const ownedInternals = new WeakMap<GentServer, OwnedServerInternal>()

/** @internal — used by Gent.client to access owned server handler context */
export const getOwnedInternal = (server: GentServer): Option.Option<OwnedServerInternal> =>
  Option.fromNullishOr(ownedInternals.get(server))

// ── Factories ──

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

// ── Language model layer from spec ──

/** Build a self-contained language model layer from spec. For "live", returns undefined
 *  (let createDependencies build its own from auth deps). */
const resolveLanguageModelLayer = (
  spec: ProviderSpec,
): Option.Option<Layer.Layer<LanguageModel.LanguageModel, never, never>> =>
  Match.value(spec).pipe(
    Match.tagsExhaustive({
      Live: () => Option.none(),
      Mock: (mockSpec) => {
        if (mockSpec.empty === true) return Option.some(ScriptedLanguageModel.empty)
        return Option.some(ScriptedLanguageModel.debug())
      },
    }),
  )

// ── Platform layers ──

/** Built once per `resolveServer`; the owned server's root and listener share it. */
const LocalPlatformLayer = BunPlatformLive
type LocalPlatform = Layer.Success<typeof LocalPlatformLayer>

// ── Helpers ──

const resolveHome = (stateSpec: StateSpec, homeDirectory: string): string =>
  Match.value(stateSpec).pipe(
    Match.tagsExhaustive({
      Memory: () => Option.none<string>(),
      Sqlite: (sqliteSpec) => Option.fromNullishOr(sqliteSpec.home),
    }),
    Option.getOrElse(() => homeDirectory),
  )

// ── Build owned server (in-process + HTTP listener) ──

const buildOwnedServer = (
  options: GentServerOptions,
  stateSpec: StateSpec,
  providerSpec: ProviderSpec,
  fingerprint: string,
): Effect.Effect<GentServer, GentConnectionError, Scope.Scope | LocalPlatform> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const platform = yield* GentPlatform
    const osInfo = yield* platform.osInfo
    const pid = yield* platform.pid
    const homeDirectory = yield* platform.homeDirectory
    const requestedPort = Option.getOrElse(Option.fromNullishOr(options.port), () => 0)
    const httpServerCtx = yield* Layer.buildWithScope(
      BunHttpServer.layer({ port: requestedPort, idleTimeout: 0 }),
      scope,
    ).pipe(
      Effect.mapError(
        (error) => new GentConnectionError({ message: `server listener failed: ${String(error)}` }),
      ),
    )
    const httpServer = Context.get(httpServerCtx, HttpServer.HttpServer)
    const port = Match.value(httpServer.address).pipe(
      Match.tag("InetAddressV4", "InetAddressV6", (address) => address.port),
      Match.orElse(() => 0),
    )
    if (port === 0) {
      return yield* new GentConnectionError({
        message: "server listener did not bind a concrete TCP port",
      })
    }
    const url = `http://127.0.0.1:${port}/rpc`
    const workspaceHeaders = workspaceHeadersForCwd(options.cwd)
    const home = resolveHome(stateSpec, homeDirectory)
    const serverId = yield* platform.randomId

    const languageModelLayer = resolveLanguageModelLayer(providerSpec)
    // The database sits in the data directory beside the server lock and the
    // logs, where `gent doctor` and `gent storage reset` look.
    const paths = yield* dataPaths(home)
    const dbPath = Match.value(stateSpec).pipe(
      Match.tagsExhaustive({
        Memory: () => Option.none<string>(),
        Sqlite: () => Option.some(paths.dbPath),
      }),
    )
    const logLevel = yield* GentLogLevel.pipe(
      Effect.mapError(
        (error) => new GentConnectionError({ message: `invalid GENT_LOG_LEVEL: ${error.message}` }),
      ),
    )
    // A user extension imports the same effect modules the shipped ones do.
    yield* platform.bindModules(BuiltinExtensionModules)
    const observability = GentObservability(options.cwd, logLevel, paths.logDir)
    const coreServices = yield* Layer.buildWithScope(
      createDependencies({
        cwd: options.cwd,
        // One broken user extension is reported, not fatal: the rest of the profile runs.
        failOnExtensionFailure: false,
        home,
        platform: osInfo.platform,
        osVersion: osInfo.release,
        shell: options.shell,
        authDirectory: options.authDirectory,
        state: Option.match(dbPath, {
          onNone: () => StateLocation.cases.Memory.make({}),
          onSome: (path) => StateLocation.cases.Disk.make({ dbPath: path }),
        }),
        extensions: options.extensions ?? BuiltinExtensions,
        branchTools: options.branchTools ?? CellBranchTools,
        modelResolverOverride: Option.getOrUndefined(
          Option.map(languageModelLayer, ModelResolver.fromLanguageModel),
        ),
      }).pipe(Layer.provide(observability)),
      scope,
    ).pipe(
      Effect.mapError(
        (error) => new GentConnectionError({ message: `server root failed: ${String(error)}` }),
      ),
    )
    const coreServicesLive = Layer.succeedContext(coreServices)
    const rpcHandlersContext = yield* Layer.buildWithScope(
      Layer.provide(RpcHandlersLive, coreServicesLive),
      scope,
    )
    const httpRoutes = buildServerRoutes(coreServicesLive, {
      identity: {
        serverId,
        pid,
        hostname: osInfo.hostname,
        dbPath: Option.getOrElse(dbPath, () => ":memory:"),
        buildFingerprint: fingerprint,
      },
    })

    const HttpServerLive = HttpRouter.serve(httpRoutes).pipe(
      Layer.provide(Layer.succeedContext(httpServerCtx)),
      Layer.provide(coreServicesLive),
    )

    yield* Layer.buildWithScope(HttpServerLive, scope).pipe(Effect.orDie)

    if (Predicate.isNotUndefined(options.seed)) {
      yield* options.seed.pipe(
        provideWorkspaceIdHeader(Headers.fromInput(workspaceHeaders)),
        // The SDK builds these headers from `cwd`; a rejected header is a bug.
        Effect.orDie,
        Effect.provideContext(coreServices),
      )
    }

    const server: GentServer = GentServer.cases.Owned.make({
      url,
      workspaceId: workspaceIdForCwd(options.cwd),
    })
    ownedInternals.set(server, {
      handlerContext: rpcHandlersContext,
      serverId,
    })

    return server
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
    const fingerprint = yield* ownBuildFingerprint

    // Memory state has nothing to share: owned outright, no lock.
    if (stateSpec._tag === "Memory") {
      return yield* buildOwnedServer(options, stateSpec, providerSpec, fingerprint)
    }

    // SQLite state: one server per database, decided by the kernel lock. A
    // fixed port changes only the attach decision: the caller asked to serve
    // on that port, so it owns the database or fails; it never attaches.
    const mayAttach = Predicate.isNullish(options.port)
    const platform = yield* GentPlatform
    const home = resolveHome(stateSpec, yield* platform.homeDirectory)
    const paths = yield* dataPaths(home)
    const dbPath = paths.dbPath

    // An entry that failed the identity probe once. The owner writes its entry
    // only after it listens, so a second failure on the same entry is final.
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
      if (yield* serverLockFile.hold(home).pipe(Scope.provide(lockScope))) {
        return yield* startOwnedServer(options, stateSpec, providerSpec, home, dbPath, fingerprint)
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

/**
 * Start the server that owns the database. The caller holds the kernel lock in
 * this scope, so an entry on disk names a server that is gone.
 */
const startOwnedServer = (
  options: GentServerOptions,
  stateSpec: StateSpec,
  providerSpec: ProviderSpec,
  home: string,
  dbPath: string,
  fingerprint: string,
): Effect.Effect<GentServer, GentConnectionError, Scope.Scope | LocalPlatform> =>
  Effect.gen(function* () {
    const stale = yield* serverLockFile.read(home)
    if (Option.isSome(stale)) yield* serverLockFile.remove(home, stale.value.serverId)

    const platform = yield* GentPlatform
    const osInfo = yield* platform.osInfo
    const pid = yield* platform.pid
    const server = yield* buildOwnedServer(options, stateSpec, providerSpec, fingerprint)
    const internal = yield* Effect.fromOption(getOwnedInternal(server)).pipe(
      Effect.mapError(
        () => new GentConnectionError({ message: "owned server internal state missing" }),
      ),
    )
    yield* serverLockFile.write(
      home,
      new ServerLockEntry({
        serverId: internal.serverId,
        pid,
        hostname: osInfo.hostname,
        rpcUrl: server.url,
        dbPath,
        buildFingerprint: fingerprint,
        startedAt: yield* Clock.currentTimeMillis,
      }),
    )
    // The entry goes before the kernel lock is released: finalizers run in reverse.
    yield* Effect.addFinalizer(() =>
      serverLockFile.remove(home, internal.serverId).pipe(Effect.ignore),
    )
    return server
  })
