import { Layer } from "effect"
import { InteractionCommands } from "./interaction-commands.js"
import { SessionCommands } from "./session-commands.js"
import { SessionQueries } from "./session-queries.js"

// `SessionCommands.Live` now depends on `SessionMutations` (W7-C5: it
// delegates pure-mutation bodies to `SessionMutations` so there is exactly
// one implementation of each). `SessionMutationsLive` must therefore be
// provided *beneath* `SessionCommands.Live`, not as a sibling — Layer.mergeAll
// constructs siblings in parallel, so dependencies between siblings are not
// satisfied. The same is true for `SessionRuntimeTerminator`, which both
// services require.
const SessionCommandsCluster = Layer.mergeAll(
  SessionQueries.Live,
  SessionCommands.Live.pipe(Layer.provideMerge(SessionCommands.SessionMutationsLive)),
).pipe(Layer.provideMerge(SessionCommands.SessionRuntimeTerminatorLive))

export const AppServicesLive = Layer.merge(
  SessionCommandsCluster,
  InteractionCommands.Live.pipe(Layer.provideMerge(SessionCommandsCluster)),
)
