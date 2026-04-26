import { Layer } from "effect"
import { InteractionCommands } from "./interaction-commands.js"
import { SessionCommands } from "./session-commands.js"
import { SessionQueries } from "./session-queries.js"

// `SessionCommands.Live` and `SessionMutationsLive` both require
// `SessionRuntimeTerminator`. Layer.mergeAll constructs siblings in parallel,
// so the terminator must be provided beneath the merge — not as a sibling —
// or its dependents see an unsatisfied requirement at build time.
const SessionCommandsCluster = Layer.mergeAll(
  SessionQueries.Live,
  SessionCommands.Live,
  SessionCommands.SessionMutationsLive,
).pipe(Layer.provideMerge(SessionCommands.SessionRuntimeTerminatorLive))

export const AppServicesLive = Layer.merge(
  SessionCommandsCluster,
  InteractionCommands.Live.pipe(Layer.provideMerge(SessionCommandsCluster)),
)
