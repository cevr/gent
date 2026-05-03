import { Context, Effect, Layer } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { StorageError } from "../domain/storage-error.js"

export interface StorageTransactionService {
  readonly withTransaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StorageError, R>
}

export class StorageTransaction extends Context.Service<
  StorageTransaction,
  StorageTransactionService
>()("@gent/core/src/storage/storage-transaction/StorageTransaction") {
  static Live: Layer.Layer<StorageTransaction, never, SqlClient.SqlClient> = Layer.effect(
    StorageTransaction,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return {
        withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          sql
            .withTransaction(effect)
            .pipe(
              Effect.catchIf(SqlError.isSqlError, (error) =>
                Effect.fail(
                  new StorageError({ message: "Failed to run storage transaction", cause: error }),
                ),
              ),
            ),
      } satisfies StorageTransactionService
    }),
  )
}
