/**
 * Reversible entity-id encoding for the AgentLoop actor.
 *
 * Encore's `Entity.toLayer` keys entities by a `string` `entityId`. Per-actor
 * state lives behind that string, so the encoding must:
 *   - Round-trip uniquely for any `(workspaceId, sessionId, branchId)` tuple
 *   - Be parseable from `CurrentAddress.entityId` inside the actor handler
 *
 * `SessionId` and `BranchId` are unconstrained branded strings, so a plain
 * `${sessionId}:${branchId}` join collides on `:` (counsel finding C5.4.4.a):
 *
 *     encodeRaw("a:", "x")  === "a::x"
 *     encodeRaw("a", ":x")  === "a::x"  // collision
 *
 * `encodeURIComponent` encodes both `:` and `/`, leaving the encoded
 * components free of separators. Use `:` as the separator on encoded
 * components.
 *
 * @module
 */

import { Effect } from "effect"
import { BranchId, SessionId } from "../../domain/ids.js"
import { WorkspaceId } from "../../server/workspace-rpc.js"
import { AgentLoopError } from "./agent-loop.state.js"

/** Encode `(workspaceId, sessionId, branchId)` into a unique reversible string. */
export const entityIdOf = (
  workspaceId: WorkspaceId,
  sessionId: SessionId,
  branchId: BranchId,
): string =>
  `${encodeURIComponent(workspaceId)}:${encodeURIComponent(sessionId)}:${encodeURIComponent(branchId)}`

/** Parse an encoded entity id back into its `(workspaceId, sessionId, branchId)` tuple. */
export const parseEntityId = (
  entityId: string,
): Effect.Effect<
  { workspaceId: WorkspaceId; sessionId: SessionId; branchId: BranchId },
  AgentLoopError
> =>
  Effect.gen(function* () {
    const firstSep = entityId.indexOf(":")
    const secondSep = firstSep < 0 ? -1 : entityId.indexOf(":", firstSep + 1)
    if (firstSep < 0 || secondSep < 0) {
      return yield* new AgentLoopError({
        message: `Invalid entity id (expected workspace/session/branch): ${entityId}`,
      })
    }
    const rawWorkspace = entityId.slice(0, firstSep)
    const rawSession = entityId.slice(firstSep + 1, secondSep)
    const rawBranch = entityId.slice(secondSep + 1)
    const workspaceId = decodeOrFail(rawWorkspace)
    if (workspaceId === undefined) {
      return yield* new AgentLoopError({
        message: `Invalid entity id (workspaceId decode): ${entityId}`,
      })
    }
    const sessionRaw = decodeOrFail(rawSession)
    if (sessionRaw === undefined) {
      return yield* new AgentLoopError({
        message: `Invalid entity id (sessionId decode): ${entityId}`,
      })
    }
    const branchRaw = decodeOrFail(rawBranch)
    if (branchRaw === undefined) {
      return yield* new AgentLoopError({
        message: `Invalid entity id (branchId decode): ${entityId}`,
      })
    }
    return {
      workspaceId: WorkspaceId.make(workspaceId),
      sessionId: SessionId.make(sessionRaw),
      branchId: BranchId.make(branchRaw),
    }
  })

const decodeOrFail = (raw: string): string | undefined => {
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}
