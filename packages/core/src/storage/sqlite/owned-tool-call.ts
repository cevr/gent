import { Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type * as Prompt from "effect/unstable/ai/Prompt"
import type { BranchId, SessionId } from "../../domain/ids.js"
import type { ToolCallBindingKey } from "../../domain/tool-binding.js"
import { StorageError } from "../../domain/storage-error.js"
import { CurrentWorkspaceId } from "../../server/workspace-rpc.js"
import { decodeStoredPromptPart } from "./rows.js"

export interface OwnedToolCallAddress extends ToolCallBindingKey {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

const MessageCallRow = Schema.Struct({ part_json: Schema.NullOr(Schema.String) })

/** One ownership check for binding records and cell execution claims. */
export const makeOwnedToolCallReader = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return Effect.fn("Storage.loadOwnedToolCall")(function* (params: OwnedToolCallAddress) {
    return yield* Effect.gen(function* () {
      const workspaceId = yield* CurrentWorkspaceId
      const rows = yield* sql<typeof MessageCallRow.Type>`
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
      const calls: Prompt.ToolCallPart[] = []
      for (const rawRow of rows) {
        const row = yield* Schema.decodeEffect(MessageCallRow)(rawRow)
        const json = Option.fromNullishOr(row.part_json)
        if (Option.isNone(json)) continue
        const part = yield* decodeStoredPromptPart(json.value)
        if (part.type === "tool-call" && part.id === params.toolCallId) calls.push(part)
      }
      if (calls.length !== 1) return Option.none<Prompt.ToolCallPart>()
      return Option.fromUndefinedOr(calls[0])
    }).pipe(
      Effect.mapError(
        (cause) => new StorageError({ message: "Failed to read owned tool call", cause }),
      ),
    )
  })
})
