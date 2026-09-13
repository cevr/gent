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

import { Effect, Option, Schema } from "effect"
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
    const workspaceId = yield* decodeComponent(WorkspaceId, "workspaceId")(
      entityId.slice(0, firstSep),
      entityId,
    )
    const sessionId = yield* decodeComponent(SessionId, "sessionId")(
      entityId.slice(firstSep + 1, secondSep),
      entityId,
    )
    const branchId = yield* decodeComponent(BranchId, "branchId")(
      entityId.slice(secondSep + 1),
      entityId,
    )
    return {
      workspaceId,
      sessionId,
      branchId,
    }
  })

/** Percent-decode one entity-id component, then decode it with its schema. */
const decodeComponent =
  <A>(schema: Schema.Codec<A, string>, label: string) =>
  (raw: string, entityId: string): Effect.Effect<A, AgentLoopError> =>
    Effect.try({
      try: () => decodeURIComponent(raw),
      catch: () =>
        new AgentLoopError({ message: `Invalid entity id (${label} decode): ${entityId}` }),
    }).pipe(
      Effect.flatMap((decoded) =>
        Schema.decodeEffect(schema)(decoded).pipe(
          Effect.mapError(
            (cause) =>
              new AgentLoopError({
                message: `Invalid entity id (${label} schema): ${entityId}`,
                cause,
              }),
          ),
        ),
      ),
    )

/**
 * Enumerate the materialized loops belonging to one workspace.
 *
 * The actor registry is keyed by opaque entity id across every workspace, so
 * reading it means decoding each id and dropping the ones that belong
 * elsewhere. An id that fails to decode is skipped rather than failing the
 * enumeration: one malformed key must not make the whole catalog unreadable.
 *
 * Lives here rather than in `SessionRuntime` because the agent loop needs the
 * same enumeration and cannot import `SessionRuntime` — that module builds the
 * loops, so the dependency would be a cycle.
 */
export const listWorkspaceLoops = (input: {
  readonly workspaceId: WorkspaceId
  readonly entityIds: ReadonlyArray<string>
  readonly concurrency: number
}): Effect.Effect<ReadonlyArray<{ readonly sessionId: SessionId; readonly branchId: BranchId }>> =>
  Effect.forEach(input.entityIds, (entityId) => parseEntityId(entityId).pipe(Effect.option), {
    concurrency: input.concurrency,
  }).pipe(
    Effect.map((targets) =>
      targets.flatMap((target) => {
        if (Option.isNone(target) || target.value.workspaceId !== input.workspaceId) return []
        return [{ sessionId: target.value.sessionId, branchId: target.value.branchId }]
      }),
    ),
  )
