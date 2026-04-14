/**
 * Debug session — re-exports seedDebugSession from core and adds
 * the scenario runner which depends on app-level agent infrastructure.
 */

import { Effect } from "effect"
import { seedDebugSession } from "@gent/core/debug/session.js"
import { startDebugScenario } from "./scenario.js"

export { seedDebugSession } from "@gent/core/debug/session.js"
export type { DebugSessionInfo } from "@gent/core/debug/session.js"

export const prepareDebugSession = Effect.fn("DebugSession.prepare")(function* (cwd: string) {
  const session = yield* seedDebugSession(cwd)
  yield* startDebugScenario({
    sessionId: session.sessionId,
    branchId: session.branchId,
    cwd,
  })
  return session
})
