import { Layer } from "effect"
import { InteractionCommands } from "./interaction-commands.js"
import { SessionCommands } from "./session-commands.js"
import { SessionQueries } from "./session-queries.js"

const BaseAppServicesLive = Layer.mergeAll(
  SessionQueries.Live,
  SessionCommands.Live,
  SessionCommands.SessionMutationsLive,
)

export const AppServicesLive = Layer.merge(
  BaseAppServicesLive,
  InteractionCommands.Live.pipe(Layer.provideMerge(BaseAppServicesLive)),
)
