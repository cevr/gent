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

import { Effect, Schema } from "effect"
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
    const workspaceRaw = decodeOrFail(rawWorkspace)
    if (workspaceRaw === undefined) {
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
    const workspaceId = yield* decodeWorkspaceId(workspaceRaw, entityId)
    const sessionId = yield* decodeSessionId(sessionRaw, entityId)
    const branchId = yield* decodeBranchId(branchRaw, entityId)
    return {
      workspaceId,
      sessionId,
      branchId,
    }
  })

const decodeOrFail = (raw: string): string | undefined => {
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}

const decodeWorkspaceId = (
  raw: string,
  entityId: string,
): Effect.Effect<WorkspaceId, AgentLoopError> =>
  Schema.decodeUnknownEffect(WorkspaceId)(raw).pipe(
    Effect.mapError(
      (cause) =>
        new AgentLoopError({
          message: `Invalid entity id (workspaceId schema): ${entityId}`,
          cause,
        }),
    ),
  )

const decodeSessionId = (raw: string, entityId: string): Effect.Effect<SessionId, AgentLoopError> =>
  Schema.decodeUnknownEffect(SessionId)(raw).pipe(
    Effect.mapError(
      (cause) =>
        new AgentLoopError({
          message: `Invalid entity id (sessionId schema): ${entityId}`,
          cause,
        }),
    ),
  )

const decodeBranchId = (raw: string, entityId: string): Effect.Effect<BranchId, AgentLoopError> =>
  Schema.decodeUnknownEffect(BranchId)(raw).pipe(
    Effect.mapError(
      (cause) =>
        new AgentLoopError({
          message: `Invalid entity id (branchId schema): ${entityId}`,
          cause,
        }),
    ),
  )
