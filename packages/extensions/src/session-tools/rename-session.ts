import { Effect, Schema } from "effect"
import { tool, ToolNeeds } from "@gent/core/extensions/api"

export const RenameSessionParams = Schema.Struct({
  name: Schema.String.annotate({
    description: "Short session title, 3-5 lowercase words describing the current task",
  }),
})

export const RenameSessionTool = tool({
  id: "rename_session",
  needs: [ToolNeeds.write("session")],
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
