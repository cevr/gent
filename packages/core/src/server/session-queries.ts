import { Effect, Option, Predicate } from "effect"
import { projectMessagesWithToolInteractions } from "../domain/message-part-display.js"
import { SessionStorage } from "../storage/session-storage.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { MessageStorage } from "../storage/message-storage.js"
import { EventStorage } from "../storage/event-storage.js"
import { makeStorageTransaction } from "../storage/sqlite-storage.js"
import { InvalidStateError, NotFoundError } from "./errors.js"
import { SessionRuntime } from "../runtime/session-runtime.js"
import { SessionSnapshot } from "./transport-contract.js"
import type { GetSessionSnapshotInput } from "./transport-contract.js"

/** The one read the client hydrates from: persisted conversation plus live runtime state. */
export const getSessionSnapshot = Effect.fn("SessionQueries.getSessionSnapshot")(function* (
  input: GetSessionSnapshotInput,
) {
  const sessionStorage = yield* SessionStorage
  const branchStorage = yield* BranchStorage
  const messageStorage = yield* MessageStorage
  const eventStorage = yield* EventStorage
  const storageTransaction = yield* makeStorageTransaction
  const sessionRuntime = yield* SessionRuntime
  const session = yield* sessionStorage.getSession(input.sessionId)
  if (Predicate.isUndefined(session)) {
    return yield* new NotFoundError({ message: "Session not found", entity: "session" })
  }
  const branch = yield* branchStorage.getBranch(input.branchId)
  if (Predicate.isUndefined(branch) || branch.sessionId !== input.sessionId) {
    return yield* new NotFoundError({ message: "Branch not found", entity: "branch" })
  }

  const snapshotState = yield* storageTransaction(
    Effect.gen(function* () {
      const messages = yield* messageStorage.listMessages(input.branchId)
      const lastEventId = yield* eventStorage.getLatestEventId({
        sessionId: input.sessionId,
        branchId: input.branchId,
      })
      return {
        projectedMessages: projectMessagesWithToolInteractions(messages),
        lastEventId,
      }
    }),
  )

  const runtime = yield* sessionRuntime.getState(input).pipe(
    Effect.mapError(
      (cause) =>
        new InvalidStateError({
          operation: "session.getSnapshot",
          message: `Failed to read session runtime state: ${cause.message}`,
        }),
    ),
  )

  // Cumulative metrics (turns, cost, last-model) are the authority for
  // client HUD displays. Keeping them on the snapshot means the TUI
  // hydrates cost/tokens from here instead of re-deriving by joining
  // streamed events against a client-side model registry.
  const metrics = yield* sessionRuntime
    .getMetrics({ sessionId: input.sessionId, branchId: input.branchId })
    .pipe(
      Effect.catchEager(() =>
        Effect.succeed({
          turns: 0,
          tokens: 0,
          toolCalls: 0,
          retries: 0,
          durationMs: 0,
          costUsd: 0,
          lastInputTokens: 0,
        }),
      ),
    )

  // Extension state is no longer hydrated through the session snapshot —
  // clients call the extension's typed `client.extension.request(...)` on
  // mount and subscribe to `ExtensionStateChanged` events for refetch
  // signals. The privileged out-of-band UI snapshot channel is gone.

  return new SessionSnapshot({
    sessionId: input.sessionId,
    branchId: input.branchId,
    name: session.name,
    messages: snapshotState.projectedMessages,
    lastEventId: Option.getOrNull(Option.fromUndefinedOr(snapshotState.lastEventId)),
    reasoningLevel: session.reasoningLevel,
    activeBranchId: session.activeBranchId,
    runtime,
    metrics,
  })
})
