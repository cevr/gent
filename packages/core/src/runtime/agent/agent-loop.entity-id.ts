/**
 * Reversible entity-id encoding for the AgentLoop actor.
 *
 * Encore's `Entity.toLayer` keys entities by a `string` `entityId`. Per-actor
 * state lives behind that string, so the encoding must:
 *   - Round-trip uniquely for any `(sessionId, branchId)` pair
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
import { AgentLoopError } from "./agent-loop.commands.js"

/** Encode `(sessionId, branchId)` into a unique reversible string. */
export const entityIdOf = (sessionId: SessionId, branchId: BranchId): string =>
  `${encodeURIComponent(sessionId)}:${encodeURIComponent(branchId)}`

/** Parse an encoded entity id back into its `(sessionId, branchId)` pair. */
export const parseEntityId = (
  entityId: string,
): Effect.Effect<{ sessionId: SessionId; branchId: BranchId }, AgentLoopError> =>
  Effect.gen(function* () {
    const sep = entityId.indexOf(":")
    if (sep < 0) {
      return yield* new AgentLoopError({
        message: `Invalid entity id (no separator): ${entityId}`,
      })
    }
    const rawSession = entityId.slice(0, sep)
    const rawBranch = entityId.slice(sep + 1)
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
