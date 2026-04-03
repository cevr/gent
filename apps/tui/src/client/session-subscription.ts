import { Effect, Stream } from "effect"
import type { EventEnvelope } from "@gent/core/domain/event.js"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import type { GentRpcError, SessionSnapshot } from "@gent/sdk"
import type { ClientLog } from "../utils/client-logger"

const formatCaughtError = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

export interface SessionSubscriptionAttempt {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly lastSeenEventId: number | null
  readonly log: ClientLog
  readonly isActiveSession: () => boolean
  readonly getSnapshot: Effect.Effect<SessionSnapshot, GentRpcError>
  readonly hydrateSnapshot: (snapshot: SessionSnapshot) => void
  readonly openEvents: (after?: number) => Stream.Stream<EventEnvelope, GentRpcError>
  readonly processEvent: (envelope: EventEnvelope) => void
}

export const runSessionSubscriptionAttempt = Effect.fn("runSessionSubscriptionAttempt")(function* (
  params: SessionSubscriptionAttempt,
) {
  const { sessionId, branchId, log } = params

  log.info("ctx.snapshot.fetch", { sessionId, branchId })
  const snapshot = yield* params.getSnapshot
  if (!params.isActiveSession()) return

  const after = params.lastSeenEventId ?? snapshot.lastEventId ?? undefined
  log.info("ctx.snapshot.hydrated", {
    sessionId,
    branchId,
    lastEventId: snapshot.lastEventId,
    after,
    agent: snapshot.runtime.agent,
    status: snapshot.runtime.status,
  })

  yield* Effect.sync(() => {
    if (!params.isActiveSession()) return
    params.hydrateSnapshot(snapshot)
  })
  if (!params.isActiveSession()) return
  const events = params.openEvents(after)
  log.info("ctx.stream.open", { sessionId, branchId, after })
  yield* Stream.runForEach(events, (envelope: EventEnvelope) =>
    Effect.sync(() => {
      if (!params.isActiveSession()) return
      try {
        params.processEvent(envelope)
      } catch (error) {
        log.error("event.processing.error", {
          error: formatCaughtError(error),
        })
      }
    }),
  )
  log.info("ctx.stream.closed", { sessionId, branchId })
})
