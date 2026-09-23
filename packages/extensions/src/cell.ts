import {
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Hash,
  type JsonSchema,
  Latch,
  Layer,
  Option,
  Path,
  Predicate,
  Queue,
  Random,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import {
  BranchId,
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  getToolId,
  getToolPrompt,
  InteractionPendingError,
  type Message,
  MessageId,
  SessionId,
  tool,
  ToolCallId,
  type ToolCapability,
  ToolResultFailure,
} from "@gent/core/extensions/api"
import {
  AgentLoopError,
  type AgentLoopTurnProfile,
  ApprovalDecisionSchema,
  type BranchToolFeature,
  type BranchToolLayerFactory,
  BranchToolWork,
  ContextDirective,
  CurrentAgentLoopTurnProfile,
  CurrentDispatchingCall,
  CurrentInteractionOwner,
  CurrentToolCall,
  eraseResourceLayer,
  type EventPublisher,
  EventStoreError,
  type FeatureMigrations,
  GentPlatform,
  getToolMetadata,
  innerOperationBindingIdentity,
  type InteractionOwnership,
  InteractionRequestId,
  type InteractionRequestRecord,
  InteractionStorage,
  makeOwnedToolCallReader,
  MessageStorage,
  ModelContextLedger,
  neverInterrupted,
  type OwnedToolCallAddress,
  partToText,
  type ResolvedToolCapability,
  resolveStoredToolBinding,
  runAgentLoopTurnProfile,
  StorageError,
  summarizeOutput,
  ToolBindingIdentity,
  ToolCallRecoveryError,
  ToolCallRecoveryOutcome,
  ToolCallRecoveryService,
  ToolId,
  ToolRunner,
  type TurnInterruptionStatus,
} from "@gent/core/extensions/branch-tools"
import { SqlClient } from "effect/unstable/sql"
import * as Prompt from "effect/unstable/ai/Prompt"
import { canonicalJsonString } from "effect-encore"
import {
  CellCatalog,
  CellCatalogEntry,
  type CellEvaluation,
  CellEvaluationError,
  type CellOutputSegment,
  CellRequest,
  cellRequestFd,
  type CellResponse,
  cellResponseFd,
  type CellRestoreReport,
  CellSnapshot,
  decodeCellResponse,
  encodeCellRequest,
  makeBoundedOutput,
  makeCellFrameReader,
  makeCellOutputScanner,
  maximumCallsPerCell,
  maximumCellDisplayHeadLength,
  maximumCellDisplayLength,
  maximumCellSourceLength,
  maximumPendingCellCalls,
  type SnapshotBinding,
  toolPath,
} from "./cell-protocol.js"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as AiTool from "effect/unstable/ai/Tool"
import { RetainedBindings } from "./compaction.js"

// ── input ───────────────────────────────────────────────────────────────────

const CellInput = Schema.Struct({
  code: Schema.String,
  reset: Schema.optionalKey(Schema.Boolean),
})
interface CellInput extends Schema.Schema.Type<typeof CellInput> {}

// ── tool operation storage ──────────────────────────────────────────────────

const CellToolOperationId = Schema.NonEmptyString.check(Schema.isMaxLength(128))
const OperationAddressRow = Schema.Struct({
  operation_id: CellToolOperationId,
})
const CellToolOperationState = Schema.TaggedUnion({
  Started: {},
  Waiting: { requestId: InteractionRequestId },
  Resuming: { requestId: InteractionRequestId, decision: ApprovalDecisionSchema },
  Completed: { result: Prompt.ToolResultPart },
})
const Operation = Schema.Struct({
  toolCallId: ToolCallId,
  binding: ToolBindingIdentity,
  input: Schema.Json,
  state: CellToolOperationState,
})
type CellToolOperation = typeof Operation.Type
const OperationJson = Schema.fromJsonString(Operation)
const Row = Schema.Struct({
  record_json: Schema.String,
  request_id: Schema.NullOr(InteractionRequestId),
})
const DecisionRow = Schema.Struct({ decision_json: Schema.NullOr(Schema.String) })
const LocatedRow = Schema.Struct({
  assistant_message_id: MessageId,
  cell_tool_call_id: ToolCallId,
  operation_id: CellToolOperationId,
  session_id: SessionId,
})
const hasInteraction = Predicate.or(Predicate.isTagged("Waiting"), Predicate.isTagged("Resuming"))

interface CellToolOperationKey {
  readonly cell: OwnedToolCallAddress
  readonly operationId: string
}

interface CellToolOperationStorageService {
  readonly admit: (
    params: CellToolOperationKey & {
      readonly binding: ToolBindingIdentity
      readonly input: Schema.Json
    },
  ) => Effect.Effect<
    { readonly admitted: boolean; readonly operation: CellToolOperation },
    StorageError
  >
  readonly get: (key: CellToolOperationKey) => Effect.Effect<CellToolOperation, StorageError>
  /** Locate an inner operation by the call id its receipt carries, within one branch. */
  readonly findByToolCallId: (params: {
    readonly branchId: BranchId
    readonly toolCallId: ToolCallId
  }) => Effect.Effect<Option.Option<CellToolOperation>, StorageError>
  /** Recover all inner outcomes without relying on a live worker or phase. */
  readonly listForToolCall: (
    cell: OwnedToolCallAddress,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly key: CellToolOperationKey; readonly operation: CellToolOperation }>,
    StorageError
  >
  readonly suspend: (
    key: CellToolOperationKey,
    request: InteractionRequestRecord,
  ) => Effect.Effect<void, StorageError>
  readonly resume: (
    key: CellToolOperationKey,
    requestId: InteractionRequestId,
  ) => Effect.Effect<CellToolOperation, StorageError>
  readonly complete: (
    key: CellToolOperationKey,
    result: Prompt.ToolResultPart,
  ) => Effect.Effect<void, StorageError>
}

/** Every storage fault is a `StorageError`; a foreign cause gets the section's message. */
const cellStorageFailure = (message: string) => (cause: unknown) => {
  if (Schema.is(StorageError)(cause)) return cause
  return new StorageError({ message, cause })
}
const toolOperationStorageFailure = cellStorageFailure("Cell tool operation storage failed")

/** Durable receipts, not a scheduler. Started and Resuming are never reclaimed. */
const makeToolOperationStorage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const platform = yield* GentPlatform
  const interactions = yield* InteractionStorage
  const readOwnedCall = yield* makeOwnedToolCallReader
  const callIdFor = (key: CellToolOperationKey) =>
    ToolCallId.make(
      `cell:${platform.hash("sha256", canonicalJsonString([key.cell.assistantMessageId, key.cell.toolCallId, key.operationId]))}`,
    )
  const ownCell = Effect.fn("CellToolOperationStorage.ownCell")(function* (
    cell: OwnedToolCallAddress,
  ) {
    const call = yield* readOwnedCall(cell)
    if (Option.isNone(call) || call.value.name !== "cell")
      return yield* new StorageError({
        message: "Cell operation is outside the current workspace and branch",
      })
    const rows =
      yield* sql`SELECT 1 FROM cell_executions WHERE assistant_message_id = ${cell.assistantMessageId} AND tool_call_id = ${cell.toolCallId}`
    if (rows.length !== 1)
      return yield* new StorageError({
        message: "Cell operation requires an admitted outer cell",
      })
  })
  const own = Effect.fn("CellToolOperationStorage.own")(function* (key: CellToolOperationKey) {
    yield* Schema.decodeEffect(CellToolOperationId)(key.operationId)
    yield* ownCell(key.cell)
  })
  const read = Effect.fn("CellToolOperationStorage.read")(function* (key: CellToolOperationKey) {
    const rows = yield* sql<
      typeof Row.Type
    >`SELECT record_json, request_id FROM cell_tool_operations WHERE assistant_message_id = ${key.cell.assistantMessageId} AND cell_tool_call_id = ${key.cell.toolCallId} AND operation_id = ${key.operationId}`
    const row = yield* Schema.decodeUnknownEffect(Row)(rows[0])
    const operation = yield* Schema.decodeEffect(OperationJson)(row.record_json)
    if (operation.toolCallId !== callIdFor(key))
      return yield* new StorageError({ message: "Cell operation call identity is corrupt" })
    if (
      operation.state._tag === "Completed" &&
      (operation.state.result.id !== operation.toolCallId ||
        operation.state.result.name !== operation.binding.toolId)
    )
      return yield* new StorageError({
        message: "Stored cell operation result does not match its binding",
      })
    if (hasInteraction(operation.state) && operation.state.requestId !== row.request_id)
      return yield* new StorageError({
        message: "Cell operation interaction identity is corrupt",
      })
    return operation
  })
  const write = Effect.fn("CellToolOperationStorage.write")(function* (
    key: CellToolOperationKey,
    operation: CellToolOperation,
  ) {
    const json = yield* Schema.encodeEffect(OperationJson)(operation)
    yield* sql`UPDATE cell_tool_operations SET record_json = ${json} WHERE assistant_message_id = ${key.cell.assistantMessageId} AND cell_tool_call_id = ${key.cell.toolCallId} AND operation_id = ${key.operationId}`
  })
  const outsideTransaction = Effect.gen(function* () {
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
      return yield* new StorageError({
        message: "Cell operation admission must commit outside a caller transaction",
      })
  })
  const requireOpenCell = Effect.fn("CellToolOperationStorage.requireOpenCell")(function* (
    key: CellToolOperationKey,
  ) {
    const rows =
      yield* sql`SELECT 1 FROM cell_executions WHERE assistant_message_id = ${key.cell.assistantMessageId} AND tool_call_id = ${key.cell.toolCallId} AND result_json IS NULL`
    if (rows.length !== 1)
      return yield* new StorageError({
        message: "Completed cell cannot admit more host effects",
      })
  })
  const admit = Effect.fn("CellToolOperationStorage.admit")(function* (
    params: Parameters<CellToolOperationStorageService["admit"]>[0],
  ) {
    yield* outsideTransaction
    return yield* Effect.gen(function* () {
      yield* own(params)
      yield* requireOpenCell(params)
      const toolCallId = callIdFor(params)
      const operation = yield* Schema.decodeEffect(Operation)({
        toolCallId,
        binding: params.binding,
        input: params.input,
        state: CellToolOperationState.cases.Started.make({}),
      })
      const json = yield* Schema.encodeEffect(OperationJson)(operation)
      const inserted =
        yield* sql`INSERT INTO cell_tool_operations (assistant_message_id, cell_tool_call_id, operation_id, record_json) VALUES (${params.cell.assistantMessageId}, ${params.cell.toolCallId}, ${params.operationId}, ${json}) ON CONFLICT DO NOTHING RETURNING operation_id`
      const existing = yield* read(params)
      const immutable = (value: CellToolOperation) =>
        canonicalJsonString({
          toolCallId: value.toolCallId,
          binding: value.binding,
          input: value.input,
        })
      if (immutable(existing) !== immutable(operation))
        return yield* new StorageError({
          message: "Cell operation input and binding are immutable",
        })
      return { admitted: inserted.length === 1, operation: existing }
    }).pipe(sql.withTransaction, Effect.mapError(toolOperationStorageFailure))
  })
  const get = Effect.fn("CellToolOperationStorage.get")((key: CellToolOperationKey) =>
    own(key).pipe(
      Effect.andThen(read(key)),
      sql.withTransaction,
      Effect.mapError(toolOperationStorageFailure),
    ),
  )
  const findByToolCallId = Effect.fn("CellToolOperationStorage.findByToolCallId")(
    function* (params: { readonly branchId: BranchId; readonly toolCallId: ToolCallId }) {
      return yield* Effect.gen(function* () {
        const rows = yield* sql<typeof LocatedRow.Type>`
            SELECT o.assistant_message_id, o.cell_tool_call_id, o.operation_id, m.session_id
            FROM cell_tool_operations o
            JOIN messages m ON m.id = o.assistant_message_id
            WHERE m.branch_id = ${params.branchId}
              AND json_extract(o.record_json, '$.toolCallId') = ${params.toolCallId}
            LIMIT 1
          `
        const located = Option.fromUndefinedOr(rows[0])
        if (Option.isNone(located)) return Option.none<CellToolOperation>()
        const row = yield* Schema.decodeEffect(LocatedRow)(located.value)
        const cell = {
          sessionId: row.session_id,
          branchId: params.branchId,
          assistantMessageId: row.assistant_message_id,
          toolCallId: row.cell_tool_call_id,
        }
        // Ownership goes through the same workspace-scoped reader as every other access.
        if (Option.isNone(yield* readOwnedCall(cell))) return Option.none<CellToolOperation>()
        return Option.some(yield* read({ cell, operationId: row.operation_id }))
      }).pipe(sql.withTransaction, Effect.mapError(toolOperationStorageFailure))
    },
  )
  const listForToolCall = Effect.fn("CellToolOperationStorage.listForToolCall")(function* (
    cell: OwnedToolCallAddress,
  ) {
    return yield* Effect.gen(function* () {
      yield* ownCell(cell)
      const rows = yield* sql<typeof OperationAddressRow.Type>`
            SELECT operation_id FROM cell_tool_operations
            WHERE assistant_message_id = ${cell.assistantMessageId}
              AND cell_tool_call_id = ${cell.toolCallId}
            ORDER BY operation_id
          `
      return yield* Effect.forEach(rows, (raw) =>
        Effect.gen(function* () {
          const row = yield* Schema.decodeEffect(OperationAddressRow)(raw)
          const key = { cell, operationId: row.operation_id }
          return { key, operation: yield* read(key) }
        }),
      )
    }).pipe(sql.withTransaction, Effect.mapError(toolOperationStorageFailure))
  })
  const interaction = Effect.fn("CellToolOperationStorage.interaction")(function* (
    key: CellToolOperationKey,
    requestId: InteractionRequestId,
  ) {
    const rows = yield* sql<
      typeof DecisionRow.Type
    >`SELECT decision_json FROM interaction_requests WHERE request_id = ${requestId} AND session_id = ${key.cell.sessionId} AND branch_id = ${key.cell.branchId} AND status = 'pending'`
    if (rows.length !== 1)
      return yield* new StorageError({
        message: "Pending interaction does not belong to this operation branch",
      })
    const row = yield* Schema.decodeUnknownEffect(DecisionRow)(rows[0])
    return Option.fromNullishOr(row.decision_json)
  })
  const suspend = Effect.fn("CellToolOperationStorage.suspend")(function* (
    key: CellToolOperationKey,
    request: InteractionRequestRecord,
  ) {
    yield* outsideTransaction
    return yield* Effect.gen(function* () {
      yield* own(key)
      yield* requireOpenCell(key)
      const operation = yield* read(key)
      if (
        request.sessionId !== key.cell.sessionId ||
        request.branchId !== key.cell.branchId ||
        request.status !== "pending" ||
        Option.isSome(Option.fromNullishOr(request.decisionJson))
      )
        return yield* new StorageError({
          message: "Cell operation requires a new approval in its own branch",
        })
      if (operation.state._tag !== "Started" && operation.state._tag !== "Resuming")
        return yield* new StorageError({
          message: "Cell operation cannot wait from its current state",
        })
      yield* interactions.persist(request)
      const requestId = request.requestId
      yield* sql`UPDATE cell_tool_operations SET request_id = ${requestId} WHERE assistant_message_id = ${key.cell.assistantMessageId} AND cell_tool_call_id = ${key.cell.toolCallId} AND operation_id = ${key.operationId}`
      yield* write(key, {
        ...operation,
        state: CellToolOperationState.cases.Waiting.make({ requestId }),
      })
    }).pipe(sql.withTransaction, Effect.mapError(toolOperationStorageFailure))
  })
  const resume = Effect.fn("CellToolOperationStorage.resume")(function* (
    key: CellToolOperationKey,
    requestId: InteractionRequestId,
  ) {
    yield* outsideTransaction
    return yield* Effect.gen(function* () {
      yield* own(key)
      yield* requireOpenCell(key)
      const operation = yield* read(key)
      if (operation.state._tag !== "Waiting" || operation.state.requestId !== requestId)
        return yield* new StorageError({
          message: "Cell operation is not waiting for this request",
        })
      const decisionJson = yield* interaction(key, requestId)
      if (Option.isNone(decisionJson))
        return yield* new StorageError({
          message: "Cell operation has no saved interaction decision",
        })
      const decision = yield* Schema.decodeEffect(Schema.fromJsonString(ApprovalDecisionSchema))(
        decisionJson.value,
      )
      const resumed = {
        ...operation,
        state: CellToolOperationState.cases.Resuming.make({ requestId, decision }),
      }
      yield* write(key, resumed)
      return resumed
    }).pipe(sql.withTransaction, Effect.mapError(toolOperationStorageFailure))
  })
  const complete = Effect.fn("CellToolOperationStorage.complete")(function* (
    key: CellToolOperationKey,
    result: Prompt.ToolResultPart,
  ) {
    return yield* Effect.gen(function* () {
      yield* own(key)
      const operation = yield* read(key)
      if (result.id !== operation.toolCallId || result.name !== operation.binding.toolId)
        return yield* new StorageError({
          message: "Cell operation result does not match its bound call",
        })
      if (operation.state._tag === "Waiting")
        return yield* new StorageError({
          message: "Cell operation must resume before completion",
        })
      const completed = {
        ...operation,
        state: CellToolOperationState.cases.Completed.make({ result }),
      }
      if (operation.state._tag === "Completed") {
        if (
          (yield* Schema.encodeEffect(OperationJson)(operation)) !==
          (yield* Schema.encodeEffect(OperationJson)(completed))
        )
          return yield* new StorageError({ message: "Cell operation result is immutable" })
        return
      }
      yield* write(key, completed)
    }).pipe(sql.withTransaction, Effect.mapError(toolOperationStorageFailure))
  })
  return {
    admit,
    get,
    findByToolCallId,
    listForToolCall,
    suspend,
    resume,
    complete,
  } satisfies CellToolOperationStorageService
})

// ── execution storage ───────────────────────────────────────────────────────

const ResultJson = Schema.fromJsonString(Prompt.ToolResultPart)
const ExecutionRow = Schema.Struct({ result_json: Schema.NullOr(Schema.String) })

/** Incomplete means no recorded result, not proof of a live worker. Never reclaim it. */
const CellExecutionAdmission = Schema.TaggedUnion({
  Claimed: CellInput.fields,
  Incomplete: {},
  Completed: { result: Prompt.ToolResultPart },
})
type CellExecutionAdmission = typeof CellExecutionAdmission.Type
type SavedCellExecution = Exclude<CellExecutionAdmission, { readonly _tag: "Claimed" }>

interface CellExecutionStorageService {
  readonly get: (
    address: OwnedToolCallAddress,
  ) => Effect.Effect<Option.Option<SavedCellExecution>, StorageError>
  /** Commit this claim before evaluation. Do not wrap evaluation in a SQL transaction. */
  readonly claim: (
    address: OwnedToolCallAddress,
  ) => Effect.Effect<CellExecutionAdmission, StorageError>
  readonly complete: (
    address: OwnedToolCallAddress,
    result: Prompt.ToolResultPart,
  ) => Effect.Effect<void, StorageError>
}

const executionStorageFailure = cellStorageFailure("Failed to record cell execution")

/** Outer cell receipts share the message database. They never store a VM continuation. */
const makeExecutionStorage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const readOwnedCall = yield* makeOwnedToolCallReader
  const requireCell = Effect.fn("CellExecutionStorage.requireCell")(function* (
    address: OwnedToolCallAddress,
  ) {
    const call = yield* readOwnedCall(address)
    if (Option.isNone(call) || call.value.name !== "cell") {
      return yield* new StorageError({
        message: "Cell call is not owned by this workspace and branch",
      })
    }
    return call.value
  })
  const readRow = Effect.fn("CellExecutionStorage.readRow")(function* (
    address: OwnedToolCallAddress,
  ) {
    const rows = yield* sql<typeof ExecutionRow.Type>`
          SELECT result_json FROM cell_executions
          WHERE assistant_message_id = ${address.assistantMessageId}
            AND tool_call_id = ${address.toolCallId}
        `
    const row = Option.fromUndefinedOr(rows[0])
    if (Option.isNone(row)) return Option.none<typeof ExecutionRow.Type>()
    return Option.some(yield* Schema.decodeEffect(ExecutionRow)(row.value))
  })
  const get = Effect.fn("CellExecutionStorage.get")(function* (address: OwnedToolCallAddress) {
    return yield* Effect.gen(function* () {
      yield* requireCell(address)
      const row = yield* readRow(address)
      if (Option.isNone(row)) return Option.none<SavedCellExecution>()
      const json = Option.fromNullishOr(row.value.result_json)
      if (Option.isNone(json)) return Option.some(CellExecutionAdmission.cases.Incomplete.make({}))
      const result = yield* Schema.decodeEffect(ResultJson)(json.value)
      if (result.id !== address.toolCallId || result.name !== "cell") {
        return yield* new StorageError({
          message: "Stored cell result does not match its call",
        })
      }
      return Option.some(CellExecutionAdmission.cases.Completed.make({ result }))
    }).pipe(sql.withTransaction, Effect.mapError(executionStorageFailure))
  })
  const claim = Effect.fn("CellExecutionStorage.claim")(function* (address: OwnedToolCallAddress) {
    const outerTransaction = yield* Effect.serviceOption(sql.transactionService)
    if (Option.isSome(outerTransaction)) {
      return yield* new StorageError({
        message: "Cell admission requires a committed claim outside any caller transaction",
      })
    }
    return yield* Effect.gen(function* () {
      const call = yield* requireCell(address)
      const input = yield* Schema.decodeUnknownEffect(CellInput)(call.params)
      const now = (yield* DateTime.nowAsDate).getTime()
      const inserted = yield* sql<{ readonly tool_call_id: string }>`
            INSERT INTO cell_executions (assistant_message_id, tool_call_id, started_at)
            VALUES (${address.assistantMessageId}, ${address.toolCallId}, ${now})
            ON CONFLICT (assistant_message_id, tool_call_id) DO NOTHING
            RETURNING tool_call_id
          `
      if (inserted.length === 1) return CellExecutionAdmission.cases.Claimed.make(input)
      return yield* get(address).pipe(
        Effect.flatMap(
          Effect.fromOption(() => new StorageError({ message: "Cell admission disappeared" })),
        ),
      )
    }).pipe(sql.withTransaction, Effect.mapError(executionStorageFailure))
  })
  const complete = Effect.fn("CellExecutionStorage.complete")(function* (
    address: OwnedToolCallAddress,
    result: Prompt.ToolResultPart,
  ) {
    return yield* Effect.gen(function* () {
      yield* requireCell(address)
      if (result.id !== address.toolCallId || result.name !== "cell") {
        return yield* new StorageError({ message: "Cell result does not match its call" })
      }
      const json = yield* Schema.encodeEffect(ResultJson)(result)
      const row = yield* readRow(address).pipe(
        Effect.flatMap(
          Effect.fromOption(() => new StorageError({ message: "Cell has not been admitted" })),
        ),
      )
      const existing = Option.fromNullishOr(row.result_json)
      if (Option.isSome(existing)) {
        if (existing.value === json) return
        return yield* new StorageError({ message: "Cell result is immutable" })
      }
      const now = (yield* DateTime.nowAsDate).getTime()
      yield* sql`
            UPDATE cell_executions SET result_json = ${json}, completed_at = ${now}
            WHERE assistant_message_id = ${address.assistantMessageId}
              AND tool_call_id = ${address.toolCallId}
              AND result_json IS NULL
          `
    }).pipe(sql.withTransaction, Effect.mapError(executionStorageFailure))
  })
  return { get, claim, complete } satisfies CellExecutionStorageService
})

// ── namespace storage ───────────────────────────────────────────────────────

const SnapshotJson = Schema.fromJsonString(CellSnapshot)
const NamespaceRow = Schema.Struct({ snapshot_json: Schema.String })

interface CellNamespaceAddress {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

interface CellNamespaceStorageService {
  readonly get: (
    address: CellNamespaceAddress,
  ) => Effect.Effect<Option.Option<CellSnapshot>, StorageError>
  readonly set: (
    address: CellNamespaceAddress,
    snapshot: CellSnapshot,
  ) => Effect.Effect<void, StorageError>
  readonly clear: (address: CellNamespaceAddress) => Effect.Effect<void, StorageError>
}

const namespaceStorageFailure = cellStorageFailure("Failed to record cell namespace")

/** The host owns the last good cell namespace per branch so a worker restart restores it. */
const makeNamespaceStorage = Effect.gen(function* () {
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
    }).pipe(Effect.mapError(namespaceStorageFailure))
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
    }).pipe(Effect.mapError(namespaceStorageFailure))
  })
  const clear = Effect.fn("CellNamespaceStorage.clear")(function* (address: CellNamespaceAddress) {
    yield* sql`
          DELETE FROM cell_namespaces
          WHERE session_id = ${address.sessionId} AND branch_id = ${address.branchId}
        `.pipe(Effect.mapError(namespaceStorageFailure))
  })
  return { get, set, clear } satisfies CellNamespaceStorageService
})

// ── cell storage ────────────────────────────────────────────────────────────

/**
 * The cell's three tables as one service: inner operation receipts, outer
 * cell receipts, and the namespace snapshot. The cell runs other tools inside
 * itself, so all three travel with the turn together. Core does not name
 * them: it carries whatever the branch tool layer builds.
 */
export class CellStorage extends Context.Service<
  CellStorage,
  {
    readonly operations: CellToolOperationStorageService
    readonly executions: CellExecutionStorageService
    readonly namespaces: CellNamespaceStorageService
  }
>()("@gent/extensions/src/cell/CellStorage") {
  static Live = Layer.effect(
    CellStorage,
    Effect.gen(function* () {
      return CellStorage.of({
        operations: yield* makeToolOperationStorage,
        executions: yield* makeExecutionStorage,
        namespaces: yield* makeNamespaceStorage,
      })
    }),
  )
}

// ── current cell tool operation ─────────────────────────────────────────────

/** Host-owned address of the admitted inner operation. Never supplied by cell code. */
class CurrentCellToolOperation extends Context.Service<
  CurrentCellToolOperation,
  CellToolOperationKey
>()("@gent/extensions/src/cell/CurrentCellToolOperation") {}

// ── process ─────────────────────────────────────────────────────────────────

export class CellProcessError extends Schema.TaggedError<CellProcessError>()("CellProcessError", {
  phase: Schema.Literals(["launch", "io", "exit"]),
  message: Schema.String,
  diagnostics: Schema.String,
}) {}

/**
 * The worker runs under a shell that points its stderr at its stdout, so all cell
 * output shares one pipe and arrives in write order. `$0` is the binary and `$1`
 * the worker path, so the worker sees the same argv it would without the shell.
 */
const cellOutputRedirect = 'exec "$0" "$1" 2>&1'

/** Launch diagnostics stay small; the tail carries whatever the worker said last. */
const diagnosticsLimit = 8192
const diagnosticsHeadLimit = 6144

/** The caller owns an immutable trusted worker artifact and the returned process scope.
 * The worker runs with the host's working directory, environment, and OS permissions,
 * the same authority the bash tool already grants. Protocol frames use dedicated
 * descriptors so cell code that writes to stdout cannot corrupt them.
 */
export const openCellProcess = Effect.fn("CellProcess.open")(function* (input: {
  readonly binaryPath: string
  readonly workerPath: string
  readonly readinessTimeoutMs?: number
}) {
  const fs = yield* FileSystem.FileSystem
  const launchError = (cause: unknown) =>
    new CellProcessError({ phase: "launch", message: String(cause), diagnostics: "" })
  const readinessTimeoutMs = input.readinessTimeoutMs ?? 5000
  if (!Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs <= 0) {
    return yield* launchError("Cell readiness timeout must be a positive integer")
  }
  const binaryPath = yield* fs.realPath(input.binaryPath).pipe(Effect.mapError(launchError))
  const workerPath = yield* fs.realPath(input.workerPath).pipe(Effect.mapError(launchError))
  for (const file of [binaryPath, workerPath]) {
    const info = yield* fs.stat(file).pipe(Effect.mapError(launchError))
    if (info.type !== "File") return yield* launchError("Cell launch requires regular files")
  }
  // `exec` replaces the shell, so the worker keeps this pid and the redirect makes
  // its stderr the same pipe as its stdout. One descriptor means the kernel orders
  // every write, including those of a process the cell spawns with inherited stdio.
  const handle = yield* ChildProcess.make(
    "/bin/sh",
    ["-c", cellOutputRedirect, binaryPath, workerPath],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      additionalFds: {
        [`fd${cellResponseFd}`]: { type: "output" },
        [`fd${cellRequestFd}`]: { type: "input" },
      },
      forceKillAfter: "1 second",
    },
  ).pipe(Effect.mapError(launchError))

  const diagnosticsBuffer = makeBoundedOutput({
    limit: diagnosticsLimit,
    headLimit: diagnosticsHeadLimit,
  })
  const diagnostics = () => diagnosticsBuffer.read()
  const ioError = (cause: unknown) =>
    new CellProcessError({ phase: "io", message: String(cause), diagnostics: diagnostics() })
  const failure = yield* Deferred.make<never, CellProcessError>()
  const ready = yield* Deferred.make<boolean, CellProcessError>()
  const incoming = yield* Queue.make<CellResponse, CellProcessError>({ capacity: 8 })
  const outbound = yield* Queue.make<Uint8Array>({ capacity: 8 })
  // A worker that dies before it reports Ready never launched. The shell reports a
  // bad binary through its own exit, so the phase has to come from readiness rather
  // than from whichever handler noticed the death first.
  // The flag holds the phase itself, so a death needs no branch to classify it.
  let deathPhase: "launch" | "exit" = "launch"
  const closedError = () =>
    new CellProcessError({
      phase: deathPhase,
      message: "Cell worker closed",
      diagnostics: diagnostics(),
    })
  yield* Effect.addFinalizer(() =>
    Deferred.fail(failure, closedError()).pipe(
      Effect.andThen(Queue.shutdown(outbound)),
      Effect.andThen(Queue.shutdown(incoming)),
    ),
  )
  yield* handle.exitCode.pipe(
    Effect.mapError(
      (cause) =>
        new CellProcessError({
          phase: deathPhase,
          message: String(cause),
          diagnostics: diagnostics(),
        }),
    ),
    Effect.flatMap(() => Effect.fail(closedError())),
    Effect.catchCause((cause) => Deferred.failCause(failure, cause)),
    Effect.forkScoped,
  )

  yield* Stream.fromQueue(outbound).pipe(
    Stream.run(handle.getInputFd(cellRequestFd)),
    Effect.mapError(ioError),
    Effect.catchCause((cause) => Deferred.failCause(failure, cause)),
    Effect.forkScoped,
  )
  // One pipe carries all cell output, never protocol frames. Each Evaluate carries an
  // unpredictable token; the worker ends the cell with a boundary carrying that token
  // before its result frame. Text before the boundary belongs to the cell. Text after
  // it is dropped when the next Evaluate is sent, and text after that belongs to the
  // next cell.
  const cellOutput = makeBoundedOutput({
    limit: maximumCellDisplayLength,
    headLimit: maximumCellDisplayHeadLength,
  })
  let expectedToken = Option.none<string>()
  let finished = Option.none<{ readonly token: string; readonly text: string }>()
  let outputClosed = false
  let waiter = Option.none<{
    readonly token: string
    readonly deferred: Deferred.Deferred<string, CellProcessError>
  }>()
  const beginCell = (token: string) => {
    cellOutput.take()
    expectedToken = Option.some(token)
    finished = Option.none()
  }
  const settle = (token: string) =>
    Effect.suspend(() => {
      const text = cellOutput.take()
      expectedToken = Option.none()
      if (Option.isSome(waiter) && waiter.value.token === token) {
        return Deferred.succeed(waiter.value.deferred, text)
      }
      finished = Option.some({ token, text })
      return Effect.void
    })
  const readOutput = (bytes: Stream.Stream<Uint8Array, unknown>) => {
    const decoder = new TextDecoder()
    const scanner = makeCellOutputScanner(() => expectedToken)
    const consume = (segment: CellOutputSegment) =>
      Effect.gen(function* () {
        diagnosticsBuffer.append(segment.text)
        cellOutput.append(segment.text)
        if (Option.isNone(segment.boundary)) return
        yield* settle(segment.boundary.value)
      })
    return bytes.pipe(
      Stream.mapEffect((chunk) =>
        Effect.forEach(scanner.push(decoder.decode(chunk, { stream: true })), consume, {
          discard: true,
        }),
      ),
      Stream.concat(
        Stream.fromEffect(
          Effect.suspend(() => consume({ text: scanner.end(), boundary: Option.none() })),
        ),
      ),
    )
  }
  const closeOutput = Effect.suspend(() => {
    outputClosed = true
    return Option.match(waiter, {
      onNone: () => Effect.void,
      onSome: (active) => Deferred.fail(active.deferred, closedError()),
    })
  })
  yield* readOutput(handle.stdout).pipe(
    Stream.runDrain,
    Effect.mapError(ioError),
    Effect.catchCause((cause) => Deferred.failCause(failure, cause)),
    Effect.ensuring(closeOutput),
    Effect.forkScoped,
  )
  const takeOutput = Effect.fn("CellProcess.takeOutput")(function* (token: string) {
    if (Option.isSome(finished)) {
      const ready = finished.value
      finished = Option.none()
      if (ready.token !== token) return yield* ioError("Unexpected cell output boundary")
      return ready.text
    }
    if (outputClosed) return yield* closedError()
    const deferred = yield* Deferred.make<string, CellProcessError>()
    waiter = Option.some({ token, deferred })
    // The process failure is terminal for every waiter, present or future.
    return yield* Deferred.await(deferred).pipe(
      Effect.raceFirst(Deferred.await(failure)),
      Effect.ensuring(
        Effect.sync(() => {
          waiter = Option.none()
        }),
      ),
    )
  })

  const responses = Stream.suspend(() => {
    const reader = makeCellFrameReader()
    return handle.getOutputFd(cellResponseFd).pipe(
      Stream.mapEffect(reader.push),
      Stream.flatMap(Stream.fromIterable),
      Stream.mapEffect(decodeCellResponse),
      Stream.concat(Stream.fromEffect(reader.end).pipe(Stream.drain)),
      Stream.mapError(ioError),
      Stream.concat(
        Stream.suspend(() =>
          Stream.fail(
            new CellProcessError({
              phase: deathPhase,
              message: "Cell worker pipe closed",
              diagnostics: diagnostics(),
            }),
          ),
        ),
      ),
      Stream.interruptWhen(Deferred.await(failure)),
    )
  })

  yield* responses.pipe(
    Stream.runForEach((response) =>
      Effect.gen(function* () {
        if (deathPhase === "launch") {
          if (response._tag !== "Ready")
            return yield* launchError("Cell worker did not send Ready first")
          deathPhase = "exit"
          yield* Deferred.succeed(ready, true)
        } else if (response._tag === "Ready") {
          return yield* ioError("Cell worker sent Ready twice")
        }
        yield* Queue.offer(incoming, response)
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.all([
        Deferred.failCause(ready, cause),
        Deferred.failCause(failure, cause),
        Queue.failCause(incoming, cause),
      ]),
    ),
    Effect.forkScoped,
  )

  const stop = Effect.gen(function* () {
    if (yield* handle.isRunning.pipe(Effect.mapError(ioError))) {
      // kill waits for the exit event; signal termination has no numeric exit code.
      yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.mapError(ioError))
    }
    yield* Deferred.fail(failure, closedError())
    yield* Queue.shutdown(outbound)
  })
  yield* Deferred.await(ready).pipe(
    Effect.timeoutOrElse({
      duration: readinessTimeoutMs,
      orElse: () =>
        Effect.fail(
          new CellProcessError({
            phase: "launch",
            message: "Cell worker readiness timed out",
            diagnostics: diagnostics(),
          }),
        ),
    }),
    Effect.onError(() => stop.pipe(Effect.orDie)),
  )

  return {
    pid: handle.pid,
    responses: Stream.fromQueue(incoming),
    diagnostics: Effect.sync(diagnostics),
    /** Output the worker wrote during the cell, once its boundary arrived. */
    takeOutput,
    isRunning: handle.isRunning.pipe(Effect.mapError(ioError)),
    exitCode: handle.exitCode.pipe(Effect.mapError(ioError)),
    send: Effect.fn("CellProcess.send")(function* (request: CellRequest) {
      if (yield* Deferred.isDone(failure)) return yield* Deferred.await(failure)
      // Output nobody claimed, such as late writes from a process a cell spawned, is dropped here.
      if (request._tag === "Evaluate") beginCell(request.outputToken)
      const bytes = yield* encodeCellRequest(request).pipe(Effect.mapError(ioError))
      const accepted = yield* Queue.offer(outbound, bytes).pipe(
        Effect.raceFirst(Deferred.await(failure)),
      )
      if (!accepted) return yield* closedError()
    }),
    stop,
  }
})

// ── kernel ──────────────────────────────────────────────────────────────────

/** Supplied by the caller for each evaluation. Only the catalog is retained in the worker. */
export class CellOperationHost extends Context.Service<
  CellOperationHost,
  {
    /** Selected host tools for the `tools` namespace. Absent leaves the worker's catalog unchanged. */
    readonly catalog?: CellCatalog
    readonly call: (
      request: Extract<CellResponse, { _tag: "HostCall" }>,
    ) => Effect.Effect<Schema.Json, CellEvaluationError | CellToolCallSuspended>
  }
>()("@gent/extensions/src/cell/CellOperationHost") {}

/** Host control signal. It must never become a catchable error inside cell code. */
export class CellToolCallSuspended extends Schema.TaggedError<CellToolCallSuspended>()(
  "CellToolCallSuspended",
  {
    operationId: Schema.NonEmptyString,
    toolCallId: ToolCallId,
    pending: InteractionPendingError,
  },
) {}

export class CellKernelError extends Schema.TaggedError<CellKernelError>()("CellKernelError", {
  reason: Schema.Literals([
    "timeout",
    "cancelled",
    "protocol",
    "process",
    "closed",
    "recovery-required",
    "replacement-limit",
  ]),
  message: Schema.String,
  diagnostics: Schema.String,
  stateLost: Schema.Literal(true),
}) {}

const KernelStatus = Schema.Literals(["ready", "lost", "closed"])

/** One worker at a time. Only explicit reset can replace a failed worker. */
export const openCellKernel = Effect.fn("CellKernel.open")(function* (input: {
  readonly binaryPath: string
  readonly workerPath: string
  readonly readinessTimeoutMs?: number
  readonly evaluationTimeoutMs?: number
  readonly maximumReplacements?: number
}) {
  const timeoutMs = input.evaluationTimeoutMs ?? 30000
  const maximumReplacements = input.maximumReplacements ?? 3
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return yield* new CellProcessError({
      phase: "launch",
      message: "Cell evaluation timeout must be a positive integer",
      diagnostics: "",
    })
  }
  if (!Number.isSafeInteger(maximumReplacements) || maximumReplacements < 0) {
    return yield* new CellProcessError({
      phase: "launch",
      message: "Cell replacement limit must be a non-negative integer",
      diagnostics: "",
    })
  }
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const ownerScope = yield* Scope.fork(yield* Effect.scope)
  let status: typeof KernelStatus.Type = "lost"
  yield* Scope.addFinalizer(
    ownerScope,
    Effect.sync(() => {
      status = "closed"
    }),
  )
  const openWorker = Effect.fn("CellKernel.openWorker")(() =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(ownerScope)
        const dispose = Scope.close(scope, Exit.void)
        const process = yield* restore(
          openCellProcess(input).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Scope.provide(scope),
            Effect.tap((child) => child.responses.pipe(Stream.runHead)),
          ),
        ).pipe(Effect.onError(() => dispose))
        return { ...process, dispose }
      }),
    ),
  )
  let child = yield* openWorker().pipe(Effect.onError(() => Scope.close(ownerScope, Exit.void)))
  status = "ready"
  const permit = yield* Semaphore.make(1)
  const shutdown = yield* Deferred.make<never, CellKernelError>()
  let replacements = 0
  let sequence = 0
  // Catalog delta: the worker keeps the last catalog, so only a changed hash travels. A
  // replacement worker starts empty and receives the full catalog on its first cell.
  let workerCatalogHash = Option.none<string>()
  const isClosed = () => status === "closed"
  const failure = (reason: CellKernelError["reason"], message: string) =>
    Effect.map(
      child.diagnostics,
      (diagnostics) => new CellKernelError({ reason, message, diagnostics, stateLost: true }),
    ).pipe(Effect.flatMap(Effect.fail))
  const processError = (error: CellProcessError) =>
    new CellKernelError({
      reason: "process",
      message: error.message,
      diagnostics: error.diagnostics,
      stateLost: true,
    })
  const close = Effect.fn("CellKernel.close")(function* () {
    status = "closed"
    yield* Deferred.fail(
      shutdown,
      new CellKernelError({
        reason: "closed",
        message: "Cell kernel is closed",
        diagnostics: yield* child.diagnostics,
        stateLost: true,
      }),
    )
    yield* Semaphore.withPermit(permit, Scope.close(ownerScope, Exit.void))
  })
  const discard = Effect.fn("CellKernel.discard")(function* () {
    if (status !== "closed") status = "lost"
    yield* child.stop.pipe(Effect.ensuring(child.dispose))
  })
  const deadline = {
    duration: timeoutMs,
    orElse: () => failure("timeout", "Cell deadline exceeded; working state was lost"),
  }

  const evaluate = Effect.fn("CellKernel.evaluate")(function* (source: string) {
    if (status === "closed") return yield* failure("closed", "Cell kernel is closed")
    if (status === "lost") {
      return yield* failure("recovery-required", "Working state was lost; reset before evaluating")
    }
    if (source.length > maximumCellSourceLength) {
      return yield* new CellEvaluationError({
        phase: "source",
        message: "Cell source exceeds the length limit",
        output: "",
      })
    }
    const host = yield* CellOperationHost
    const cellId = String(++sequence)
    const catalog = Option.fromUndefinedOr(host.catalog).pipe(
      Option.filter((next) => !Option.contains(workerCatalogHash, next.hash)),
    )
    const response = yield* Effect.scoped(
      Effect.gen(function* () {
        const result = yield* Deferred.make<
          Extract<CellResponse, { _tag: "Evaluated" | "Failed" }>,
          CellKernelError | CellToolCallSuspended
        >()
        const seen = new Set<string>()
        const pending = new Set<string>()
        // The deadline bounds worker compute only. Host operations own their bounds
        // (tool timeouts, approvals), so the clock stops while one is pending and a
        // fresh compute stretch starts when the worker gets its reply.
        const idle = yield* Latch.make(true)
        const busy = yield* Latch.make(false)
        const watchdog: Effect.Effect<never, CellKernelError> = Effect.gen(function* () {
          while (true) {
            yield* idle.await
            const timedOut = yield* busy.await.pipe(
              Effect.as(false),
              Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed(true) }),
            )
            if (timedOut) return yield* deadline.orElse()
          }
        })
        const receive = Effect.fn("CellKernel.receive")(function* (frame: CellResponse) {
          if (
            frame._tag === "Ready" ||
            frame._tag === "Reset" ||
            frame._tag === "Snapshot" ||
            frame._tag === "Restored" ||
            frame.cellId !== cellId
          ) {
            return yield* failure("protocol", "Unexpected cell response")
          }
          if (frame._tag === "HostCall") {
            if (
              seen.has(frame.operationId) ||
              seen.size >= maximumCallsPerCell ||
              pending.size >= maximumPendingCellCalls
            ) {
              return yield* failure("protocol", "Duplicate or excessive cell host call")
            }
            seen.add(frame.operationId)
            pending.add(frame.operationId)
            yield* idle.close
            yield* busy.open
            yield* host.call(frame).pipe(
              Effect.map((value) =>
                CellRequest.cases.HostSucceeded.make({
                  cellId,
                  operationId: frame.operationId,
                  value,
                }),
              ),
              Effect.catchTag("CellEvaluationError", (error) =>
                Effect.succeed(
                  CellRequest.cases.HostFailed.make({
                    cellId,
                    operationId: frame.operationId,
                    message: error.message,
                  }),
                ),
              ),
              Effect.flatMap((reply) => {
                pending.delete(frame.operationId)
                return child.send(reply).pipe(Effect.mapError(processError))
              }),
              Effect.tap(() => {
                if (pending.size > 0) return Effect.void
                return busy.close.pipe(Effect.andThen(idle.open))
              }),
              Effect.catchCause((cause) => Deferred.failCause(result, cause)),
              Effect.forkScoped,
            )
            return
          }
          if (pending.size > 0) {
            return yield* failure("protocol", "Cell ended with pending host operations")
          }
          yield* Deferred.succeed(result, frame)
        })
        yield* child.responses.pipe(
          Stream.mapError(processError),
          Stream.runForEach(receive),
          Effect.catchCause((cause) => Deferred.failCause(result, cause)),
          Effect.forkScoped,
        )
        const outputToken = (yield* Effect.forEach([0, 1, 2, 3], () =>
          Random.nextIntBetween(0, 0x1_0000_0000),
        ))
          .map((part) => part.toString(16).padStart(8, "0"))
          .join("")
        yield* child
          .send(
            CellRequest.cases.Evaluate.make({
              cellId,
              outputToken,
              source,
              catalog: Option.getOrUndefined(catalog),
            }),
          )
          .pipe(Effect.mapError(processError))
        if (Option.isSome(catalog)) workerCatalogHash = Option.some(catalog.value.hash)
        const frame = yield* Deferred.await(result).pipe(Effect.raceFirst(watchdog))
        // The worker marks the end of the cell on its one output pipe before the frame;
        // the take resolves once that mark arrived, so the output is complete and ordered.
        return {
          frame,
          output: yield* child.takeOutput(outputToken).pipe(Effect.mapError(processError)),
        }
      }),
    ).pipe(Effect.onError(() => discard().pipe(Effect.orDie)))
    // Prime-style result text: process output first, then the cell's own display.
    const withOutput = (display: string) =>
      [response.output.trimEnd(), display].filter((text) => text.length > 0).join("\n")
    if (response.frame._tag === "Failed") {
      return yield* new CellEvaluationError({
        phase: response.frame.error.phase,
        message: response.frame.error.message,
        output: withOutput(response.frame.error.output),
      })
    }
    return { ...response.frame.result, display: withOutput(response.frame.result.display) }
  })

  /** One control request with one matching reply, while no cell is active. */
  const control = Effect.fn("CellKernel.control")(function* <A>(
    make: (requestId: string) => CellRequest,
    read: (response: CellResponse, requestId: string) => Option.Option<A>,
  ) {
    if (status === "closed") return yield* failure("closed", "Cell kernel is closed")
    if (status === "lost") {
      return yield* failure("recovery-required", "Working state was lost; reset before evaluating")
    }
    const requestId = String(++sequence)
    return yield* Effect.gen(function* () {
      yield* child.send(make(requestId))
      const response = yield* child.responses.pipe(Stream.runHead)
      const value = Option.flatMap(response, (frame) => read(frame, requestId))
      if (Option.isNone(value))
        return yield* failure("protocol", "Unexpected cell control response")
      return value.value
    }).pipe(
      Effect.catchTag("CellProcessError", (error) => Effect.fail(processError(error))),
      Effect.timeoutOrElse(deadline),
      Effect.onError(() => discard().pipe(Effect.orDie)),
    )
  })

  const reset = Effect.fn("CellKernel.reset")(function* () {
    if (status === "closed") return yield* failure("closed", "Cell kernel is closed")
    // A lost worker has nothing to talk to: replace the process instead.
    if (status === "lost") {
      if (replacements >= maximumReplacements) {
        return yield* failure("replacement-limit", "Cell worker replacement limit reached")
      }
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          replacements++
          workerCatalogHash = Option.none()
          child = yield* restore(openWorker()).pipe(Effect.mapError(processError))
          // close can run while the replacement is starting. Never restore a closed owner.
          if (isClosed()) return yield* failure("closed", "Cell kernel closed during replacement")
          status = "ready"
        }),
      )
    }
    // A live worker resets like any other control request; the reply carries
    // nothing but its own id, so that is what the read returns.
    yield* control(
      (requestId) => CellRequest.cases.Reset.make({ requestId }),
      (frame, requestId): Option.Option<string> => {
        if (frame._tag === "Reset" && frame.requestId === requestId) return Option.some(requestId)
        return Option.none()
      },
    )
  })

  const snapshot = control(
    (requestId) => CellRequest.cases.Snapshot.make({ requestId }),
    (frame, requestId): Option.Option<CellSnapshot> => {
      if (frame._tag === "Snapshot" && frame.requestId === requestId)
        return Option.some(frame.snapshot)
      return Option.none()
    },
  )
  const restore = (bindings: ReadonlyArray<SnapshotBinding>) =>
    control(
      (requestId) => CellRequest.cases.Restore.make({ requestId, bindings }),
      (frame, requestId): Option.Option<ReadonlyArray<string>> => {
        if (frame._tag === "Restored" && frame.requestId === requestId)
          return Option.some(frame.bindings)
        return Option.none()
      },
    )

  const guarded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Semaphore.withPermit(permit, effect.pipe(Effect.raceFirst(Deferred.await(shutdown))))
  return {
    evaluate: (source: string) => guarded(evaluate(source)),
    snapshot: guarded(snapshot),
    restore: (bindings: ReadonlyArray<SnapshotBinding>) => guarded(restore(bindings)),
    reset: guarded(reset()),
    close: close().pipe(Effect.uninterruptible),
  }
})

// ── catalog ─────────────────────────────────────────────────────────────────

const encodeEntries = Schema.encodeSync(Schema.fromJsonString(Schema.Array(CellCatalogEntry)))
const decodeEntry = Schema.decodeUnknownEffect(CellCatalogEntry)

/**
 * Read the selected bindings directly. No second schema registry: the entry carries the
 * capability's actual Effect AI input schema. The outer `cell` never lists itself.
 */
const buildCellCatalog = Effect.fn("CellCatalog.build")(function* (
  bindings: ReadonlyMap<string, ResolvedToolCapability>,
) {
  const selected = [...bindings.entries()]
    .filter(([name]) => name !== "cell")
    .sort(([left], [right]) => left.localeCompare(right))
  const tools = yield* Effect.forEach(selected, ([name, entry]) =>
    decodeEntry({
      name,
      description: entry.capability.description,
      guidelines: getToolMetadata(entry.capability).promptGuidelines ?? [],
      parameters: AiTool.getJsonSchema(entry.capability),
    }),
  )
  return CellCatalog.make({ hash: String(Hash.string(encodeEntries(tools))), tools })
})

// ── context host ────────────────────────────────────────────────────────────

/** Host calls under this prefix serve the cell's `context` namespace, not a selected tool. */
const CONTEXT_CALL_PREFIX = "context."

const isContextCall = (name: string): boolean => name.startsWith(CONTEXT_CALL_PREFIX)

const DEFAULT_READ_CHARS = 20_000
const MAXIMUM_READ_CHARS = 100_000

const ReadInput = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  offset: Schema.optional(Schema.Natural),
  limit: Schema.optional(Schema.Natural),
})

const DEFAULT_HISTORY_LIMIT = 50
const MAXIMUM_HISTORY_LIMIT = 200
const HISTORY_PREVIEW_CHARS = 120

const HistoryInput = Schema.Struct({
  offset: Schema.optional(Schema.Natural),
  limit: Schema.optional(Schema.Natural),
})

const CompactInput = Schema.Struct({
  instructions: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
})

const WINDOW_NOTICE =
  "Earlier context was dropped from the model view by context.newWindow(). It stays durable: context.history({ offset, limit }) lists it and context.read(messageId) or context.read(toolCallId) recovers any of it."

const ContextOperation = Schema.Literals(["status", "history", "read", "compact", "newWindow"])

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const contextHostFailure = (message: string) =>
  new CellEvaluationError({ phase: "execute", message, output: "" })

const messageText = (message: Message): string => message.parts.map(partToText).join("\n")

/** Locate durable text by message id, by a tool result id in the transcript, or by an inner cell operation id. */
const locateText = Effect.fn("CellContextHost.locate")(function* (branchId: BranchId, id: string) {
  const messages = yield* MessageStorage
  const message = yield* messages.getMessage(MessageId.make(id))
  if (Predicate.isNotUndefined(message) && message.branchId === branchId) {
    return Option.some({ kind: "message", text: messageText(message) })
  }
  const toolCallId = ToolCallId.make(id)
  for (const candidate of yield* messages.listMessages(branchId)) {
    for (const part of candidate.parts) {
      if (part.type === "tool-result" && part.id === toolCallId) {
        return Option.some({ kind: "tool-result", text: encodeJson(part.result) })
      }
    }
  }
  const operations = (yield* CellStorage).operations
  const operation = yield* operations.findByToolCallId({ branchId, toolCallId })
  if (Option.isSome(operation) && operation.value.state._tag === "Completed") {
    return Option.some({
      kind: "cell-operation",
      text: encodeJson(operation.value.state.result.result),
    })
  }
  return Option.none<{ readonly kind: string; readonly text: string }>()
})

/** One line of the branch's durable transcript: enough to decide what to `read`. */
const historyEntry = (message: Message): Schema.Json => {
  const text = messageText(message)
  const base = {
    id: message.id,
    role: message.role,
    chars: text.length,
    preview: text.slice(0, HISTORY_PREVIEW_CHARS).replace(/\s+/g, " "),
    createdAt: message.createdAt.toISOString(),
  }
  return Option.match(Option.fromUndefinedOr(message.metadata?.customType), {
    onNone: (): Schema.Json => base,
    onSome: (kind): Schema.Json => ({ ...base, kind }),
  })
}

interface ReadPage {
  readonly text: string
  readonly totalChars: number
  readonly offset: number
  readonly nextOffset: number
  readonly done: boolean
}

/** A page of characters; every byte of a stored result is reachable by continuing from `nextOffset`. */
export const pageText = (text: string, offset: number, limit: number): ReadPage => {
  const start = Math.min(offset, text.length)
  const boundedLimit = Math.max(1, Math.min(limit, MAXIMUM_READ_CHARS))
  const end = Math.min(text.length, start + boundedLimit)
  return {
    text: text.slice(start, end),
    totalChars: text.length,
    offset: start,
    nextOffset: end,
    done: end >= text.length,
  }
}

/** Serve one `context.*` host call. History and reads are durable lookups; the rest schedule work for the next projection. */
export const handleContextCall = Effect.fn("CellContextHost.call")(function* (params: {
  readonly branchId: BranchId
  readonly name: string
  readonly input: Schema.Json
}) {
  const operation = yield* Schema.decodeUnknownEffect(ContextOperation)(
    params.name.slice(CONTEXT_CALL_PREFIX.length),
  ).pipe(Effect.mapError(() => contextHostFailure(`Unknown context operation ${params.name}`)))
  const ledger = yield* ModelContextLedger
  switch (operation) {
    case "status": {
      const status = yield* ledger.status
      return Option.match(status, {
        onNone: (): Schema.Json => ({ projected: false }),
        onSome: (value): Schema.Json => ({
          projected: true,
          tokens: value.estimatedTokens,
          limit: value.contextLimitTokens,
          available: value.availableInputTokens,
          percent: Math.round(
            (value.estimatedTokens / Math.max(1, value.contextLimitTokens)) * 100,
          ),
          omittedMessages: value.omittedMessages,
          handoffMessageId: value.handoffMessageId ?? "",
        }),
      })
    }
    case "history": {
      const input = yield* Schema.decodeUnknownEffect(HistoryInput)(params.input).pipe(
        Effect.mapError((cause) =>
          contextHostFailure(`context.history input is invalid: ${cause.message}`),
        ),
      )
      const messages = yield* MessageStorage
      const all = yield* messages
        .listMessages(params.branchId)
        .pipe(
          Effect.mapError((cause) =>
            contextHostFailure(`context.history failed: ${cause.message}`),
          ),
        )
      const offset = Math.min(input.offset ?? 0, all.length)
      const limit = Math.max(
        1,
        Math.min(input.limit ?? DEFAULT_HISTORY_LIMIT, MAXIMUM_HISTORY_LIMIT),
      )
      const page = all.slice(offset, offset + limit)
      const reply: Schema.Json = {
        branchId: params.branchId,
        total: all.length,
        offset,
        nextOffset: offset + page.length,
        done: offset + page.length >= all.length,
        entries: page.map(historyEntry),
      }
      return reply
    }
    case "read": {
      const input = yield* Schema.decodeUnknownEffect(ReadInput)(params.input).pipe(
        Effect.mapError((cause) =>
          contextHostFailure(`context.read input is invalid: ${cause.message}`),
        ),
      )
      const located = yield* locateText(params.branchId, input.id).pipe(
        Effect.mapError((cause) => contextHostFailure(`context.read failed: ${cause.message}`)),
      )
      if (Option.isNone(located))
        return yield* contextHostFailure(`No stored message or result has id ${input.id}`)
      const page = pageText(
        located.value.text,
        input.offset ?? 0,
        input.limit ?? DEFAULT_READ_CHARS,
      )
      const reply: Schema.Json = { id: input.id, kind: located.value.kind, ...page }
      return reply
    }
    case "compact": {
      const input = yield* Schema.decodeUnknownEffect(CompactInput)(params.input).pipe(
        Effect.mapError((cause) =>
          contextHostFailure(`context.compact input is invalid: ${cause.message}`),
        ),
      )
      yield* ledger.schedule(
        ContextDirective.cases.Compact.make({ instructions: input.instructions }),
      )
      return { scheduled: "compact" } satisfies Schema.Json
    }
    case "newWindow": {
      yield* ledger.schedule(ContextDirective.cases.NewWindow.make({ notice: WINDOW_NOTICE }))
      return { scheduled: "newWindow" } satisfies Schema.Json
    }
  }
})

// ── interaction owner ───────────────────────────────────────────────────────

/**
 * The cell as the owner of its inner calls' interactions.
 *
 * An approval raised inside a cell belongs to that operation's receipt, so it
 * survives a crash with the operation rather than with the branch. This maps
 * the cell's operation key onto the host-facing `InteractionOwnership` seam so
 * core can route the interaction without knowing what a cell is.
 */

export const cellInteractionOwner = (
  key: CellToolOperationKey,
  storage: CellToolOperationStorageService,
): InteractionOwnership => ({
  sessionId: key.cell.sessionId,
  branchId: key.cell.branchId,
  persist: (record) =>
    storage
      .suspend(key, record)
      .pipe(
        Effect.mapError(
          (cause) =>
            new EventStoreError({ message: "Failed to persist interaction request", cause }),
        ),
      ),
  // `Started` has raised no interaction yet, so a fresh one begins. `Resuming`
  // is mid-approval and replays the id it recorded. Any other state was never
  // admitted to ask.
  resumeRequestId: storage.get(key).pipe(
    Effect.mapError(
      (cause) => new EventStoreError({ message: "Cannot read the interaction owner", cause }),
    ),
    Effect.flatMap((operation) => {
      if (operation.state._tag === "Started") return Effect.succeedNone
      if (operation.state._tag === "Resuming") return Effect.succeedSome(operation.state.requestId)
      return new EventStoreError({ message: "The owning call cannot take an interaction" })
    }),
  ),
})

// ── operation receipt ───────────────────────────────────────────────────────

/** Compact record of one admitted inner call. It stays in the saved cell result. */
const CellOperationReceipt = Schema.Struct({
  toolCallId: ToolCallId,
  tool: Schema.String,
  outcome: Schema.Literals(["succeeded", "failed", "incomplete"]),
  summary: Schema.String,
})
type CellOperationReceipt = typeof CellOperationReceipt.Type

const CELL_OPERATIONS_KEY = "operations"

const decodeJsonObject = Schema.decodeUnknownOption(Schema.JsonObject)
const encodeReceipts = Schema.encodeSync(Schema.Array(CellOperationReceipt))

const receiptFor = (operation: CellToolOperation): CellOperationReceipt => {
  if (operation.state._tag !== "Completed") {
    return {
      toolCallId: operation.toolCallId,
      tool: operation.binding.toolId,
      outcome: "incomplete",
      summary: "",
    }
  }
  let outcome: CellOperationReceipt["outcome"] = "succeeded"
  if (operation.state.result.isFailure) outcome = "failed"
  return {
    toolCallId: operation.toolCallId,
    tool: operation.binding.toolId,
    outcome,
    summary: summarizeOutput(operation.state.result.result),
  }
}

/**
 * Attach inner-operation receipts to a saved cell result. The transcript keeps
 * effects visible after reload. Cells without inner calls stay unchanged.
 */
const withCellOperationReceipts = Effect.fn("CellOperationReceipt.attach")(function* (
  cell: OwnedToolCallAddress,
  result: Prompt.ToolResultPart,
) {
  const storage = (yield* CellStorage).operations
  const operations = yield* storage.listForToolCall(cell)
  if (operations.length === 0) return result
  const value = decodeJsonObject(result.result)
  if (Option.isNone(value)) return result
  const receipts = encodeReceipts(operations.map((entry) => receiptFor(entry.operation)))
  return { ...result, result: { ...value.value, [CELL_OPERATIONS_KEY]: receipts } }
})

// ── tool call ───────────────────────────────────────────────────────────────

const JsonText = Schema.fromJsonString(Schema.Json)
// Tool results are Schema-encoded values. Optional fields left `undefined` are
// legal there but are not JSON values. The cell pipe carries JSON text, so the
// value is projected through the text codec before it crosses to the worker.
const UnknownText = Schema.fromJsonString(Schema.Unknown)

/** The caller owns the bound capability and operation receipt. */
export const executeBoundCellTool = Effect.fn("CellToolCall.executeBound")(function* (params: {
  readonly request: Pick<
    Extract<CellResponse, { _tag: "HostCall" }>,
    "operationId" | "name" | "input"
  >
  readonly toolCallId: ToolCallId
  readonly binding: Option.Option<ResolvedToolCapability>
}) {
  const runner = yield* ToolRunner
  if (
    Option.isSome(params.binding) &&
    getToolId(params.binding.value.capability) !== params.request.name
  ) {
    return yield* new CellEvaluationError({
      phase: "execute",
      message: "Cell tool name does not match its bound capability",
      output: "",
    })
  }
  return yield* runner
    .runBound(
      {
        toolCallId: params.toolCallId,
        toolName: params.request.name,
        input: params.request.input,
      },
      params.binding,
    )
    .pipe(
      Effect.mapError(
        (pending) =>
          new CellToolCallSuspended({
            operationId: params.request.operationId,
            toolCallId: params.toolCallId,
            pending,
          }),
      ),
    )
})

export const cellToolResultValue = Effect.fn("CellToolCall.resultValue")(function* (
  result: Prompt.ToolResultPart,
) {
  const value = yield* Schema.encodeEffect(UnknownText)(result.result).pipe(
    Effect.flatMap(Schema.decodeEffect(JsonText)),
    Effect.mapError(
      (cause) =>
        new CellEvaluationError({
          phase: "execute",
          message: `Tool result is not JSON: ${String(cause)}`,
          output: "",
        }),
    ),
  )
  if (result.isFailure) {
    const message = yield* Schema.encodeEffect(JsonText)(value).pipe(
      Effect.mapError(
        (cause) =>
          new CellEvaluationError({ phase: "execute", message: String(cause), output: "" }),
      ),
    )
    return yield* new CellEvaluationError({ phase: "execute", message, output: "" })
  }
  return value
})

// ── tool host ───────────────────────────────────────────────────────────────

interface CellToolHostParams {
  readonly cell: OwnedToolCallAddress
  readonly profile: AgentLoopTurnProfile
}

interface CellContextHostParams {
  /** The branch ledger the `context` namespace reads and schedules against. */
  readonly ledger: typeof ModelContextLedger.Service
}

const requireCellHostBranch = (params: CellToolHostParams) =>
  Effect.gen(function* () {
    if (
      params.profile.turnHostCtx.sessionId !== params.cell.sessionId ||
      params.profile.turnHostCtx.branchId !== params.cell.branchId
    )
      return yield* new CellEvaluationError({
        phase: "execute",
        message: "Cell host belongs to another branch",
        output: "",
      })
  })

/** Resume the selected inner operation, never the outer cell's JavaScript. */
export const resumeCellToolOperation = Effect.fn("CellToolHost.resume")(
  (
    params: CellToolHostParams & {
      readonly operationId: string
      readonly requestId: InteractionRequestId
    },
  ) =>
    runAgentLoopTurnProfile(params.profile)(
      Effect.gen(function* () {
        yield* requireCellHostBranch(params)
        const storage = (yield* CellStorage).operations
        const key = { cell: params.cell, operationId: params.operationId }
        const stored = yield* storage.get(key)
        const binding = yield* resolveStoredToolBinding({
          sessionId: params.cell.sessionId,
          assistantMessageId: params.cell.assistantMessageId,
          toolCallId: stored.toolCallId,
          binding: stored.binding,
          generationId: params.profile.turnGenerationId,
        })
        const admitted = yield* storage.resume(key, params.requestId)
        const result = yield* executeBoundCellTool({
          request: {
            operationId: params.operationId,
            name: admitted.binding.toolId,
            input: admitted.input,
          },
          toolCallId: admitted.toolCallId,
          binding: Option.some(binding),
        }).pipe(
          Effect.provideService(CurrentCellToolOperation, key),
          Effect.provideService(CurrentInteractionOwner, cellInteractionOwner(key, storage)),
          Effect.provideService(CurrentDispatchingCall, {
            assistantMessageId: key.cell.assistantMessageId,
            toolCallId: key.cell.toolCallId,
          }),
        )
        yield* storage.complete(key, result)
        return result
      }),
    ),
)

/**
 * Runtime services a host call reads beyond the turn profile. The host is made
 * inside the turn, so they are captured there and provided to each call.
 */
type CellToolHostServices =
  | CellStorage
  | EventPublisher
  | GentPlatform
  | MessageStorage
  | ToolRunner

/** One outer cell's host. The turn profile owns every admitted call. */
export const makeCellToolHost = (
  params: CellToolHostParams &
    CellContextHostParams & {
      readonly toolBindings: ReadonlyMap<string, ResolvedToolCapability>
      readonly catalog?: CellCatalog
    },
): Effect.Effect<typeof CellOperationHost.Service, never, CellToolHostServices> =>
  Effect.map(Effect.context<CellToolHostServices>(), (services) =>
    makeCellToolHostWith(params, services),
  )

const makeCellToolHostWith = (
  params: CellToolHostParams &
    CellContextHostParams & {
      readonly toolBindings: ReadonlyMap<string, ResolvedToolCapability>
      readonly catalog?: CellCatalog
    },
  services: Context.Context<CellToolHostServices>,
): typeof CellOperationHost.Service =>
  CellOperationHost.of({
    catalog: params.catalog,
    call: Effect.fn("CellToolHost.call")((request) =>
      runAgentLoopTurnProfile(params.profile)(
        Effect.gen(function* () {
          yield* requireCellHostBranch(params)
          // The context namespace never touches tool admission: reads are durable
          // lookups and directives are idempotent until the next projection.
          if (isContextCall(request.name)) {
            return yield* handleContextCall({
              branchId: params.cell.branchId,
              name: request.name,
              input: request.input,
            }).pipe(Effect.provideService(ModelContextLedger, params.ledger))
          }
          const storage = (yield* CellStorage).operations
          const captured = Option.fromUndefinedOr(params.toolBindings.get(request.name))
          if (Option.isNone(captured))
            return yield* new CellEvaluationError({
              phase: "execute",
              message: `Tool ${request.name} is not selected for this turn`,
              output: "",
            })
          const identity = yield* innerOperationBindingIdentity(
            captured.value,
            params.profile.turnGenerationId,
          )
          if (Option.isNone(identity))
            return yield* new CellEvaluationError({
              phase: "execute",
              message: `Tool ${request.name} has no bindable source identity`,
              output: "",
            })
          const key = { cell: params.cell, operationId: request.operationId }
          const admission = yield* storage.admit({
            ...key,
            binding: identity.value,
            input: request.input,
          })
          if (!admission.admitted) {
            if (admission.operation.state._tag === "Completed")
              return yield* cellToolResultValue(admission.operation.state.result)
            return yield* new CellEvaluationError({
              phase: "execute",
              message:
                "Cell operation has no recorded result. Its effects may have occurred. It was not executed again.",
              output: "",
            })
          }
          const result = yield* executeBoundCellTool({
            request,
            toolCallId: admission.operation.toolCallId,
            binding: captured,
          }).pipe(
            Effect.provideService(CurrentCellToolOperation, key),
            Effect.provideService(CurrentInteractionOwner, cellInteractionOwner(key, storage)),
            Effect.provideService(CurrentDispatchingCall, {
              assistantMessageId: key.cell.assistantMessageId,
              toolCallId: key.cell.toolCallId,
            }),
          )
          yield* storage.complete(key, result)
          return yield* cellToolResultValue(result)
        }),
      ).pipe(
        Effect.catchTags({
          StorageError: (cause) =>
            Effect.fail(
              new CellEvaluationError({
                phase: "execute",
                message: `Cell operation storage failed. Its effects may have occurred: ${cause.message}`,
                output: "",
              }),
            ),
        }),
        Effect.provideContext(services),
      ),
    ),
  })

// ── execution ───────────────────────────────────────────────────────────────

/** The worker binary this build ships next to the executable. */
const CELL_WORKER_BINARY = "gent-cell"

export class CellExecutionIncomplete extends Schema.TaggedError<CellExecutionIncomplete>()(
  "CellExecutionIncomplete",
  {
    sessionId: SessionId,
    branchId: BranchId,
    assistantMessageId: MessageId,
    toolCallId: ToolCallId,
    message: Schema.String,
  },
) {}

const CellFailure = Schema.Union([CellEvaluationError, CellKernelError, CellProcessError])
const isPassThrough = Predicate.or(
  Predicate.isTagged("CellToolCallSuspended"),
  Predicate.isTagged("StorageError"),
)
type Kernel = Effect.Success<ReturnType<typeof openCellKernel>>

interface CellExecutionService {
  readonly run: (call: {
    readonly assistantMessageId: MessageId
    readonly toolCallId: ToolCallId
  }) => Effect.Effect<
    Prompt.ToolResultPart,
    StorageError | CellExecutionIncomplete | CellToolCallSuspended,
    CellOperationHost
  >
  readonly reset: Effect.Effect<void, CellKernelError>
  readonly cancel: Effect.Effect<void>
}

/** One branch scope owns admission and a lazily acquired kernel. Host authority stays per call. */
export class CellExecution extends Context.Service<CellExecution, CellExecutionService>()(
  "@gent/extensions/src/cell/CellExecution",
) {
  /** The cell names its own worker; the platform resolves where it lives. */
  static Branch = (address: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly turnInterruption: TurnInterruptionStatus
  }) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const binaryPath = yield* platform.siblingBinaryPath(CELL_WORKER_BINARY)
        const live = CellExecution.Live({ ...address, binaryPath, workerPath: binaryPath })
        // The loop cancels branch work through `BranchToolWork`; the cell's
        // own cancel is what that means here. The context ledger ships with the
        // cell too: the cell is what schedules directives into it.
        return Layer.provideMerge(
          Layer.merge(
            Layer.effect(
              BranchToolWork,
              Effect.map(CellExecution, (cells) => BranchToolWork.of({ cancel: cells.cancel })),
            ),
            ModelContextLedger.Branch,
          ),
          live,
        )
      }),
    )

  static Live = (
    input: Parameters<typeof openCellKernel>[0] & {
      readonly sessionId: SessionId
      readonly branchId: BranchId
      readonly turnInterruption?: TurnInterruptionStatus
    },
  ) =>
    Layer.effect(
      CellExecution,
      Effect.gen(function* () {
        const storage = (yield* CellStorage).executions
        const namespaces = (yield* CellStorage).namespaces
        const scope = yield* Effect.scope
        const platform = yield* Effect.context<
          FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
        >()
        const permit = yield* Semaphore.make(1)
        let cancellationEpoch = 0
        let active = Option.none<Deferred.Deferred<never, CellKernelError>>()
        const cancelled = () =>
          new CellKernelError({
            reason: "cancelled",
            message: "Cell cancelled. Its effects may have occurred; its source was not replayed.",
            diagnostics: "",
            stateLost: true,
          })
        let kernel = Option.none<Kernel>()
        let startupAttempts = 0
        // Set when the worker reported state loss; the next run replaces it and restores.
        let recoveryPending = false
        // Report for the first evaluation after a host-owned restore.
        let restoreReport = Option.none<CellRestoreReport>()
        const namespaceAddress = { sessionId: input.sessionId, branchId: input.branchId }
        /** Put the last good namespace back into a fresh worker. Missing values are named. */
        const restoreNamespace = Effect.fn("CellExecution.restoreNamespace")(function* (
          current: Kernel,
        ) {
          const saved = yield* namespaces.get(namespaceAddress)
          if (Option.isNone(saved)) return
          const restored = yield* current.restore(saved.value.bindings)
          // An empty namespace has nothing to report.
          if (restored.length === 0 && saved.value.omitted.length === 0) return
          restoreReport = Option.some({ restored, omitted: saved.value.omitted })
        })
        /** Keep the namespace after each good cell. A failed snapshot only loses recency. */
        const saveNamespace = Effect.fn("CellExecution.saveNamespace")(function* (current: Kernel) {
          yield* current.snapshot.pipe(
            Effect.flatMap((snapshot) => namespaces.set(namespaceAddress, snapshot)),
            Effect.catch((error) =>
              Effect.logWarning("Cell namespace snapshot failed").pipe(
                Effect.annotateLogs({ error: String(error) }),
              ),
            ),
          )
        })
        const getKernel = Effect.fn("CellExecution.getKernel")(function* () {
          if (Option.isSome(kernel)) return kernel.value
          const remainingReplacements = (input.maximumReplacements ?? 3) - startupAttempts
          if (remainingReplacements < 0) {
            return yield* new CellProcessError({
              phase: "launch",
              message: "Cell worker startup attempt limit reached",
              diagnostics: "",
            })
          }
          startupAttempts++
          return yield* Effect.uninterruptibleMask((restore) =>
            restore(
              openCellKernel({ ...input, maximumReplacements: remainingReplacements }).pipe(
                Effect.provideContext(platform),
                Scope.provide(scope),
              ),
            ).pipe(
              Effect.tap((opened) =>
                Effect.sync(() => {
                  kernel = Option.some(opened)
                }),
              ),
              Effect.tap((opened) => restoreNamespace(opened)),
            ),
          )
        })
        /** Reset on request clears the saved namespace; reset after loss restores it. */
        const prepare = Effect.fn("CellExecution.prepare")(function* (
          current: Kernel,
          reset: boolean,
        ) {
          if (reset) {
            yield* current.reset
            yield* namespaces.clear(namespaceAddress)
            recoveryPending = false
            restoreReport = Option.none()
            return
          }
          if (!recoveryPending) return
          yield* current.reset
          recoveryPending = false
          yield* restoreNamespace(current)
        })
        const evaluated = (value: CellEvaluation): CellEvaluation => {
          if (Option.isNone(restoreReport)) return value
          const report = restoreReport.value
          restoreReport = Option.none()
          return { ...value, restored: report }
        }
        const run = Effect.fn("CellExecution.run")(function* (
          call: Parameters<CellExecutionService["run"]>[0],
          runEpoch: number,
        ) {
          const address = { ...call, sessionId: input.sessionId, branchId: input.branchId }
          const admission = yield* storage.claim(address)
          if (admission._tag === "Completed") return admission.result
          if (admission._tag === "Incomplete") {
            return yield* new CellExecutionIncomplete({
              ...address,
              message:
                "The cell has no recorded result. Its effects may have occurred. Its source was not replayed.",
            })
          }
          const signal = yield* Deferred.make<never, CellKernelError>()
          active = Option.some(signal)
          const evaluate = Effect.gen(function* () {
            if (
              cancellationEpoch !== runEpoch ||
              (yield* (input.turnInterruption ?? neverInterrupted).interrupted)
            )
              return yield* new CellEvaluationError({
                phase: "execute",
                message: "Cell did not start because execution was cancelled.",
                output: "",
              })
            return yield* getKernel()
          })
          const result = yield* evaluate.pipe(
            Effect.flatMap((current) =>
              Effect.gen(function* () {
                yield* prepare(current, admission.reset === true)
                const value = yield* current.evaluate(admission.code)
                yield* saveNamespace(current)
                return evaluated(value)
              }),
            ),
            Effect.raceFirst(Deferred.await(signal)),
            Effect.ensuring(
              Effect.sync(() => {
                active = Option.none()
              }),
            ),
            Effect.matchEffect({
              onSuccess: (value) =>
                Effect.succeed(
                  Prompt.toolResultPart({
                    id: call.toolCallId,
                    name: "cell",
                    result: value,
                    isFailure: false,
                    providerExecuted: false,
                  }),
                ),
              onFailure: (
                error,
              ): Effect.Effect<Prompt.ToolResultPart, StorageError | CellToolCallSuspended> => {
                // A suspended cell loses its worker like any kernel failure: the next
                // run restores the last good namespace instead of demanding a reset.
                if (error._tag === "CellToolCallSuspended") recoveryPending = true
                if (isPassThrough(error)) return Effect.fail(error)
                if (error._tag !== "CellEvaluationError") recoveryPending = true
                return Schema.encodeEffect(CellFailure)(error).pipe(
                  Effect.mapError(
                    (cause) =>
                      new StorageError({ message: "Failed to encode cell failure", cause }),
                  ),
                  Effect.map((value) =>
                    Prompt.toolResultPart({
                      id: call.toolCallId,
                      name: "cell",
                      result: value,
                      isFailure: true,
                      providerExecuted: false,
                    }),
                  ),
                )
              },
            }),
          )
          yield* storage.complete(address, result)
          return result
        })
        const reset = Effect.fn("CellExecution.reset")(function* () {
          if (Option.isSome(kernel)) yield* kernel.value.reset
          yield* namespaces.clear(namespaceAddress).pipe(Effect.orDie)
          recoveryPending = false
          restoreReport = Option.none()
        })
        const cancel = Effect.fn("CellExecution.cancel")(function* () {
          cancellationEpoch++
          if (Option.isSome(active)) yield* Deferred.fail(active.value, cancelled())
          yield* Semaphore.withPermit(permit, Effect.void)
        })
        return CellExecution.of({
          run: (call) =>
            Effect.suspend(() => Semaphore.withPermit(permit, run(call, cancellationEpoch))),
          reset: Semaphore.withPermit(permit, reset()),
          cancel: cancel().pipe(Effect.uninterruptible),
        })
      }),
    )
}

// ── dispatch ────────────────────────────────────────────────────────────────

/** Execute the current recorded outer call, never a call address supplied by cell code. */
export const dispatchCell = Effect.fn("CellExecution.dispatch")(function* () {
  if (Option.isSome(yield* Effect.serviceOption(CurrentCellToolOperation))) {
    return yield* new AgentLoopError({
      message: "A cell cannot invoke another outer cell as a host tool",
    })
  }
  const execution = yield* Effect.serviceOption(CellExecution)
  const ledger = yield* Effect.serviceOption(ModelContextLedger)
  if (Option.isNone(execution) || Option.isNone(ledger)) {
    return yield* new AgentLoopError({ message: "Cell execution requires a branch-owned runtime" })
  }
  const call = yield* Effect.serviceOption(CurrentToolCall)
  const profile = yield* Effect.serviceOption(CurrentAgentLoopTurnProfile)
  if (Option.isNone(call) || Option.isNone(profile)) {
    return yield* new AgentLoopError({ message: "Cell execution requires a recorded turn call" })
  }
  const cell = call.value
  const params = {
    cell,
    toolBindings: call.value.toolBindings,
    catalog: yield* buildCellCatalog(call.value.toolBindings),
    profile: profile.value,
    ledger: ledger.value,
  }
  yield* requireCellHostBranch(params)
  const host = yield* makeCellToolHost(params)
  const result = yield* execution.value
    .run(cell)
    .pipe(Effect.provideService(CellOperationHost, host))
  return yield* runAgentLoopTurnProfile(params.profile)(withCellOperationReceipts(cell, result))
})

// ── tool ────────────────────────────────────────────────────────────────────

/** Declaration only. The turn dispatcher still owns identity, permissions, and execution scope. */
/** The model-facing name of the cell tool. */
const CELL_TOOL_ID = "cell"

export const CellTool = tool({
  id: CELL_TOOL_ID,
  description: "Run TypeScript in this branch's Bun process. Bindings persist across cells.",
  // The cell calls host tools from inside itself, so recovery must restore
  // host bindings for it, not just its own.
  dispatches: true,
  params: CellInput,
  output: Schema.Json,
  promptGuidelines: [
    "Top-level variables stay bound in later cells on this branch. The host saves them after each cell and restores them after a worker restart; a result then carries restored (names) and omitted (functions, class instances, cycles, oversized values).",
    "Call a host tool through its id path: await tools.read({ path }), await tools.delegate.start({ todo }). Run independent calls concurrently with Promise.all; chain dependent calls with sequential awaits.",
    "The cell is a full Bun process in the working directory with your user's privileges; nothing is sandboxed. Bun (Bun.file, Bun.write, Bun.$, Bun.spawn), bun:sqlite, fetch, process (cwd, env), node builtins through await import('node:fs/promises') or require('node:path'), and packages resolved from the working directory are all available. Use it directly to read, search, parse, and transform data.",
    "Network reads are plain fetch in the cell; parse HTML or JSON there. Past sessions live in ~/.gent/data.db (bun:sqlite; tables sessions, messages, message_chunks, content_chunks, events), so search them with SQL instead of a host tool.",
    "Shell that changes state (git, installs, deletes, network writes) goes through tools.bash({ command }): it carries the approval guardrails and the session trailer. Bun.$ and Bun.spawn are for reading: builds, tests, queries, parsers. Use host tools for work that needs permissions, durable records, and child agents.",
    "console output, process.stdout and process.stderr writes, and inherited output of spawned processes return with the cell result, before the value of the last expression. Output a spawned process writes after the cell ends is lost, so await the processes you start.",
    "The value of the last expression is the cell result; an undefined value shows nothing. Top-level await works; a top-level return does not.",
    "Return a summary, not the data. You see at most 8,000 characters of any tool result (head and tail); a larger result is spilled and its `read` field says how to page the rest with context.read. Slice arrays, count instead of listing, and keep the full value in a binding for the next cell.",
    "Bun.$`cmd`.text() returns stdout only, and Bun.$ pipes stderr away; test runners and many tools report on stderr. Use Bun.spawn with inherited stdio so the output returns with the cell, or .quiet() and read .stderr.",
    "The Host Tools section lists every host tool selected for this turn with its signature. tools.describe(id) returns its full input schema and guidelines; it is local and synchronous and does not grant permission to execute. Object.keys(tools) lists the top-level names.",
    "The whole session stays reachable from the cell. context.history({ offset, limit }) lists this branch's durable messages in order (id, role, chars, preview, kind), 50 per page with nextOffset. context.read(id, { offset, limit }) returns durable text by message id or tool call id, paged by character offset and limit (nextOffset continues); receipts in a cell result carry the ids of inner calls. context.status() reports what the model sees: tokens, limit, percent, omittedMessages, handoffMessageId. When the window overflows, the history before the current turn is handed off: one durable notice summarizes it and names the session, branch, and message-id range it replaced, so read it back with context.history and context.read instead of guessing. context.compact(instructions?) asks for that handoff before the next turn, focused on the instructions. context.newWindow() drops older history from the model view without a summary. All five are awaited host calls.",
    "Set reset: true to discard retained values and the saved namespace before running new code.",
    "A failed cell may have completed effects. Do not replay source to recover unknown outcomes.",
  ],
  execute: Effect.fn("CellTool.execute")(function* () {
    const saved = yield* dispatchCell().pipe(
      Effect.catchTag("CellToolCallSuspended", (suspended) => Effect.fail(suspended.pending)),
    )
    const result = yield* Schema.decodeUnknownEffect(Schema.Json)(saved.result)
    if (saved.isFailure) {
      return yield* new ToolResultFailure({ message: "Cell execution failed", result })
    }
    return result
    // The cell cancels its own work through `BranchToolWork` and reports what
    // the cancel cost. A fiber interrupt would cut that report short.
  }, Effect.uninterruptible),
})

// ── recovery ────────────────────────────────────────────────────────────────

const RecoveredOperation = Schema.TaggedUnion({
  Completed: { operationId: CellToolOperationId, result: Prompt.ToolResultPart },
  Unknown: { operationId: CellToolOperationId, toolCallId: ToolCallId, toolName: ToolId },
})

/** The branch owner calls this only after cell execution has stopped. No source replay. */
export const recoverCellExecution = Effect.fn("CellExecution.recover")(function* (
  params: Pick<Parameters<typeof resumeCellToolOperation>[0], "cell" | "profile">,
) {
  yield* requireCellHostBranch(params)
  const operations = (yield* CellStorage).operations
  const cells = (yield* CellStorage).executions
  const interactions = yield* InteractionStorage
  const outer = yield* cells
    .get(params.cell)
    .pipe(
      Effect.flatMap(
        Effect.fromOption(() => new StorageError({ message: "Cell has not been admitted" })),
      ),
    )
  if (outer._tag === "Completed") return outer.result
  const records = yield* operations.listForToolCall(params.cell)
  const pending = yield* interactions.listPending(params.cell)
  for (const { key, operation } of records) {
    if (operation.state._tag !== "Waiting") continue
    const requestId = operation.state.requestId
    const request = Option.fromUndefinedOr(pending.find((record) => record.requestId === requestId))
    if (Option.isNone(request))
      return yield* new StorageError({
        message: "Cell approval request is missing during recovery",
      })
    if (Option.isNone(Option.fromUndefinedOr(request.value.decisionJson)))
      return yield* new CellToolCallSuspended({
        operationId: key.operationId,
        toolCallId: operation.toolCallId,
        pending: new InteractionPendingError({
          requestId,
          sessionId: params.cell.sessionId,
          branchId: params.cell.branchId,
        }),
      })
    yield* resumeCellToolOperation({ ...params, operationId: key.operationId, requestId })
  }
  const latest = yield* operations.listForToolCall(params.cell)
  const outcomes = latest.map(({ key, operation }) => {
    if (operation.state._tag === "Completed")
      return RecoveredOperation.cases.Completed.make({
        operationId: key.operationId,
        result: operation.state.result,
      })
    return RecoveredOperation.cases.Unknown.make({
      operationId: key.operationId,
      toolCallId: operation.toolCallId,
      toolName: operation.binding.toolId,
    })
  })
  const result = Prompt.toolResultPart({
    id: params.cell.toolCallId,
    name: "cell",
    isFailure: true,
    providerExecuted: false,
    result: {
      error:
        "The cell worker state was lost. Its source was not replayed. Unrecorded operation effects may have occurred.",
      stateLost: true,
      operations: outcomes,
    },
  })
  yield* cells.complete(params.cell, result)
  return result
})

// ── tool call recovery ──────────────────────────────────────────────────────

/**
 * The cell's answer to core's crash-recovery question.
 *
 * A cell that was mid-flight when the process died left receipts: an outer
 * admission, and one row per inner call. Those settle the call without running
 * it again. A tool call that is not a cell, or a cell that was never admitted,
 * is re-issued instead.
 */

const cellToolCallRecovery = Layer.effect(
  ToolCallRecoveryService,
  Effect.gen(function* () {
    const cells = (yield* CellStorage).executions
    // `recoverCellExecution` reads the cell's own storage. The layer already
    // has it, so capture it once here; the service's Effect then requires only
    // the per-turn profile, which the loop supplies at the call.
    const cellContext = yield* Effect.context<CellStorage | InteractionStorage>()
    const recover = (input: Parameters<typeof recoverCellExecution>[0]) =>
      Effect.provide(recoverCellExecution(input), cellContext)
    return ToolCallRecoveryService.of({
      recover: Effect.fn("CellToolCallRecovery.recover")(function* (params) {
        if (params.toolCall.name !== CELL_TOOL_ID)
          return ToolCallRecoveryOutcome.cases.NotRecovered.make({})
        const cell = {
          sessionId: params.sessionId,
          branchId: params.branchId,
          assistantMessageId: params.assistantMessageId,
          toolCallId: ToolCallId.make(params.toolCall.id),
        }
        const saved = yield* cells
          .get(cell)
          .pipe(
            Effect.mapError(
              (cause) => new ToolCallRecoveryError({ message: "Cannot read the receipt", cause }),
            ),
          )
        // Never admitted: nothing ran, so re-issue rather than settle.
        if (Option.isNone(saved)) return ToolCallRecoveryOutcome.cases.NotRecovered.make({})
        const profile = yield* CurrentAgentLoopTurnProfile
        return yield* recover({ cell, profile }).pipe(
          Effect.map((result) => ToolCallRecoveryOutcome.cases.Settled.make({ result })),
          Effect.catchTag("CellToolCallSuspended", (suspended) =>
            Effect.succeed(
              ToolCallRecoveryOutcome.cases.Suspended.make({
                requestId: suspended.pending.requestId,
              }),
            ),
          ),
          Effect.mapError(
            (cause) => new ToolCallRecoveryError({ message: "Recovery failed", cause }),
          ),
        )
      }),
    })
  }),
)

// ── storage ─────────────────────────────────────────────────────────────────

/**
 * The cell's storage layers, assembled as one unit.
 *
 * Core's SQLite assembler builds the kernel's tables and takes any extra
 * repositories as a parameter. This is the cell's contribution to that call:
 * the three tables it owns, wired against the same SQL client, so core never
 * names them.
 */

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
type CellStorageTags = CellStorage | RetainedBindings | ToolCallRecoveryService

const cellStorageLayer = <E, R>(
  base: Layer.Layer<SqlClient.SqlClient, E, R>,
  interactionStorage: Layer.Layer<InteractionStorage, E, R>,
): Layer.Layer<CellStorageTags, E, R | GentPlatform> => {
  const tables = Layer.provide(CellStorage.Live, Layer.merge(base, interactionStorage))
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
    const namespaces = (yield* CellStorage).namespaces
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

// ── extension ───────────────────────────────────────────────────────────────

export const CELL_EXTENSION_ID = ExtensionId.make("@gent/cell")

/**
 * The default model execution surface. When this builtin is registered, a native
 * model turn advertises only `cell`; host tools stay callable inside the cell
 * as `tools.<id path>(input)` through the turn's bound identities. The kernel
 * builds that namespace, and the local `tools.describe`, from the catalog the
 * host ships with each changed turn.
 * The extension owns the model selection and catalog through ordinary hooks.
 */
export const CellExtension = defineExtension({
  id: CELL_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", CellTool)
    yield* host.on("turnProjection", () =>
      Effect.gen(function* () {
        const ctx = yield* ExtensionContext
        if (
          ctx.turn?.agent.driver?._tag === "External" ||
          ctx.turn?.agent.deniedTools?.includes("cell")
        ) {
          return {}
        }
        return { toolPolicy: { include: ["cell"], modelSet: ["cell"] } }
      }),
    )
    yield* host.on("systemPrompt", (input) =>
      Effect.gen(function* () {
        if (
          input.agent.driver?._tag === "External" ||
          input.tools?.length !== 1 ||
          !input.tools.some((tool) => getToolId(tool) === "cell")
        ) {
          return input.basePrompt
        }
        const entries = yield* Effect.forEach(
          (input.hostTools ?? [])
            .filter((tool) => getToolId(tool) !== "cell")
            .toSorted((left, right) => getToolId(left).localeCompare(getToolId(right))),
          renderToolSignature,
        )
        if (entries.length === 0) return `${input.basePrompt}\n\n${CELL_WORK}`
        const catalog = `## Host Tools\n\nInside \`cell\`, each host tool id is a function path under \`tools\`: id \`a.b\` is \`await tools.a.b(input)\`. \`tools.describe(id)\` returns the full input schema and the tool's guidelines.\n\n${entries.join("\n")}`
        return `${input.basePrompt}\n\n${CELL_WORK}\n\n${catalog}`
      }),
    )
  }),
})

/**
 * How to work when the cell is the execution surface.
 *
 * Core's base prompt says a turn ends when the model stops calling tools; it
 * does not say the work happens in a cell, because a deployment without this
 * extension has no cell. The sentences that assume one live here.
 */
const CELL_WORK = `# Working in the cell

- The cell is your persistent control environment. Keep intermediate values in named variables, inspect and transform outputs, and write small helpers. Use it for loops, parsing, and state; call host tools for effects.
- You solve tasks by writing and running TypeScript in the cell, observing results, and iterating. Batch independent work inside one cell; iterate between cells.
- Independent work goes to children: start each with tools.delegate.start({ todo }) from one cell, then end your turn. Each child's result arrives as a message that wakes you. Single reads, searches, and edits stay inline.
- Example: \`const run = await Bun.$\`bun test\`.quiet().nothrow(); const lines = (run.stdout.toString() + run.stderr.toString()).split("\\n"); const failing = lines.filter((l) => l.includes("(fail)")); ({ exit: run.exitCode, total: failing.length, sample: failing.slice(0, 5) })\` returns the outcome and a sample; lines stays bound for the next cell.
- To find files, prefer tools.grep({ pattern }) over a raw directory walk: it honours .gitignore and caches the listing.`

// ── tool signatures ─────────────────────────────────────────────────────────

/** Nested objects longer than this render as `object`; `tools.describe(id)` has the rest. */
const INLINE_OBJECT_LIMIT = 80
/** A result type longer than this renders as `object`. */
const RESULT_TYPE_LIMIT = 100
/** The description after a signature is cut here, as opencode codemode cuts it. */
const DESCRIPTION_LIMIT = 120

type SchemaValue = JsonSchema.JsonSchema[string]

const isSchemaNode = (value: SchemaValue): value is JsonSchema.JsonSchema =>
  Predicate.isObject(value) && !Array.isArray(value)

const schemaNodes = (value: SchemaValue): ReadonlyArray<JsonSchema.JsonSchema> => {
  if (!Array.isArray(value)) return []
  return value.filter(isSchemaNode)
}

const strings = (value: SchemaValue): ReadonlyArray<string> => {
  if (!Array.isArray(value)) return []
  return value.filter(Predicate.isString)
}

const parenthesize = (rendered: string) => {
  if (rendered.includes(" | ")) return `(${rendered})`
  return rendered
}

const union = (members: ReadonlyArray<string>) => {
  const distinct = [...new Set(members)]
  if (distinct.includes("unknown")) return "unknown"
  return distinct.join(" | ")
}

const propertyKey = (name: string) => {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return name
  return encodeJson(name)
}

/**
 * One TypeScript-like type for a JSON Schema node. Objects past the first level
 * inline only while short; references and anything unrecognized fall back to
 * `object` or `unknown`.
 */
const renderSchemaType = (schema: JsonSchema.JsonSchema, depth: number): string => {
  if ("const" in schema) return encodeJson(schema["const"])
  if (Array.isArray(schema["enum"])) return union(schema["enum"].map((value) => encodeJson(value)))
  const alternatives = [...schemaNodes(schema["anyOf"]), ...schemaNodes(schema["oneOf"])]
  if (alternatives.length > 0) {
    return union(alternatives.map((member) => renderSchemaType(member, depth)))
  }
  if (Predicate.isString(schema["$ref"])) return "object"
  const declared = schema["type"]
  const types = strings([declared].flat())
  if (types.length === 0) {
    if (isSchemaNode(schema["properties"])) return renderObjectType(schema, depth)
    return "unknown"
  }
  return union(types.map((type) => renderTypeName(schema, type, depth)))
}

const renderTypeName = (schema: JsonSchema.JsonSchema, type: string, depth: number): string => {
  switch (type) {
    case "string":
    case "boolean":
    case "null":
      return type
    case "number":
    case "integer":
      return "number"
    case "array": {
      const items = schema["items"]
      if (!isSchemaNode(items)) return "unknown[]"
      return `${parenthesize(renderSchemaType(items, depth))}[]`
    }
    case "object":
      return renderObjectType(schema, depth)
    default:
      return "unknown"
  }
}

/** An optional key drops `null` from its union: omission already says "no value". */
const renderField = (name: string, schema: SchemaValue, required: boolean, depth: number) => {
  if (!isSchemaNode(schema)) return `${propertyKey(name)}?: unknown`
  const rendered = renderSchemaType(schema, depth)
  if (required) return `${propertyKey(name)}: ${rendered}`
  const present = rendered.split(" | ").filter((member) => member !== "null")
  if (present.length === 0) return `${propertyKey(name)}?: ${rendered}`
  return `${propertyKey(name)}?: ${present.join(" | ")}`
}

const renderObjectType = (schema: JsonSchema.JsonSchema, depth: number): string => {
  const properties = schema["properties"]
  const empty = !isSchemaNode(properties) || Object.keys(properties).length === 0
  if (empty && depth === 0) return "{}"
  if (empty || !isSchemaNode(properties) || depth >= 2) return "object"
  const required = new Set(strings(schema["required"]))
  const fields = Object.entries(properties).map(([name, value]) =>
    renderField(name, value, required.has(name), depth + 1),
  )
  const rendered = `{ ${fields.join("; ")} }`
  if (depth > 0 && rendered.length > INLINE_OBJECT_LIMIT) return "object"
  return rendered
}

/** A long result type keeps only its outer shape. */
const renderResultType = (schema: JsonSchema.JsonSchema) => {
  const rendered = renderSchemaType(schema, 0)
  if (rendered.length <= RESULT_TYPE_LIMIT) return rendered
  if (rendered.endsWith("[]")) return "object[]"
  return "object"
}

const firstLine = (text: string) => {
  const line = (text.split("\n")[0] ?? "").trim()
  if (line.length <= DESCRIPTION_LIMIT) return line
  return `${line.slice(0, DESCRIPTION_LIMIT - 3)}...`
}

/** A schema the renderer cannot derive renders as `unknown` instead of failing the prompt. */
const jsonSchemaOf = (derive: () => JsonSchema.JsonSchema) =>
  Effect.try({ try: derive, catch: () => "underivable" }).pipe(
    Effect.orElseSucceed((): JsonSchema.JsonSchema => ({})),
  )

/**
 * One prompt line per host tool: the callable path with its input and result
 * types, then the first line of its snippet or description.
 * `- tools.wake.cancel(input?: { wakeId?: string }): Promise<{ cancelled: string[] }> // Cancel ...`
 */
export const renderToolSignature = Effect.fn("CellCatalog.renderToolSignature")(function* (
  tool: ToolCapability,
) {
  const parameters = yield* jsonSchemaOf(() => AiTool.getJsonSchema(tool))
  const output = tool.output
  let result: JsonSchema.JsonSchema = {}
  if (Schema.isSchema(output)) {
    result = yield* jsonSchemaOf(() => AiTool.getJsonSchemaFromSchema(output))
  }
  let input = `input: ${renderSchemaType(parameters, 0)}`
  if (strings(parameters["required"]).length === 0)
    input = `input?: ${renderSchemaType(parameters, 0)}`
  const signature = `${toolPath(getToolId(tool))}(${input}): Promise<${renderResultType(result)}>`
  const summary = firstLine(getToolPrompt(tool).promptSnippet ?? tool.description)
  if (summary.length === 0) return `- ${signature}`
  return `- ${signature} // ${summary}`
})
