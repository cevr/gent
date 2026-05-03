import { Layer } from "effect"
import { InteractionCommands } from "./interaction-commands.js"
import { SessionCommands } from "./session-commands.js"
import { SessionQueries } from "./session-queries.js"

// `SessionCommands.Live` depends on `SessionMutations` and `SessionRuntime`.
// Neither is provided here: production wiring builds them once in
// `dependencies.ts` and forwards them via the parent context. Callers must
// include `SessionMutationsLive` and `SessionRuntime.LiveWithEntity` in the
// parent layer they provide to `AppServicesLive`.
const SessionCommandsCluster = Layer.mergeAll(SessionQueries.Live, SessionCommands.Live)

export const AppServicesLive = Layer.merge(
  SessionCommandsCluster,
  InteractionCommands.Live.pipe(Layer.provideMerge(SessionCommandsCluster)),
)
