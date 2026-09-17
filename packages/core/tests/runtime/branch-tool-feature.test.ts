/**
 * A branch-tool feature is input to the runtime, not part of it.
 *
 * Core installs whatever feature the composition root names, and works with
 * none. These tests hold that seam open: they build storage from
 * `noBranchTools` and from a synthetic feature, and never mention the cell.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteStorage } from "../../src/storage/sqlite-storage"
import { MessageStorage } from "../../src/storage/message-storage"
import {
  noBranchTools,
  CurrentBranchToolFeature,
  type BranchToolFeature,
} from "../../src/runtime/agent/branch-tool-feature"
import { emptyErasedResourceLayer } from "../../src/runtime/extensions/extension-effect-membrane"

const tableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    name: string
  }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
  return rows.map((row) => row.name)
})

/** A feature that owns one table, standing in for any real one. */
const widgetTools: BranchToolFeature<never> = {
  migrations: {
    "021_widgets": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE widget_slots (id TEXT PRIMARY KEY)`
    }),
  },
  storage: () => Layer.empty,
  branchLayer: () => emptyErasedResourceLayer,
}

describe("branch tool feature", () => {
  it.effect("builds a working runtime store when the deployment ships no feature", () =>
    Effect.gen(function* () {
      // The kernel's own tables are there; nothing else is.
      const tables = yield* tableNames
      expect(tables).toContain("messages")
      expect(tables.some((name) => name.startsWith("widget_"))).toBe(false)

      // And the store works, not merely exists.
      const storage = yield* MessageStorage
      expect(storage).toBeDefined()
    }).pipe(
      Effect.provide(SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations)),
    ),
  )

  it.effect("creates the tables of whichever feature the root names", () =>
    Effect.gen(function* () {
      const tables = yield* tableNames
      expect(tables).toContain("widget_slots")
      expect(tables).toContain("messages")
    }).pipe(Effect.provide(SqliteStorage.TestWithSql(widgetTools.storage, widgetTools.migrations))),
  )

  it.effect("reports the stateless-tools feature when no root bound one", () =>
    Effect.gen(function* () {
      const feature = yield* CurrentBranchToolFeature
      expect(feature).toBe(noBranchTools)
    }),
  )

  it.effect("reports the feature a root bound", () =>
    Effect.gen(function* () {
      const feature = yield* CurrentBranchToolFeature
      expect(feature).toBe(widgetTools)
    }).pipe(Effect.provide(Layer.succeed(CurrentBranchToolFeature, widgetTools))),
  )
})
