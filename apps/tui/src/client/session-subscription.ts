import { Effect, Fiber, Schema, Stream } from "effect"
import { createEffect, on, onCleanup, type Accessor } from "solid-js"
import { AgentName as AgentNameSchema } from "@gent/core/domain/agent.js"
import type { EventEnvelope } from "@gent/core/domain/event.js"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import type { GentNamespacedClient, GentRpcError, GentRuntime, SessionSnapshot } from "@gent/sdk"
import type { ClientLog } from "../utils/client-logger"
import { formatConnectionIssue, formatError } from "../utils/format-error"
import { runWithReconnect } from "../utils/run-with-reconnect"
import { reduceAgentLifecycle } from "./agent-lifecycle"
import { AgentStatus, type AgentState } from "./agent-state"
import type { ClientTransportValue } from "./context"
import { SessionStateEvent, type Session } from "./session-state"

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
    runtimeTag: snapshot.runtime._tag,
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

export interface SessionSubscriptionEffectParams {
  readonly client: GentNamespacedClient
  readonly runtime: GentRuntime
  readonly log: ClientLog
  readonly sessionKey: Accessor<string | null>
  readonly workerEpoch: Accessor<number | null>
  readonly connectionState: ClientTransportValue["connectionState"]
  readonly session: () => Session | null
  readonly lastSeenEventId: Accessor<number | null>
  readonly lastSeenSessionKey: Accessor<string | null>
  readonly setLastSeenEventId: (id: number | null) => void
  readonly setLastSeenSessionKey: (key: string | null) => void
  readonly setConnectionIssue: (issue: string | null) => void
  readonly dispatchSessionEvent: (event: SessionStateEvent) => void
  readonly setAgentStore: (patch: Partial<AgentState>) => void
  readonly setLatestInputTokens: (tokens: number) => void
  readonly notifyExtensionStateChanged: (event: EventEnvelope["event"]) => void
  readonly notifySessionEvent: (envelope: EventEnvelope) => void
}

export const createSessionSubscriptionEffect = (params: SessionSubscriptionEffectParams): void => {
  const {
    client,
    runtime,
    log,
    sessionKey,
    workerEpoch,
    connectionState,
    session,
    lastSeenEventId,
    lastSeenSessionKey,
    setLastSeenEventId,
    setLastSeenSessionKey,
    setConnectionIssue,
    dispatchSessionEvent,
    setAgentStore,
    setLatestInputTokens,
    notifyExtensionStateChanged,
    notifySessionEvent,
  } = params

  createEffect(
    on([sessionKey, workerEpoch], ([key]) => {
      if (key === null) {
        setLastSeenEventId(null)
        setLastSeenSessionKey(null)
        setConnectionIssue(null)
        return
      }
      if (key !== lastSeenSessionKey()) {
        setLastSeenSessionKey(key)
        setLastSeenEventId(null)
        setConnectionIssue(null)
      }

      const sep = key.indexOf(":")
      const sessionId = SessionId.make(key.slice(0, sep))
      const branchId = BranchId.make(key.slice(sep + 1))
      let cancelled = false
      const isActiveSession = () => !cancelled && sessionKey() === key

      const processEvent = (envelope: EventEnvelope): void => {
        if (!isActiveSession()) return

        log.debug("event.received", {
          eventId: envelope.id,
          tag: envelope.event._tag,
          traceId: envelope.traceId,
        })
        setConnectionIssue(null)

        notifySessionEvent(envelope)
        setLastSeenEventId(envelope.id)

        const event = envelope.event
        if (event._tag === "StreamEnded" && event.usage !== undefined) {
          const s = session()
          if (s !== null) {
            runtime.cast(
              client.actor.getMetrics({ sessionId: s.sessionId, branchId: s.branchId }).pipe(
                Effect.tap((metrics) =>
                  Effect.sync(() => {
                    setAgentStore({
                      cost: metrics.costUsd,
                      lastModelId: metrics.lastModelId,
                    })
                    setLatestInputTokens(metrics.lastInputTokens)
                  }),
                ),
                Effect.catchEager(() => Effect.void),
              ),
            )
          }
        }

        if (event._tag === "ErrorOccurred") {
          log.error("agent.error", { error: event.error, eventId: envelope.id })
        }

        const lifecycle = reduceAgentLifecycle(event)
        if (lifecycle.preferredAgent !== undefined) {
          if (Schema.is(AgentNameSchema)(lifecycle.preferredAgent)) {
            setAgentStore({ agent: lifecycle.preferredAgent })
          } else {
            setAgentStore({ agent: undefined })
          }
        }
        if (lifecycle.status !== undefined) {
          switch (lifecycle.status._tag) {
            case "idle":
              setAgentStore({ status: AgentStatus.idle() })
              break
            case "streaming":
              setAgentStore({ status: AgentStatus.streaming() })
              break
            case "error":
              setAgentStore({ status: AgentStatus.error(lifecycle.status.error) })
              break
          }
        }

        notifyExtensionStateChanged(event)

        switch (event._tag) {
          case "SessionNameUpdated":
            if (event.sessionId === sessionId) {
              dispatchSessionEvent(SessionStateEvent.UpdateName.make({ name: event.name }))
            }
            break

          case "BranchSwitched":
            if (event.sessionId === sessionId) {
              dispatchSessionEvent(
                SessionStateEvent.UpdateBranch.make({ branchId: event.toBranchId }),
              )
            }
            break

          case "SessionSettingsUpdated":
            if (event.sessionId === sessionId && event.reasoningLevel !== undefined) {
              dispatchSessionEvent(
                SessionStateEvent.UpdateReasoningLevel.make({
                  reasoningLevel: event.reasoningLevel,
                }),
              )
            }
            break
        }
      }

      log.info("ctx.subscribe.start", { sessionId, branchId })
      const fiber = runtime.fork(
        runWithReconnect(
          () =>
            Effect.gen(function* () {
              if (connectionState()?._tag !== "connected") {
                log.info("ctx.wait-for-ready", { sessionId, branchId })
                yield* runtime.lifecycle.waitForReady
                log.info("ctx.ready", { sessionId, branchId })
              }

              yield* runSessionSubscriptionAttempt({
                sessionId,
                branchId,
                lastSeenEventId: lastSeenEventId(),
                log,
                isActiveSession,
                getSnapshot: client.session.getSnapshot({ sessionId, branchId }),
                hydrateSnapshot: (snapshot) => {
                  setConnectionIssue(null)
                  if (snapshot.reasoningLevel !== undefined) {
                    dispatchSessionEvent(
                      SessionStateEvent.UpdateReasoningLevel.make({
                        reasoningLevel: snapshot.reasoningLevel,
                      }),
                    )
                  }
                  const rt = snapshot.runtime
                  const status = rt._tag === "Idle" ? AgentStatus.idle() : AgentStatus.streaming()
                  setAgentStore({
                    agent: rt.agent,
                    status,
                    cost: snapshot.metrics.costUsd,
                    lastModelId: snapshot.metrics.lastModelId,
                  })
                  setLatestInputTokens(snapshot.metrics.lastInputTokens)
                },
                openEvents: (after) =>
                  client.session.events({
                    sessionId,
                    branchId,
                    ...(after !== undefined ? { after } : {}),
                  }),
                processEvent,
              })
            }),
          {
            label: "ctx.events",
            log,
            onError: (err) => {
              if (!isActiveSession()) return
              if (connectionState()?._tag !== "connected") return
              log.error("event.subscription.failed", { error: formatError(err) })
              setConnectionIssue(formatConnectionIssue(err))
            },
            waitForRetry: () => runtime.lifecycle.waitForReady,
          },
        ),
      )

      onCleanup(() => {
        log.info("ctx.subscribe.cleanup", { sessionId, branchId })
        cancelled = true
        Effect.runFork(Fiber.interrupt(fiber))
      })
    }),
  )
}
