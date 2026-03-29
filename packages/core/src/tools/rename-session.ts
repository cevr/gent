import { DateTime, Effect, Schema } from "effect"
import { defineTool } from "../domain/tool.js"
import { Storage } from "../storage/sqlite-storage.js"
import { EventStore, SessionNameUpdated } from "../domain/event.js"
import { Session } from "../domain/message.js"

const MAX_NAME_LENGTH = 80

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
    const storage = yield* Storage
    const eventStore = yield* EventStore

    const trimmed = params.name.trim().slice(0, MAX_NAME_LENGTH)
    if (trimmed.length === 0) return { renamed: false, reason: "empty name" }

    const session = yield* storage.getSession(ctx.sessionId)
    if (session === undefined) return { renamed: false, reason: "session not found" }
    if (session.name === trimmed) return { renamed: false, reason: "name unchanged" }

    const updated = new Session({ ...session, name: trimmed, updatedAt: yield* DateTime.nowAsDate })
    yield* storage.updateSession(updated)
    yield* eventStore.publish(new SessionNameUpdated({ sessionId: ctx.sessionId, name: trimmed }))

    return { renamed: true, name: trimmed }
  }),
})
