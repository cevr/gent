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
  AGENT_PROMPT_PRIORITY,
  BranchId,
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  getToolId,
  getToolPrompt,
  InteractionPendingError,
  isSpawnedSession,
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
  type EventStore,
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
  ToolBindingIdentity,
  ToolCallRecoveryError,
  ToolCallRecoveryOutcome,
  ToolCallRecoveryService,
  ToolRunner,
  toolResultSummary,
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
/** Started or resuming after its answer, with no result recorded: it may have acted. */
const mayHaveActed = Predicate.or(Predicate.isTagged("Started"), Predicate.isTagged("Resuming"))

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
  /** The call took its answer and runs on: it waits for nothing now. */
  readonly take: (
    key: CellToolOperationKey,
    requestId: InteractionRequestId,
  ) => Effect.Effect<void, StorageError>
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
      // Operation ids are the worker's call numbers stored as text: sort them
      // as numbers, or call 10 comes before call 2. A receipt's place is its
      // only link to the call in the source.
      const rows = yield* sql<typeof OperationAddressRow.Type>`
            SELECT operation_id FROM cell_tool_operations
            WHERE assistant_message_id = ${cell.assistantMessageId}
              AND cell_tool_call_id = ${cell.toolCallId}
            ORDER BY CAST(operation_id AS INTEGER), operation_id
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
  const take = Effect.fn("CellToolOperationStorage.take")(function* (
    key: CellToolOperationKey,
    requestId: InteractionRequestId,
  ) {
    yield* outsideTransaction
    return yield* Effect.gen(function* () {
      yield* own(key)
      yield* requireOpenCell(key)
      const operation = yield* read(key)
      if (!hasInteraction(operation.state) || operation.state.requestId !== requestId)
        return yield* new StorageError({
          message: "Cell operation is not asking this request",
        })
      yield* write(key, { ...operation, state: CellToolOperationState.cases.Started.make({}) })
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
    take,
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
}

/** What a reset leaves: a saved namespace with nothing in it, so nothing is inherited later. */
const emptyNamespace: CellSnapshot = { bindings: [], omitted: [] }

/** A namespace to restore, and the previous session of the thread it came from, if any. */
interface SavedNamespace {
  readonly snapshot: CellSnapshot
  readonly previousSession: Option.Option<SessionId>
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
  return { get, set } satisfies CellNamespaceStorageService
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
 * How a worker starts. `Compiled` is the `gent-cell` executable. `Script` is a
 * worker source file that the Bun at `runtimePath` runs.
 */
export const CellWorker = Schema.TaggedUnion({
  Compiled: { binaryPath: Schema.String },
  Script: { runtimePath: Schema.String, scriptPath: Schema.String },
})
export type CellWorker = typeof CellWorker.Type

/**
 * A script worker starts with the controls the compiled worker is built with:
 * no project `bunfig.toml` (so no project preload runs before the worker) and
 * no `.env` files. `/dev/null` is an empty Bun config. A project `tsconfig.json`
 * or `package.json` in the working directory does not reach a worker file
 * outside that project.
 */
const scriptWorkerControls = ["--config=/dev/null", "--no-env-file"]

/**
 * The worker runs under a shell that points its stderr at its stdout, so all cell
 * output shares one pipe and arrives in write order. The shell `exec`s its
 * arguments unchanged, so the worker sees the argv it would see without the shell.
 */
const cellOutputRedirect = 'exec "$@" 2>&1'

/** Launch diagnostics stay small; the tail carries whatever the worker said last. */
const diagnosticsLimit = 8192
const diagnosticsHeadLimit = 6144

/** The caller owns an immutable trusted worker artifact and the returned process scope.
 * The worker runs in `cwd`, the session's working directory, with the host's
 * environment and OS permissions, the same authority the bash tool already grants. Protocol frames use dedicated
 * descriptors so cell code that writes to stdout cannot corrupt them.
 */
export const openCellProcess = Effect.fn("CellProcess.open")(function* (input: {
  readonly worker: CellWorker
  readonly cwd: string
  readonly readinessTimeoutMs?: number
}) {
  const fs = yield* FileSystem.FileSystem
  const launchError = (cause: unknown) =>
    new CellProcessError({ phase: "launch", message: String(cause), diagnostics: "" })
  const readinessTimeoutMs = input.readinessTimeoutMs ?? 5000
  if (!Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs <= 0) {
    return yield* launchError("Cell readiness timeout must be a positive integer")
  }
  const launchFile = Effect.fn("CellProcess.launchFile")(function* (file: string) {
    const resolved = yield* fs.realPath(file).pipe(Effect.mapError(launchError))
    const info = yield* fs.stat(resolved).pipe(Effect.mapError(launchError))
    if (info.type !== "File") return yield* launchError("Cell launch requires regular files")
    return resolved
  })
  const argv = yield* CellWorker.match(input.worker, {
    Compiled: ({ binaryPath }) => launchFile(binaryPath).pipe(Effect.map((binary) => [binary])),
    Script: ({ runtimePath, scriptPath }) =>
      Effect.gen(function* () {
        const runtime = yield* launchFile(runtimePath)
        const script = yield* launchFile(scriptPath)
        return [runtime, ...scriptWorkerControls, script]
      }),
  })
  // `exec` replaces the shell, so the worker keeps this pid and the redirect makes
  // its stderr the same pipe as its stdout. One descriptor means the kernel orders
  // every write, including those of a process the cell spawns with inherited stdio.
  const handle = yield* ChildProcess.make(
    "/bin/sh",
    ["-c", cellOutputRedirect, "gent-cell", ...argv],
    {
      cwd: input.cwd,
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
    ) => Effect.Effect<Schema.Json, CellEvaluationError>
  }
>()("@gent/extensions/src/cell/CellOperationHost") {}

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

/**
 * How long one stretch of worker compute may run before the worker is killed.
 * Awaited host calls stop the clock, so long commands belong in `tools.bash`;
 * the cell guidance names this number.
 */
const CELL_COMPUTE_DEADLINE_MS = 30_000

/** Launches in a row that may fail before the kernel stops replacing its worker. */
const DEFAULT_MAXIMUM_FAILED_LAUNCHES = 3

/**
 * One worker at a time. Only explicit reset can replace a failed worker.
 *
 * `maximumFailedLaunches` stops a crash loop: once that many launches in a row
 * failed, reset refuses. A launch fails when the worker never reaches Ready, or
 * when it dies (a process exit, a protocol fault) before it completes a cell.
 * A worker the kernel stops (a timeout, a cancel) did not fail. Only a
 * completed cell starts the count again.
 */
export const openCellKernel = Effect.fn("CellKernel.open")(function* (input: {
  readonly worker: CellWorker
  readonly cwd: string
  readonly readinessTimeoutMs?: number
  readonly evaluationTimeoutMs?: number
  readonly maximumFailedLaunches?: number
}) {
  const timeoutMs = input.evaluationTimeoutMs ?? CELL_COMPUTE_DEADLINE_MS
  const maximumFailedLaunches = input.maximumFailedLaunches ?? DEFAULT_MAXIMUM_FAILED_LAUNCHES
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return yield* new CellProcessError({
      phase: "launch",
      message: "Cell evaluation timeout must be a positive integer",
      diagnostics: "",
    })
  }
  if (!Number.isSafeInteger(maximumFailedLaunches) || maximumFailedLaunches < 1) {
    return yield* new CellProcessError({
      phase: "launch",
      message: "Cell failed-launch limit must be a positive integer",
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
  let failedLaunches = 0
  // The current worker has not completed a cell yet, so its death is a failed launch.
  let unproven = true
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
  /** A worker that dies on its own before completing a cell is a failed launch. */
  const countUnprovenDeath = (error: CellKernelError) =>
    Effect.sync(() => {
      if (unproven && (error.reason === "process" || error.reason === "protocol")) {
        failedLaunches++
      }
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
          CellKernelError
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
        // The worker answered a cell: it is not part of a crash loop.
        unproven = false
        failedLaunches = 0
        // The worker marks the end of the cell on its one output pipe before the frame;
        // the take resolves once that mark arrived, so the output is complete and ordered.
        return {
          frame,
          output: yield* child.takeOutput(outputToken).pipe(Effect.mapError(processError)),
        }
      }),
    ).pipe(
      Effect.tapError(countUnprovenDeath),
      Effect.onError(() => discard().pipe(Effect.orDie)),
    )
    // The worker named built-ins the cell changed and it cannot put back; its
    // own code may run cell code through them, so it goes. The result stands,
    // and the next cell starts on a new worker.
    if ((response.frame.unrestored ?? []).length > 0)
      yield* discard().pipe(Effect.mapError(processError))
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
      Effect.tapError(countUnprovenDeath),
      Effect.onError(() => discard().pipe(Effect.orDie)),
    )
  })

  /** Start a new worker process in place of one that is lost. */
  const replaceWorker = Effect.fn("CellKernel.replaceWorker")(function* () {
    if (failedLaunches >= maximumFailedLaunches) {
      return yield* failure(
        "replacement-limit",
        `Cell worker failed ${failedLaunches} times in a row before completing a cell`,
      )
    }
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        workerCatalogHash = Option.none()
        child = yield* restore(openWorker()).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              failedLaunches++
            }),
          ),
          Effect.mapError(processError),
        )
        unproven = true
        // close can run while the replacement is starting. Never restore a closed owner.
        if (isClosed()) return yield* failure("closed", "Cell kernel closed during replacement")
        status = "ready"
      }),
    )
  })

  const reset = Effect.fn("CellKernel.reset")(function* () {
    if (status === "closed") return yield* failure("closed", "Cell kernel is closed")
    // A lost worker has nothing to talk to: replace the process instead.
    if (status === "lost") return yield* replaceWorker()
    // A live worker resets like any other control request; the reply names
    // the globals it could not put back.
    const unrestored = yield* control(
      (requestId) => CellRequest.cases.Reset.make({ requestId }),
      (frame, requestId): Option.Option<ReadonlyArray<string>> => {
        if (frame._tag === "Reset" && frame.requestId === requestId)
          return Option.some(frame.unrestored ?? [])
        return Option.none()
      },
    )
    if (unrestored.length === 0) return
    // A global the worker cannot remove or put back would outlive the reset,
    // so the worker is replaced: a reset always leaves the globals it found.
    yield* discard().pipe(Effect.mapError(processError))
    return yield* replaceWorker()
  })

  const snapshot = Effect.gen(function* () {
    const frame = yield* control(
      (requestId) => CellRequest.cases.Snapshot.make({ requestId }),
      (response, requestId) => {
        if (response._tag === "Snapshot" && response.requestId === requestId)
          return Option.some(response)
        return Option.none()
      },
    )
    const unrestored = frame.unrestored ?? []
    if (unrestored.length === 0) return frame.snapshot
    // A worker that cannot put a built-in back saves nothing: it is replaced.
    yield* discard().pipe(Effect.mapError(processError))
    return yield* failure(
      "recovery-required",
      `The worker could not put back built-ins: ${unrestored.join(", ")}`,
    )
  })
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
    /** Whether the kernel discarded its worker; the next cell needs a reset and a restore. */
    isLost: () => status === "lost",
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
          // The messages' share of the input they may take: 100 is where the
          // window hands off, also on a model whose input cap is below its window.
          percent: Math.round(
            (value.estimatedTokens / Math.max(1, value.availableInputTokens)) * 100,
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
  // `Started` waits for no answer, so a fresh ask begins. `Resuming` came back
  // from a crash mid-approval and takes the answer it recorded. Any other
  // state was never admitted to ask.
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
  take: (requestId) =>
    storage
      .take(key, requestId)
      .pipe(
        Effect.mapError(
          (cause) => new EventStoreError({ message: "Failed to record the taken answer", cause }),
        ),
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

/**
 * Tools bound for this cell call, by tool id. A receipt reads the author's
 * summary from here; a tool missing from it gets the head of its output.
 */
type ReceiptTools = ReadonlyMap<string, ResolvedToolCapability>

const receiptFor = (operation: CellToolOperation, tools: ReceiptTools): CellOperationReceipt => {
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
    summary: toolResultSummary(
      Option.map(
        Option.fromUndefinedOr(tools.get(String(operation.binding.toolId))),
        (entry) => entry.capability,
      ),
      operation.input,
      operation.state.result,
    ),
  }
}

/**
 * Attach inner-operation receipts to a saved cell result. The transcript keeps
 * effects visible after reload. Cells without inner calls stay unchanged.
 */
const withCellOperationReceipts = Effect.fn("CellOperationReceipt.attach")(function* (
  cell: OwnedToolCallAddress,
  result: Prompt.ToolResultPart,
  tools: ReceiptTools,
) {
  const storage = (yield* CellStorage).operations
  const operations = yield* storage.listForToolCall(cell)
  if (operations.length === 0) return result
  const value = decodeJsonObject(result.result)
  if (Option.isNone(value)) return result
  const receipts = encodeReceipts(operations.map((entry) => receiptFor(entry.operation, tools)))
  return { ...result, result: { ...value.value, [CELL_OPERATIONS_KEY]: receipts } }
})

/**
 * What a cell that ended without its result says about its host operations.
 * A completed operation's result is in its receipt. One that started with no
 * recorded result may have acted. One that waited for an approval stopped
 * before its answer.
 */
const operationEffectsNote = (operations: ReadonlyArray<CellToolOperation>): string => {
  if (operations.length === 0) return "It made no host operation."
  const count = (n: number) => {
    if (n === 1) return "1 operation"
    return `${n} operations`
  }
  const whose = (n: number) => {
    if (n === 1) return "its"
    return "their"
  }
  const unrecorded = operations.filter((operation) => mayHaveActed(operation.state)).length
  const waiting = operations.filter((operation) => operation.state._tag === "Waiting").length
  const notes: Array<string> = []
  if (unrecorded > 0)
    notes.push(
      `${count(unrecorded)} ran with no recorded result; ${whose(unrecorded)} effects may have occurred.`,
    )
  if (waiting > 0) notes.push(`${count(waiting)} stopped at an approval that was not answered.`)
  if (notes.length === 0) return "Every host operation it made has its result in operations."
  return notes.join(" ")
}

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
      // An inner call waits for its answer in place, so it never parks. A
      // call that parks anyway has no turn to resume it: it fails closed.
      Effect.mapError(
        () =>
          new CellEvaluationError({
            phase: "execute",
            message:
              "The call parked on an interaction, which an inner cell call cannot resume. Its effects may have occurred.",
            output: "",
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
    const message = yield* Option.match(decodeErrorOnly(value), {
      onSome: ({ error }) => Effect.succeed(error),
      onNone: () =>
        Schema.encodeEffect(JsonText)(value).pipe(
          Effect.mapError(
            (cause) =>
              new CellEvaluationError({ phase: "execute", message: String(cause), output: "" }),
          ),
        ),
    })
    return yield* new CellEvaluationError({ phase: "execute", message, output: "" })
  }
  return value
})

/** A failure that is only `{ error }` throws that text; any other value throws as JSON. */
const decodeErrorOnly = (value: Schema.Json) =>
  Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }))(value, {
    onExcessProperty: "error",
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
type CellToolHostServices = CellStorage | EventStore | GentPlatform | MessageStorage | ToolRunner

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
          const admission = yield* storage
            .admit({
              ...key,
              binding: identity.value,
              input: request.input,
            })
            .pipe(
              // Admission comes before the operation: nothing ran.
              Effect.mapError(
                (cause) =>
                  new CellEvaluationError({
                    phase: "execute",
                    message: `Cell operation storage failed. The operation was not run: ${cause.message}`,
                    output: "",
                  }),
              ),
            )
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

/** The worker binary a compiled build ships next to its executable. */
const CELL_WORKER_BINARY = "gent-cell"

/** The compiled build defines this symbol; a source run leaves it undeclared. */
declare const __GENT_COMPILED__: unknown

const isCompiledBuild = Effect.try({
  try: () => __GENT_COMPILED__ === true,
  catch: () => false,
}).pipe(Effect.orElseSucceed(() => false))

/**
 * Where the worker lives. A compiled build runs the `gent-cell` binary beside
 * its executable. A source run executes this checkout's worker source with the
 * running Bun, so it never launches a stale built worker.
 */
export const cellWorkerLaunch = Effect.gen(function* () {
  const platform = yield* GentPlatform
  const path = yield* Path.Path
  const execPath = yield* platform.execPath
  if (yield* isCompiledBuild) {
    return CellWorker.cases.Compiled.make({
      binaryPath: path.join(path.dirname(execPath), CELL_WORKER_BINARY),
    })
  }
  const scriptPath = yield* path.fromFileUrl(new URL("./cell-worker-boundary.ts", import.meta.url))
  return CellWorker.cases.Script.make({ runtimePath: execPath, scriptPath })
})

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
type Kernel = Effect.Success<ReturnType<typeof openCellKernel>>

interface CellExecutionService {
  /** The caller's `ExtensionContext` reads the session a first kernel start may inherit from. */
  readonly run: (call: {
    readonly assistantMessageId: MessageId
    readonly toolCallId: ToolCallId
  }) => Effect.Effect<
    Prompt.ToolResultPart,
    StorageError | CellExecutionIncomplete,
    CellOperationHost | ExtensionContext
  >
  readonly cancel: Effect.Effect<void>
  /** The loop closes: end the running cell and record nothing, as a crash would. */
  readonly stop: Effect.Effect<void>
}

/** One branch scope owns admission and a lazily acquired kernel. Host authority stays per call. */
export class CellExecution extends Context.Service<CellExecution, CellExecutionService>()(
  "@gent/extensions/src/cell/CellExecution",
) {
  /** The cell owns its worker: `cellWorkerLaunch` says where it lives. */
  static Branch = (address: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly cwd: string
    readonly turnInterruption: TurnInterruptionStatus
  }) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const worker = yield* cellWorkerLaunch
        const live = CellExecution.Live({ ...address, worker })
        // The loop cancels branch work through `BranchToolWork`; the cell's
        // own cancel is what that means here. The context ledger ships with the
        // cell too: the cell is what schedules directives into it.
        return Layer.provideMerge(
          Layer.merge(
            Layer.effect(
              BranchToolWork,
              Effect.map(CellExecution, (cells) =>
                BranchToolWork.of({ cancel: cells.cancel, stop: cells.stop }),
              ),
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
        const operations = (yield* CellStorage).operations
        const namespaces = (yield* CellStorage).namespaces
        const scope = yield* Effect.scope
        const platform = yield* Effect.context<
          FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
        >()
        const permit = yield* Semaphore.make(1)
        let cancellationEpoch = 0
        // Set once the loop closes: a run that ends records nothing.
        let stopping = false
        let active = Option.none<Deferred.Deferred<never, CellKernelError>>()
        const cancelled = () =>
          new CellKernelError({
            reason: "cancelled",
            message: "Cell cancelled. Its source was not replayed.",
            diagnostics: "",
            stateLost: true,
          })
        let kernel = Option.none<Kernel>()
        let failedStarts = 0
        // Set when the worker reported state loss; the next run replaces it and restores.
        let recoveryPending = false
        // Report for the first evaluation after a host-owned restore.
        let restoreReport = Option.none<CellRestoreReport>()
        const namespaceAddress = { sessionId: input.sessionId, branchId: input.branchId }
        /**
         * A handoff session continues its predecessor's thread, so the branch
         * it opened with starts from the namespace the predecessor saved on
         * the branch it was handed off from. That is the session's first
         * branch; a branch created or forked later in the session starts
         * empty. One hop: the predecessor's own inheritance was
         * copied into its row the same way. A spawned session (a delegate
         * child, a `/btw` fork) does not join the thread and starts empty.
         */
        const inheritNamespace = Effect.fn("CellExecution.inheritNamespace")(function* () {
          const ctx = yield* ExtensionContext
          const session = yield* ctx.Session.getSession(input.sessionId).pipe(
            Effect.mapError(namespaceStorageFailure),
          )
          const predecessor = Option.fromUndefinedOr(session).pipe(
            Option.filter((value) => !isSpawnedSession(value)),
            Option.flatMap((value) =>
              Option.all({
                sessionId: Option.fromUndefinedOr(value.parentSessionId),
                branchId: Option.fromUndefinedOr(value.parentBranchId),
              }),
            ),
          )
          if (Option.isNone(predecessor)) return Option.none<SavedNamespace>()
          // The caller's session branches, oldest first. A fork always comes
          // after the branch it forks, so the oldest is the opening branch.
          const branches = yield* ctx.Session.listBranches.pipe(
            Effect.mapError(namespaceStorageFailure),
          )
          if (branches[0]?.id !== input.branchId) return Option.none<SavedNamespace>()
          const saved = yield* namespaces.get(predecessor.value)
          return Option.map(saved, (snapshot): SavedNamespace => ({
            snapshot,
            previousSession: Option.some(predecessor.value.sessionId),
          }))
        })
        /**
         * A branch's first start fixes its starting namespace in its own row:
         * the inherited one, else an empty one. Copied, not shared: later
         * writes on either side stay on their own branch, and a predecessor
         * that saves only later is not inherited.
         */
        const startNamespace = Effect.fn("CellExecution.startNamespace")(function* () {
          const inherited = yield* inheritNamespace()
          yield* namespaces.set(
            namespaceAddress,
            Option.match(inherited, {
              onNone: () => emptyNamespace,
              onSome: (value) => value.snapshot,
            }),
          )
          return inherited
        })
        /**
         * Put the last good namespace back into a fresh worker: this branch's
         * own, else the one its first start fixes. Missing values are named;
         * an inherited namespace also names the session it came from.
         */
        const restoreNamespace = Effect.fn("CellExecution.restoreNamespace")(function* (
          current: Kernel,
        ) {
          const saved = yield* namespaces.get(namespaceAddress).pipe(
            Effect.flatMap(
              Option.match({
                onNone: startNamespace,
                onSome: (snapshot) =>
                  Effect.succeedSome<SavedNamespace>({ snapshot, previousSession: Option.none() }),
              }),
            ),
          )
          if (Option.isNone(saved)) return
          const { snapshot, previousSession } = saved.value
          const restored = yield* current.restore(snapshot.bindings)
          // An empty namespace has nothing to report.
          if (restored.length === 0 && snapshot.omitted.length === 0) return
          const report: CellRestoreReport = { restored, omitted: snapshot.omitted }
          restoreReport = Option.some(
            Option.match(previousSession, {
              onNone: () => report,
              onSome: (sessionId) => ({ ...report, previousSession: sessionId }),
            }),
          )
        })
        /**
         * Keep the namespace after each good cell. A snapshot that fails lost
         * the worker, so the next cell replaces it and restores the last
         * namespace saved; a failed store only loses recency.
         */
        const saveNamespace = Effect.fn("CellExecution.saveNamespace")(function* (current: Kernel) {
          yield* current.snapshot.pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                recoveryPending = true
              }),
            ),
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
          // The first launch counts against the same limit as the kernel's replacements.
          if (failedStarts >= (input.maximumFailedLaunches ?? DEFAULT_MAXIMUM_FAILED_LAUNCHES)) {
            return yield* new CellProcessError({
              phase: "launch",
              message: `Cell worker failed to launch ${failedStarts} times in a row`,
              diagnostics: "",
            })
          }
          return yield* Effect.uninterruptibleMask((restore) =>
            restore(
              openCellKernel(input).pipe(Effect.provideContext(platform), Scope.provide(scope)),
            ).pipe(
              Effect.tapError(() =>
                Effect.sync(() => {
                  failedStarts++
                }),
              ),
              // The worker is recorded only once its namespace is back. A
              // failed restore closes it, so the next cell opens a clean one
              // and restores again instead of running on an empty worker.
              Effect.tap((opened) =>
                restoreNamespace(opened).pipe(Effect.onError(() => opened.close)),
              ),
              Effect.tap((opened) =>
                Effect.sync(() => {
                  kernel = Option.some(opened)
                  // A new worker starts clean and was restored above: the
                  // recovery a failed launch asked for is done.
                  recoveryPending = false
                }),
              ),
            ),
          )
        })
        /**
         * Reset on request saves an empty namespace, so a later restart
         * neither restores the old one nor inherits a predecessor's; reset
         * after loss restores it.
         */
        const prepare = Effect.fn("CellExecution.prepare")(function* (
          current: Kernel,
          reset: boolean,
        ) {
          if (reset) {
            yield* current.reset
            yield* namespaces.set(namespaceAddress, emptyNamespace)
            recoveryPending = false
            restoreReport = Option.none()
            return
          }
          if (!recoveryPending) return
          yield* current.reset
          yield* restoreNamespace(current)
          // Cleared only after the restore: a failed one is tried again next cell.
          recoveryPending = false
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
          // The loop closed before this run took the permit: it takes no claim
          // and runs nothing, so a restart issues the call again.
          if (stopping) return yield* Effect.interrupt
          const address = { ...call, sessionId: input.sessionId, branchId: input.branchId }
          const admission = yield* storage.claim(address)
          if (admission._tag === "Completed") return admission.result
          if (admission._tag === "Incomplete") {
            // What its operations did is on their records; a failed read says
            // only that effects may have occurred.
            const effects = yield* operations.listForToolCall(address).pipe(
              Effect.map((listed) => operationEffectsNote(listed.map((entry) => entry.operation))),
              Effect.orElseSucceed(() => "Its effects may have occurred."),
            )
            return yield* new CellExecutionIncomplete({
              ...address,
              message: `The cell has no recorded result. ${effects} Its source was not replayed.`,
            })
          }
          const signal = yield* Deferred.make<never, CellKernelError>()
          active = Option.some(signal)
          // Set once the cell may act. A run stopped before then never ran.
          let started = false
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
            started = true
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
              onFailure: (error): Effect.Effect<Prompt.ToolResultPart, StorageError> => {
                if (error._tag === "StorageError") return Effect.fail(error)
                // A cell error leaves the worker as it was, unless the kernel
                // discarded it for a built-in the worker could not put back.
                if (
                  error._tag !== "CellEvaluationError" ||
                  Option.exists(kernel, (current) => current.isLost())
                )
                  recoveryPending = true
                // A cancelled cell says what its operations did, from their
                // records. A failed read keeps the plain cancel: the cancel
                // still records its result.
                let described: Effect.Effect<typeof error, StorageError> = Effect.succeed(error)
                if (error._tag === "CellKernelError" && error.reason === "cancelled")
                  described = operations.listForToolCall(address).pipe(
                    Effect.map(
                      (listed): typeof error =>
                        new CellKernelError({
                          reason: error.reason,
                          message: `${error.message} ${operationEffectsNote(listed.map((entry) => entry.operation))}`,
                          diagnostics: error.diagnostics,
                          stateLost: error.stateLost,
                        }),
                    ),
                    Effect.orElseSucceed(() => error),
                  )
                return described.pipe(
                  Effect.flatMap((failure) =>
                    Schema.encodeEffect(CellFailure)(failure).pipe(
                      Effect.mapError(
                        (cause) =>
                          new StorageError({ message: "Failed to encode cell failure", cause }),
                      ),
                    ),
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
          // The loop closed under a run that started. Leave its record as a
          // crash would, so recovery after a restart resumes a waiting
          // operation. A run stopped before it started did nothing: its
          // "did not start" result is recorded, so recovery does not report
          // a lost worker.
          if (stopping && started) return yield* Effect.interrupt
          yield* storage.complete(address, result)
          if (stopping) return yield* Effect.interrupt
          return result
        })
        const cancel = Effect.fn("CellExecution.cancel")(function* () {
          cancellationEpoch++
          if (Option.isSome(active)) yield* Deferred.fail(active.value, cancelled())
          yield* Semaphore.withPermit(permit, Effect.void)
        })
        const stop = Effect.fn("CellExecution.stop")(function* () {
          stopping = true
          yield* cancel()
        })
        return CellExecution.of({
          run: (call) =>
            Effect.suspend(() => Semaphore.withPermit(permit, run(call, cancellationEpoch))),
          cancel: cancel().pipe(Effect.uninterruptible),
          stop: stop().pipe(Effect.uninterruptible),
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
  return yield* runAgentLoopTurnProfile(params.profile)(
    withCellOperationReceipts(cell, result, params.toolBindings),
  )
})

// ── tool ────────────────────────────────────────────────────────────────────

/** The model-facing name of the cell tool. */
const CELL_TOOL_ID = "cell"

/** Declaration only. The turn dispatcher still owns identity, permissions, and execution scope. */
export const CellTool = tool({
  id: CELL_TOOL_ID,
  description: "Run TypeScript in this branch's Bun process. Bindings persist across cells.",
  // The cell calls host tools from inside itself, so recovery must restore
  // host bindings for it, not just its own.
  dispatches: true,
  params: CellInput,
  output: Schema.Json,
  promptGuidelines: [
    "Top-level variables stay bound in later cells on this branch. A result's bindings names only those the cell added or bound to another value; bindingCount counts them all. The host saves them after each cell and restores them after a worker restart; a result then carries restored (names) and omitted (functions, class instances, cycles, oversized values). They also carry into a /handoff session, which continues the thread: its first cell starts with the previous session's saved values, and restored.previousSession names that session. Keep a scratchpad for long work in a binding.",
    "Call a host tool through its id path: await tools.read({ path }), await tools.delegate.start({ todo }). Run independent calls concurrently with Promise.all; chain dependent calls with sequential awaits.",
    "The cell is a full Bun process in the working directory with your user's privileges; nothing is sandboxed. Bun (Bun.file, Bun.write, Bun.$, Bun.spawn), bun:sqlite, fetch, process (cwd, env), node builtins through await import('node:fs/promises') or require('node:path'), and packages resolved from the working directory are all available. Use it directly to read, search, parse, and transform data.",
    "Network reads are plain fetch in the cell; parse HTML or JSON there. Past sessions live in data.db under process.env.GENT_DATA_DIR, else ~/.gent (bun:sqlite; tables sessions, messages, message_chunks, content_chunks, events), so search them with SQL instead of a host tool.",
    "Shell that changes state (git, installs, deletes, network writes) goes through tools.bash({ command }): it carries the approval guardrails and the session trailer. Bun.$ and Bun.spawn are for short reads: queries, parsers, quick checks. Use host tools for work that needs permissions, durable records, and child agents.",
    `A cell gets ${CELL_COMPUTE_DEADLINE_MS / 1000} seconds of its own compute; past that the worker is killed and bindings not yet saved are lost. An awaited host call stops that clock, so run builds, test suites, and other long commands through tools.bash({ command, timeout }) (timeout up to 600000 ms) and parse its stdout and stderr in the cell.`,
    "console output, process.stdout and process.stderr writes, and inherited output of spawned processes return with the cell result, before the value of the last expression. Output a spawned process writes after the cell ends is lost, so await the processes you start.",
    "The value of the last expression is the cell result; an undefined value shows nothing. Top-level await works; a top-level return does not.",
    "Return a summary, not the data. You see at most 8,000 characters of any tool result (head and tail); a larger result is spilled and its `read` field says how to page the rest with context.read. Slice arrays, count instead of listing, and keep the full value in a binding for the next cell.",
    "Bun.$`cmd`.text() returns stdout only, and Bun.$ pipes stderr away; test runners and many tools report on stderr. Use Bun.spawn with inherited stdio so the output returns with the cell, or .quiet() and read .stderr.",
    "The Host Tools section lists every host tool selected for this turn with its signature. tools(id) returns the tool as a function carrying its full input schema (parameters) and guidelines; it is local and synchronous and does not grant permission to execute. Object.keys(tools) lists the top-level names.",
    "The whole session stays reachable from the cell. context.history({ offset, limit }) lists this branch's durable messages in order (id, role, chars, preview, kind), 50 per page with nextOffset. context.read(id, { offset, limit }) returns durable text by message id or tool call id, paged by character offset and limit (nextOffset continues); receipts in a cell result carry the ids of inner calls. context.status() reports what the model sees: tokens, limit, percent, omittedMessages, handoffMessageId. When the window overflows, the history before the current turn is handed off: one durable notice summarizes it and names the session, branch, and message-id range it replaced, so read it back with context.history and context.read instead of guessing. context.compact(instructions?) asks for that handoff before the next turn, focused on the instructions. context.newWindow() drops older history from the model view without a summary. All five are awaited host calls.",
    "Set reset: true to discard retained values and the saved namespace before running new code.",
    "A failed cell may have completed effects. Do not replay source to recover unknown outcomes.",
  ],
  execute: Effect.fn("CellTool.execute")(function* () {
    const saved = yield* dispatchCell()
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

/**
 * The tools a recovered cell's completed operations were bound to, resolved
 * the way a resume resolves them. A binding that no longer resolves (the tool
 * is gone, or its source or schema changed) is left out, so that receipt keeps
 * the head of its output instead of a summary from a different tool.
 */
const recoveredReceiptTools = (
  params: Pick<Parameters<typeof resumeCellToolOperation>[0], "cell" | "profile">,
  operations: ReadonlyArray<{ readonly operation: CellToolOperation }>,
) =>
  runAgentLoopTurnProfile(params.profile)(
    Effect.gen(function* () {
      const tools = new Map<string, ResolvedToolCapability>()
      for (const { operation } of operations) {
        if (operation.state._tag !== "Completed") continue
        const resolved = yield* resolveStoredToolBinding({
          sessionId: params.cell.sessionId,
          assistantMessageId: params.cell.assistantMessageId,
          toolCallId: operation.toolCallId,
          binding: operation.binding,
          generationId: params.profile.turnGenerationId,
        }).pipe(Effect.option)
        if (Option.isSome(resolved)) tools.set(String(operation.binding.toolId), resolved.value)
      }
      return tools satisfies ReceiptTools
    }),
  )

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
  // A cell stored as completed may have died before its receipts were attached.
  if (outer._tag === "Completed")
    return yield* withCellOperationReceipts(
      params.cell,
      outer.result,
      yield* recoveredReceiptTools(params, yield* operations.listForToolCall(params.cell)),
    )
  const records = yield* operations.listForToolCall(params.cell)
  const pending = yield* interactions.listOpen(params.cell)
  for (const { key, operation } of records) {
    if (operation.state._tag !== "Waiting") continue
    const requestId = operation.state.requestId
    const request = Option.fromUndefinedOr(pending.find((record) => record.requestId === requestId))
    if (Option.isNone(request))
      return yield* new StorageError({
        message: "Cell approval request is missing during recovery",
      })
    // An operation a lost worker left waiting has no answer yet, so the turn
    // parks on its request. A live inner call never parks; it waits in place.
    if (Option.isNone(Option.fromUndefinedOr(request.value.decisionJson)))
      return yield* new InteractionPendingError({
        requestId,
        sessionId: params.cell.sessionId,
        branchId: params.cell.branchId,
      })
    yield* resumeCellToolOperation({ ...params, operationId: key.operationId, requestId })
  }
  // The receipt shape every client decodes. An operation with no recorded
  // outcome is incomplete; a completed one is read back with context.read.
  const latest = yield* operations.listForToolCall(params.cell)
  const tools = yield* recoveredReceiptTools(params, latest)
  const receipts = encodeReceipts(latest.map(({ operation }) => receiptFor(operation, tools)))
  const result = Prompt.toolResultPart({
    id: params.cell.toolCallId,
    name: "cell",
    isFailure: true,
    providerExecuted: false,
    result: {
      error: `The cell worker state was lost. Its source was not replayed. ${operationEffectsNote(latest.map((entry) => entry.operation))}`,
      stateLost: true,
      [CELL_OPERATIONS_KEY]: receipts,
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
 * is left to the loop, which reports it as interrupted.
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
        // Never admitted: no receipt to settle from; the loop reports it.
        if (Option.isNone(saved)) return ToolCallRecoveryOutcome.cases.NotRecovered.make({})
        const profile = yield* CurrentAgentLoopTurnProfile
        return yield* recover({ cell, profile }).pipe(
          Effect.map((result) => ToolCallRecoveryOutcome.cases.Settled.make({ result })),
          Effect.catchTag("InteractionPendingError", (pending) =>
            Effect.succeed(
              ToolCallRecoveryOutcome.cases.Suspended.make({ requestId: pending.requestId }),
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

/** What the cell's storage installs. Core merges it without naming it. */
type CellStorageTags = CellStorage | RetainedBindings | ToolCallRecoveryService

/**
 * The cell's storage layers, assembled as one unit.
 *
 * Core's SQLite assembler builds the kernel's tables and takes any extra
 * repositories as a parameter. This is the cell's contribution to that call:
 * the three tables it owns, wired against the same SQL client, so core never
 * names them.
 *
 * `interactionStorage` is passed in rather than rebuilt: operation receipts
 * and interaction records must share one instance, or a suspended approval
 * would be written to a store nothing reads back.
 */
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

const CELL_EXTENSION_ID = ExtensionId.make("@gent/cell")

/**
 * The default model execution surface. When this builtin is registered, a native
 * model turn advertises only `cell`; host tools stay callable inside the cell
 * as `tools.<id path>(input)` through the turn's bound identities. The kernel
 * builds that namespace, and the local `tools(id)` lookup, from the catalog the
 * host ships with each changed turn.
 * The extension owns the model selection and catalog through ordinary hooks.
 */
export const CellExtension = defineExtension({
  id: CELL_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", CellTool)
    yield* host.on("turnProjection", ({ agent }) => {
      if (agent.deniedTools?.includes("cell") === true) {
        return Effect.succeed({})
      }
      return Effect.succeed({
        toolPolicy: { include: ["cell"], modelSet: ["cell"] },
        promptSections: [CELL_WORK_SECTION],
      })
    })
    // The host tool list differs by agent, so it follows the shared prompt.
    yield* host.on("systemPrompt", (input) =>
      Effect.gen(function* () {
        if (input.tools?.length !== 1 || !input.tools.some((tool) => getToolId(tool) === "cell")) {
          return input.basePrompt
        }
        const entries = yield* Effect.forEach(
          (input.hostTools ?? [])
            .filter((tool) => getToolId(tool) !== "cell")
            .toSorted((left, right) => getToolId(left).localeCompare(getToolId(right))),
          renderToolSignature,
        )
        if (entries.length === 0) return input.basePrompt
        const catalog = `## Host Tools\n\nInside \`cell\`, each host tool id is a function path under \`tools\`: id \`a.b\` is \`await tools.a.b(input)\`. \`tools(id)\` returns the tool with its full input schema (\`parameters\`) and \`guidelines\`, and reaches an id with a JavaScript built-in segment such as \`then\` or \`name\`.\n\n${entries.join("\n")}`
        return `${input.basePrompt}\n\n${catalog}`
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
- Example: \`const run = await tools.bash({ command: "bun test", timeout: 600000 }); const lines = (run.stdout + run.stderr).split("\\n"); const failing = lines.filter((l) => l.includes("(fail)")); ({ exit: run.exitCode, total: failing.length, sample: failing.slice(0, 5) })\` returns the outcome and a sample; lines stays bound for the next cell.
- To find files, prefer tools.grep({ pattern }) over a raw directory walk: it honours .gitignore.`

/**
 * The cell guide, in the agent's own part after the tool list and tool
 * guidelines: an agent denied the cell has no guide, so the part it shares
 * with its parent cannot hold one.
 */
const CELL_WORK_SECTION = {
  id: "cell-work",
  priority: AGENT_PROMPT_PRIORITY + 6,
  content: CELL_WORK,
}

// ── tool signatures ─────────────────────────────────────────────────────────

/** Nested objects longer than this render as `object`; `tools(id).parameters` has the rest. */
const INLINE_OBJECT_LIMIT = 80
/**
 * An input or result type longer than this renders as its outer shape, so no
 * schema can flood the prompt. One bound for both: the result is the half of
 * the contract the cell code reads, so a shipped tool's result renders whole.
 */
const SIGNATURE_TYPE_LIMIT = 300
/** An enum with more literals than this renders as the literals' types. */
const LITERAL_LIMIT = 8
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

const literalType = (value: SchemaValue) => {
  if (Predicate.isString(value)) return "string"
  if (Predicate.isNumber(value)) return "number"
  if (Predicate.isBoolean(value)) return "boolean"
  if (Predicate.isNull(value)) return "null"
  return "unknown"
}

/** A short enum lists its literals; a long one names their types. */
const renderLiterals = (values: ReadonlyArray<SchemaValue>) => {
  if (values.length <= LITERAL_LIMIT) return union(values.map((value) => encodeJson(value)))
  return union(values.map(literalType))
}

/**
 * The definitions a schema's local `#/$defs/X` references name, and the ones
 * being rendered now: a reference back into one of them is a cycle. One render
 * shares `expanded`: a definition's text is built once per mode and reused, so
 * a definition reached many times costs one expansion, and each text is kept
 * only up to `limit`.
 */
interface SchemaScope {
  readonly defs: JsonSchema.JsonSchema
  readonly visiting: ReadonlySet<string>
  readonly expanded: Map<string, string>
  readonly limit: number
}

const rootScope = (schema: JsonSchema.JsonSchema, limit: number): SchemaScope => {
  const found = schema["$defs"]
  let defs: JsonSchema.JsonSchema = {}
  if (isSchemaNode(found)) defs = found
  return { defs, visiting: new Set(), expanded: new Map(), limit }
}

const LOCAL_REF = "#/$defs/"

/** The node a local reference names, with its name marked as visiting; none for a cycle or a foreign ref. */
const resolveRef = (
  ref: string,
  scope: SchemaScope,
): Option.Option<readonly [JsonSchema.JsonSchema, SchemaScope]> => {
  if (!ref.startsWith(LOCAL_REF)) return Option.none()
  const name = ref.slice(LOCAL_REF.length)
  const target = scope.defs[name]
  if (scope.visiting.has(name) || !isSchemaNode(target)) return Option.none()
  return Option.some([target, { ...scope, visiting: new Set([...scope.visiting, name]) }])
}

/**
 * A text past `limit`, with no ` | ` for a field to split: it keeps every
 * enclosing type past the limit too, and an inline object drops it as `object`.
 */
const overLimit = (limit: number) => "~".repeat(limit + 1)

/**
 * A local reference's text in one render mode: a cycle or a foreign ref is
 * `object`; any other definition is expanded once per mode and reused. The
 * cache key leaves out the refs being visited, so a definition first rendered
 * inside a cycle keeps the `object` it showed for that cycle's ref wherever it
 * is reused: a shallower text, still valid.
 */
const expandRef = (
  ref: string,
  mode: string,
  scope: SchemaScope,
  render: (target: JsonSchema.JsonSchema, inner: SchemaScope) => string,
): string =>
  Option.match(resolveRef(ref, scope), {
    onNone: () => "object",
    onSome: ([target, inner]) => {
      const key = `${mode} ${ref}`
      const known = scope.expanded.get(key)
      if (Predicate.isNotUndefined(known)) return known
      let rendered = render(target, inner)
      if (rendered.length > scope.limit) rendered = overLimit(scope.limit)
      scope.expanded.set(key, rendered)
      return rendered
    },
  })

/**
 * Whether a call with no argument is valid: the host sends `{}` for it, so the
 * schema must accept an empty object. A schema with no constraint accepts it;
 * a number, a literal, or an object with required keys does not.
 */
const acceptsEmptyInput = (schema: JsonSchema.JsonSchema, scope: SchemaScope): boolean => {
  const alternatives = [...schemaNodes(schema["anyOf"]), ...schemaNodes(schema["oneOf"])]
  if (alternatives.length > 0)
    return alternatives.some((member) => acceptsEmptyInput(member, scope))
  const ref = schema["$ref"]
  if (Predicate.isString(ref)) {
    // A cycle or a foreign ref expands to `object`, which is not "true".
    const accepts = expandRef(ref, "empty", scope, (target, inner) =>
      String(acceptsEmptyInput(target, inner)),
    )
    return accepts === "true"
  }
  if ("const" in schema || "enum" in schema) return false
  const types = strings([schema["type"]].flat())
  if (types.length === 0) return true
  return types.includes("object") && strings(schema["required"]).length === 0
}

/**
 * The outer shape of a type too long to render whole: each union member keeps
 * its kind, an array keeps its items' kind, and an object becomes `object`.
 */
const outerType = (schema: JsonSchema.JsonSchema, scope: SchemaScope): string => {
  if ("const" in schema) return literalType(schema["const"])
  if (Array.isArray(schema["enum"])) return union(schema["enum"].map(literalType))
  const alternatives = [...schemaNodes(schema["anyOf"]), ...schemaNodes(schema["oneOf"])]
  if (alternatives.length > 0) return union(alternatives.map((member) => outerType(member, scope)))
  const ref = schema["$ref"]
  if (Predicate.isString(ref)) return expandRef(ref, "outer", scope, outerType)
  const types = strings([schema["type"]].flat())
  if (types.length === 0) {
    if (isSchemaNode(schema["properties"])) return "object"
    return "unknown"
  }
  return union(types.map((type) => outerTypeName(schema, type, scope)))
}

const outerTypeName = (schema: JsonSchema.JsonSchema, type: string, scope: SchemaScope) => {
  if (type === "object") return "object"
  if (type !== "array") return renderTypeName({}, type, 0, scope)
  const items = schema["items"]
  if (!isSchemaNode(items)) return "unknown[]"
  return `${parenthesize(outerType(items, scope))}[]`
}

/**
 * The plain kind of a type whose outer shape is still too long: each union
 * member's kind, every array `unknown[]` and every object `object`. It names at
 * most the seven kinds, so it always fits.
 */
const plainKind = (schema: JsonSchema.JsonSchema, scope: SchemaScope): string => {
  if ("const" in schema) return literalType(schema["const"])
  if (Array.isArray(schema["enum"])) return union(schema["enum"].map(literalType))
  const alternatives = [...schemaNodes(schema["anyOf"]), ...schemaNodes(schema["oneOf"])]
  if (alternatives.length > 0) {
    // A kind has no inner ` | `, so a member's kinds split apart and merge with the rest.
    return union(alternatives.flatMap((member) => plainKind(member, scope).split(" | ")))
  }
  const ref = schema["$ref"]
  if (Predicate.isString(ref)) return expandRef(ref, "plain", scope, plainKind)
  const types = strings([schema["type"]].flat())
  if (types.length === 0) {
    if (isSchemaNode(schema["properties"])) return "object"
    return "unknown"
  }
  return union(
    types.map((type) => {
      if (type === "array") return "unknown[]"
      if (type === "object") return "object"
      return renderTypeName({}, type, 0, scope)
    }),
  )
}

/**
 * A schema's type; past `limit`, its outer shape; still past it, its plain kind.
 * Every definition is expanded at most once per form, so a shared definition
 * reached at each level of a deep union costs one expansion, not one per path.
 */
const boundedSchemaType = (schema: JsonSchema.JsonSchema, limit: number) => {
  const scope = rootScope(schema, limit)
  const rendered = renderSchemaType(schema, 0, scope)
  if (rendered.length <= limit) return rendered
  const outer = outerType(schema, scope)
  if (outer.length <= limit) return outer
  return plainKind(schema, scope)
}

/**
 * One TypeScript-like type for a JSON Schema node. Objects past the first level
 * inline only while short; a local reference renders its definition, a cycle or
 * a foreign reference renders `object`, and anything unrecognized `unknown`.
 */
const renderSchemaType = (
  schema: JsonSchema.JsonSchema,
  depth: number,
  scope: SchemaScope,
): string => {
  if ("const" in schema) return encodeJson(schema["const"])
  if (Array.isArray(schema["enum"])) return renderLiterals(schema["enum"])
  const alternatives = [...schemaNodes(schema["anyOf"]), ...schemaNodes(schema["oneOf"])]
  if (alternatives.length > 0) {
    return union(alternatives.map((member) => renderSchemaType(member, depth, scope)))
  }
  const ref = schema["$ref"]
  if (Predicate.isString(ref)) {
    return expandRef(ref, `type ${depth}`, scope, (target, inner) =>
      renderSchemaType(target, depth, inner),
    )
  }
  const declared = schema["type"]
  const types = strings([declared].flat())
  if (types.length === 0) {
    if (isSchemaNode(schema["properties"])) return renderObjectType(schema, depth, scope)
    return "unknown"
  }
  return union(types.map((type) => renderTypeName(schema, type, depth, scope)))
}

const renderTypeName = (
  schema: JsonSchema.JsonSchema,
  type: string,
  depth: number,
  scope: SchemaScope,
): string => {
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
      return `${parenthesize(renderSchemaType(items, depth, scope))}[]`
    }
    case "object":
      return renderObjectType(schema, depth, scope)
    default:
      return "unknown"
  }
}

/** An optional key drops `null` from its union: omission already says "no value". */
const renderField = (
  name: string,
  schema: SchemaValue,
  required: boolean,
  depth: number,
  scope: SchemaScope,
) => {
  if (!isSchemaNode(schema)) return `${propertyKey(name)}?: unknown`
  const rendered = renderSchemaType(schema, depth, scope)
  if (required) return `${propertyKey(name)}: ${rendered}`
  // Only the field's own top-level members: a `null` nested inside one stays.
  const present = withoutNull(schema)
  if (Option.isNone(present)) return `${propertyKey(name)}?: ${rendered}`
  return `${propertyKey(name)}?: ${renderSchemaType(present.value, depth, scope)}`
}

const isNullSchema = (schema: JsonSchema.JsonSchema) =>
  schema["type"] === "null" || ("const" in schema && Predicate.isNull(schema["const"]))

/** The schema with its top-level `null` member removed; none when it has none or only that. */
const withoutNull = (schema: JsonSchema.JsonSchema): Option.Option<JsonSchema.JsonSchema> => {
  const alternatives = [...schemaNodes(schema["anyOf"]), ...schemaNodes(schema["oneOf"])]
  if (alternatives.length > 0) {
    // A nullable member is itself a union; its `null` is still top-level.
    const members = alternatives
      .filter((member) => !isNullSchema(member))
      .map((member) => {
        const inner = withoutNull(member)
        return { schema: Option.getOrElse(inner, () => member), stripped: Option.isSome(inner) }
      })
    const kept = members.map((member) => member.schema)
    const changed = kept.length < alternatives.length || members.some((member) => member.stripped)
    if (!changed || kept.length === 0) return Option.none()
    const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = schema
    return Option.some({ ...rest, anyOf: kept })
  }
  const types = strings([schema["type"]].flat())
  const kept = types.filter((type) => type !== "null")
  if (kept.length === types.length || kept.length === 0) return Option.none()
  return Option.some({ ...schema, type: kept })
}

/** An object with no named keys and a value schema is a record. */
const renderRecordType = (values: JsonSchema.JsonSchema, depth: number, scope: SchemaScope) => {
  if (depth >= 2) return "object"
  return `Record<string, ${renderSchemaType(values, depth + 1, scope)}>`
}

const renderObjectType = (
  schema: JsonSchema.JsonSchema,
  depth: number,
  scope: SchemaScope,
): string => {
  const properties = schema["properties"]
  const empty = !isSchemaNode(properties) || Object.keys(properties).length === 0
  const values = schema["additionalProperties"]
  if (empty && isSchemaNode(values)) return renderRecordType(values, depth, scope)
  if (empty && depth === 0) return "{}"
  if (empty || !isSchemaNode(properties) || depth >= 2) return "object"
  const required = new Set(strings(schema["required"]))
  const fields = Object.entries(properties).map(([name, value]) =>
    renderField(name, value, required.has(name), depth + 1, scope),
  )
  const rendered = `{ ${fields.join("; ")} }`
  if (depth > 0 && rendered.length > INLINE_OBJECT_LIMIT) return "object"
  return rendered
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
  const inputType = boundedSchemaType(parameters, SIGNATURE_TYPE_LIMIT)
  let input = `input: ${inputType}`
  if (acceptsEmptyInput(parameters, rootScope(parameters, SIGNATURE_TYPE_LIMIT))) {
    input = `input?: ${inputType}`
  }
  const resultType = boundedSchemaType(result, SIGNATURE_TYPE_LIMIT)
  const signature = `${toolPath(getToolId(tool))}(${input}): Promise<${resultType}>`
  const summary = firstLine(getToolPrompt(tool).promptSnippet ?? tool.description)
  if (summary.length === 0) return `- ${signature}`
  return `- ${signature} // ${summary}`
})
