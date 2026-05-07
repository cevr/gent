import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { SqliteClient as BunSqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, FileSystem, Path } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  formatDoctorReport,
  inspectStorage,
  makeDoctorReport,
  resetStorage,
  storagePaths,
} from "../src/ops/local-health"

const createDb = (dbPath: string, statement: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(statement)
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

      const report = formatDoctorReport(yield* makeDoctorReport(home, undefined))
      expect(report).toContain("Gent doctor")
      expect(report).toContain("incompatible")
      expect(report).toContain("Migration table: missing")
    }).pipe(Effect.provide(BunServices.layer)),
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
})
