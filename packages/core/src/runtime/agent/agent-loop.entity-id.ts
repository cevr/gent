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

import { Effect, Option, Result, Schema } from "effect"
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
    let secondSep = -1
    if (firstSep >= 0) secondSep = entityId.indexOf(":", firstSep + 1)
    if (firstSep < 0 || secondSep < 0) {
      return yield* new AgentLoopError({
        message: `Invalid entity id (expected workspace/session/branch): ${entityId}`,
      })
    }
    const rawWorkspace = entityId.slice(0, firstSep)
    const rawSession = entityId.slice(firstSep + 1, secondSep)
    const rawBranch = entityId.slice(secondSep + 1)
    const workspaceRaw = decodeOrFail(rawWorkspace)
    if (Option.isNone(workspaceRaw)) {
      return yield* new AgentLoopError({
        message: `Invalid entity id (workspaceId decode): ${entityId}`,
      })
    }
    const sessionRaw = decodeOrFail(rawSession)
    if (Option.isNone(sessionRaw)) {
      return yield* new AgentLoopError({
        message: `Invalid entity id (sessionId decode): ${entityId}`,
      })
    }
    const branchRaw = decodeOrFail(rawBranch)
    if (Option.isNone(branchRaw)) {
      return yield* new AgentLoopError({
        message: `Invalid entity id (branchId decode): ${entityId}`,
      })
    }
    const workspaceId = yield* decodeWorkspaceId(workspaceRaw.value, entityId)
    const sessionId = yield* decodeSessionId(sessionRaw.value, entityId)
    const branchId = yield* decodeBranchId(branchRaw.value, entityId)
    return {
      workspaceId,
      sessionId,
      branchId,
    }
  })

const decodeOrFail = (raw: string): Option.Option<string> =>
  Result.try(() => decodeURIComponent(raw)).pipe(Result.getSuccess)

const decodeWorkspaceId = (
  raw: string,
  entityId: string,
): Effect.Effect<WorkspaceId, AgentLoopError> =>
  Schema.decodeEffect(WorkspaceId)(raw).pipe(
    Effect.mapError(
      (cause) =>
        new AgentLoopError({
          message: `Invalid entity id (workspaceId schema): ${entityId}`,
          cause,
        }),
    ),
  )

const decodeSessionId = (raw: string, entityId: string): Effect.Effect<SessionId, AgentLoopError> =>
  Schema.decodeEffect(SessionId)(raw).pipe(
    Effect.mapError(
      (cause) =>
        new AgentLoopError({
          message: `Invalid entity id (sessionId schema): ${entityId}`,
          cause,
        }),
    ),
  )

const decodeBranchId = (raw: string, entityId: string): Effect.Effect<BranchId, AgentLoopError> =>
  Schema.decodeEffect(BranchId)(raw).pipe(
    Effect.mapError(
      (cause) =>
        new AgentLoopError({
          message: `Invalid entity id (branchId schema): ${entityId}`,
          cause,
        }),
    ),
  )
