import { Effect, Schema } from "effect"
import { defineTool } from "../../domain/tool.js"

export const RenameSessionParams = Schema.Struct({
  name: Schema.String.annotate({
    description: "Short session title, 3-5 lowercase words describing the current task",
  }),
})

export const RenameSessionTool = defineTool({
  name: "rename_session",
  action: "state",
  concurrency: "serial",
  idempotent: true,
  description:
    "Rename the current session. Call once you understand the task, and again if the topic shifts significantly.",
  params: RenameSessionParams,
  execute: Effect.fn("RenameSessionTool.execute")(function* (
    params: typeof RenameSessionParams.Type,
    ctx,
  ) {
    return yield* ctx.session.renameCurrent(params.name)
  }),
})
