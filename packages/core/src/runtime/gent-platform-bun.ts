/**
 * `BunGentPlatformLive` — Bun-runtime implementation of `GentPlatform`. It is the
 * one owner of `Bun.randomUUIDv7()`. The `effect/noGlobals` project bans in
 * `.oxlintrc.json` keep other `Bun.*` calls inside this file, the adapters,
 * tooling, the e2e harness and tests; a deliberate exception elsewhere carries
 * a line-local suppression with its reason.
 *
 * It is also the sole sanctioned home for raw `process.*` access (pid,
 * execPath, kill, exit) and Node `os` info — every other source file routes
 * through `GentPlatform` so the runtime stays portable.
 *
 * Every method here is a thin Effect wrapper over the underlying Bun/Node
 * API. Surrounding runtime code yields `GentPlatform` and stays portable.
 */

// oxlint-disable-next-line effect/noNodeBuiltinImport -- the platform adapter resolves its own executable once, before any Effect runs
import { realpathSync } from "node:fs"
import * as os from "node:os"
// oxlint-disable-next-line effect/noNodeBuiltinImport -- the platform adapter reads Bun's build record, whose paths are relative to the process's directory
import * as path from "node:path"
import { Database } from "bun:sqlite"
import {
  Duration,
  Effect,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  type PlatformError,
  Predicate,
  Result,
  Schedule,
  Schema,
  Scope,
} from "effect"
import { SqlClient } from "effect/sql"
import { causeMessage } from "../domain/guards.js"
import { storageError, type StorageError } from "../domain/errors.js"
import * as EffectPlatformBun from "@effect/platform-bun"
import { BunHttpServer, BunServices } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { AuthError, ProviderLock } from "./provider.js"
import { FetchHttpClient } from "effect/http"
import {
  GentBuild,
  GentPlatform,
  ImageCodecError,
  type ImageTranscode,
  type ModuleBundle,
  ModuleBundleError,
  type RuntimeModuleSource,
  SERVED_MODULE_QUERY,
  SignalError,
} from "./gent-platform.js"

/**
 * The compiled build defines this symbol as `{ id, version }`
 * (`apps/tui/scripts/build.ts`); a source run leaves it undeclared. The
 * builtin extensions read its `id` too, as their artifact identity
 * (`packages/extensions/src/index.ts`).
 */
declare const __GENT_BUILD__: unknown

/** An undeclared symbol throws a ReferenceError: a source run. */
const thisBuild: GentBuild = Result.try(() => __GENT_BUILD__).pipe(
  Result.getSuccess,
  Option.flatMap(
    Schema.decodeUnknownOption(
      Schema.Struct({ id: Schema.NonEmptyString, version: Schema.NonEmptyString }),
    ),
  ),
  Option.match({
    onNone: () => GentBuild.cases.Source.make({}),
    onSome: (fields) => GentBuild.cases.Compiled.make(fields),
  }),
)

/**
 * The real path of the running executable, resolved once as the process
 * starts. An install links `gent` into a version directory and later switches
 * the link to another version; the compiled host starts its `gent-cell` from
 * beside this path, so a running gent keeps its own version's worker however
 * the link moves. A path that does not resolve stays as the runtime gave it.
 */
const executablePath: string = Result.try(() => realpathSync(process.execPath)).pipe(
  Result.getOrElse(() => process.execPath),
)

/** The specifiers bound in this process. Bun keeps a plugin for the process lifetime. */
const boundModules = new Set<string>()

/**
 * `GentPlatform.bindModules` on Bun: a runtime plugin serves each specifier
 * as a virtual module. A Bun host that loads files outside a `GentPlatform`
 * context, the TUI's client extension loader, calls it directly.
 */
export const bindBunModules = Effect.fn("GentPlatform.bindModules")(function* (
  modules: ReadonlyMap<string, RuntimeModuleSource>,
) {
  const added = [...modules].filter(([specifier]) => !boundModules.has(specifier))
  if (added.length === 0) return
  yield* Effect.sync(() => {
    for (const [specifier] of added) boundModules.add(specifier)
    Bun.plugin({
      name: "gent-bound-modules",
      setup: (build) => {
        for (const [specifier, source] of added) {
          build.module(specifier, () =>
            // oxlint-disable-next-line effect/noNewPromise -- Bun reads a virtual module from a promise callback.
            Promise.resolve(source()).then((exports): Bun.OnLoadResultObject => ({
              exports: { ...exports },
              loader: "object",
            })),
          )
        }
      },
    })
  })
})

/** One build log line: where, then what. */
const buildLogLine = (log: BuildMessage | ResolveMessage): string =>
  Option.match(Option.fromNullishOr(log.position), {
    onNone: () => log.message,
    onSome: (position) => `${position.file}:${position.line}:${position.column}: ${log.message}`,
  })

/**
 * `GentPlatform.bundleModule` on Bun: `Bun.build` with every package import
 * external. The build's own record (`metafile`) names the files it read,
 * relative to the process's directory.
 */
const bundleBunModule = (entry: string): Effect.Effect<ModuleBundle, ModuleBundleError> =>
  Effect.tryPromise({
    try: () =>
      Bun.build({
        entrypoints: [entry],
        target: "bun",
        format: "esm",
        packages: "external",
        metafile: true,
        // The output names each input relative to this root in a comment, so
        // the same files build the same text whatever the process's directory.
        root: path.dirname(entry),
        throw: false,
      }),
    catch: (cause) => new ModuleBundleError({ entry, message: causeMessage(cause) }),
  }).pipe(
    Effect.flatMap((result) => {
      const output = Option.fromNullishOr(result.outputs[0])
      if (!result.success || Option.isNone(output)) {
        const message = result.logs.map(buildLogLine).join("\n") || "the build produced no module"
        return Effect.fail(new ModuleBundleError({ entry, message }))
      }
      const recorded = Option.match(Option.fromNullishOr(result.metafile), {
        onNone: () => [],
        onSome: (metafile) => Object.keys(metafile.inputs),
      })
      const inputs = recorded.map((input) => path.resolve(process.cwd(), input))
      return Effect.tryPromise({
        try: () => output.value.text(),
        catch: (cause) => new ModuleBundleError({ entry, message: causeMessage(cause) }),
      }).pipe(Effect.map((code): ModuleBundle => ({ code, inputs })))
    }),
  )

/**
 * The code each served specifier imports as (`serveModule`). Bun keeps a
 * module for the process lifetime, so its code stays here as long.
 */
const servedModules = new Map<string, string>()

/**
 * `GentPlatform.serveModule` on Bun: one runtime plugin, registered with the
 * first served module, answers each load of a path with the served query from
 * the map. The file's directory stays the importer's, so its package imports
 * resolve as the file's own would.
 */
const serveBunModule = (specifier: string, code: string): Effect.Effect<void> =>
  Effect.sync(() => {
    const first = servedModules.size === 0
    servedModules.set(specifier, code)
    if (!first) return
    Bun.plugin({
      name: "gent-served-modules",
      setup: (build) => {
        build.onLoad({ filter: new RegExp(`\\?${SERVED_MODULE_QUERY}=`) }, (args) => ({
          contents: Option.getOrElse(Option.fromNullishOr(servedModules.get(args.path)), () => ""),
          loader: "js",
        }))
      },
    })
  })

/** A codec failure as the platform's reason, read from its `Bun.Image.ErrorCode`. */
const imageCodecReason = (cause: unknown): ImageCodecError["reason"] => {
  if (!Predicate.hasProperty(cause, "code")) return "failed"
  return Match.value(cause.code).pipe(
    Match.when("ERR_IMAGE_UNKNOWN_FORMAT", () => "not-an-image" as const),
    Match.when("ERR_IMAGE_DECODE_FAILED", () => "undecodable" as const),
    Match.when("ERR_IMAGE_TOO_MANY_PIXELS", () => "too-large" as const),
    Match.orElse(() => "failed" as const),
  )
}

const imageCodecError = (cause: unknown) =>
  new ImageCodecError({ reason: imageCodecReason(cause), message: causeMessage(cause) })

/**
 * `GentPlatform.transcodeImage` on Bun: `Bun.Image`, Bun's own codec
 * (libspng, libjpeg-turbo, libwebp, a built-in GIF decoder), so the compiled
 * binary carries it with no file beside it. It resizes with Lanczos3 and
 * applies a JPEG's EXIF orientation first; `metadata` names the oriented size.
 */
const transcodeBunImage = (bytes: Uint8Array, options: ImageTranscode) =>
  Effect.tryPromise({
    try: () => new Bun.Image(bytes).metadata(),
    catch: imageCodecError,
  }).pipe(
    Effect.flatMap((source) => {
      const fitted = new Bun.Image(bytes).resize(options.maxSide, options.maxSide, {
        fit: "inside",
        withoutEnlargement: true,
        filter: "lanczos3",
      })
      const quality = Option.match(Option.fromUndefinedOr(options.quality), {
        onNone: () => ({}),
        onSome: (value) => ({ quality: value }),
      })
      const encoder = {
        png: () => fitted.png(),
        jpeg: () => fitted.jpeg(quality),
        webp: () => fitted.webp(quality),
      }[options.format]()
      return Effect.tryPromise({
        try: () => encoder.bytes(),
        catch: imageCodecError,
      }).pipe(
        Effect.map((encoded) => ({
          bytes: encoded,
          width: encoder.width,
          height: encoder.height,
          sourceWidth: source.width,
          sourceHeight: source.height,
        })),
      )
    }),
  )

export const BunGentPlatformLive: Layer.Layer<GentPlatform> = Layer.succeed(
  GentPlatform,
  GentPlatform.of({
    bindModules: bindBunModules,

    bundleModule: bundleBunModule,

    serveModule: serveBunModule,

    // oxlint-disable-next-line effect/noGlobals -- GentPlatform.randomId is the one owner of Bun's UUIDv7
    randomId: Effect.sync(() => Bun.randomUUIDv7()),

    osInfo: Effect.sync(() => ({
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      hostname: os.hostname(),
      type: os.type(),
    })),

    pid: Effect.sync(() => process.pid),

    execPath: Effect.succeed(executablePath),

    build: Effect.succeed(thisBuild),

    homeDirectory: Effect.sync(() => os.homedir()),

    signal: (pid, signal) =>
      Effect.try({
        try: () => {
          process.kill(pid, signal)
        },
        catch: (cause) => new SignalError({ pid, signal, reason: causeMessage(cause) }),
      }),

    hash: (algorithm, input) => new Bun.CryptoHasher(algorithm).update(input).digest("hex"),

    transcodeImage: transcodeBunImage,

    loopbackServer: (port) => BunHttpServer.layerServer({ port, hostname: "127.0.0.1" }),
  }),
)

/**
 * The modules the Bun host binds beside the shipped set
 * (`BuiltinExtensionModules`): a user extension that imports
 * `@effect/platform-bun` gets the instances this process runs. No shipped
 * extension imports it: they reach the host through `GentPlatform`.
 */
export const BunHostModules: ReadonlyMap<string, RuntimeModuleSource> = new Map([
  ["@effect/platform-bun", () => EffectPlatformBun],
])

// ── provider lock ───────────────────────────────────────────────────────────

/** SQLite reports a lock another connection holds as `SQLITE_BUSY`. */
const isSqliteBusy = Schema.is(Schema.Struct({ code: Schema.Literal("SQLITE_BUSY") }))

/** Another connection holds the provider's lock file; try again shortly. */
class AuthLockBusy extends Schema.TaggedError<AuthLockBusy>()("AuthLockBusy", {}) {}

/** A writer polls a busy lock this often, this many times (about 30 seconds). */
const AUTH_LOCK_POLL = Duration.millis(20)
const AUTH_LOCK_POLLS = 1500

/**
 * An exclusive SQLite transaction on one lock file per provider. The OS drops
 * the lock when its process exits, so a crash never leaves a held lock (the
 * same kind of lock the server kernel uses). Taking it never blocks the event
 * loop: a busy file is polled.
 */
const fileProviderLock =
  (lockDirectory: string, provider: string, pathService: Path.Path, fs: FileSystem.FileSystem) =>
  <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | AuthError> => {
    const file = pathService.join(lockDirectory, `${encodeURIComponent(provider)}.lock.db`)
    const lockError = (cause: unknown) =>
      new AuthError({ message: `Failed to take the auth lock for "${provider}"`, cause })
    const open = Effect.try({
      try: () => new Database(file, { create: true }),
      catch: lockError,
    })
    const take = (db: Database) =>
      Effect.try({
        try: () => {
          db.exec("PRAGMA busy_timeout = 0")
          db.exec("BEGIN EXCLUSIVE")
        },
        catch: (cause) => {
          if (isSqliteBusy(cause)) return new AuthLockBusy()
          return lockError(cause)
        },
      })
    const close = (db: Database) =>
      Effect.sync(() => {
        db.close()
      })
    // One open-and-take attempt is the uninterruptible acquire; the poll
    // between attempts is not, so a cancel ends the wait at once. Only a
    // held lock outlives an interrupt, and its release always runs.
    const attempt = Effect.acquireRelease(
      fs.makeDirectory(lockDirectory, { recursive: true }).pipe(
        Effect.mapError(lockError),
        Effect.andThen(open),
        Effect.flatMap((db) =>
          take(db).pipe(
            Effect.onError(() => close(db)),
            Effect.as(db),
          ),
        ),
      ),
      close,
    )
    const held = attempt.pipe(
      Effect.retry({
        while: (error) => error._tag === "AuthLockBusy",
        schedule: Schedule.spaced(AUTH_LOCK_POLL),
        times: AUTH_LOCK_POLLS,
      }),
      Effect.catchTag("AuthLockBusy", () =>
        Effect.fail(
          new AuthError({ message: `Timed out waiting for the auth lock for "${provider}"` }),
        ),
      ),
    )
    // The held lock lives in a private scope, so `effect` never runs inside
    // it: a scope of the caller's stays the caller's, whatever `effect` needs.
    return Effect.acquireUseRelease(
      Scope.make(),
      (lockScope) => held.pipe(Scope.provide(lockScope), Effect.andThen(effect)),
      (lockScope, exit) => Scope.close(lockScope, exit),
    )
  }

/**
 * `ProviderLock` on Bun: the lock file of each provider sits in `.locks`
 * inside the store. No provider id starts with a dot, so the directory never
 * reads as a credential, and it goes with the store. Every gent process on
 * the machine that opens the store takes the same file.
 */
export const BunProviderLockLive: Layer.Layer<
  ProviderLock,
  never,
  FileSystem.FileSystem | Path.Path
> = Layer.effect(
  ProviderLock,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    return ProviderLock.of({
      exclusive: (directory, provider) =>
        fileProviderLock(pathService.join(directory, ".locks"), provider, pathService, fs),
    })
  }),
)

// ── sqlite client ───────────────────────────────────────────────────────────

/**
 * The PRAGMAs of a connection gent opens itself. They configure the
 * connection, not the schema, so they belong to the client layer that opens
 * it: a hosted client's platform owns its durability and refuses them.
 */
const configureLocalConnection: Layer.Layer<never, StorageError, SqlClient.SqlClient> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`PRAGMA journal_mode = WAL`)
      yield* sql.unsafe(`PRAGMA synchronous = NORMAL`)
      yield* sql.unsafe(`PRAGMA busy_timeout = 5000`)
      yield* sql.unsafe(`PRAGMA wal_autocheckpoint = 1000`)
      yield* sql.unsafe(`PRAGMA foreign_keys = ON`)
    }).pipe(Effect.mapError(storageError("Storage pragma initialization failed"))),
  )

/** A Bun SQLite connection gent opens and configures: a file, or `:memory:`. */
const localSqliteClient = (filename: string): Layer.Layer<SqlClient.SqlClient, StorageError> =>
  configureLocalConnection.pipe(Layer.provideMerge(Layer.orDie(SqliteClient.layer({ filename }))))

/**
 * The SQLite clients the Bun host opens for a root's state
 * (`SqliteStorage.WithSql`, `createDependencies`): one connection, its
 * transactions opened with BEGIN IMMEDIATE, and the PRAGMAs above.
 */
export const BunSqlite = {
  /** The database file at `dbPath`; its directory is made first. */
  file: (
    dbPath: string,
  ): Layer.Layer<
    SqlClient.SqlClient,
    StorageError | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > =>
    localSqliteClient(dbPath).pipe(
      Layer.provideMerge(
        Layer.effectDiscard(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const pathService = yield* Path.Path
            yield* fs.makeDirectory(pathService.dirname(dbPath), { recursive: true })
          }),
        ),
      ),
    ),
  /** A database that lives as long as the layer. */
  memory: localSqliteClient(":memory:"),
}

// ── platform stack ──────────────────────────────────────────────────────────

/**
 * The complete Bun-runtime platform stack: `@effect/platform-bun`
 * (FileSystem, Path, ChildProcessSpawner, …) and the fetch `HttpClient`,
 * bundled with the gent-owned `BunGentPlatformLive` and the provider lock
 * file. Production wiring and test harnesses both yield this single Layer so
 * they can't drift on which BunService stack they pull in.
 *
 * Note: this is an output-context bundle (`Layer.merge`), not a dependency
 * wiring — each member either has no requirements or is given its own.
 */
export const BunPlatformLive = Layer.mergeAll(
  BunServices.layer,
  // Fresh: `FetchHttpClient.layer` captures the `Fetch` of the context it is
  // built in, and a shared build would hand this one to a model client built
  // later over its own `Fetch`.
  Layer.fresh(FetchHttpClient.layer),
  BunGentPlatformLive,
  BunProviderLockLive.pipe(Layer.provide(BunServices.layer)),
)
