import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { SqliteClient as BunSqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, FileSystem, Layer, Option, Path } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform"
import {
  ExtensionHealth,
  ExtensionHealthIssue,
  ExtensionHealthSnapshot,
} from "@gent/core-internal/server/transport-contract"
import {
  extensionHealthFromSnapshot,
  formatDoctorReport,
  inspectResourceGraphs,
  inspectStorage,
  makeDoctorReport,
  resetStorage,
  storagePaths,
} from "../src/ops/local-health"

const absentServerEntry = Option.getOrUndefined(Option.none())

const createDb = (dbPath: string, ...statements: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const statement of statements) yield* sql.unsafe(statement)
  }).pipe(Effect.provide(BunSqliteClient.layer({ filename: dbPath })))

describe("local health", () => {
  it.scopedLive("reports incompatible storage tables without migration records", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const { dbPath } = storagePaths(home)
      yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true })
      yield* createDb(
        dbPath,
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      )

      const storage = yield* inspectStorage(home)
      expect(storage.status).toBe("incompatible")
      expect(storage.existingStorageTables).toEqual(["sessions"])
      expect(storage.migrationCount).toBe(0)

      const report = formatDoctorReport(yield* makeDoctorReport(home, absentServerEntry))
      expect(report).toContain("Gent doctor")
      expect(report).toContain("incompatible")
      expect(report).toContain("Migration table: missing")
      expect(report).toContain("Extensions:")
      expect(report).toContain("No live shared server.")
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, GentPlatform.Test()))),
  )

  it.scopedLive("doctor report includes degraded extension resource health", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const extensionHealth = extensionHealthFromSnapshot(
        ExtensionHealthSnapshot.cases.degraded.make({
          healthyExtensions: [],
          degradedExtensions: [
            ExtensionHealth.cases.degraded.make({
              manifest: { id: "@test/broken-resource" },
              scope: "builtin",
              sourcePath: "builtin",
              issues: [
                ExtensionHealthIssue.cases["activation-failed"].make({
                  phase: "startup",
                  error: "resource start boom",
                }),
              ],
            }),
          ],
        }),
      )

      const report = formatDoctorReport(
        yield* makeDoctorReport(home, absentServerEntry, extensionHealth),
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
      const { dbPath } = storagePaths(home)
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

  it.scopedLive("storage reset is idempotent when no db files exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const result = yield* resetStorage(home)
      expect(result.archiveDir).toBeUndefined()
      expect(result.archived).toEqual([])
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive("doctor report lists saved resource graphs that need attention", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const { dbPath } = storagePaths(home)
      yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true })
      yield* createDb(
        dbPath,
        "CREATE TABLE gent_storage_migrations (name TEXT PRIMARY KEY)",
        "CREATE TABLE resource_graph_state (workspace_id TEXT NOT NULL, cwd TEXT NOT NULL, state TEXT NOT NULL, failure_json TEXT, updated_at INTEGER NOT NULL)",
        "INSERT INTO resource_graph_state VALUES ('ws-1', '/repo/a', 'applied', NULL, 2)",
        `INSERT INTO resource_graph_state VALUES ('ws-1', '/repo/b', 'failed', '{"message":"module import failed"}', 1)`,
      )

      const health = yield* inspectResourceGraphs(dbPath)
      expect(health.status).toBe("attention")
      expect(health.entries.map((entry) => entry.state)).toEqual(["applied", "failed"])

      const report = formatDoctorReport(yield* makeDoctorReport(home, absentServerEntry))
      expect(report).toContain("Resources:")
      expect(report).toContain("applied /repo/a (workspace ws-1)")
      expect(report).toContain("failed /repo/b (workspace ws-1)")
      expect(report).toContain("failure: module import failed")
      expect(report).toContain("No per-cwd repair exists.")
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, GentPlatform.Test()))),
  )

  it.scopedLive("doctor report says when no resource graphs are saved", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const { dbPath } = storagePaths(home)
      yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true })
      yield* createDb(dbPath, "CREATE TABLE gent_storage_migrations (name TEXT PRIMARY KEY)")

      const report = formatDoctorReport(yield* makeDoctorReport(home, absentServerEntry))
      expect(report).toContain("No saved resource graphs.")
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, GentPlatform.Test()))),
  )
})
