import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AgentName } from "../domain/agent.js"
import { BranchId, SessionId } from "../domain/ids.js"
import { StorageError } from "../domain/storage-error.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"

const CREATE_SESSION_OPERATION = "session.create"
const CREATE_BRANCH_OPERATION = "branch.create"
const FORK_BRANCH_OPERATION = "branch.fork"
const SWITCH_BRANCH_OPERATION = "branch.switch"

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

export const StoredBranchResult = Schema.Struct({
  branchId: BranchId,
})
export type StoredBranchResult = typeof StoredBranchResult.Type

export const StoredSwitchBranchResult = Schema.Struct({
  sessionId: SessionId,
  fromBranchId: BranchId,
  toBranchId: BranchId,
})
export type StoredSwitchBranchResult = typeof StoredSwitchBranchResult.Type

const StoredBranchResultJson = Schema.fromJsonString(StoredBranchResult)
const encodeStoredBranchResult = Schema.encodeEffect(StoredBranchResultJson)
const decodeStoredBranchResult = Schema.decodeUnknownEffect(StoredBranchResultJson)

const StoredSwitchBranchResultJson = Schema.fromJsonString(StoredSwitchBranchResult)
const encodeStoredSwitchBranchResult = Schema.encodeEffect(StoredSwitchBranchResultJson)
const decodeStoredSwitchBranchResult = Schema.decodeUnknownEffect(StoredSwitchBranchResultJson)

export interface SessionOperationStorageService {
  readonly getCreateSession: (
    requestId: string,
  ) => Effect.Effect<StoredCreateSessionResult | undefined, StorageError>
  readonly saveCreateSession: (
    requestId: string,
    result: StoredCreateSessionResult,
  ) => Effect.Effect<void, StorageError>
  readonly getCreateBranch: (
    requestId: string,
  ) => Effect.Effect<StoredBranchResult | undefined, StorageError>
  readonly saveCreateBranch: (
    requestId: string,
    result: StoredBranchResult,
  ) => Effect.Effect<void, StorageError>
  readonly getForkBranch: (
    requestId: string,
  ) => Effect.Effect<StoredBranchResult | undefined, StorageError>
  readonly saveForkBranch: (
    requestId: string,
    result: StoredBranchResult,
  ) => Effect.Effect<void, StorageError>
  readonly getSwitchBranch: (
    requestId: string,
  ) => Effect.Effect<StoredSwitchBranchResult | undefined, StorageError>
  readonly saveSwitchBranch: (
    requestId: string,
    result: StoredSwitchBranchResult,
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

      const getOperation = Effect.fn("SessionOperationStorage.getOperation")(function* <A>(
        operation: string,
        requestId: string,
        decode: (json: string) => Effect.Effect<A, unknown>,
      ) {
        const workspaceId = yield* CurrentWorkspaceId
        const rows = yield* sql<{ result_json: string }>`
          SELECT result_json
          FROM durable_operations
          WHERE workspace_id = ${workspaceId}
            AND operation = ${operation}
            AND request_id = ${requestId}
          LIMIT 1
        `
        const row = rows[0]
        if (row === undefined) return undefined
        return yield* decode(row.result_json)
      })

      const saveOperation = Effect.fn("SessionOperationStorage.saveOperation")(function* <A>(
        operation: string,
        requestId: string,
        result: A,
        encode: (value: A) => Effect.Effect<string, unknown>,
      ) {
        const workspaceId = yield* CurrentWorkspaceId
        const resultJson = yield* encode(result)
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
            ${operation},
            ${requestId},
            ${resultJson},
            ${createdAt}
          )
        `
      })

      return {
        getCreateSession: Effect.fn("SessionOperationStorage.getCreateSession")(
          function* (requestId) {
            return yield* getOperation(
              CREATE_SESSION_OPERATION,
              requestId,
              decodeStoredCreateSessionResult,
            )
          },
          Effect.mapError(mapError("Failed to get create-session operation result")),
        ),

        saveCreateSession: Effect.fn("SessionOperationStorage.saveCreateSession")(
          function* (requestId, result) {
            yield* saveOperation(
              CREATE_SESSION_OPERATION,
              requestId,
              result,
              encodeStoredCreateSessionResult,
            )
          },
          Effect.mapError(mapError("Failed to save create-session operation result")),
        ),

        getCreateBranch: Effect.fn("SessionOperationStorage.getCreateBranch")(
          function* (requestId) {
            return yield* getOperation(CREATE_BRANCH_OPERATION, requestId, decodeStoredBranchResult)
          },
          Effect.mapError(mapError("Failed to get create-branch operation result")),
        ),

        saveCreateBranch: Effect.fn("SessionOperationStorage.saveCreateBranch")(
          function* (requestId, result) {
            yield* saveOperation(
              CREATE_BRANCH_OPERATION,
              requestId,
              result,
              encodeStoredBranchResult,
            )
          },
          Effect.mapError(mapError("Failed to save create-branch operation result")),
        ),

        getForkBranch: Effect.fn("SessionOperationStorage.getForkBranch")(
          function* (requestId) {
            return yield* getOperation(FORK_BRANCH_OPERATION, requestId, decodeStoredBranchResult)
          },
          Effect.mapError(mapError("Failed to get fork-branch operation result")),
        ),

        saveForkBranch: Effect.fn("SessionOperationStorage.saveForkBranch")(
          function* (requestId, result) {
            yield* saveOperation(FORK_BRANCH_OPERATION, requestId, result, encodeStoredBranchResult)
          },
          Effect.mapError(mapError("Failed to save fork-branch operation result")),
        ),

        getSwitchBranch: Effect.fn("SessionOperationStorage.getSwitchBranch")(
          function* (requestId) {
            return yield* getOperation(
              SWITCH_BRANCH_OPERATION,
              requestId,
              decodeStoredSwitchBranchResult,
            )
          },
          Effect.mapError(mapError("Failed to get switch-branch operation result")),
        ),

        saveSwitchBranch: Effect.fn("SessionOperationStorage.saveSwitchBranch")(
          function* (requestId, result) {
            yield* saveOperation(
              SWITCH_BRANCH_OPERATION,
              requestId,
              result,
              encodeStoredSwitchBranchResult,
            )
          },
          Effect.mapError(mapError("Failed to save switch-branch operation result")),
        ),
      } satisfies SessionOperationStorageService
    }),
  )
}
