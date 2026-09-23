import { describe, expect, it, test } from "effect-bun-test"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Random,
  Schema,
} from "effect"
import { MinimumLogLevel } from "effect/References"
import {
  classifyLogFile,
  dataPaths,
  dataPathsIn,
  makeJsonFileLogger,
  serverLock,
  ServerLockEntry,
  ServerLockStatus,
} from "@gent/sdk"
import { makeClientTraceLogger } from "../src/client"
import {
  extensionHealthFromSnapshot,
  formatDoctorReport,
  inspectLogs,
  inspectServer,
  inspectStorage,
  makeDoctorReport,
  readDoctorExtensionHealth,
  refuseResetWhileServing,
  resetStorage,
} from "../src/ops"
import { SqliteClient as BunSqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { GentPlatform } from "@gent/core/host"
import { ExtensionHealth, ExtensionHealthIssue, ExtensionHealthSnapshot } from "@gent/core/protocol"

// ── client-logs.test ────────────────────────────────────────────────────────

/**
 * The client log file and the doctor's log section.
 *
 * Every case runs against a directory it creates and owns. `/tmp/gent/logs`
 * belongs to a live gent, so a test that removed it would take a running
 * instance's logs with it, and a test that read it would race whatever else
 * writes there.
 *
 * The SDK owns the file-naming rule, so `inspectLogs` only reports what it is
 * told: the newest file each side wrote, and nothing for a name neither side
 * claims.
 */

/** The line shape `gent doctor` reads from both the server and the client log. */
const LogEntry = Schema.fromJsonString(
  Schema.Struct({
    ts: Schema.String,
    level: Schema.String,
    msg: Schema.String,
    sessionId: Schema.String,
    traceId: Schema.String,
    spanId: Schema.String,
    spanName: Schema.String,
    spans: Schema.Record(Schema.String, Schema.Finite),
  }),
)
const decodeLogEntry = Schema.decodeUnknownSync(LogEntry)
const decodeJsonLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

const emitOneEntry = (marker: string) => (logger: Logger.Logger<unknown, void>) =>
  Effect.logInfo(marker).pipe(
    Effect.annotateLogs({ sessionId: "s-1" }),
    Effect.withLogSpan("turn"),
    Effect.withSpan("receipt-span"),
    Effect.provide(Logger.layer([logger])),
    Effect.provideService(MinimumLogLevel, "Info"),
  )

/** Other tests append to the shared client log; pick this test's line by its marker. */
const findLineByMarker = (path: string, marker: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const lines = (yield* fs.readFileString(path)).split("\n")
    const own = lines.find((line) =>
      Option.exists(decodeJsonLine(line), (entry) => entry["msg"] === marker),
    )
    return Option.getOrElse(Option.fromNullishOr(own), () => "")
  })

/** The name `classifyLogFile` reads, from a full path. */
const basename = (path: Option.Option<string>): string =>
  Option.getOrElse(
    Option.map(path, (value) =>
      Option.getOrElse(Option.fromUndefinedOr(value.split("/").at(-1)), () => value),
    ),
    () => "",
  )

/**
 * `inspectLogs` orders by mtime. Fixtures are written in order so each is newer
 * than the last, and removed again on the way out; assertions compare only
 * files this test created, never "newest in the directory".
 */
const writeLog = (dir: string, name: string, ageRank: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = `${dir}/${name}`
    yield* fs.writeFileString(path, "{}\n")
    // Four writes land in one millisecond, and `inspectLogs` orders by
    // millisecond mtime, so the order has to be stamped rather than assumed.
    const seconds = 1_757_000_000 + ageRank
    yield* fs.utimes(path, seconds, seconds)
    return path
  })

describe("client trace logger", () => {
  it.scopedLive("creates the log directory it writes into", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      // No module import creates the directory: the scoped logger makes it
      // before opening the file. Naming a directory that does not exist and
      // building the logger is the whole protection.
      const root = yield* fs.makeTempDirectoryScoped()
      const dir = `${root}/logs`
      const path = `${dir}/00000000-20260917000000-client.log`
      expect(yield* fs.exists(dir)).toBe(false)

      yield* Effect.scoped(Effect.asVoid(makeClientTraceLogger(dir, path)))

      expect(yield* fs.exists(dir)).toBe(true)
    }).pipe(Effect.provide(BunFileSystem.layer)),
  )

  it.scopedLive("writes the SDK JSON line format at the client log path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const marker = `trace-receipt-${yield* Random.nextInt}`
      const dir = yield* fs.makeTempDirectoryScoped()
      const clientPath = `${dir}/00000000-20260917000000-client.log`
      const serverStylePath = `${dir}/00000000-20260917000000-server.log`
      const emit = emitOneEntry(marker)
      yield* Effect.scoped(Effect.flatMap(makeClientTraceLogger(dir, clientPath), emit))
      yield* Effect.scoped(Effect.flatMap(makeJsonFileLogger(serverStylePath), emit))

      const clientLine = yield* findLineByMarker(clientPath, marker)
      const serverLine = yield* findLineByMarker(serverStylePath, marker)

      const clientEntry = decodeLogEntry(clientLine)
      const serverEntry = decodeLogEntry(serverLine)
      const keysOf = (line: string) =>
        Object.keys(Option.getOrElse(decodeJsonLine(line), () => ({}))).sort()
      expect(keysOf(clientLine)).toEqual(keysOf(serverLine))
      expect(clientEntry.msg).toBe(marker)
      expect(clientEntry.level).toBe("Info")
      expect(clientEntry.sessionId).toBe("s-1")
      expect(clientEntry.spanName).toBe("receipt-span")
      expect(Object.keys(clientEntry.spans)).toEqual(["turn"])
      expect(serverEntry.msg).toBe(marker)
    }).pipe(Effect.provide(BunFileSystem.layer)),
  )
})

describe("log file classification", () => {
  it.live("names each side by its suffix and claims nothing else", () =>
    Effect.sync(() => {
      expect(classifyLogFile("abc12345-20260915120000-server.log")).toEqual(Option.some("server"))
      expect(classifyLogFile("abc12345-20260915120000-client.log")).toEqual(Option.some("client"))
      expect(classifyLogFile("notes.txt")).toEqual(Option.none())
      expect(classifyLogFile("server.log")).toEqual(Option.none())
    }),
  )
})

describe("inspect logs", () => {
  it.scopedLive("reports the newest file each side wrote and ignores unrelated names", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()

      // Written oldest first; the last write of each kind is the newest.
      const older = yield* writeLog(dir, "00000001-20260915120000-server.log", 1)
      const client = yield* writeLog(dir, "00000002-20260915140000-client.log", 2)
      const newer = yield* writeLog(dir, "00000003-20260915130000-server.log", 3)
      // Newest file of all, and not a log: the classifier must refuse it.
      const ignored = yield* writeLog(dir, "00000004-notes.txt", 4)

      const logs = yield* inspectLogs(dir)

      expect(logs.dir).toBe(dir)
      // A name neither side claims never wins, however new it is.
      expect(logs.latestServer).not.toBe(ignored)
      expect(logs.latestClient).not.toBe(ignored)
      // The directory holds only this test's files, so each side has one answer.
      expect(logs.latestServer).toBe(newer)
      expect(logs.latestClient).toBe(client)
      expect(logs.latestServer).not.toBe(older)
      expect(
        Option.contains(
          classifyLogFile(basename(Option.fromUndefinedOr(logs.latestServer))),
          "server",
        ),
      ).toBe(true)
      expect(
        Option.contains(
          classifyLogFile(basename(Option.fromUndefinedOr(logs.latestClient))),
          "client",
        ),
      ).toBe(true)
    }).pipe(Effect.timeout("20 seconds"), Effect.provide(BunServices.layer)),
  )
})

// ── local-health.test ───────────────────────────────────────────────────────

const absentServer = ServerLockStatus.cases.None.make({})

const lockEntry = new ServerLockEntry({
  serverId: "server-1",
  pid: 4242,
  hostname: "test-host",
  rpcUrl: "http://127.0.0.1:1/rpc",
  dbPath: "/tmp/data.db",
  buildFingerprint: "fp",
  startedAt: 0,
})

/** Run the effect against an environment that redirects the data directory. */
const withDataDir =
  (dataDir: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(
      effect,
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnvRecord({ GENT_DATA_DIR: dataDir }),
    )

const createDb = (dbPath: string, ...statements: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const statement of statements) yield* sql.unsafe(statement)
  }).pipe(Effect.provide(BunSqliteClient.layer({ filename: dbPath })))

describe("local health", () => {
  test("a live shared server reports its pid, id, and url from the SDK lock record", () => {
    const server = inspectServer(ServerLockStatus.cases.Alive.make({ entry: lockEntry }))
    expect(server.status).toBe("alive")
    expect(server.summary).toBe("Shared server alive: pid 4242, server-1, http://127.0.0.1:1/rpc")
  })

  test("a lock whose pid is gone reports a stale server", () => {
    const server = inspectServer(ServerLockStatus.cases.Stale.make({ entry: lockEntry }))
    expect(server.status).toBe("dead")
    expect(server.summary).toBe("Shared server lock is stale: pid 4242, server-1")
  })

  it.live("the doctor reports a lock holder that does not answer instead of waiting for it", () =>
    Effect.gen(function* () {
      const health = yield* readDoctorExtensionHealth(
        ServerLockStatus.cases.Alive.make({ entry: lockEntry }),
      ).pipe(Effect.timeout("4 seconds"))
      expect(health.status).toBe("unavailable")
      expect(health.summary).toContain("4242")
    }),
  )

  test("no lock reports no shared server", () => {
    expect(inspectServer(absentServer)).toEqual({ status: "none", summary: "No shared server." })
  })

  it.scopedLive("reports incompatible storage tables without migration records", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const { dbPath } = yield* dataPaths(home)
      yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true })
      yield* createDb(
        dbPath,
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      )

      const storage = yield* inspectStorage(home)
      expect(storage.status).toBe("incompatible")
      expect(storage.existingStorageTables).toEqual(["sessions"])
      expect(storage.migrationCount).toBe(0)

      const report = formatDoctorReport(yield* makeDoctorReport(home, absentServer))
      expect(report).toContain("Gent doctor")
      expect(report).toContain("incompatible")
      expect(report).toContain("Migration table: missing")
      expect(report).toContain("Extensions:")
      expect(report).toContain("No live shared server.")
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, GentPlatform.Test()))),
  )

  it.scopedLive("a run with its own data directory reads its own logs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const dataDir = yield* fs.makeTempDirectoryScoped()
      const report = yield* makeDoctorReport(home, absentServer).pipe(withDataDir(dataDir))
      // The run writes its logs beside its database, so the doctor names that directory.
      expect(report.logs.dir).toBe(`${dataDir}/logs`)
      expect(formatDoctorReport(report)).toContain(`Directory: ${dataDir}/logs`)
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, GentPlatform.Test()))),
  )

  it.scopedLive("doctor report includes degraded extension resource health", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const extensionHealth = extensionHealthFromSnapshot(
        ExtensionHealthSnapshot.cases.Degraded.make({
          healthyExtensions: [],
          degradedExtensions: [
            ExtensionHealth.cases.Degraded.make({
              manifest: { id: "@test/broken-resource" },
              scope: "builtin",
              sourcePath: "builtin",
              issues: [
                ExtensionHealthIssue.cases.ActivationFailed.make({
                  phase: "startup",
                  error: "resource start boom",
                }),
              ],
            }),
          ],
        }),
      )

      const report = formatDoctorReport(
        yield* makeDoctorReport(home, absentServer, extensionHealth),
      )
      expect(report).toContain("Extensions:")
      expect(report).toContain("degraded (1 degraded, 0 healthy)")
      expect(report).toContain("@test/broken-resource:")
      expect(report).toContain("activation failed during startup: resource start boom")
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, GentPlatform.Test()))),
  )

  it.scopedLive("archives storage files on reset", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const { dbPath } = yield* dataPaths(home)
      yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true })
      yield* createDb(
        dbPath,
        "CREATE TABLE gent_storage_migrations (migration_id INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL)",
      )

      const result = yield* resetStorage(home)
      expect(result.archiveDir).toBeDefined()
      expect(result.archived.length).toBeGreaterThan(0)
      expect(yield* fs.exists(dbPath)).toBe(false)
      for (const file of result.archived) {
        expect(yield* fs.exists(file)).toBe(true)
      }
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive(
    "storage reset refuses while a server without the kernel lock answers for the database",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.makeTempDirectoryScoped()
        const { hostname } = yield* (yield* GentPlatform).osInfo
        const identity = { ...lockEntry, hostname, buildFingerprint: "older-build" }
        const endpoint = yield* Effect.acquireRelease(
          Effect.sync(() =>
            // oxlint-disable-next-line effect/noGlobals -- this test needs a raw Bun identity fixture server
            Bun.serve({
              port: 0,
              fetch: () =>
                Response.json({
                  serverId: identity.serverId,
                  pid: identity.pid,
                  hostname: identity.hostname,
                  dbPath: identity.dbPath,
                  buildFingerprint: identity.buildFingerprint,
                }),
            }),
          ),
          (server) => Effect.promise(() => server.stop(true)),
        )
        yield* serverLock.write(
          home,
          new ServerLockEntry({ ...identity, rpcUrl: `${new URL(endpoint.url).origin}/rpc` }),
        )
        const refused = yield* refuseResetWhileServing(home).pipe(Effect.flip)
        expect(refused._tag).toBe("CliStartupError")
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, GentPlatform.Test()))),
  )

  it.scopedLive("storage reset is idempotent when no db files exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const result = yield* resetStorage(home)
      expect(result.archiveDir).toBeUndefined()
      expect(result.archived).toEqual([])
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive("the doctor reads the database GENT_DATA_DIR names, not the one under home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      // `home` holds no database; the server wrote to `dataDir` instead.
      const home = yield* fs.makeTempDirectoryScoped()
      const dataDir = yield* fs.makeTempDirectoryScoped()
      const { dbPath } = dataPathsIn(dataDir)
      yield* createDb(
        dbPath,
        "CREATE TABLE gent_storage_migrations (migration_id INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL)",
        "INSERT INTO gent_storage_migrations (migration_id, name) VALUES (1, 'initial')",
      )

      const storage = yield* inspectStorage(home).pipe(withDataDir(dataDir))
      expect(storage.dbPath).toBe(dbPath)
      expect(storage.exists).toBe(true)
      expect(storage.status).toBe("ok")
      expect(storage.migrationCount).toBe(1)
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive("storage reset archives the database GENT_DATA_DIR names", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const dataDir = yield* fs.makeTempDirectoryScoped()
      const { dbPath } = dataPathsIn(dataDir)
      yield* createDb(
        dbPath,
        "CREATE TABLE gent_storage_migrations (migration_id INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL)",
      )

      const result = yield* resetStorage(home).pipe(withDataDir(dataDir))
      expect(result.archived.length).toBeGreaterThan(0)
      expect(yield* fs.exists(dbPath)).toBe(false)
      for (const file of result.archived) {
        expect(file.startsWith(dataDir)).toBe(true)
        expect(yield* fs.exists(file)).toBe(true)
      }
    }).pipe(Effect.provide(BunServices.layer)),
  )
})
