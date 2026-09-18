/**
 * The cell's storage layers, assembled as one unit.
 *
 * Core's SQLite assembler builds the kernel's tables and takes any extra
 * repositories as a parameter. This is the cell's contribution to that call:
 * the three tables it owns, wired against the same SQL client, so core never
 * names them.
 */

import {
  type BranchToolFeature,
  type BranchToolLayerFactory,
  type FeatureMigrations,
  type GentPlatform,
  type InteractionStorage,
  type ToolCallRecoveryService,
  eraseResourceLayer,
} from "@gent/core/extensions/branch-tools"
import { RetainedBindings } from "../compaction.js"
import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { CellExecution } from "./cell-execution.js"
import { CellExecutionStorage } from "./cell-execution-storage.js"
import { CellNamespaceStorage } from "./cell-namespace-storage.js"
import { CellToolOperationStorage } from "./cell-tool-operation-storage.js"
import type { DispatchingToolStorage } from "./dispatching-tool-storage.js"
import { cellToolCallRecovery } from "./cell-tool-call-recovery.js"

/**
 * The tables the cell owns.
 *
 * Ids continue core's chain rather than starting a new one: one migration
 * sequence runs against one database, so a feature picks the next free ids
 * and keeps them for the life of the schema. These three shipped as 012-014
 * and must keep those ids or an existing database re-runs them.
 */
const cellMigrations: FeatureMigrations = {
  "012_cell_executions": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`
    CREATE TABLE cell_executions (
      assistant_message_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      result_json TEXT,
      completed_at INTEGER,
      PRIMARY KEY (assistant_message_id, tool_call_id),
      CHECK ((result_json IS NULL) = (completed_at IS NULL)),
      FOREIGN KEY (assistant_message_id) REFERENCES messages(id) ON DELETE CASCADE
    )
  `)
  }),
  "013_cell_tool_operations": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`
    CREATE TABLE cell_tool_operations (
      assistant_message_id TEXT NOT NULL,
      cell_tool_call_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      request_id TEXT UNIQUE,
      PRIMARY KEY (assistant_message_id, cell_tool_call_id, operation_id),
      FOREIGN KEY (assistant_message_id, cell_tool_call_id)
        REFERENCES cell_executions(assistant_message_id, tool_call_id) ON DELETE CASCADE
    )
  `)
  }),
  "014_cell_namespaces": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`
    CREATE TABLE cell_namespaces (
      session_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, branch_id),
      FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
    )
  `)
  }),
}

/**
 * Build the cell's repositories over an existing SQL client.
 *
 * `interactionStorage` is passed in rather than rebuilt: operation receipts
 * and interaction records must share one instance, or a suspended approval
 * would be written to a store nothing reads back.
 */
/** What the cell's storage installs. Core merges it without naming it. */
type CellStorageTags = DispatchingToolStorage | RetainedBindings | ToolCallRecoveryService

const cellStorageLayer = <E, R>(
  base: Layer.Layer<SqlClient.SqlClient, E, R>,
  interactionStorage: Layer.Layer<InteractionStorage, E, R>,
): Layer.Layer<CellStorageTags, E, R | GentPlatform> => {
  const tables = Layer.mergeAll(
    Layer.provide(CellExecutionStorage.Live, base),
    Layer.provide(CellNamespaceStorage.Live, base),
    Layer.provide(CellToolOperationStorage.Live, Layer.merge(base, interactionStorage)),
  )
  // The projections ship with the tables. Installing the cell's storage
  // without the answers core reads from it would leave a handoff silently
  // reporting no retained names.
  return Layer.provideMerge(
    Layer.mergeAll(cellRetainedBindings, cellToolCallRecovery),
    Layer.merge(tables, interactionStorage),
  )
}

/**
 * The cell's answer to core's retained-names question: its namespace bindings.
 */
const cellRetainedBindings = Layer.effect(
  RetainedBindings,
  Effect.gen(function* () {
    const namespaces = yield* CellNamespaceStorage
    return RetainedBindings.of({
      list: (params) =>
        namespaces.get(params).pipe(
          Effect.map(
            Option.match({
              onNone: (): ReadonlyArray<string> => [],
              onSome: (snapshot) => snapshot.bindings.map((binding) => binding.name),
            }),
          ),
        ),
    })
  }),
)

/**
 * The cell's branch-scoped layer, as the feature's per-branch factory.
 *
 * The cell kernel lives for the life of a branch: one worker process holding a
 * namespace across turns. It is built with the loop and torn down with it.
 */
const cellBranchLayer: BranchToolLayerFactory = (input) =>
  eraseResourceLayer(CellExecution.Branch(input))

/**
 * The cell, as one thing a composition root can install.
 *
 * Its tables, the migrations that create them, and its per-branch kernel are
 * useless apart: the kernel writes rows only the cell's storage reads back.
 * Bundling them is what lets core take the cell as input instead of naming it.
 */
export const CellBranchTools: BranchToolFeature<CellStorageTags> = {
  migrations: cellMigrations,
  storage: cellStorageLayer,
  branchLayer: cellBranchLayer,
}
