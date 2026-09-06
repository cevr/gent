import { Context, DateTime, Effect, Layer, Option, Predicate, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { decodeStoredPromptPart } from "./sqlite/rows.js"
import {
  decodeToolBindingIdentity,
  encodeToolBindingIdentity,
  canonicalizeToolBindingIdentity,
  ToolCallBindingConflictError,
  validateToolBindingIdentity,
  type ToolBindingIdentity,
  type ToolCallBindingKey,
} from "../domain/tool-binding.js"
import type { BranchId, MessageId, SessionId, ToolCallId } from "../domain/ids.js"
import { StorageError } from "../domain/storage-error.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"

const ToolCallBindingRow = Schema.Struct({
  assistant_message_id: Schema.String,
  tool_call_id: Schema.String,
  binding_json: Schema.String,
  created_at: Schema.Finite,
})
type ToolCallBindingRow = typeof ToolCallBindingRow.Type

const MessageCallRow = Schema.Struct({
  part_json: Schema.NullOr(Schema.String),
})
type MessageCallRow = typeof MessageCallRow.Type

export interface ToolCallBindingStorageWrite extends ToolCallBindingKey {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly binding: ToolBindingIdentity
  readonly createdAt?: number
}

export interface ToolCallBindingStorageService {
  readonly save: (
    params: ToolCallBindingStorageWrite,
  ) => Effect.Effect<ToolBindingIdentity, StorageError | ToolCallBindingConflictError>
  readonly get: (
    params: ToolCallBindingKey & {
      readonly sessionId: SessionId
      readonly branchId: BranchId
    },
    // oxlint-disable-next-line effect/noNullish -- Storage lookup uses undefined for an absent row.
  ) => Effect.Effect<ToolBindingIdentity | undefined, StorageError>
}

const mapStorageError = (message: string) => (cause: unknown) => {
  if (Schema.is(StorageError)(cause)) return cause
  if (Schema.is(ToolCallBindingConflictError)(cause)) return cause
  return new StorageError({ message, cause })
}

const mapReadError =
  (message: string) =>
  (cause: unknown): StorageError => {
    if (Schema.is(StorageError)(cause)) return cause
    return new StorageError({ message, cause })
  }

export class ToolCallBindingStorage extends Context.Service<
  ToolCallBindingStorage,
  ToolCallBindingStorageService
>()("@gent/core/src/storage/tool-call-binding-storage/ToolCallBindingStorage") {
  static Live: Layer.Layer<ToolCallBindingStorage, never, SqlClient.SqlClient> = Layer.effect(
    ToolCallBindingStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const loadOwnedCall = Effect.fn("ToolCallBindingStorage.loadOwnedCall")(function* (params: {
        readonly assistantMessageId: MessageId
        readonly toolCallId: ToolCallId
        readonly sessionId: SessionId
        readonly branchId: BranchId
      }) {
        const workspaceId = yield* CurrentWorkspaceId
        const rawRows = yield* sql<MessageCallRow>`
          SELECT c.part_json
          FROM messages m
          JOIN sessions s ON s.id = m.session_id
          LEFT JOIN message_chunks mc ON mc.message_id = m.id
          LEFT JOIN content_chunks c ON c.id = mc.chunk_id
          WHERE m.id = ${params.assistantMessageId}
            AND m.session_id = ${params.sessionId}
            AND m.branch_id = ${params.branchId}
            AND m.role = 'assistant'
            AND s.workspace_id = ${workspaceId}
          ORDER BY mc.ordinal ASC
        `
        const rows = yield* Effect.forEach(rawRows, (rawRow) =>
          Schema.decodeEffect(MessageCallRow)(rawRow),
        )
        const calls = yield* Effect.forEach(rows, (row) =>
          Option.match(Option.fromNullishOr(row.part_json), {
            onNone: () => Effect.succeed(Option.none<string>()),
            onSome: (partJson) =>
              decodeStoredPromptPart(partJson).pipe(
                Effect.map((part) => {
                  if (part.type === "tool-call" && part.id === params.toolCallId) {
                    return Option.some(part.name)
                  }
                  return Option.none<string>()
                }),
              ),
          }),
        )
        const matchingNames = calls.flatMap(
          Option.match({ onNone: () => [], onSome: (name) => [name] }),
        )
        // oxlint-disable-next-line effect/noNullish -- Internal call lookup uses undefined for a missing call.
        if (matchingNames.length !== 1) return undefined
        return matchingNames[0]
      })

      const loadOwnedRow = Effect.fn("ToolCallBindingStorage.loadOwnedRow")(function* (params: {
        readonly assistantMessageId: MessageId
        readonly toolCallId: ToolCallId
        readonly sessionId: SessionId
        readonly branchId: BranchId
      }) {
        const workspaceId = yield* CurrentWorkspaceId
        const rows = yield* sql<ToolCallBindingRow>`
          SELECT b.assistant_message_id, b.tool_call_id, b.binding_json, b.created_at
          FROM tool_call_bindings b
          JOIN messages m ON m.id = b.assistant_message_id
          JOIN sessions s ON s.id = m.session_id
          WHERE b.assistant_message_id = ${params.assistantMessageId}
            AND b.tool_call_id = ${params.toolCallId}
            AND m.session_id = ${params.sessionId}
            AND m.branch_id = ${params.branchId}
            AND m.role = 'assistant'
            AND s.workspace_id = ${workspaceId}
          LIMIT 1
        `
        return rows[0]
      })

      const save = Effect.fn("ToolCallBindingStorage.save")(function* (
        params: ToolCallBindingStorageWrite,
      ) {
        const binding = canonicalizeToolBindingIdentity(params.binding)
        const validatedBinding = yield* validateToolBindingIdentity(binding).pipe(
          Effect.mapError(mapStorageError("Invalid tool call binding identity")),
        )
        const bindingJson = yield* encodeToolBindingIdentity(validatedBinding).pipe(
          Effect.mapError(mapStorageError("Failed to encode tool call binding")),
        )
        const createdAt = params.createdAt ?? (yield* DateTime.nowAsDate).getTime()

        return yield* Effect.gen(function* () {
          const toolName = yield* loadOwnedCall(params)
          if (Predicate.isUndefined(toolName)) {
            return yield* new StorageError({
              message: `Assistant message does not contain the requested tool call in the current workspace and branch: ${params.assistantMessageId}/${params.toolCallId}`,
            })
          }
          if (toolName !== validatedBinding.toolId) {
            return yield* new StorageError({
              message: `Tool call name does not match the binding identity: ${params.toolCallId}`,
            })
          }

          yield* sql`
            INSERT INTO tool_call_bindings (
              assistant_message_id,
              tool_call_id,
              binding_json,
              created_at
            ) VALUES (
              ${params.assistantMessageId},
              ${params.toolCallId},
              ${bindingJson},
              ${createdAt}
            )
            ON CONFLICT (assistant_message_id, tool_call_id) DO NOTHING
          `

          const row = yield* loadOwnedRow(params)
          if (Predicate.isUndefined(row)) {
            return yield* new StorageError({
              message: `Tool call binding disappeared during save: ${params.assistantMessageId}/${params.toolCallId}`,
            })
          }
          const existing = yield* Schema.decodeEffect(ToolCallBindingRow)(row).pipe(
            Effect.mapError(mapStorageError("Failed to decode stored tool call binding row")),
            Effect.flatMap((decoded) =>
              decodeToolBindingIdentity(decoded.binding_json).pipe(
                Effect.mapError(mapStorageError("Failed to decode stored tool binding identity")),
              ),
            ),
          )
          const existingJson = yield* encodeToolBindingIdentity(existing).pipe(
            Effect.mapError(mapStorageError("Failed to encode stored tool binding identity")),
          )
          if (existing.toolId !== toolName) {
            return yield* new StorageError({
              message: `Stored binding does not match the message tool call: ${params.toolCallId}`,
            })
          }
          if (existingJson !== bindingJson) {
            return yield* new ToolCallBindingConflictError({
              assistantMessageId: params.assistantMessageId,
              toolCallId: params.toolCallId,
            })
          }
          return existing
        }).pipe(
          sql.withTransaction,
          Effect.mapError(mapStorageError("Failed to save tool call binding")),
        )
      })

      const get = Effect.fn("ToolCallBindingStorage.get")(function* (
        params: ToolCallBindingKey & {
          readonly sessionId: SessionId
          readonly branchId: BranchId
        },
      ) {
        return yield* Effect.gen(function* () {
          const row = yield* loadOwnedRow(params)
          // oxlint-disable-next-line effect/noNullish -- Storage lookup uses undefined for an absent row.
          if (Predicate.isUndefined(row)) return undefined
          const decoded = yield* Schema.decodeEffect(ToolCallBindingRow)(row).pipe(
            Effect.mapError(mapReadError("Failed to decode stored tool call binding row")),
          )
          const binding = yield* decodeToolBindingIdentity(decoded.binding_json).pipe(
            Effect.mapError(mapReadError("Failed to decode stored tool binding identity")),
          )
          const toolName = yield* loadOwnedCall(params)
          if (Predicate.isUndefined(toolName) || toolName !== binding.toolId) {
            return yield* new StorageError({
              message: `Stored binding does not match the message tool call: ${params.toolCallId}`,
            })
          }
          return binding
        }).pipe(Effect.mapError(mapReadError("Failed to load tool call binding")))
      })

      return ToolCallBindingStorage.of({ save, get })
    }),
  )
}
