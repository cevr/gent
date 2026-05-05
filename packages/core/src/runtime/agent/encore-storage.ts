/**
 * EncoreMessageStorage adapter for gent.
 *
 * Layers `effect/unstable/cluster/SqlMessageStorage` (provides upstream
 * `MessageStorage` over an `SqlClient`) with `effect-encore`'s
 * `EncoreMessageStorage` Tag so `Actor.rerun` can do a surgical
 * single-envelope delete instead of coarsening to `flush`. Without this,
 * any per-op `.rerun` fails loud per encore's contract.
 *
 * Table prefix matches the upstream `SqlMessageStorage` default of
 * `"cluster"` — the cluster substrate manages `cluster_messages` and
 * `cluster_replies` rows; `deleteEnvelope` removes one envelope (and its
 * replies) by Snowflake id.
 *
 * The `encoreMessageStorageLayer` helper expects a static
 * `deleteEnvelope: (requestId) => Effect<void, PersistenceError>` (no
 * service requirements), which doesn't match a SQL-backed implementation.
 * We build the layer manually instead: yield the upstream
 * `MessageStorage` plus the `SqlClient`, then call `fromMessageStorage`
 * with a closure that captures the sql instance.
 *
 * @module
 */

import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  ClusterError,
  MessageStorage,
  ShardingConfig,
  SqlMessageStorage,
} from "effect/unstable/cluster"
import { EncoreMessageStorage, fromMessageStorage } from "effect-encore"

const PREFIX = "cluster"

const messagesTable = `${PREFIX}_messages`
const repliesTable = `${PREFIX}_replies`

const upstreamLayer: Layer.Layer<
  MessageStorage.MessageStorage,
  never,
  SqlClient.SqlClient | ShardingConfig.ShardingConfig
> = SqlMessageStorage.layer

const encoreTagLayer = Layer.effect(
  EncoreMessageStorage,
  Effect.gen(function* () {
    const upstream = yield* MessageStorage.MessageStorage
    const sql = yield* SqlClient.SqlClient
    return fromMessageStorage(upstream, {
      deleteEnvelope: (requestId) => {
        const id = String(requestId)
        return sql`DELETE FROM ${sql(repliesTable)} WHERE request_id = ${id}`.pipe(
          Effect.andThen(sql`DELETE FROM ${sql(messagesTable)} WHERE request_id = ${id}`),
          sql.withTransaction,
          Effect.asVoid,
          (effect) => ClusterError.PersistenceError.refail(effect),
        )
      },
    })
  }),
)

/**
 * Encore message-storage layer over gent's SQLite `SqlClient`. Provides
 * BOTH `MessageStorage.MessageStorage` (cluster substrate) and
 * `EncoreMessageStorage` (with `deleteEnvelope` for surgical rerun).
 *
 * Requirements:
 * - `SqlClient.SqlClient` — gent owns this via `SqliteStorage`.
 * - `ShardingConfig.ShardingConfig` — provided by
 *   `ShardingConfig.layerDefaults` unless overridden.
 */
export const EncoreMessageStorageLive = Layer.merge(
  upstreamLayer,
  encoreTagLayer.pipe(Layer.provide(upstreamLayer)),
).pipe(Layer.provide(ShardingConfig.layerDefaults))
