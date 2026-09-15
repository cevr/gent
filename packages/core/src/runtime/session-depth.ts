/**
 * Session nesting depth: one computation and one admission rule for every
 * child-session writer. Delegate spawns and compaction handoffs both nest a
 * session under a parent; both go through `admitChildSessionDepth`.
 *
 * @module
 */
import { Effect, Predicate } from "effect"
import { DEFAULT_MAX_AGENT_RUN_DEPTH, SessionDepthLimitError } from "../domain/agent.js"
import { NotFoundError } from "../domain/business-errors.js"
import type { SessionId } from "../domain/ids.js"
import { RelationshipStorage } from "../storage/relationship-storage.js"

/** Compute nesting depth of a session from its persisted parent chain. Root sessions have depth 0. */
export const getSessionDepth = Effect.fn("SessionDepth.getSessionDepth")(function* (
  sessionId: SessionId,
) {
  const relationshipStorage = yield* RelationshipStorage
  // Fail closed: an unreadable ancestry is a failure, never a root-level grant.
  const ancestors = yield* relationshipStorage.getSessionAncestors(sessionId)
  const root = ancestors.at(-1)
  if (
    ancestors[0]?.id !== sessionId ||
    Predicate.isUndefined(root) ||
    Predicate.isNotUndefined(root.parentSessionId)
  ) {
    return yield* new NotFoundError({
      message: `Cannot determine session depth for "${sessionId}" — ancestry is missing or incomplete.`,
    })
  }
  return ancestors.length - 1
})

/**
 * Admit one more child under `parentSessionId`. Fails with
 * `SessionDepthLimitError` when the parent already sits at the cap.
 */
export const admitChildSessionDepth = Effect.fn("SessionDepth.admitChildSessionDepth")(function* (
  parentSessionId: SessionId,
) {
  const depth = yield* getSessionDepth(parentSessionId)
  if (depth >= DEFAULT_MAX_AGENT_RUN_DEPTH) {
    return yield* new SessionDepthLimitError({
      message: `Agent run depth limit reached (max ${DEFAULT_MAX_AGENT_RUN_DEPTH}) — parent session "${parentSessionId}" is already at depth ${depth}.`,
      parentSessionId,
      depth,
      max: DEFAULT_MAX_AGENT_RUN_DEPTH,
    })
  }
  return depth
})
