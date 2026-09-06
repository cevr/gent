import { Database } from "bun:sqlite"
import { DateTime, Effect, FileSystem, Match, Option, Schema } from "effect"
import type { ExtensionHealthIssue, ExtensionHealthSnapshot } from "@gent/sdk"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform.js"

const LOG_DIR = "/tmp/gent/logs"
const STORAGE_TABLES = [
  "sessions",
  "branches",
  "messages",
  "events",
] satisfies ReadonlyArray<string>

export interface StorageHealth {
  readonly dbPath: string
  readonly exists: boolean
  readonly sizeBytes: number
  readonly migrationTable: "missing" | "present"
  readonly migrationCount: number
  readonly existingStorageTables: ReadonlyArray<string>
  readonly status: "missing" | "ok" | "incompatible" | "unreadable"
  readonly error?: string
}

export interface ServerHealth {
  readonly status: "none" | "alive" | "dead"
  readonly summary: string
}

export interface LogHealth {
  readonly dir: string
  readonly latestServer?: string
  readonly latestClient?: string
}

export interface ExtensionDoctorHealth {
  readonly status: "unavailable" | "healthy" | "degraded" | "error"
  readonly summary: string
  readonly snapshot?: ExtensionHealthSnapshot
  readonly error?: string
}

export interface DoctorReport {
  readonly home: string
  readonly storage: StorageHealth
  readonly server: ServerHealth
  readonly logs: LogHealth
  readonly extensions: ExtensionDoctorHealth
}

export interface StorageResetResult {
  readonly archiveDir?: string
  readonly archived: ReadonlyArray<string>
}

export const storagePaths = (home: string) => {
  const dbPath = `${home}/.gent/data.db`
  return {
    dbPath,
    files: [dbPath, `${dbPath}-shm`, `${dbPath}-wal`] satisfies ReadonlyArray<string>,
  }
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
    const { dbPath } = storagePaths(home)
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

export const inspectLogs: Effect.Effect<LogHealth, never, FileSystem.FileSystem> = Effect.gen(
  function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(LOG_DIR).pipe(Effect.orElseSucceed(() => false))
    if (!exists) return { dir: LOG_DIR }

    const names = yield* fs.readDirectory(LOG_DIR).pipe(Effect.orElseSucceed(() => []))
    const entries = yield* Effect.forEach(names, (name) =>
      Effect.gen(function* () {
        const path = `${LOG_DIR}/${name}`
        const stat = yield* fs.stat(path).pipe(Effect.option)
        let mtimeMs = 0
        if (stat._tag === "Some" && stat.value.mtime._tag === "Some") {
          mtimeMs = stat.value.mtime.value.getTime()
        }
        return { path, name, mtimeMs }
      }),
    )
    const sorted = entries.sort((a, b) => b.mtimeMs - a.mtimeMs)

    return {
      dir: LOG_DIR,
      latestServer: sorted.find((entry) => entry.name.endsWith("-server.log"))?.path,
      latestClient: sorted.find((entry) => entry.name.endsWith("-client.log"))?.path,
    }
  },
)

const ServerLockEntry = Schema.Struct({
  pid: Schema.Finite,
  serverId: Schema.optionalKey(Schema.String),
  rpcUrl: Schema.optionalKey(Schema.String),
})
const decodeServerLockEntry = Schema.decodeUnknownOption(ServerLockEntry)
type ServerLockEntryInput = Parameters<typeof decodeServerLockEntry>[0]

export const inspectServer = (
  entry: ServerLockEntryInput,
): Effect.Effect<ServerHealth, never, GentPlatform> =>
  Effect.gen(function* () {
    if (Option.isNone(Option.fromNullishOr(entry))) {
      return { status: "none", summary: "No shared server." }
    }
    const decoded = decodeServerLockEntry(entry)
    if (Option.isNone(decoded)) return { status: "dead", summary: "Invalid server lock." }
    const { pid } = decoded.value
    const platform = yield* GentPlatform
    const alive = yield* platform.signal(pid, 0).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
    const id = Option.getOrElse(Option.fromNullishOr(decoded.value.serverId), () => "unknown")
    const url = Option.getOrElse(Option.fromNullishOr(decoded.value.rpcUrl), () => "unknown")
    if (alive) {
      return { status: "alive", summary: `Shared server alive: pid ${pid}, ${id}, ${url}` }
    }
    return { status: "dead", summary: `Shared server lock is stale: pid ${pid}, ${id}` }
  })

export const extensionHealthUnavailable = (summary: string): ExtensionDoctorHealth => ({
  status: "unavailable",
  summary,
})

export const extensionHealthError = (error: string): ExtensionDoctorHealth => ({
  status: "error",
  summary: "Extension health query failed.",
  error,
})

export const extensionHealthFromSnapshot = (
  snapshot: ExtensionHealthSnapshot,
): ExtensionDoctorHealth => {
  if (snapshot._tag === "healthy") {
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
  serverEntry: ServerLockEntryInput,
  extensions?: ExtensionDoctorHealth,
): Effect.Effect<DoctorReport, never, FileSystem.FileSystem | GentPlatform> =>
  Effect.gen(function* () {
    const server = yield* inspectServer(serverEntry)
    const defaultExtensions = () => {
      let summary = "No live shared server."
      if (server.status === "alive") summary = "Extension health was not queried."
      return extensionHealthUnavailable(summary)
    }
    return {
      home,
      storage: yield* inspectStorage(home),
      server,
      logs: yield* inspectLogs,
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
    const { files } = storagePaths(home)
    const existing = []
    for (const file of files) {
      if (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))) {
        existing.push(file)
      }
    }
    if (existing.length === 0) return { archived: [] }

    const archiveDir = `${home}/.gent/storage-archive/${stamp()}`
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
      "activation-failed": (issue) => `activation failed during ${issue.phase}: ${issue.error}`,
      "scheduled-job-failed": (issue) => `scheduled job ${issue.jobId} failed: ${issue.error}`,
    }),
  )

const formatExtensions = (extensions: ExtensionDoctorHealth): ReadonlyArray<string> => {
  const lines = [`  Status: ${extensions.summary}`]
  const error = Option.fromNullishOr(extensions.error)
  if (Option.isSome(error)) lines.push(`  Error: ${error.value}`)
  const snapshot = Option.fromNullishOr(extensions.snapshot)
  if (Option.isNone(snapshot) || snapshot.value._tag !== "degraded") return lines

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
