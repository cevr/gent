import { Context, DateTime, Effect, Layer, Option, Predicate, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { canonicalJsonString } from "effect-encore"
import {
  canonicalizeResourceGraphDesiredCommand,
  ResourceGraphCommandConflictError,
  ResourceGraphDesiredCommand,
  ResourceGraphDesiredReceipt,
  ResourceGraphDesiredCommandJson,
  ResourceGraphExpectedRevisionError,
  ResourceGraphFailureJson,
  ResourceGraphKey,
  ResourceGraphSnapshotJson,
  ResourceGraphStaleReceiptError,
  ResourceGraphStatus,
  ResourceGraphStatusState,
  ResourceGraphSequence,
  type ResourceGraphAppliedReceipt,
  type ResourceGraphFailedReceipt,
  type ResourceGraphFailure,
  type ResourceGraphReceiptKey,
  type ResourceGraphStatus as ResourceGraphStatusType,
} from "../domain/resource-graph-state.js"
import { RequestId } from "../domain/ids.js"
import { StorageError } from "../domain/storage-error.js"
import { CurrentWorkspaceId, WorkspaceId } from "../server/workspace-rpc.js"
import { toSqlNull } from "./sqlite/rows.js"

const ResourceGraphStateRow = Schema.Struct({
  workspace_id: WorkspaceId,
  cwd: ResourceGraphKey.fields.cwd,
  desired_revision: ResourceGraphDesiredCommand.fields.desiredRevision,
  desired_sequence: ResourceGraphSequence,
  desired_json: Schema.String,
  applied_revision: Schema.NullOr(ResourceGraphDesiredCommand.fields.desiredRevision),
  applied_sequence: Schema.NullOr(ResourceGraphSequence),
  state: ResourceGraphStatusState,
  failure_json: Schema.NullOr(Schema.String),
  command_id: RequestId,
  updated_at: Schema.Int,
})
type ResourceGraphStateRow = typeof ResourceGraphStateRow.Type

const ResourceGraphCommandRow = Schema.Struct({
  workspace_id: WorkspaceId,
  cwd: ResourceGraphKey.fields.cwd,
  command_id: RequestId,
  desired_sequence: ResourceGraphSequence,
  command_json: Schema.String,
  created_at: Schema.Int,
})
type ResourceGraphCommandRow = typeof ResourceGraphCommandRow.Type

interface ResourceGraphStateSqlRow {
  readonly workspace_id: ResourceGraphStateRow["workspace_id"]
  readonly cwd: ResourceGraphStateRow["cwd"]
  readonly desired_revision: ResourceGraphStateRow["desired_revision"]
  readonly desired_sequence: ResourceGraphStateRow["desired_sequence"]
  readonly desired_json: ResourceGraphStateRow["desired_json"]
  readonly applied_revision: ResourceGraphStateRow["applied_revision"]
  readonly applied_sequence: ResourceGraphStateRow["applied_sequence"]
  readonly state: ResourceGraphStateRow["state"]
  readonly failure_json: ResourceGraphStateRow["failure_json"]
  readonly command_id: ResourceGraphStateRow["command_id"]
  readonly updated_at: ResourceGraphStateRow["updated_at"]
}

interface ResourceGraphCommandSqlRow {
  readonly workspace_id: ResourceGraphCommandRow["workspace_id"]
  readonly cwd: ResourceGraphCommandRow["cwd"]
  readonly command_id: ResourceGraphCommandRow["command_id"]
  readonly desired_sequence: ResourceGraphCommandRow["desired_sequence"]
  readonly command_json: ResourceGraphCommandRow["command_json"]
  readonly created_at: ResourceGraphCommandRow["created_at"]
}

export interface ResourceGraphStorageService {
  readonly recordDesired: (
    command: ResourceGraphDesiredCommand,
  ) => Effect.Effect<
    ResourceGraphDesiredReceipt,
    StorageError | ResourceGraphCommandConflictError | ResourceGraphExpectedRevisionError
  >
  readonly recordApplying: (
    receipt: ResourceGraphReceiptKey,
  ) => Effect.Effect<ResourceGraphStatusType, StorageError | ResourceGraphStaleReceiptError>
  /** Admit one receipt at the host transition boundary. */
  readonly admit: (
    receipt: ResourceGraphReceiptKey,
  ) => Effect.Effect<ResourceGraphAdmission, StorageError | ResourceGraphStaleReceiptError>
  readonly recordApplied: (
    receipt: ResourceGraphAppliedReceipt,
  ) => Effect.Effect<ResourceGraphStatusType, StorageError | ResourceGraphStaleReceiptError>
  /** Record completion for a receipt that was admitted before a newer desired row. */
  readonly recordAppliedAdmission: (
    admission: ResourceGraphAdmission,
  ) => Effect.Effect<ResourceGraphStatusType, StorageError | ResourceGraphStaleReceiptError>
  /** Discard an admission proof after live application fails. */
  readonly discardAdmission: (admission: ResourceGraphAdmission) => Effect.Effect<void>
  readonly recordFailed: (
    receipt: ResourceGraphFailedReceipt,
  ) => Effect.Effect<ResourceGraphStatusType, StorageError | ResourceGraphStaleReceiptError>
  readonly get: (
    key: ResourceGraphKey,
    // oxlint-disable-next-line effect/noNullish -- Storage lookup uses undefined for an absent owner.
  ) => Effect.Effect<ResourceGraphStatusType | undefined, StorageError>
  readonly listPending: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<ResourceGraphKey>, StorageError>
  readonly listAll: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<ResourceGraphKey>, StorageError>
  /** Trusted startup enumeration of workspaces with durable graph owners. */
  readonly listWorkspaces: Effect.Effect<ReadonlyArray<WorkspaceId>, StorageError>
}

/** Opaque proof issued only after the final desired-state admission check. */
export interface ResourceGraphAdmission {
  readonly receipt: ResourceGraphReceiptKey
}

// oxlint-disable-next-line effect/noUnknownParameters -- SQLite and schema decoders expose unknown causes.
const mapDesiredError = (message: string) => (cause: unknown) => {
  if (Schema.is(StorageError)(cause)) return cause
  if (Schema.is(ResourceGraphCommandConflictError)(cause)) return cause
  if (Schema.is(ResourceGraphExpectedRevisionError)(cause)) return cause
  return new StorageError({ message, cause })
}

// oxlint-disable-next-line effect/noUnknownParameters -- SQLite and schema decoders expose unknown causes.
const mapLifecycleError = (message: string) => (cause: unknown) => {
  if (Schema.is(StorageError)(cause)) return cause
  if (Schema.is(ResourceGraphStaleReceiptError)(cause)) return cause
  return new StorageError({ message, cause })
}

const mapReadError =
  (message: string) =>
  (cause: unknown): StorageError => {
    if (Schema.is(StorageError)(cause)) return cause
    return new StorageError({ message, cause })
  }

const statusKey = (status: ResourceGraphStatusType) =>
  ResourceGraphKey.make({ workspaceId: status.workspaceId, cwd: status.cwd })

const decodeStateRow = Schema.decodeUnknownEffect(ResourceGraphStateRow)
const decodeCommandRow = Schema.decodeUnknownEffect(ResourceGraphCommandRow)
const JsonString = Schema.fromJsonString(Schema.Json)
const mapJsonError =
  (message: string) =>
  (cause: unknown): StorageError => {
    if (Schema.is(StorageError)(cause)) return cause
    return new StorageError({ message, cause })
  }

const canonicalCommandJson = (
  command: ResourceGraphDesiredCommand,
): Effect.Effect<string, StorageError> =>
  Schema.encodeEffect(ResourceGraphDesiredCommandJson)(command).pipe(
    Effect.flatMap((encoded) => Schema.decodeEffect(JsonString)(encoded)),
    Effect.flatMap((json) =>
      Effect.try({
        try: () => canonicalJsonString(json),
        catch: (cause) =>
          new StorageError({ message: "Invalid desired resource graph JSON", cause }),
      }),
    ),
    Effect.mapError(mapJsonError("Invalid desired resource graph JSON")),
  )

const canonicalSnapshotJson = (
  snapshot: ResourceGraphDesiredCommand["snapshot"],
): Effect.Effect<string, StorageError> =>
  Schema.encodeEffect(ResourceGraphSnapshotJson)(snapshot).pipe(
    Effect.flatMap((encoded) => Schema.decodeEffect(JsonString)(encoded)),
    Effect.flatMap((json) =>
      Effect.try({
        try: () => canonicalJsonString(json),
        catch: (cause) =>
          new StorageError({ message: "Invalid resource graph snapshot JSON", cause }),
      }),
    ),
    Effect.mapError(mapJsonError("Invalid resource graph snapshot JSON")),
  )

export class ResourceGraphStorage extends Context.Service<
  ResourceGraphStorage,
  ResourceGraphStorageService
>()("@gent/core/src/storage/resource-graph-storage/ResourceGraphStorage") {
  static Live: Layer.Layer<ResourceGraphStorage, never, SqlClient.SqlClient> = Layer.effect(
    ResourceGraphStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const admissions = new WeakSet<ResourceGraphAdmission>()

      const ensureWorkspace = Effect.fn("ResourceGraphStorage.ensureWorkspace")(function* (
        workspaceId: WorkspaceId,
      ) {
        const currentWorkspaceId = yield* CurrentWorkspaceId
        if (workspaceId === currentWorkspaceId) return
        return yield* new StorageError({
          message: `Resource graph belongs to another workspace: ${workspaceId}`,
        })
      })

      const loadStateRow = Effect.fn("ResourceGraphStorage.loadStateRow")(function* (
        key: ResourceGraphKey,
      ) {
        const rows = yield* sql<ResourceGraphStateSqlRow>`
          SELECT workspace_id, cwd, desired_revision, desired_sequence, desired_json,
                 applied_revision, applied_sequence, state, failure_json, command_id, updated_at
          FROM resource_graph_state
          WHERE workspace_id = ${key.workspaceId} AND cwd = ${key.cwd}
          LIMIT 1
        `
        const row = rows[0]
        // oxlint-disable-next-line effect/noNullish -- Storage lookup uses undefined for an absent row.
        if (Predicate.isUndefined(row)) return undefined
        return yield* decodeStateRow(row).pipe(
          Effect.mapError(mapReadError("Failed to decode resource graph state row")),
        )
      })

      const loadCommandRow = Effect.fn("ResourceGraphStorage.loadCommandRow")(function* (
        key: ResourceGraphKey & { readonly commandId: RequestId },
      ) {
        const rows = yield* sql<ResourceGraphCommandSqlRow>`
          SELECT workspace_id, cwd, command_id, desired_sequence, command_json, created_at
          FROM resource_graph_commands
          WHERE workspace_id = ${key.workspaceId}
            AND cwd = ${key.cwd}
            AND command_id = ${key.commandId}
          LIMIT 1
        `
        const row = rows[0]
        // oxlint-disable-next-line effect/noNullish -- Storage lookup uses undefined for an absent row.
        if (Predicate.isUndefined(row)) return undefined
        return yield* decodeCommandRow(row).pipe(
          Effect.mapError(mapReadError("Failed to decode resource graph command row")),
        )
      })

      const decodeStatus = Effect.fn("ResourceGraphStorage.decodeStatus")(function* (
        row: ResourceGraphStateRow,
      ) {
        const snapshot = yield* Schema.decodeEffect(ResourceGraphSnapshotJson)(row.desired_json)
        const failure = yield* Option.match(Option.fromNullishOr(row.failure_json), {
          onNone: () => Effect.succeed(Option.none<ResourceGraphFailure>()),
          onSome: (json) => Schema.decodeEffect(ResourceGraphFailureJson)(json).pipe(Effect.asSome),
        })
        return ResourceGraphStatus.make({
          workspaceId: row.workspace_id,
          cwd: row.cwd,
          commandId: row.command_id,
          desiredRevision: row.desired_revision,
          desiredSequence: row.desired_sequence,
          snapshot,
          appliedRevision: Option.getOrUndefined(Option.fromNullishOr(row.applied_revision)),
          appliedSequence: Option.getOrUndefined(Option.fromNullishOr(row.applied_sequence)),
          state: row.state,
          failure: Option.getOrUndefined(failure),
        })
      })

      const loadStatus = Effect.fn("ResourceGraphStorage.loadStatus")(function* (
        key: ResourceGraphKey,
      ) {
        const row = yield* loadStateRow(key)
        // oxlint-disable-next-line effect/noNullish -- Storage lookup uses undefined for an absent row.
        if (Predicate.isUndefined(row)) return undefined
        return yield* decodeStatus(row)
      })

      const staleReceipt = (receipt: ResourceGraphReceiptKey) =>
        new ResourceGraphStaleReceiptError({
          workspaceId: receipt.workspaceId,
          cwd: receipt.cwd,
          desiredRevision: receipt.desiredRevision,
          desiredSequence: receipt.desiredSequence,
        })

      const ensureReceiptMatches = Effect.fn("ResourceGraphStorage.ensureReceiptMatches")(
        function* (receipt: ResourceGraphReceiptKey) {
          const current = yield* loadStatus({
            workspaceId: receipt.workspaceId,
            cwd: receipt.cwd,
          })
          if (
            Predicate.isUndefined(current) ||
            current.desiredRevision !== receipt.desiredRevision ||
            current.desiredSequence !== receipt.desiredSequence
          ) {
            return yield* staleReceipt(receipt)
          }
          return current
        },
      )

      const recordDesired = Effect.fn("ResourceGraphStorage.recordDesired")(function* (
        input: ResourceGraphDesiredCommand,
      ) {
        const decoded = yield* Schema.decodeEffect(ResourceGraphDesiredCommand)(input).pipe(
          Effect.mapError(mapDesiredError("Invalid desired resource graph")),
        )
        const command = ResourceGraphDesiredCommand.make(
          canonicalizeResourceGraphDesiredCommand(decoded),
        )
        yield* ensureWorkspace(command.workspaceId)
        const commandJson = yield* canonicalCommandJson(command)
        const snapshotJson = yield* canonicalSnapshotJson(command.snapshot)
        const now = (yield* DateTime.nowAsDate).getTime()

        return yield* Effect.gen(function* () {
          const key = { workspaceId: command.workspaceId, cwd: command.cwd }
          const existingCommand = yield* loadCommandRow({ ...key, commandId: command.commandId })
          if (Predicate.isNotUndefined(existingCommand)) {
            const savedCommand = yield* Schema.decodeEffect(ResourceGraphDesiredCommandJson)(
              existingCommand.command_json,
            )
            const existingCommandJson = yield* canonicalCommandJson(
              canonicalizeResourceGraphDesiredCommand(savedCommand),
            )
            if (existingCommandJson !== commandJson) {
              return yield* new ResourceGraphCommandConflictError({
                workspaceId: command.workspaceId,
                cwd: command.cwd,
                commandId: command.commandId,
              })
            }
            const current = yield* loadStatus(key)
            if (Predicate.isUndefined(current)) {
              return yield* new StorageError({
                message: "Resource graph command exists without its state projection",
              })
            }
            return ResourceGraphDesiredReceipt.make({
              workspaceId: savedCommand.workspaceId,
              cwd: savedCommand.cwd,
              commandId: savedCommand.commandId,
              desiredRevision: savedCommand.desiredRevision,
              desiredSequence: existingCommand.desired_sequence,
            })
          }

          const current = yield* loadStatus(key)
          const expectedRevision = command.expectedRevision
          if (Predicate.isUndefined(current)) {
            if (Predicate.isNotUndefined(expectedRevision)) {
              return yield* new ResourceGraphExpectedRevisionError(key)
            }
          } else if (
            Predicate.isUndefined(expectedRevision) ||
            expectedRevision !== current.desiredRevision
          ) {
            return yield* new ResourceGraphExpectedRevisionError(key)
          }

          const desiredSequence = Option.match(Option.fromUndefinedOr(current), {
            onNone: () => 1,
            onSome: (status) => status.desiredSequence + 1,
          })
          const appliedRevision = Option.fromUndefinedOr(current).pipe(
            Option.flatMap((status) => Option.fromUndefinedOr(status.appliedRevision)),
          )
          const appliedSequence = Option.fromUndefinedOr(current).pipe(
            Option.flatMap((status) => Option.fromUndefinedOr(status.appliedSequence)),
          )

          if (Predicate.isUndefined(current)) {
            yield* sql`
              INSERT INTO resource_graph_state (
                workspace_id, cwd, desired_revision, desired_sequence, desired_json,
                applied_revision, applied_sequence, state, failure_json, command_id, updated_at
              ) VALUES (
                ${command.workspaceId}, ${command.cwd}, ${command.desiredRevision}, ${desiredSequence},
                ${snapshotJson}, ${toSqlNull(Option.getOrUndefined(appliedRevision))},
                ${toSqlNull(Option.getOrUndefined(appliedSequence))},
                ${"pending"}, ${toSqlNull()}, ${command.commandId}, ${now}
              )
            `
          } else {
            yield* sql`
              UPDATE resource_graph_state
              SET desired_revision = ${command.desiredRevision},
                  desired_sequence = ${desiredSequence},
                  desired_json = ${snapshotJson},
                  applied_revision = ${toSqlNull(Option.getOrUndefined(appliedRevision))},
                  applied_sequence = ${toSqlNull(Option.getOrUndefined(appliedSequence))},
                  state = ${"pending"},
                  failure_json = ${toSqlNull()},
                  command_id = ${command.commandId},
                  updated_at = ${now}
              WHERE workspace_id = ${command.workspaceId} AND cwd = ${command.cwd}
            `
          }
          yield* sql`
            INSERT INTO resource_graph_commands (
              workspace_id, cwd, command_id, desired_sequence, command_json, created_at
            ) VALUES (
              ${command.workspaceId}, ${command.cwd}, ${command.commandId}, ${desiredSequence},
              ${commandJson}, ${now}
            )
          `
          return ResourceGraphDesiredReceipt.make({
            workspaceId: command.workspaceId,
            cwd: command.cwd,
            commandId: command.commandId,
            desiredRevision: command.desiredRevision,
            desiredSequence,
          })
        }).pipe(
          sql.withTransaction,
          Effect.mapError(mapDesiredError("Failed to record desired resource graph")),
        )
      })

      const markApplying = (receipt: ResourceGraphReceiptKey) =>
        Effect.gen(function* () {
          yield* ensureReceiptMatches(receipt)
          yield* sql`
            UPDATE resource_graph_state
            SET state = ${"applying"}, failure_json = ${toSqlNull()}
            WHERE workspace_id = ${receipt.workspaceId}
              AND cwd = ${receipt.cwd}
              AND desired_revision = ${receipt.desiredRevision}
              AND desired_sequence = ${receipt.desiredSequence}
          `
          const status = yield* loadStatus({ workspaceId: receipt.workspaceId, cwd: receipt.cwd })
          if (Predicate.isUndefined(status)) {
            return yield* new StorageError({ message: "Resource graph state disappeared" })
          }
          return status
        })

      const recordApplying = Effect.fn("ResourceGraphStorage.recordApplying")(function* (
        receipt: ResourceGraphReceiptKey,
      ) {
        yield* ensureWorkspace(receipt.workspaceId)
        return yield* markApplying(receipt).pipe(
          sql.withTransaction,
          Effect.mapError(mapLifecycleError("Failed to record resource graph applying state")),
        )
      })

      const admit = Effect.fn("ResourceGraphStorage.admit")(function* (
        receipt: ResourceGraphReceiptKey,
      ) {
        yield* ensureWorkspace(receipt.workspaceId)
        yield* markApplying(receipt).pipe(
          sql.withTransaction,
          Effect.mapError(mapLifecycleError("Failed to admit resource graph application")),
        )
        const admission: ResourceGraphAdmission = { receipt }
        admissions.add(admission)
        return admission
      })

      const recordApplied = Effect.fn("ResourceGraphStorage.recordApplied")(function* (
        receipt: ResourceGraphAppliedReceipt,
      ) {
        yield* ensureWorkspace(receipt.workspaceId)
        return yield* Effect.gen(function* () {
          yield* ensureReceiptMatches(receipt)
          yield* sql`
            UPDATE resource_graph_state
            SET state = ${"applied"},
                applied_revision = ${receipt.desiredRevision},
                applied_sequence = ${receipt.desiredSequence},
                failure_json = ${toSqlNull()}
            WHERE workspace_id = ${receipt.workspaceId}
              AND cwd = ${receipt.cwd}
              AND desired_revision = ${receipt.desiredRevision}
              AND desired_sequence = ${receipt.desiredSequence}
          `
          const status = yield* loadStatus({ workspaceId: receipt.workspaceId, cwd: receipt.cwd })
          if (Predicate.isUndefined(status)) {
            return yield* new StorageError({ message: "Resource graph state disappeared" })
          }
          return status
        }).pipe(
          sql.withTransaction,
          Effect.mapError(mapLifecycleError("Failed to record applied resource graph")),
        )
      })

      const recordAppliedAdmission = Effect.fn("ResourceGraphStorage.recordAppliedAdmission")(
        function* (admission: ResourceGraphAdmission) {
          if (!admissions.has(admission)) {
            return yield* new StorageError({ message: "Unknown resource graph admission" })
          }
          const receipt = admission.receipt
          yield* ensureWorkspace(receipt.workspaceId)
          const result = yield* Effect.gen(function* () {
            const current = yield* loadStatus({
              workspaceId: receipt.workspaceId,
              cwd: receipt.cwd,
            })
            if (Predicate.isUndefined(current)) return yield* staleReceipt(receipt)
            const currentAppliedSequence = current.appliedSequence
            if (
              Predicate.isNotUndefined(currentAppliedSequence) &&
              (currentAppliedSequence > receipt.desiredSequence ||
                (currentAppliedSequence === receipt.desiredSequence &&
                  current.appliedRevision !== receipt.desiredRevision))
            ) {
              return yield* staleReceipt(receipt)
            }
            const currentDesired =
              current.desiredRevision === receipt.desiredRevision &&
              current.desiredSequence === receipt.desiredSequence
            if (
              currentAppliedSequence === receipt.desiredSequence &&
              current.appliedRevision === receipt.desiredRevision
            ) {
              if (currentDesired && current.state !== "applied") {
                yield* sql`
                  UPDATE resource_graph_state
                  SET state = ${"applied"}, failure_json = ${toSqlNull()}
                  WHERE workspace_id = ${receipt.workspaceId} AND cwd = ${receipt.cwd}
                `
              }
              const status = yield* loadStatus({
                workspaceId: receipt.workspaceId,
                cwd: receipt.cwd,
              })
              if (Predicate.isUndefined(status)) {
                return yield* new StorageError({ message: "Resource graph state disappeared" })
              }
              return status
            }
            if (currentDesired) {
              yield* sql`
                UPDATE resource_graph_state
                SET state = ${"applied"},
                    applied_revision = ${receipt.desiredRevision},
                    applied_sequence = ${receipt.desiredSequence},
                    failure_json = ${toSqlNull()}
                WHERE workspace_id = ${receipt.workspaceId} AND cwd = ${receipt.cwd}
              `
            } else {
              yield* sql`
                UPDATE resource_graph_state
                SET applied_revision = ${receipt.desiredRevision},
                    applied_sequence = ${receipt.desiredSequence}
                WHERE workspace_id = ${receipt.workspaceId} AND cwd = ${receipt.cwd}
              `
            }
            const status = yield* loadStatus({
              workspaceId: receipt.workspaceId,
              cwd: receipt.cwd,
            })
            if (Predicate.isUndefined(status)) {
              return yield* new StorageError({ message: "Resource graph state disappeared" })
            }
            return status
          }).pipe(
            sql.withTransaction,
            Effect.mapError(mapLifecycleError("Failed to record admitted resource graph")),
          )
          admissions.delete(admission)
          return result
        },
      )

      const discardAdmission = (admission: ResourceGraphAdmission): Effect.Effect<void> =>
        Effect.sync(() => {
          admissions.delete(admission)
        })

      const recordFailed = Effect.fn("ResourceGraphStorage.recordFailed")(function* (
        receipt: ResourceGraphFailedReceipt,
      ) {
        yield* ensureWorkspace(receipt.workspaceId)
        const failureJson = yield* Schema.encodeEffect(ResourceGraphFailureJson)(
          receipt.failure,
        ).pipe(Effect.mapError(mapLifecycleError("Failed to encode resource graph failure")))
        return yield* Effect.gen(function* () {
          yield* ensureReceiptMatches(receipt)
          yield* sql`
            UPDATE resource_graph_state
            SET state = ${"failed"}, failure_json = ${failureJson}
            WHERE workspace_id = ${receipt.workspaceId}
              AND cwd = ${receipt.cwd}
              AND desired_revision = ${receipt.desiredRevision}
              AND desired_sequence = ${receipt.desiredSequence}
          `
          const status = yield* loadStatus({ workspaceId: receipt.workspaceId, cwd: receipt.cwd })
          if (Predicate.isUndefined(status)) {
            return yield* new StorageError({ message: "Resource graph state disappeared" })
          }
          return status
        }).pipe(
          sql.withTransaction,
          Effect.mapError(mapLifecycleError("Failed to record failed resource graph")),
        )
      })

      const get = Effect.fn("ResourceGraphStorage.get")(function* (key: ResourceGraphKey) {
        const currentWorkspaceId = yield* CurrentWorkspaceId
        // oxlint-disable-next-line effect/noNullish -- Cross-workspace lookup returns no owner.
        if (key.workspaceId !== currentWorkspaceId) return undefined
        return yield* loadStatus(key).pipe(
          Effect.mapError(mapReadError("Failed to load resource graph status")),
        )
      })

      const listPending = Effect.fn("ResourceGraphStorage.listPending")(function* (
        workspaceId: WorkspaceId,
      ) {
        const currentWorkspaceId = yield* CurrentWorkspaceId
        if (workspaceId !== currentWorkspaceId) return []
        const rows = yield* sql<ResourceGraphStateSqlRow>`
          SELECT workspace_id, cwd, desired_revision, desired_sequence, desired_json,
                 applied_revision, applied_sequence, state, failure_json, command_id, updated_at
          FROM resource_graph_state
          WHERE workspace_id = ${workspaceId}
            AND (applied_sequence IS NULL OR applied_sequence < desired_sequence OR state <> 'applied')
          ORDER BY cwd ASC
        `.pipe(Effect.mapError(mapReadError("Failed to list pending resource graphs")))
        return yield* Effect.forEach(rows, (row) =>
          decodeStateRow(row).pipe(
            Effect.flatMap((decoded) => decodeStatus(decoded)),
            Effect.map(statusKey),
            Effect.mapError(mapReadError("Failed to decode pending resource graph row")),
          ),
        )
      })

      const listAll = Effect.fn("ResourceGraphStorage.listAll")(function* (
        workspaceId: WorkspaceId,
      ) {
        const currentWorkspaceId = yield* CurrentWorkspaceId
        if (workspaceId !== currentWorkspaceId) return []
        const rows = yield* sql<ResourceGraphStateSqlRow>`
          SELECT workspace_id, cwd, desired_revision, desired_sequence, desired_json,
                 applied_revision, applied_sequence, state, failure_json, command_id, updated_at
          FROM resource_graph_state
          WHERE workspace_id = ${workspaceId}
          ORDER BY cwd ASC
        `.pipe(Effect.mapError(mapReadError("Failed to list resource graphs")))
        return yield* Effect.forEach(rows, (row) =>
          decodeStateRow(row).pipe(
            Effect.flatMap((decoded) => decodeStatus(decoded)),
            Effect.map(statusKey),
            Effect.mapError(mapReadError("Failed to decode resource graph row")),
          ),
        )
      })

      const listWorkspaces = Effect.gen(function* () {
        const rows = yield* sql<{ readonly workspace_id: string }>`
          SELECT DISTINCT workspace_id
          FROM resource_graph_state
          ORDER BY workspace_id ASC
        `.pipe(Effect.mapError(mapReadError("Failed to list resource graph workspaces")))
        return yield* Effect.forEach(rows, (row) =>
          Schema.decodeEffect(WorkspaceId)(row.workspace_id).pipe(
            Effect.mapError(mapReadError("Failed to decode resource graph workspace")),
          ),
        )
      })

      return ResourceGraphStorage.of({
        recordDesired,
        recordApplying,
        admit,
        recordApplied,
        recordAppliedAdmission,
        discardAdmission,
        recordFailed,
        get,
        listPending,
        listAll,
        listWorkspaces,
      })
    }),
  )
}
