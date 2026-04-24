import { Layer } from "effect"
import { InteractionCommands } from "./interaction-commands.js"
import { SessionCommands } from "./session-commands.js"
import { SessionQueries } from "./session-queries.js"

const BaseAppServicesLive = Layer.mergeAll(
  SessionQueries.Live,
  SessionCommands.Live,
  // Project SessionCommands.deleteSession onto the domain-tier SessionDeleter
  // Tag so the runtime's extension host context can call into destructive
  // cleanup without importing from `server/`.
  SessionCommands.SessionDeleterLive.pipe(Layer.provideMerge(SessionCommands.Live)),
  SessionCommands.SessionMutationsLive.pipe(Layer.provideMerge(SessionCommands.Live)),
)

export const AppServicesLive = Layer.merge(
  BaseAppServicesLive,
  InteractionCommands.Live.pipe(Layer.provideMerge(BaseAppServicesLive)),
)
