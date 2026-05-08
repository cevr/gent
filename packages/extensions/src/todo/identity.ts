/**
 * Todo identity + UI schemas.
 *
 * Shared between the projection (UI snapshot model) and the
 * client-side TUI snapshot reader. Kept separate from queries/mutations to
 * avoid circular imports — the projection imports from here; queries/mutations
 * import their own schemas from @gent/core/extensions/api.
 *
 * @module
 */
import { Schema } from "effect"
import { ExtensionId } from "@gent/core/extensions/api"
import { TodoId, TodoStatus } from "./domain.js"

export const TODO_EXTENSION_ID = ExtensionId.make("@gent/todo")

/** Schema for individual todo entries in the UI snapshot (subset of full Todo). */
export const TodoEntrySchema = Schema.Struct({
  id: TodoId,
  parentId: Schema.optional(TodoId),
  subject: Schema.String,
  status: TodoStatus,
})
export type TodoEntry = typeof TodoEntrySchema.Type

/** Schema for the todo extension UI snapshot model. */
export const TodoUiModel = Schema.Struct({
  todos: Schema.Array(TodoEntrySchema),
})
export type TodoUiModel = typeof TodoUiModel.Type
