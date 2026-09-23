import { type ExtensionHealthIssue, type ExtensionHealthSnapshot } from "@gent/core/protocol"
import { Database } from "bun:sqlite"
import {
  Cause,
  Config,
  Console,
  DateTime,
  Effect,
  FileSystem,
  Match,
  Option,
  Predicate,
  Runtime,
  Schema,
  Stdio,
  Stream,
} from "effect"
import {
  classifyLogFile,
  dataPaths,
  Gent,
  resolveLogDir,
  serverLock,
  type ServerLockEntry,
  type ServerLockStatus,
} from "@gent/sdk"
import type { GentPlatform } from "@gent/core/host"
import { Command, Flag } from "effect/unstable/cli"
import * as Terminal from "effect/Terminal"

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
 * Read a log directory. The doctor passes the one this environment writes to
 * (`resolveLogDir`); tests pass a directory they own, so they never read or
 * remove real logs.
 */
export const inspectLogs = (dir: string): Effect.Effect<LogHealth, never, FileSystem.FileSystem> =>
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

/** The doctor's server line: the one server a data directory has, read from its kernel lock. */
export const inspectServer = (status: ServerLockStatus): ServerHealth => {
  if (status._tag === "None")
    return { status: "none", summary: "No server for this data directory." }
  if (status._tag === "Unnamed") {
    return {
      status: "alive",
      summary: "A process holds the server lock but has not named itself yet (still starting?)",
    }
  }
  const { pid, serverId, rpcUrl } = status.entry
  if (status._tag === "Alive") {
    return { status: "alive", summary: `Server alive: pid ${pid}, ${serverId}, ${rpcUrl}` }
  }
  return { status: "dead", summary: `Server lock is stale: pid ${pid}, ${serverId}` }
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
      let summary = "No live server for this data directory."
      if (server.status === "alive") summary = "Extension health was not queried."
      return extensionHealthUnavailable(summary)
    }
    const storage = yield* inspectStorage(home)
    return {
      home,
      storage,
      server,
      logs: yield* inspectLogs(yield* resolveLogDir),
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
      ModelCatalogFailed: (issue) =>
        `model driver ${issue.driverId} could not list its models: ${issue.error}`,
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

/**
 * A failure that ends the CLI (a startup error such as an unknown agent) is
 * reported on stderr, one line per error: `NotFoundError: Unknown agent: x`.
 * Stdout carries only the session's output, so a caller that pipes it reads
 * the reply and nothing else. A defect is a bug, so it keeps its stack.
 */
export const reportFailureOnStderr = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.tapCause(effect, (cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.void
    if (!Runtime.getErrorReported(Cause.squash(cause))) return Effect.void
    return Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio
      yield* Stream.make(`${failureText(cause)}\n`).pipe(Stream.run(stdio.stderr()))
    })
  })

const failureText = <E>(cause: Cause.Cause<E>): string => {
  if (Cause.hasDies(cause)) return Cause.pretty(cause)
  return Cause.prettyErrors(cause)
    .map((error) => `${error.name}: ${error.message}`)
    .join("\n")
}

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
      Flag.withDescription("Run with an in-process server (no data-directory server, no registry)"),
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

/**
 * Lay out a table: each column is as wide as its widest cell, one space apart,
 * so a long value (a scratch `GENT_DATA_DIR` database path) never pushes the
 * columns after it out from under their headers. The rule spans the table.
 */
const formatTable = (
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string => {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  )
  const line = (cells: ReadonlyArray<string>) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join(" ")
      .trimEnd()
  const width = widths.reduce((sum, w) => sum + w, 0) + widths.length - 1
  return [line(headers), "─".repeat(width), ...rows.map(line)].join("\n")
}

/**
 * The `server status` report: a table (header, rule, the one server's row)
 * when it fits in `columns`, else one `Field: value` line per field, so a long
 * database path never wraps the table apart. Output with no terminal width
 * (a pipe) keeps the table.
 */
export const formatServerStatus = (
  label: string,
  entry: ServerLockEntry,
  columns: number,
): string => {
  const fields: ReadonlyArray<readonly [string, string, string]> = [
    ["PID", "PID", String(entry.pid)],
    ["STATUS", "Status", label],
    ["SERVER ID", "Server ID", entry.serverId],
    ["DB PATH", "DB path", entry.dbPath],
    ["URL", "URL", entry.rpcUrl],
  ]
  const table = formatTable(
    fields.map(([header]) => header),
    [fields.map(([, , value]) => value)],
  )
  const width = Math.max(...table.split("\n").map((line) => line.length))
  if (width <= columns) return table
  const labelWidth = Math.max(...fields.map(([, name]) => name.length)) + 1
  return fields.map(([, name, value]) => `${`${name}:`.padEnd(labelWidth)} ${value}`).join("\n")
}

const serverStatus = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const status = yield* serverLock.status(yield* readHome)
    if (status._tag === "None") {
      yield* Console.log("No server for this data directory.")
      return
    }
    if (status._tag === "Unnamed") {
      yield* Console.log("A process holds the server lock but has not named itself yet.")
      return
    }

    yield* Console.log("Server for this data directory:\n")
    let label = "alive"
    if (status._tag === "Stale") label = "dead"
    // Off a terminal (a pipe) the width is 0: keep the table.
    let columns = yield* (yield* Terminal.Terminal).columns
    if (columns === 0) columns = Number.POSITIVE_INFINITY
    yield* Console.log(formatServerStatus(label, status.entry, columns))
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
          None: () => "No server for this data directory.",
          Unnamed: () =>
            "A process holds the server lock but names no PID to signal; nothing was stopped.",
          NotRunning: () => "No live server for this data directory on this host.",
          Removed: ({ entry }) =>
            `Server ${entry.serverId} (PID ${entry.pid}) was not running; removed its lock entry.`,
          NotOwned: ({ entry }) =>
            `Skipped PID ${entry.pid} (${entry.serverId}): identity probe failed`,
          Stopped: ({ entry }) =>
            `Sent SIGTERM to PID ${entry.pid} (${entry.serverId})\n\nServer stopped and cleaned up.`,
          StillRunning: ({ entry }) =>
            `Sent SIGTERM to PID ${entry.pid} (${entry.serverId})\n\nServer is still running after SIGTERM.`,
        }),
      )
      yield* Console.log(line)
    }),
)

export const server = Command.make("server", {}, () =>
  Console.log("Usage: gent server <status|stop>"),
).pipe(Command.withSubcommands([serverStatus, serverStop]))

/** How long the doctor waits for a confirmed server to report extension health. */
const DOCTOR_QUERY_TIMEOUT = "5 seconds"

/**
 * Ask the data directory's server for extension health. The doctor runs when something
 * is wrong, so it confirms the server's identity first and bounds the query:
 * a holder that does not answer is reported, not waited on.
 */
export const readDoctorExtensionHealth = (
  status: ServerLockStatus,
): Effect.Effect<ExtensionDoctorHealth> => {
  if (status._tag === "None")
    return Effect.succeed(extensionHealthUnavailable("No server for this data directory."))
  if (status._tag === "Unnamed") {
    return Effect.succeed(extensionHealthUnavailable("The server has not named itself yet."))
  }
  if (status._tag === "Stale") {
    return Effect.succeed(extensionHealthUnavailable("Server lock is stale."))
  }
  const { entry } = status
  return Effect.gen(function* () {
    if (!(yield* serverLock.probe(entry))) {
      return extensionHealthUnavailable(
        `PID ${entry.pid} holds the server lock but does not answer as a gent server at ${entry.rpcUrl}.`,
      )
    }
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const bundle = yield* Gent.client(entry.rpcUrl, { cwd: process.cwd() })
        yield* bundle.runtime.lifecycle.waitForReady
        const snapshot = yield* bundle.client.extension.listStatus({})
        return extensionHealthFromSnapshot(snapshot)
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: DOCTOR_QUERY_TIMEOUT,
        orElse: () =>
          Effect.succeed(
            extensionHealthError(`no answer within ${DOCTOR_QUERY_TIMEOUT} from ${entry.rpcUrl}`),
          ),
      }),
      Effect.catch((error) => Effect.succeed(extensionHealthError(String(error)))),
    )
  })
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

/** A server holds or answers for the database, named or not: the database is in use. */
const serverHoldsLock = Predicate.or(Predicate.isTagged("Alive"), Predicate.isTagged("Unnamed"))

/** `storage reset` moves the database away, so it refuses while any server uses it. */
export const refuseResetWhileServing = (
  home: string,
): Effect.Effect<void, CliStartupError, FileSystem.FileSystem | GentPlatform> =>
  Effect.gen(function* () {
    const status = yield* serverLock
      .status(home)
      .pipe(
        Effect.mapError((error) => new CliStartupError({ message: error.message, cause: error })),
      )
    if (!serverHoldsLock(status)) return
    return yield* new CliStartupError({
      message: "a server is running for this data directory; stop it with `gent server stop` first",
    })
  })

const storageReset = Command.make("reset", {}, () =>
  Effect.gen(function* () {
    const home = yield* readHome
    yield* refuseResetWhileServing(home)

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
