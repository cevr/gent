import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AgentName } from "../domain/agent.js"
import { BranchId, SessionId } from "../domain/ids.js"
import { StorageError } from "../domain/storage-error.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"

const CREATE_SESSION_OPERATION = "session.create"

export const StoredCreateSessionResult = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  name: Schema.String,
  initialPrompt: Schema.optional(Schema.String),
  agentOverride: Schema.optional(AgentName),
})
export type StoredCreateSessionResult = typeof StoredCreateSessionResult.Type

const StoredCreateSessionResultJson = Schema.fromJsonString(StoredCreateSessionResult)
const encodeStoredCreateSessionResult = Schema.encodeEffect(StoredCreateSessionResultJson)
const decodeStoredCreateSessionResult = Schema.decodeUnknownEffect(StoredCreateSessionResultJson)

export interface SessionOperationStorageService {
  readonly getCreateSession: (
    requestId: string,
  ) => Effect.Effect<StoredCreateSessionResult | undefined, StorageError>
  readonly saveCreateSession: (
    requestId: string,
    result: StoredCreateSessionResult,
  ) => Effect.Effect<void, StorageError>
}

export class SessionOperationStorage extends Context.Service<
  SessionOperationStorage,
  SessionOperationStorageService
>()("@gent/core/src/storage/session-operation-storage/SessionOperationStorage") {
  static Live: Layer.Layer<SessionOperationStorage, never, SqlClient.SqlClient> = Layer.effect(
    SessionOperationStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const mapError = (message: string) => (cause: unknown) => new StorageError({ message, cause })

      return {
        getCreateSession: Effect.fn("SessionOperationStorage.getCreateSession")(
          function* (requestId) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows = yield* sql<{ result_json: string }>`
              SELECT result_json
              FROM durable_operations
              WHERE workspace_id = ${workspaceId}
                AND operation = ${CREATE_SESSION_OPERATION}
                AND request_id = ${requestId}
              LIMIT 1
            `
            const row = rows[0]
            if (row === undefined) return undefined
            return yield* decodeStoredCreateSessionResult(row.result_json)
          },
          Effect.mapError(mapError("Failed to get create-session operation result")),
        ),

        saveCreateSession: Effect.fn("SessionOperationStorage.saveCreateSession")(
          function* (requestId, result) {
            const workspaceId = yield* CurrentWorkspaceId
            const resultJson = yield* encodeStoredCreateSessionResult(result)
            const createdAt = (yield* DateTime.nowAsDate).getTime()
            yield* sql`
              INSERT INTO durable_operations (
                workspace_id,
                operation,
                request_id,
                result_json,
                created_at
              )
              VALUES (
                ${workspaceId},
                ${CREATE_SESSION_OPERATION},
                ${requestId},
                ${resultJson},
                ${createdAt}
              )
            `
          },
          Effect.mapError(mapError("Failed to save create-session operation result")),
        ),
      } satisfies SessionOperationStorageService
    }),
  )
}
