/**
 * The cell's storage layers, assembled as one unit.
 *
 * Core's SQLite assembler builds the kernel's tables and takes any extra
 * repositories as a parameter. This is the cell's contribution to that call:
 * the three tables it owns, wired against the same SQL client, so core never
 * names them.
 */

import { Effect, Layer, Option } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { InteractionStorage } from "../../storage/interaction-storage.js"
import { CellExecution } from "./cell-execution.js"
import type { BranchToolLayerFactory } from "../agent/branch-tool-layer.js"
import { eraseResourceLayer } from "../extensions/extension-effect-membrane.js"
import { CellExecutionStorage } from "./cell-execution-storage.js"
import { CellNamespaceStorage } from "./cell-namespace-storage.js"
import { CellToolOperationStorage } from "./cell-tool-operation-storage.js"
import type { GentPlatform } from "../gent-platform.js"
import type { DispatchingToolStorage } from "./dispatching-tool-storage.js"
import { InnerOperationReceipts } from "../../domain/inner-operation-receipts.js"
import { RetainedBindings } from "../../domain/retained-bindings.js"
import type { ToolCallRecoveryService } from "../../domain/tool-call-recovery.js"
import { cellToolCallRecovery } from "./cell-tool-call-recovery.js"

/**
 * Build the cell's repositories over an existing SQL client.
 *
 * `interactionStorage` is passed in rather than rebuilt: operation receipts
 * and interaction records must share one instance, or a suspended approval
 * would be written to a store nothing reads back.
 */
export const cellStorageLayer = <E, R>(
  base: Layer.Layer<SqlClient.SqlClient, E, R>,
  interactionStorage: Layer.Layer<InteractionStorage, E, R>,
): Layer.Layer<
  DispatchingToolStorage | InnerOperationReceipts | RetainedBindings | ToolCallRecoveryService,
  E,
  R | GentPlatform
> => {
  const tables = Layer.mergeAll(
    Layer.provide(CellExecutionStorage.Live, base),
    Layer.provide(CellNamespaceStorage.Live, base),
    Layer.provide(CellToolOperationStorage.Live, Layer.merge(base, interactionStorage)),
  )
  // The projections ship with the tables. Installing the cell's storage
  // without the answers core reads from it would leave compaction silently
  // reporting no receipts and no retained names.
  return Layer.provideMerge(
    Layer.mergeAll(cellInnerOperationReceipts, cellRetainedBindings, cellToolCallRecovery),
    Layer.merge(tables, interactionStorage),
  )
}

/**
 * The cell's answer to core's inner-operation question.
 *
 * Compaction asks what a tool call dispatched; the cell's receipts know. This
 * projects them to the shape core reads, dropping the storage key it does not
 * need.
 */
export const cellInnerOperationReceipts = Layer.effect(
  InnerOperationReceipts,
  Effect.gen(function* () {
    const storage = yield* CellToolOperationStorage
    return InnerOperationReceipts.of({
      listForToolCall: (params) =>
        storage
          .listForToolCall(params)
          .pipe(Effect.map((rows) => rows.map(({ operation }) => operation))),
    })
  }),
)

/**
 * The cell's answer to core's retained-names question: its namespace bindings.
 */
export const cellRetainedBindings = Layer.effect(
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
 * The cell's branch-scoped layer, as the loop's `BranchToolLayer` factory.
 *
 * The cell kernel lives for the life of a branch: one worker process holding a
 * namespace across turns. It is built with the loop and torn down with it.
 */
export const cellBranchLayer: BranchToolLayerFactory = (input) =>
  eraseResourceLayer(CellExecution.Branch(input))
