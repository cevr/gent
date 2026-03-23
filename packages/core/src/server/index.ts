import { Layer } from "effect"
import { InteractionCommands } from "./interaction-commands.js"
import { SessionCommands } from "./session-commands.js"
import { SessionEvents } from "./session-events.js"
import { SessionQueries } from "./session-queries.js"

const BaseAppServicesLive = Layer.mergeAll(
  SessionQueries.Live,
  SessionCommands.Live,
  SessionEvents.Live,
)

export const AppServicesLive = Layer.merge(
  BaseAppServicesLive,
  InteractionCommands.Live.pipe(Layer.provideMerge(BaseAppServicesLive)),
)
