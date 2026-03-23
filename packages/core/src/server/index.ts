import { Layer } from "effect"
import { InteractionCommands } from "./interaction-commands.js"
import { SessionCommands } from "./session-commands.js"
import { SessionEvents } from "./session-events.js"
import { SessionQueries } from "./session-queries.js"
import { SessionSubscriptions } from "./session-subscriptions.js"

const BaseAppServicesLive = Layer.mergeAll(
  SessionQueries.Live,
  SessionCommands.Live,
  SessionEvents.Live,
)
const SubscriptionServicesLive = SessionSubscriptions.Live.pipe(
  Layer.provideMerge(BaseAppServicesLive),
)

export const AppServicesLive = Layer.merge(
  Layer.merge(BaseAppServicesLive, SubscriptionServicesLive),
  InteractionCommands.Live.pipe(Layer.provideMerge(BaseAppServicesLive)),
)
