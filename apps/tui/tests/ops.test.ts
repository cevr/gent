import {
  collectTestContributions,
  ExtensionHealth,
  makeTempDirectoryScoped,
} from "@gent/core/test-utils"
import { describe, expect, it, test } from "effect-bun-test"
import { BunChildProcessSpawner, BunFileSystem, BunServices } from "@effect/platform-bun"
import { getToolId } from "@gent/core/extensions/api"
import { BuiltinExtensions } from "@gent/extensions"
import {
  ConfigProvider,
  Console,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Predicate,
  Random,
  Schema,
  Sink,
  Stdio,
} from "effect"
import { MinimumLogLevel } from "effect/References"
import {
  classifyLogFile,
  dataPaths,
  Gent,
  makeJsonFileLogger,
  serverLock,
  ServerLockEntry,
  ServerLockStatus,
} from "@gent/sdk"
import { textWidth } from "../src/bun-adapter"
import { makeClientTraceLogger } from "../src/client"
import {
  extensionHealthFromSnapshot,
  formatDoctorReport,
  formatServerStatus,
  formatSessionList,
  inspectLogs,
  inspectServer,
  inspectStorage,
  makeDoctorReport,
  readDoctorExtensionHealth,
  reportFailureOnStderr,
  resetStorage,
  resolveClientBundle,
  resumableSessions,
  seedDebugSession,
} from "../src/ops"
import { SqliteClient as BunSqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/sql"
import { GentPlatform } from "@gent/core/host"
import {
  dateFromMillis,
  ExtensionHealthIssue,
  ExtensionHealthSnapshot,
  Session,
  SessionId,
} from "@gent/core/protocol"

// ── client logs ─────────────────────────────────────────────────────────────

/**
 * The client log file and the doctor's log section.
 *
 * Every case runs against a directory it creates and owns. The real log
 * directory belongs to a live gent, so a test that removed it would take a running
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

class UnknownAgentError extends Schema.TaggedError<UnknownAgentError>()("NotFoundError", {
  message: Schema.String,
}) {}

const reported = { stdout: "", stderr: "" }
const captureTo = (stream: "stdout" | "stderr") =>
  Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      reported[stream] += String(chunk)
    }),
  )
const reportTest = it.live.layer(
  Stdio.layerTest({ stdout: () => captureTo("stdout"), stderr: () => captureTo("stderr") }),
)

describe("resumable sessions", () => {
  test("a local run keeps its sessions unless its state is in memory", () => {
    expect(resumableSessions({ connect: Option.none(), inMemory: false })).toBe(true)
    expect(resumableSessions({ connect: Option.none(), inMemory: true })).toBe(false)
  })

  test("a connected run keeps what the server keeps; the local --isolate does not apply", () => {
    const server = Option.some("ws://127.0.0.1:4097")
    expect(resumableSessions({ connect: server, inMemory: true })).toBe(true)
    expect(resumableSessions({ connect: server, inMemory: false })).toBe(true)
  })
})

// A scripted model needs no sign-in. Only the server this run starts serves
// one: a connected server chose its own model, so its sign-in gate stays.
describe("scripted model", () => {
  const mockEmpty = (cwd: string) => ({
    cwd,
    inMemory: true,
    debug: false,
    mock: Option.some({ empty: true }),
    authDirectory: Option.some(cwd),
  })

  it.live("--mock-empty on a server this run starts serves a scripted model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* makeTempDirectoryScoped("gent-scripted-local-")
        const bundle = yield* resolveClientBundle({ ...mockEmpty(cwd), connect: Option.none() })
        expect(bundle.scriptedModel).toBe(true)
      }).pipe(Effect.timeout("10 seconds")),
    ),
  )

  it.live("--mock-empty with --connect keeps the connected server's model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* makeTempDirectoryScoped("gent-scripted-connect-")
        const bundle = yield* resolveClientBundle({
          ...mockEmpty(cwd),
          connect: Option.some("ws://127.0.0.1:9/nonexistent-loop-probe"),
        })
        expect(bundle.scriptedModel).toBe(false)
      }).pipe(Effect.timeout("10 seconds")),
    ),
  )
})

describe("startup failure report", () => {
  reportTest("a failure is one line on stderr, and stdout stays the session's output", () =>
    Effect.gen(function* () {
      reported.stdout = ""
      reported.stderr = ""
      const exit = yield* Effect.exit(
        reportFailureOnStderr(new UnknownAgentError({ message: "Unknown agent: revieww" })),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(reported.stderr).toBe("NotFoundError: Unknown agent: revieww\n")
      expect(reported.stdout).toBe("")
    }),
  )

  reportTest("an interrupt reports nothing", () =>
    Effect.gen(function* () {
      reported.stderr = ""
      yield* Effect.exit(reportFailureOnStderr(Effect.interrupt))
      expect(reported.stderr).toBe("")
    }),
  )
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

// ── local health ────────────────────────────────────────────────────────────

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
  test("a live server reports its pid, id, and url from the SDK lock record", () => {
    const server = inspectServer(ServerLockStatus.cases.Alive.make({ entry: lockEntry }))
    expect(server.status).toBe("alive")
    expect(server.summary).toBe("Server alive: pid 4242, server-1, http://127.0.0.1:1/rpc")
  })

  test("a lock whose pid is gone reports a stale server", () => {
    const server = inspectServer(ServerLockStatus.cases.Stale.make({ entry: lockEntry }))
    expect(server.status).toBe("dead")
    expect(server.summary).toBe("Server lock is stale: pid 4242, server-1")
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

  test("no lock reports no server for the data directory", () => {
    expect(inspectServer(absentServer)).toEqual({
      status: "none",
      summary: "No server for this data directory.",
    })
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

      const report = formatDoctorReport(
        yield* makeDoctorReport(home, absentServer, yield* readDoctorExtensionHealth(absentServer)),
      )
      expect(report).toContain("Gent doctor")
      expect(report).toContain("incompatible")
      expect(report).toContain("Migration table: missing")
      expect(report).toContain("Extensions:")
      expect(report).toContain("Status: No server for this data directory.")
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, GentPlatform.Test()))),
  )

  // A lock whose database path is longer than any default column.
  const longPathEntry = ServerLockEntry.make({
    serverId: "gent-server-3f9c2a1e-7b44-4d0e-9a5f-2c6e1b8d0f37",
    pid: 48213,
    hostname: "workbox",
    rpcUrl: "http://127.0.0.1:52811/rpc",
    dbPath: "/private/tmp/gent-gamut-scratch/data-dir-for-a-long-run/data.db",
    buildFingerprint: "b",
    startedAt: 0,
  })

  test("server status fits each column to a long database path", () => {
    const [header = "", rule = "", row = ""] = formatServerStatus(
      "alive",
      longPathEntry,
      200,
    ).split("\n")
    // Each value sits under its own header, and the URL column starts in the
    // same place on both lines, so no value pushes the next one out of place.
    const columns: ReadonlyArray<readonly [string, string]> = [
      ["SERVER ID", longPathEntry.serverId],
      ["DB PATH", longPathEntry.dbPath],
      ["URL", longPathEntry.rpcUrl],
    ]
    for (const [title, value] of columns) {
      expect(row.indexOf(value)).toBe(header.indexOf(title))
    }
    expect(row).toContain(` ${longPathEntry.dbPath} `)
    expect(rule.length).toBe(row.length)
  })

  // `gent sessions` lists what `gent resume` can pick: the conversations,
  // newest first, each with the directory it runs in. A delegate or `/btw`
  // child is the agent's work; a handoff joins its parent's thread and stays.
  test("the sessions listing shows conversations, newest first, with their cwd", () => {
    const session = (
      id: string,
      updatedMs: number,
      extra: Partial<ConstructorParameters<typeof Session>[0]> = {},
    ) =>
      new Session({
        id: SessionId.make(id),
        name: id,
        cwd: `/work/${id}`,
        createdAt: dateFromMillis(0),
        updatedAt: dateFromMillis(updatedMs),
        ...extra,
      })
    const child = session("child", 3_000, {
      parentSessionId: SessionId.make("older"),
      threadId: SessionId.make("child"),
    })
    const listing = formatSessionList([
      session("older", 1_000),
      child,
      session("newer", 2_000),
      session("handoff", 1_500, {
        parentSessionId: SessionId.make("older"),
        threadId: SessionId.make("older"),
      }),
    ])
    const [header = "", , ...rows] = listing.split("\n")
    expect(header.split(/\s+/)).toEqual(["ID", "NAME", "CWD", "UPDATED"])
    expect(rows.map((row) => row.split(/\s+/).slice(0, 3))).toEqual([
      ["newer", "newer", "/work/newer"],
      ["handoff", "handoff", "/work/handoff"],
      ["older", "older", "/work/older"],
    ])
    expect(formatSessionList([child])).toBe("No sessions found.")
  })

  // A name from a CJK or emoji prompt is wider on screen than its code
  // units: the columns after it stay under their headers.
  test("the sessions listing aligns its columns by display width", () => {
    const named = (id: string, name: string) =>
      new Session({
        id: SessionId.make(id),
        name,
        cwd: `/work/${id}`,
        createdAt: dateFromMillis(0),
        updatedAt: dateFromMillis(0),
      })
    const [header = "", rule = "", ...rows] = formatSessionList([
      named("a", "plain name"),
      named("b", "日本語のテスト"),
      named("c", "ship it 🚀"),
    ]).split("\n")
    const columnOf = (line: string, text: string) => textWidth(line.slice(0, line.indexOf(text)))
    const cwdColumn = columnOf(header, "CWD")
    expect(rows.map((row) => columnOf(row, "/work/"))).toEqual([cwdColumn, cwdColumn, cwdColumn])
    expect(textWidth(rule)).toBe(Math.max(...rows.map(textWidth), textWidth(header)))
  })

  test("server status wider than the terminal prints one field per line", () => {
    expect(formatServerStatus("dead", longPathEntry, 107).split("\n")).toEqual([
      "PID:       48213",
      "Status:    dead",
      `Server ID: ${longPathEntry.serverId}`,
      `DB path:   ${longPathEntry.dbPath}`,
      `URL:       ${longPathEntry.rpcUrl}`,
    ])
  })

  it.scopedLive("a run with its own data directory reads its own logs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const dataDir = yield* fs.makeTempDirectoryScoped()
      const report = yield* makeDoctorReport(
        home,
        absentServer,
        yield* readDoctorExtensionHealth(absentServer),
      ).pipe(withDataDir(dataDir))
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

  it.scopedLive("storage reset refuses while a server holds the database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const { hostname } = yield* (yield* GentPlatform).osInfo
      const paths = yield* dataPaths(home)
      yield* fs.makeDirectory(paths.dataDir, { recursive: true })
      // The kernel lock a server holds for its life: an exclusive transaction,
      // open until this test's scope closes.
      const kernelLock = yield* Layer.build(
        BunSqliteClient.layer({ filename: paths.serverKernelLock }),
      )
      yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("BEGIN EXCLUSIVE")).pipe(
        Effect.provide(kernelLock),
      )
      // The discovery entry a server writes once it listens, as its JSON file.
      const entry = new ServerLockEntry({ ...lockEntry, hostname })
      yield* fs.writeFileString(
        paths.serverLock,
        yield* Schema.encodeEffect(Schema.fromJsonString(ServerLockEntry))(entry),
      )
      yield* createDb(
        paths.dbPath,
        "CREATE TABLE gent_storage_migrations (migration_id INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL)",
      )
      reported.stderr = ""
      const refused = yield* reportFailureOnStderr(resetStorage(home)).pipe(Effect.flip)
      expect(refused._tag).toBe("CliStartupError")
      expect(reported.stderr).toBe(
        "CliStartupError: a server is running for this data directory; stop it with `gent server stop` first\n",
      )
      expect(yield* fs.exists(paths.dbPath)).toBe(true)
      expect(yield* fs.exists(paths.archiveDir)).toBe(false)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          GentPlatform.Test(),
          Stdio.layerTest({
            stdout: () => captureTo("stdout"),
            stderr: () => captureTo("stderr"),
          }),
          // Anything logged as an error reaches the same stderr.
          Layer.effect(
            Console.Console,
            Effect.map(Console.Console, (console) => ({
              ...console,
              error: (...args: ReadonlyArray<unknown>) => {
                reported.stderr += `${args.join(" ")}\n`
              },
            })),
          ),
        ),
      ),
    ),
  )

  it.scopedLive("no server can own the database while storage reset moves its files", () =>
    Effect.gen(function* () {
      const base = yield* FileSystem.FileSystem
      const home = yield* base.makeTempDirectoryScoped()
      const { dataDir, dbPath } = yield* dataPaths(home)
      yield* base.makeDirectory(dataDir, { recursive: true })
      yield* createDb(
        dbPath,
        "CREATE TABLE gent_storage_migrations (migration_id INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL)",
      )
      // A server start takes this ownership; it releases it when its scope closes.
      const serverStart = Effect.scoped(serverLock.hold(home)).pipe(
        Effect.provideService(FileSystem.FileSystem, base),
        Effect.orDie,
      )
      // Before each file moves, a server start tries to take the database.
      const startsDuringMove: Array<boolean> = []
      const interleaved = FileSystem.FileSystem.of({
        ...base,
        rename: (from, to) =>
          serverStart.pipe(
            Effect.tap((owned) => Effect.sync(() => startsDuringMove.push(owned))),
            Effect.andThen(base.rename(from, to)),
          ),
      })
      const result = yield* resetStorage(home).pipe(
        Effect.provideService(FileSystem.FileSystem, interleaved),
      )
      expect(result.archived.length).toBeGreaterThan(0)
      expect(startsDuringMove).toEqual(result.archived.map(() => false))
      expect(yield* serverStart).toBe(true)
    }).pipe(Effect.provide(BunServices.layer)),
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
      const { dbPath } = yield* dataPaths(home).pipe(withDataDir(dataDir))
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
      const { dbPath } = yield* dataPaths(home).pipe(withDataDir(dataDir))
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

// ── debug session ───────────────────────────────────────────────────────────

interface SeededCall {
  readonly name: string
  readonly params: unknown
}

/**
 * The seeded calls no shipped tool accepts: an unknown tool id, or params the
 * tool's own schema rejects. Tools come from the builtin extensions' setup.
 */
const rejectedCalls = (calls: ReadonlyArray<SeededCall>) =>
  Effect.gen(function* () {
    const tools = new Map<string, Schema.Constraint>()
    for (const extension of BuiltinExtensions) {
      const contributions = yield* collectTestContributions(extension.setup)
      for (const tool of contributions.tools ?? []) {
        tools.set(getToolId(tool), tool.parametersSchema)
      }
    }
    const rejected: string[] = []
    for (const call of calls) {
      const schema = tools.get(call.name)
      if (Predicate.isUndefined(schema)) {
        rejected.push(`${call.name}: no shipped tool has this id`)
        continue
      }
      // The seeded tools' params are plain structs: their type side is their JSON.
      if (!Schema.is(schema)(call.params)) rejected.push(`${call.name}: params do not fit`)
    }
    return rejected
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        BunServices.layer,
        BunChildProcessSpawner.layer.pipe(Layer.provide(BunServices.layer)),
        GentPlatform.Test(),
      ),
    ),
  )

describe("debug session", () => {
  it.live(
    "--debug seeds only calls to shipped tools, with params those tools accept",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* makeTempDirectoryScoped("gent-debug-seed-")
          const server = yield* Gent.server({
            cwd,
            seed: seedDebugSession(cwd),
            state: Gent.state.memory(),
            provider: Gent.provider.mock(),
          })
          const { client } = yield* Gent.client(server, { cwd })
          const [session] = yield* client.session.list()
          const branchId = yield* Effect.fromNullishOr(session?.activeBranchId)
          const messages = yield* client.message.list({ branchId })
          const calls = messages.flatMap((message) =>
            message.parts.filter((part) => part.type === "tool-call"),
          )
          expect(calls.length).toBeGreaterThan(0)
          expect(yield* rejectedCalls(calls)).toEqual([])
        }).pipe(Effect.timeout("20 seconds")),
      ),
    30_000,
  )
})
