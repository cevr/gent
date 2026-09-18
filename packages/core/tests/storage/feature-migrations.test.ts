/**
 * Core's migration chain leaves room for the tables a feature owns.
 *
 * Core assembles the kernel's tables and nothing else. A feature that owns
 * tables contributes its own migrations at the same seam it contributes its
 * repositories, so core never names them.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteStorage } from "../../src/storage/storage"
import type { FeatureMigrations } from "../../src/storage/schema"

const appliedMigrations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    name: string
  }>`SELECT name FROM gent_storage_migrations ORDER BY migration_id`
  return rows.map((row) => row.name)
})

const tableExists = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      name: string
    }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`
    return rows.length > 0
  })

const widgetMigrations: FeatureMigrations = {
  "021_widgets": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`CREATE TABLE widgets (id TEXT PRIMARY KEY)`)
  }),
}

const kernelOnly = SqliteStorage.TestWithSql(() => Layer.empty, {})
const withWidgets = SqliteStorage.TestWithSql(() => Layer.empty, widgetMigrations)

describe("feature migrations", () => {
  it.live("core builds only the kernel's tables when no feature contributes any", () =>
    Effect.gen(function* () {
      expect(yield* tableExists("widgets")).toBe(false)
      expect(yield* appliedMigrations).not.toContain("widgets")
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the storage layer under test.
    }).pipe(Effect.provide(kernelOnly)),
  )

  it.live("a feature's tables join the chain after core's", () =>
    Effect.gen(function* () {
      const names = yield* appliedMigrations
      expect(yield* tableExists("widgets")).toBe(true)
      expect(names.at(-1)).toBe("widgets")
      expect(names.indexOf("widgets")).toBeGreaterThan(names.indexOf("message_insertion_order"))
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the storage layer under test.
    }).pipe(Effect.provide(withWidgets)),
  )
})
