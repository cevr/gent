import { Predicate, Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AgentName, RunSpecSchema, DEFAULT_MAX_CHILD_MODEL_ATTEMPTS } from "../domain/agent.js"
import { BranchId, MessageId, RequestId, SessionId, ToolCallId } from "../domain/ids.js"
import { StorageError } from "../domain/storage-error.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"

const CREATE_SESSION_OPERATION = "session.create"
const CREATE_BRANCH_OPERATION = "branch.create"
const FORK_BRANCH_OPERATION = "branch.fork"
const SWITCH_BRANCH_OPERATION = "branch.switch"
const START_AGENT_OPERATION = "agent.start"
const CANCEL_TURN_OPERATION = "turn.cancel"
const CHILD_MODEL_BUDGET_OPERATION = "agent.model-budget"

export const TurnCancellationAddress = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  messageId: MessageId,
})
export interface TurnCancellationAddress extends Schema.Schema.Type<
  typeof TurnCancellationAddress
> {}

export const StoredAgentStartInput = Schema.Struct({
  parentSessionId: SessionId,
  parentBranchId: BranchId,
  agentName: AgentName,
  prompt: Schema.String,
  cwd: Schema.String,
  toolCallId: Schema.optional(ToolCallId),
  runSpec: Schema.optional(RunSpecSchema),
})
export const StoredAgentStartResult = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  input: StoredAgentStartInput,
})
export type StoredAgentStartResult = typeof StoredAgentStartResult.Type
const StoredAgentStartResultJson = Schema.fromJsonString(StoredAgentStartResult)
const decodeStoredAgentStartResult = Schema.decodeUnknownEffect(StoredAgentStartResultJson)

/** One parent-owned child registry row. Completed means the admitted turn has a receipt. */
export interface AgentStartRegistryRow {
  readonly requestId: RequestId
  readonly result: StoredAgentStartResult
  readonly completed: boolean
}

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
  /** None: no admitted child. Some(false): exhausted. A successful reservation is never refunded. */
  readonly reserveChildModelAttempt: (address: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
  }) => Effect.Effect<Option.Option<boolean>, StorageError>
  readonly countPendingAgentStarts: (parent: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
  }) => Effect.Effect<number, StorageError>
  readonly cancelTurn: (address: TurnCancellationAddress) => Effect.Effect<void, StorageError>
  readonly isTurnCancelled: (
    address: TurnCancellationAddress,
  ) => Effect.Effect<boolean, StorageError>
  readonly getAgentStart: (
    requestId: RequestId,
  ) => Effect.Effect<Option.Option<StoredAgentStartResult>, StorageError>
  /** The authoritative child registry. None lists every start in the workspace. */
  readonly listAgentStarts: (
    parent: Option.Option<{ readonly sessionId: SessionId; readonly branchId: BranchId }>,
  ) => Effect.Effect<ReadonlyArray<AgentStartRegistryRow>, StorageError>
  readonly saveAgentStart: (
    requestId: RequestId,
    result: StoredAgentStartResult,
  ) => Effect.Effect<void, StorageError>
  readonly getCreateSession: (
    requestId: RequestId,
    // oxlint-disable-next-line effect/noNullish -- Idempotency lookup uses undefined when no row exists.
  ) => Effect.Effect<StoredCreateSessionResult | undefined, StorageError>
  readonly saveCreateSession: (
    requestId: RequestId,
    result: StoredCreateSessionResult,
  ) => Effect.Effect<void, StorageError>
  readonly getCreateBranch: (
    requestId: RequestId,
    // oxlint-disable-next-line effect/noNullish -- Idempotency lookup uses undefined when no row exists.
  ) => Effect.Effect<StoredBranchResult | undefined, StorageError>
  readonly saveCreateBranch: (
    requestId: RequestId,
    result: StoredBranchResult,
  ) => Effect.Effect<void, StorageError>
  readonly getForkBranch: (
    requestId: RequestId,
    // oxlint-disable-next-line effect/noNullish -- Idempotency lookup uses undefined when no row exists.
  ) => Effect.Effect<StoredBranchResult | undefined, StorageError>
  readonly saveForkBranch: (
    requestId: RequestId,
    result: StoredBranchResult,
  ) => Effect.Effect<void, StorageError>
  readonly getSwitchBranch: (
    requestId: RequestId,
    // oxlint-disable-next-line effect/noNullish -- Idempotency lookup uses undefined when no row exists.
  ) => Effect.Effect<StoredSwitchBranchResult | undefined, StorageError>
  readonly saveSwitchBranch: (
    requestId: RequestId,
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
        // oxlint-disable-next-line effect/noNullish -- Idempotency lookup uses undefined when no row exists.
        if (Predicate.isUndefined(row)) return undefined
        return yield* decode(row.result_json)
      })

      const saveOperation = Effect.fn("SessionOperationStorage.saveOperation")(function* <A>(
        operation: string,
        requestId: string,
        result: A,
        encode: (value: A) => Effect.Effect<string, unknown>,
        subject: { readonly sessionId: SessionId; readonly branchId: BranchId },
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
            subject_session_id,
            subject_branch_id,
            created_at
          )
          VALUES (
            ${workspaceId},
            ${operation},
            ${requestId},
            ${resultJson},
            ${subject.sessionId},
            ${subject.branchId},
            ${createdAt}
          )
        `
      })

      const sessionIdForBranch = Effect.fn("SessionOperationStorage.sessionIdForBranch")(function* (
        branchId: BranchId,
      ) {
        const workspaceId = yield* CurrentWorkspaceId
        const rows = yield* sql<{ session_id: SessionId }>`
          SELECT b.session_id
          FROM branches b
          JOIN sessions s ON s.id = b.session_id
          WHERE b.id = ${branchId}
            AND s.workspace_id = ${workspaceId}
          LIMIT 1
        `
        const row = rows[0]
        if (Predicate.isUndefined(row)) {
          return yield* new StorageError({
            message: `Cannot persist durable operation for missing branch: ${branchId}`,
          })
        }
        return row.session_id
      })

      return {
        reserveChildModelAttempt: Effect.fn("SessionOperationStorage.reserveChildModelAttempt")(
          function* (address) {
            if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
              return yield* new StorageError({
                message: "Model admission must commit outside a caller transaction",
              })
            }
            const sessionId = yield* sessionIdForBranch(address.branchId)
            if (sessionId !== address.sessionId)
              return yield* new StorageError({ message: "Model branch does not belong to session" })
            const workspaceId = yield* CurrentWorkspaceId
            const starts = yield* sql<{
              request_id: string
              subject_session_id: string
              subject_branch_id: string
            }>`
              SELECT request_id, subject_session_id, subject_branch_id FROM durable_operations
              WHERE workspace_id = ${workspaceId} AND operation = ${START_AGENT_OPERATION}
                AND json_extract(result_json, '$.sessionId') = ${address.sessionId}
              LIMIT 1`
            const start = starts[0]
            if (Predicate.isUndefined(start)) return Option.none<boolean>()
            const createdAt = (yield* DateTime.nowAsDate).getTime()
            const reserved = yield* sql`
              INSERT INTO durable_operations (
                workspace_id, operation, request_id, result_json,
                subject_session_id, subject_branch_id, created_at
              ) VALUES (
                ${workspaceId}, ${CHILD_MODEL_BUDGET_OPERATION}, ${start.request_id}, '{"attempts":1}',
                ${start.subject_session_id}, ${start.subject_branch_id}, ${createdAt}
              ) ON CONFLICT(workspace_id, operation, request_id) DO UPDATE SET
                result_json = json_set(durable_operations.result_json, '$.attempts',
                  json_extract(durable_operations.result_json, '$.attempts') + 1)
              WHERE json_extract(durable_operations.result_json, '$.attempts') < ${DEFAULT_MAX_CHILD_MODEL_ATTEMPTS}
              RETURNING request_id`
            return Option.some(reserved.length === 1)
          },
          Effect.mapError(mapError("Failed to reserve child model attempt")),
        ),
        countPendingAgentStarts: Effect.fn("SessionOperationStorage.countPendingAgentStarts")(
          function* (parent) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows = yield* sql`SELECT COUNT(*) AS pending FROM durable_operations d
              WHERE d.workspace_id = ${workspaceId}
                AND d.operation = ${START_AGENT_OPERATION}
                AND d.subject_session_id = ${parent.sessionId}
                AND d.subject_branch_id = ${parent.branchId}
                AND NOT EXISTS (
                  SELECT 1 FROM messages m
                  WHERE m.id = 'agent-start:' || d.request_id
                    AND m.session_id = json_extract(d.result_json, '$.sessionId')
                    AND m.branch_id = json_extract(d.result_json, '$.branchId')
                    AND m.turn_duration_ms IS NOT NULL
                )`
            const row = yield* Schema.decodeUnknownEffect(Schema.Struct({ pending: Schema.Int }))(
              rows[0],
            )
            return row.pending
          },
          Effect.mapError(mapError("Failed to count pending agent starts")),
        ),
        cancelTurn: Effect.fn("SessionOperationStorage.cancelTurn")(
          function* (address) {
            const workspaceId = yield* CurrentWorkspaceId
            const sessionId = yield* sessionIdForBranch(address.branchId)
            if (sessionId !== address.sessionId) {
              return yield* new StorageError({
                message: "Cancellation branch does not belong to session",
              })
            }
            const createdAt = (yield* DateTime.nowAsDate).getTime()
            yield* sql`INSERT INTO durable_operations (
              workspace_id, operation, request_id, result_json,
              subject_session_id, subject_branch_id, created_at
            ) VALUES (
              ${workspaceId}, ${CANCEL_TURN_OPERATION}, ${address.messageId}, '{}',
              ${address.sessionId}, ${address.branchId}, ${createdAt}
            ) ON CONFLICT(workspace_id, operation, request_id) DO NOTHING`
            const owned = yield* sql`SELECT 1 FROM durable_operations
              WHERE workspace_id = ${workspaceId}
                AND operation = ${CANCEL_TURN_OPERATION}
                AND request_id = ${address.messageId}
                AND subject_session_id = ${address.sessionId}
                AND subject_branch_id = ${address.branchId}`
            if (owned.length === 0) {
              return yield* new StorageError({
                message: "Cancellation receipt belongs to another turn",
              })
            }
          },
          Effect.mapError(mapError("Failed to record turn cancellation")),
        ),
        isTurnCancelled: Effect.fn("SessionOperationStorage.isTurnCancelled")(
          function* (address) {
            const workspaceId = yield* CurrentWorkspaceId
            const rows = yield* sql`SELECT 1 FROM durable_operations
              WHERE workspace_id = ${workspaceId}
                AND operation = ${CANCEL_TURN_OPERATION}
                AND request_id = ${address.messageId}
                AND subject_session_id = ${address.sessionId}
                AND subject_branch_id = ${address.branchId}
              LIMIT 1`
            return rows.length > 0
          },
          Effect.mapError(mapError("Failed to read turn cancellation")),
        ),
        listAgentStarts: Effect.fn("SessionOperationStorage.listAgentStarts")(
          function* (parent) {
            const workspaceId = yield* CurrentWorkspaceId
            const completed = sql`EXISTS (
                  SELECT 1 FROM messages m
                  WHERE m.id = 'agent-start:' || d.request_id
                    AND m.session_id = json_extract(d.result_json, '$.sessionId')
                    AND m.branch_id = json_extract(d.result_json, '$.branchId')
                    AND m.turn_duration_ms IS NOT NULL
                )`
            const rows = yield* Option.match(parent, {
              onNone: () => sql<{ request_id: string; result_json: string; completed: number }>`
                SELECT d.request_id, d.result_json, ${completed} AS completed
                FROM durable_operations d
                WHERE d.workspace_id = ${workspaceId} AND d.operation = ${START_AGENT_OPERATION}
                ORDER BY d.created_at, d.request_id`,
              onSome: (owner) => sql<{
                request_id: string
                result_json: string
                completed: number
              }>`
                SELECT d.request_id, d.result_json, ${completed} AS completed
                FROM durable_operations d
                WHERE d.workspace_id = ${workspaceId} AND d.operation = ${START_AGENT_OPERATION}
                  AND d.subject_session_id = ${owner.sessionId}
                  AND d.subject_branch_id = ${owner.branchId}
                ORDER BY d.created_at, d.request_id`,
            })
            return yield* Effect.forEach(rows, (row) =>
              decodeStoredAgentStartResult(row.result_json).pipe(
                Effect.map((result): AgentStartRegistryRow => ({
                  requestId: RequestId.make(row.request_id),
                  result,
                  completed: row.completed === 1,
                })),
              ),
            )
          },
          Effect.mapError(mapError("Failed to list agent-start receipts")),
        ),
        getAgentStart: Effect.fn("SessionOperationStorage.getAgentStart")(
          (requestId) =>
            getOperation(
              START_AGENT_OPERATION,
              requestId,
              Schema.decodeUnknownEffect(StoredAgentStartResultJson),
            ).pipe(Effect.map(Option.fromUndefinedOr)),
          Effect.mapError(mapError("Failed to get agent-start receipt")),
        ),
        saveAgentStart: Effect.fn("SessionOperationStorage.saveAgentStart")(
          (requestId, result) =>
            saveOperation(
              START_AGENT_OPERATION,
              requestId,
              result,
              Schema.encodeEffect(StoredAgentStartResultJson),
              { sessionId: result.input.parentSessionId, branchId: result.input.parentBranchId },
            ),
          Effect.mapError(mapError("Failed to save agent-start receipt")),
        ),
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
              { sessionId: result.sessionId, branchId: result.branchId },
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
            const sessionId = yield* sessionIdForBranch(result.branchId)
            yield* saveOperation(
              CREATE_BRANCH_OPERATION,
              requestId,
              result,
              encodeStoredBranchResult,
              { sessionId, branchId: result.branchId },
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
            const sessionId = yield* sessionIdForBranch(result.branchId)
            yield* saveOperation(
              FORK_BRANCH_OPERATION,
              requestId,
              result,
              encodeStoredBranchResult,
              {
                sessionId,
                branchId: result.branchId,
              },
            )
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
              { sessionId: result.sessionId, branchId: result.toBranchId },
            )
          },
          Effect.mapError(mapError("Failed to save switch-branch operation result")),
        ),
      } satisfies SessionOperationStorageService
    }),
  )
}
