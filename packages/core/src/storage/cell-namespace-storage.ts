import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { BranchId, SessionId } from "../domain/ids.js"
import { StorageError } from "../domain/storage-error.js"
import { CellSnapshot } from "../runtime/code-cell/cell-snapshot.js"

const SnapshotJson = Schema.fromJsonString(CellSnapshot)
const NamespaceRow = Schema.Struct({ snapshot_json: Schema.String })

export interface CellNamespaceAddress {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

export interface CellNamespaceStorageService {
  readonly get: (
    address: CellNamespaceAddress,
  ) => Effect.Effect<Option.Option<CellSnapshot>, StorageError>
  readonly set: (
    address: CellNamespaceAddress,
    snapshot: CellSnapshot,
  ) => Effect.Effect<void, StorageError>
  readonly clear: (address: CellNamespaceAddress) => Effect.Effect<void, StorageError>
}

const storageFailure = (cause: unknown) => {
  if (Schema.is(StorageError)(cause)) return cause
  return new StorageError({ message: "Failed to record cell namespace", cause })
}

/** The host owns the last good cell namespace per branch so a worker restart restores it. */
export class CellNamespaceStorage extends Context.Service<
  CellNamespaceStorage,
  CellNamespaceStorageService
>()("@gent/core/src/storage/cell-namespace-storage/CellNamespaceStorage") {
  static Live = Layer.effect(
    CellNamespaceStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const get = Effect.fn("CellNamespaceStorage.get")(function* (address: CellNamespaceAddress) {
        return yield* Effect.gen(function* () {
          const rows = yield* sql<typeof NamespaceRow.Type>`
            SELECT snapshot_json FROM cell_namespaces
            WHERE session_id = ${address.sessionId} AND branch_id = ${address.branchId}
          `
          const row = Option.fromUndefinedOr(rows[0])
          if (Option.isNone(row)) return Option.none<CellSnapshot>()
          const decoded = yield* Schema.decodeEffect(NamespaceRow)(row.value)
          return Option.some(yield* Schema.decodeEffect(SnapshotJson)(decoded.snapshot_json))
        }).pipe(Effect.mapError(storageFailure))
      })
      const set = Effect.fn("CellNamespaceStorage.set")(function* (
        address: CellNamespaceAddress,
        snapshot: CellSnapshot,
      ) {
        yield* Effect.gen(function* () {
          const json = yield* Schema.encodeEffect(SnapshotJson)(snapshot)
          const now = yield* DateTime.now
          yield* sql`
            INSERT INTO cell_namespaces (session_id, branch_id, snapshot_json, updated_at)
            VALUES (${address.sessionId}, ${address.branchId}, ${json}, ${DateTime.toEpochMillis(now)})
            ON CONFLICT (session_id, branch_id)
            DO UPDATE SET snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at
          `
        }).pipe(Effect.mapError(storageFailure))
      })
      const clear = Effect.fn("CellNamespaceStorage.clear")(function* (
        address: CellNamespaceAddress,
      ) {
        yield* sql`
          DELETE FROM cell_namespaces
          WHERE session_id = ${address.sessionId} AND branch_id = ${address.branchId}
        `.pipe(Effect.mapError(storageFailure))
      })
      return CellNamespaceStorage.of({ get, set, clear })
    }),
  )
}
