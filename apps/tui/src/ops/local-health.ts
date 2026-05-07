import { Database } from "bun:sqlite"
import { DateTime, Effect, FileSystem, Option } from "effect"

const LOG_DIR = "/tmp/gent/logs"
const STORAGE_TABLES = ["sessions", "branches", "messages", "events"] as const

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

export interface DoctorReport {
  readonly home: string
  readonly storage: StorageHealth
  readonly server: ServerHealth
  readonly logs: LogHealth
}

export interface StorageResetResult {
  readonly archiveDir?: string
  readonly archived: ReadonlyArray<string>
}

export const storagePaths = (home: string) => {
  const dbPath = `${home}/.gent/data.db`
  return {
    dbPath,
    files: [dbPath, `${dbPath}-shm`, `${dbPath}-wal`] as const,
  }
}

const readSqliteHealth = (
  dbPath: string,
): Omit<StorageHealth, "dbPath" | "exists" | "sizeBytes"> => {
  try {
    const db = new Database(dbPath, { readonly: true })
    try {
      const tables = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name)
      const migrationTable = tables.includes("gent_storage_migrations") ? "present" : "missing"
      const migrationCount =
        migrationTable === "present"
          ? (db
              .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM gent_storage_migrations")
              .get()?.count ?? 0)
          : 0
      const existingStorageTables = STORAGE_TABLES.filter((table) => tables.includes(table))
      const incompatible = existingStorageTables.length > 0 && migrationCount === 0
      return {
        migrationTable,
        migrationCount,
        existingStorageTables,
        status: incompatible ? "incompatible" : "ok",
      }
    } finally {
      db.close()
    }
  } catch (error) {
    return {
      migrationTable: "missing",
      migrationCount: 0,
      existingStorageTables: [],
      status: "unreadable",
      error: String(error),
    }
  }
}

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
      ...readSqliteHealth(dbPath),
    }
  })

export const inspectLogs = (): Effect.Effect<LogHealth, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
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
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

export const inspectServer = (entry: unknown): ServerHealth => {
  if (entry === undefined) return { status: "none", summary: "No shared server." }
  if (!isRecord(entry)) return { status: "dead", summary: "Invalid server lock." }
  const pid = entry["pid"]
  if (typeof pid !== "number") return { status: "dead", summary: "Invalid server lock." }
  const alive = (() => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })()
  const serverId = entry["serverId"]
  const rpcUrl = entry["rpcUrl"]
  const id = typeof serverId === "string" ? serverId : "unknown"
  const url = typeof rpcUrl === "string" ? rpcUrl : "unknown"
  return alive
    ? { status: "alive", summary: `Shared server alive: pid ${pid}, ${id}, ${url}` }
    : { status: "dead", summary: `Shared server lock is stale: pid ${pid}, ${id}` }
}

export const makeDoctorReport = (
  home: string,
  serverEntry: unknown,
): Effect.Effect<DoctorReport, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    return {
      home,
      storage: yield* inspectStorage(home),
      server: inspectServer(serverEntry),
      logs: yield* inspectLogs(),
    }
  })

const stamp = () =>
  DateTime.make(performance.timeOrigin + performance.now()).pipe(
    Option.match({
      onNone: () => "unknown",
      onSome: (date) =>
        DateTime.formatIso(date)
          .replace(/[-:T.]/g, "")
          .slice(0, 14),
    }),
  )

const basename = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path

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

export const formatDoctorReport = (report: DoctorReport): string => {
  const storage = report.storage
  const storageLine =
    storage.status === "missing"
      ? `missing (${storage.dbPath})`
      : `${storage.status} (${storage.dbPath}, ${formatBytes(storage.sizeBytes)}, migrations: ${storage.migrationCount})`
  const tableLine =
    storage.existingStorageTables.length === 0 ? "none" : storage.existingStorageTables.join(", ")

  return [
    "Gent doctor",
    "",
    `Home: ${report.home}`,
    "",
    "Storage:",
    `  DB: ${storageLine}`,
    `  Migration table: ${storage.migrationTable}`,
    `  Existing storage tables: ${tableLine}`,
    ...(storage.error !== undefined ? [`  Error: ${storage.error}`] : []),
    "",
    "Server:",
    `  ${report.server.summary}`,
    "",
    "Logs:",
    `  Directory: ${report.logs.dir}`,
    `  Latest server: ${report.logs.latestServer ?? "none"}`,
    `  Latest client: ${report.logs.latestClient ?? "none"}`,
  ].join("\n")
}
