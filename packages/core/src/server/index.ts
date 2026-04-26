import { Layer } from "effect"
import { InteractionCommands } from "./interaction-commands.js"
import { SessionCommands } from "./session-commands.js"
import { SessionQueries } from "./session-queries.js"

// `SessionCommands.Live` depends on `SessionMutations` and
// `SessionRuntimeTerminator`. The terminator's empty-Ref construction
// is provided here because both `SessionCommands.Live` and
// `InteractionCommands.Live` need access to the same instance.
// `SessionMutations` is *not* provided here: production wiring builds it
// once in `dependencies.ts` and forwards it via the parent context;
// providing it here too would build a second instance and shadow the
// shared one. Callers must include `SessionMutationsLive` in the parent
// layer they provide to `AppServicesLive`.
const SessionCommandsCluster = Layer.mergeAll(SessionQueries.Live, SessionCommands.Live).pipe(
  Layer.provideMerge(SessionCommands.SessionRuntimeTerminatorLive),
)

export const AppServicesLive = Layer.merge(
  SessionCommandsCluster,
  InteractionCommands.Live.pipe(Layer.provideMerge(SessionCommandsCluster)),
)
