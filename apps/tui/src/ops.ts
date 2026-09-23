import { Database } from "bun:sqlite"
import { Config, Console, DateTime, Effect, FileSystem, Match, Option, Schema } from "effect"
import {
  classifyLogFile,
  dataPaths,
  type ExtensionHealthIssue,
  type ExtensionHealthSnapshot,
  Gent,
  LOG_DIR,
  serverLock,
  type ServerLockStatus,
} from "@gent/sdk"
import type { GentPlatform } from "@gent/core-internal/runtime/gent-platform.js"
import { Command, Flag } from "effect/unstable/cli"

// ── local health report ─────────────────────────────────────────────────────

const STORAGE_TABLES = [
  "sessions",
  "branches",
  "messages",
  "events",
] satisfies ReadonlyArray<string>

interface StorageHealth {
  readonly dbPath: string
  readonly exists: boolean
  readonly sizeBytes: number
  readonly migrationTable: "missing" | "present"
  readonly migrationCount: number
  readonly existingStorageTables: ReadonlyArray<string>
  readonly status: "missing" | "ok" | "incompatible" | "unreadable"
  readonly error?: string
}

interface ServerHealth {
  readonly status: "none" | "alive" | "dead"
  readonly summary: string
}

interface LogHealth {
  readonly dir: string
  readonly latestServer?: string
  readonly latestClient?: string
}

interface ExtensionDoctorHealth {
  readonly status: "unavailable" | "healthy" | "degraded" | "error"
  readonly summary: string
  readonly snapshot?: ExtensionHealthSnapshot
  readonly error?: string
}

interface DoctorReport {
  readonly home: string
  readonly storage: StorageHealth
  readonly server: ServerHealth
  readonly logs: LogHealth
  readonly extensions: ExtensionDoctorHealth
}

interface StorageResetResult {
  readonly archiveDir?: string
  readonly archived: ReadonlyArray<string>
}

type SqliteHealth = Omit<StorageHealth, "dbPath" | "exists" | "sizeBytes">

const readSqliteHealth = (dbPath: string): Effect.Effect<SqliteHealth> =>
  Effect.acquireUseRelease(
    Effect.try(() => new Database(dbPath, { readonly: true })),
    (db) =>
      Effect.try((): SqliteHealth => {
        const tables = db
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name)
        let migrationTable: StorageHealth["migrationTable"] = "missing"
        if (tables.includes("gent_storage_migrations")) migrationTable = "present"
        let migrationCount = 0
        if (migrationTable === "present") {
          migrationCount = Option.fromNullishOr(
            db
              .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM gent_storage_migrations")
              .get(),
          ).pipe(
            Option.map((row) => row.count),
            Option.getOrElse(() => 0),
          )
        }
        const existingStorageTables = STORAGE_TABLES.filter((table) => tables.includes(table))
        const incompatible = existingStorageTables.length > 0 && migrationCount === 0
        let status: StorageHealth["status"] = "ok"
        if (incompatible) status = "incompatible"
        return {
          migrationTable,
          migrationCount,
          existingStorageTables,
          status,
        }
      }),
    (db) => Effect.sync(() => db.close()),
  ).pipe(
    Effect.catchEager((error) =>
      Effect.succeed({
        migrationTable: "missing",
        migrationCount: 0,
        existingStorageTables: [],
        status: "unreadable",
        error: String(error),
      } satisfies SqliteHealth),
    ),
  )

export const inspectStorage = (
  home: string,
): Effect.Effect<StorageHealth, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { dbPath } = yield* dataPaths(home)
    const exists = yield* fs.exists(dbPath).pipe(Effect.orElseSucceed(() => false))
    if (!exists) {
      return {
        dbPath,
        exists: false,
        sizeBytes: 0,
        migrationTable: "missing",
        migrationCount: 0,
        existingStorageTables: [],
        status: "missing",
      }
    }

    const stat = yield* fs.stat(dbPath).pipe(Effect.orDie)
    return {
      dbPath,
      exists: true,
      sizeBytes: Number(stat.size),
      ...(yield* readSqliteHealth(dbPath)),
    }
  })

/**
 * Read a log directory. `dir` defaults to the one a live gent writes to; tests
 * pass a directory they own, so they never read or remove real logs.
 */
export const inspectLogs = (
  dir: string = LOG_DIR,
): Effect.Effect<LogHealth, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))
    if (!exists) return { dir }

    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))
    const entries = yield* Effect.forEach(names, (name) =>
      Effect.gen(function* () {
        const path = `${dir}/${name}`
        const stat = yield* fs.stat(path).pipe(Effect.option)
        let mtimeMs = 0
        if (stat._tag === "Some" && stat.value.mtime._tag === "Some") {
          mtimeMs = stat.value.mtime.value.getTime()
        }
        return { path, name, mtimeMs }
      }),
    )
    const sorted = entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
    // The SDK writes these names, so it also says which side wrote one.
    const latest = (side: "server" | "client") =>
      Option.getOrUndefined(
        Option.map(
          Option.fromUndefinedOr(
            sorted.find((entry) => Option.contains(classifyLogFile(entry.name), side)),
          ),
          (entry) => entry.path,
        ),
      )

    return {
      dir,
      latestServer: latest("server"),
      latestClient: latest("client"),
    }
  })

/** The doctor's server line, from the SDK's reading of the lock. */
export const inspectServer = (status: ServerLockStatus): ServerHealth => {
  if (status._tag === "None") return { status: "none", summary: "No shared server." }
  const { pid, serverId, rpcUrl } = status.entry
  if (status._tag === "Alive") {
    return { status: "alive", summary: `Shared server alive: pid ${pid}, ${serverId}, ${rpcUrl}` }
  }
  return { status: "dead", summary: `Shared server lock is stale: pid ${pid}, ${serverId}` }
}

const extensionHealthUnavailable = (summary: string): ExtensionDoctorHealth => ({
  status: "unavailable",
  summary,
})

const extensionHealthError = (error: string): ExtensionDoctorHealth => ({
  status: "error",
  summary: "Extension health query failed.",
  error,
})

export const extensionHealthFromSnapshot = (
  snapshot: ExtensionHealthSnapshot,
): ExtensionDoctorHealth => {
  if (snapshot._tag === "Healthy") {
    let suffix = "s"
    if (snapshot.extensions.length === 1) suffix = ""
    return {
      status: "healthy",
      summary: `healthy (${snapshot.extensions.length} active extension${suffix})`,
      snapshot,
    }
  }

  return {
    status: "degraded",
    summary: `degraded (${snapshot.degradedExtensions.length} degraded, ${snapshot.healthyExtensions.length} healthy)`,
    snapshot,
  }
}

export const makeDoctorReport = (
  home: string,
  serverStatus: ServerLockStatus,
  extensions?: ExtensionDoctorHealth,
): Effect.Effect<DoctorReport, never, FileSystem.FileSystem | GentPlatform> =>
  Effect.gen(function* () {
    const server = inspectServer(serverStatus)
    const defaultExtensions = () => {
      let summary = "No live shared server."
      if (server.status === "alive") summary = "Extension health was not queried."
      return extensionHealthUnavailable(summary)
    }
    const storage = yield* inspectStorage(home)
    return {
      home,
      storage,
      server,
      logs: yield* inspectLogs(),
      extensions: Option.getOrElse(Option.fromNullishOr(extensions), defaultExtensions),
    }
  })

const stamp = () =>
  DateTime.formatIso(DateTime.nowUnsafe())
    .replace(/[-:T.]/g, "")
    .slice(0, 14)

const basename = (path: string): string =>
  Option.getOrElse(Option.fromNullishOr(path.split("/").filter(Boolean).at(-1)), () => path)

export const resetStorage = (
  home: string,
): Effect.Effect<StorageResetResult, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* dataPaths(home)
    const existing = []
    for (const file of paths.files) {
      if (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))) {
        existing.push(file)
      }
    }
    if (existing.length === 0) return { archived: [] }

    const archiveDir = `${paths.archiveDir}/${stamp()}`
    yield* fs.makeDirectory(archiveDir, { recursive: true }).pipe(Effect.orDie)
    const archived: string[] = []
    for (const file of existing) {
      const target = `${archiveDir}/${basename(file)}`
      yield* fs.rename(file, target).pipe(Effect.orDie)
      archived.push(target)
    }
    return { archiveDir, archived }
  })

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const formatIssue = (issue: ExtensionHealthIssue): string =>
  Match.value(issue).pipe(
    Match.tagsExhaustive({
      ActivationFailed: (issue) => `activation failed during ${issue.phase}: ${issue.error}`,
    }),
  )

const formatExtensions = (extensions: ExtensionDoctorHealth): ReadonlyArray<string> => {
  const lines = [`  Status: ${extensions.summary}`]
  const error = Option.fromNullishOr(extensions.error)
  if (Option.isSome(error)) lines.push(`  Error: ${error.value}`)
  const snapshot = Option.fromNullishOr(extensions.snapshot)
  if (Option.isNone(snapshot) || snapshot.value._tag !== "Degraded") return lines

  for (const extension of snapshot.value.degradedExtensions) {
    lines.push(`  ${extension.manifest.id}:`)
    for (const issue of extension.issues) {
      lines.push(`    - ${formatIssue(issue)}`)
    }
  }

  return lines
}

export const formatDoctorReport = (report: DoctorReport): string => {
  const storage = report.storage
  let storageLine = `missing (${storage.dbPath})`
  if (storage.status !== "missing") {
    storageLine = `${storage.status} (${storage.dbPath}, ${formatBytes(storage.sizeBytes)}, migrations: ${storage.migrationCount})`
  }
  let tableLine = "none"
  if (storage.existingStorageTables.length > 0) {
    tableLine = storage.existingStorageTables.join(", ")
  }

  const lines = [
    "Gent doctor",
    "",
    `Home: ${report.home}`,
    "",
    "Storage:",
    `  DB: ${storageLine}`,
    `  Migration table: ${storage.migrationTable}`,
    `  Existing storage tables: ${tableLine}`,
  ]
  const error = Option.fromNullishOr(storage.error)
  if (Option.isSome(error)) lines.push(`  Error: ${error.value}`)
  lines.push(
    "",
    "Server:",
    `  ${report.server.summary}`,
    "",
    "Extensions:",
    ...formatExtensions(report.extensions),
    "",
    "Logs:",
    `  Directory: ${report.logs.dir}`,
    `  Latest server: ${Option.getOrElse(Option.fromNullishOr(report.logs.latestServer), () => "none")}`,
    `  Latest client: ${Option.getOrElse(Option.fromNullishOr(report.logs.latestClient), () => "none")}`,
  )
  return lines.join("\n")
}

// ── admin subcommands ───────────────────────────────────────────────────────

/**
 * The admin subcommands: `sessions`, `server status`, `server stop`, `doctor`
 * and `storage reset`.
 *
 * They share no state with the interactive TUI — each one opens what it needs,
 * prints, and returns — so they live beside the health readers they call rather
 * than in the entry point that renders the app.
 */

export class CliStartupError extends Schema.TaggedError<CliStartupError>()("CliStartupError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/** Where the server lock and the storage live. `/tmp` when the shell has no HOME. */
export const readHome = Effect.map(
  Config.option(Config.string("HOME")),
  Option.getOrElse(() => "/tmp"),
)

/**
 * The one way a command reaches a running gent.
 *
 * `connect` attaches to a server someone else started. Otherwise this starts
 * one in-process, which is what every caller wants when no url is given: the
 * bundle owns its own server for the life of the call.
 */
export const resolveClientBundle = (options: {
  readonly cwd: string
  readonly connect: Option.Option<string>
  /** Keep state in memory instead of the shared SQLite file. */
  readonly inMemory: boolean
  readonly debug: boolean
  /** Serve scripted responses instead of a real provider; `empty` serves none. */
  readonly mock: Option.Option<{ readonly empty: boolean }>
  readonly authDirectory: Option.Option<string>
}) => {
  if (Option.isSome(options.connect)) return Gent.client(options.connect.value)
  let state = Gent.state.sqlite()
  if (options.inMemory) state = Gent.state.memory()
  let provider = Gent.provider.live()
  if (Option.isSome(options.mock)) provider = Gent.provider.mock(options.mock.value)
  const base = { cwd: options.cwd, state, provider, debug: options.debug }
  const configured = Option.match(options.authDirectory, {
    onNone: () => base,
    onSome: (authDirectory) => ({ ...base, authDirectory }),
  })
  return Effect.flatMap(Gent.server(configured), Gent.client)
}

export const sessions = Command.make(
  "sessions",
  {
    connect: Flag.string("connect").pipe(
      Flag.withDescription("Connect to an existing gent server"),
      Flag.optional,
    ),
    isolate: Flag.boolean("isolate").pipe(
      Flag.withDescription("Run with an in-process server (no shared server, no registry)"),
      Flag.withDefault(false),
    ),
  },
  ({ connect, isolate }) =>
    Effect.gen(function* () {
      const bundle = yield* resolveClientBundle({
        cwd: process.cwd(),
        connect,
        inMemory: isolate,
        debug: false,
        mock: Option.none(),
        authDirectory: Option.none(),
      })
      yield* bundle.runtime.lifecycle.waitForReady
      const allSessions = yield* bundle.client.session.list()

      if (allSessions.length === 0) {
        yield* Console.log("No sessions found.")
        return
      }

      yield* Console.log("Sessions:")
      for (const s of allSessions) {
        const date = DateTime.make(s.updatedAt).pipe(
          Option.match({
            onNone: () => "unknown",
            onSome: DateTime.formatIso,
          }),
        )
        const name = Option.getOrElse(Option.fromNullishOr(s.name), () => "Unnamed")
        yield* Console.log(`  ${s.id} - ${name} (${date})`)
      }
    }),
)

const serverStatus = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const status = yield* serverLock.status(yield* readHome)
    if (status._tag === "None") {
      yield* Console.log("No shared server.")
      return
    }

    yield* Console.log("Shared server:\n")
    yield* Console.log(
      `${"PID".padEnd(8)} ${"STATUS".padEnd(10)} ${"SERVER ID".padEnd(40)} ${"DB PATH".padEnd(40)} ${"URL"}`,
    )
    yield* Console.log("─".repeat(120))

    let label = "alive"
    if (status._tag === "Stale") label = "dead"
    const { entry } = status
    yield* Console.log(
      `${String(entry.pid).padEnd(8)} ${label.padEnd(10)} ${entry.serverId.padEnd(40)} ${entry.dbPath.padEnd(40)} ${entry.rpcUrl}`,
    )
  }),
)

const serverStop = Command.make(
  "stop",
  {
    all: Flag.boolean("all").pipe(
      Flag.withDescription("Also remove the lock of a server that is no longer running"),
      Flag.withDefault(false),
    ),
  },
  ({ all }) =>
    Effect.gen(function* () {
      const result = yield* serverLock.stop(yield* readHome, { removeStale: all })
      const line = Match.value(result).pipe(
        Match.tagsExhaustive({
          None: () => "No shared server.",
          NotRunning: () => "No live shared server to stop on this host.",
          Removed: ({ entry }) =>
            `Shared server ${entry.serverId} (PID ${entry.pid}) was not running; removed its lock.`,
          NotOwned: ({ entry }) =>
            `Skipped PID ${entry.pid} (${entry.serverId}): identity probe failed`,
          Stopped: ({ entry }) =>
            `Sent SIGTERM to PID ${entry.pid} (${entry.serverId})\n\nShared server stopped and cleaned up.`,
          StillRunning: ({ entry }) =>
            `Sent SIGTERM to PID ${entry.pid} (${entry.serverId})\n\nShared server is still running after SIGTERM.`,
        }),
      )
      yield* Console.log(line)
    }),
)

export const server = Command.make("server", {}, () =>
  Console.log("Usage: gent server <status|stop>"),
).pipe(Command.withSubcommands([serverStatus, serverStop]))

const readDoctorExtensionHealth = (
  status: ServerLockStatus,
): Effect.Effect<ExtensionDoctorHealth> => {
  if (status._tag === "None") return Effect.succeed(extensionHealthUnavailable("No shared server."))
  if (status._tag === "Stale") {
    return Effect.succeed(extensionHealthUnavailable("Shared server lock is stale."))
  }
  return Effect.scoped(
    Effect.gen(function* () {
      const bundle = yield* Gent.client(status.entry.rpcUrl, { cwd: process.cwd() })
      yield* bundle.runtime.lifecycle.waitForReady
      const snapshot = yield* bundle.client.extension.listStatus({})
      return extensionHealthFromSnapshot(snapshot)
    }),
  ).pipe(Effect.catch((error) => Effect.succeed(extensionHealthError(String(error)))))
}

export const doctor = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const home = yield* readHome
    const status = yield* serverLock.status(home)
    const extensions = yield* readDoctorExtensionHealth(status)
    const report = yield* makeDoctorReport(home, status, extensions)
    yield* Console.log(formatDoctorReport(report))
  }),
)

const storageReset = Command.make("reset", {}, () =>
  Effect.gen(function* () {
    const home = yield* readHome
    if ((yield* serverLock.status(home))._tag === "Alive") {
      yield* Console.error(
        "Error: shared server is running. Stop it with `gent server stop` first.",
      )
      return yield* new CliStartupError({
        message: "shared server is running; refusing to reset storage",
      })
    }

    const result = yield* resetStorage(home)
    if (result.archived.length === 0) {
      yield* Console.log("No storage files found.")
      return
    }

    yield* Console.log(`Archived storage files to ${result.archiveDir}`)
    for (const file of result.archived) {
      yield* Console.log(`  ${file}`)
    }
  }),
)

export const storage = Command.make("storage", {}, () =>
  Console.log("Usage: gent storage <reset>"),
).pipe(Command.withSubcommands([storageReset]))
