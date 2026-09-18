/** @jsxImportSource @opentui/solid */
/**
 * Session metrics must not cross a session boundary.
 *
 * Two ways they used to: a session change reset the cost and the token count
 * but left `contextMetrics` behind, and an in-flight `getSnapshot` reply was
 * written back without checking which session had asked for it. Both are
 * visible: `buildContextLabels` prefers the projection over the live token
 * count whenever it carries a limit, so a stale projection renders the
 * previous session's context percentage on the status border.
 *
 * Each test below fails if its half of the repair is removed.
 */
import { describe, it, expect } from "effect-bun-test"
import { onMount } from "solid-js"
import { Deferred, Effect, Option, Schema } from "effect"
import {
  AgentEvent,
  AgentName,
  BranchId,
  EventEnvelope,
  ModelId,
  SessionId,
  dateFromMillis,
  type SessionSnapshot,
} from "@gent/core/protocol"
import { EventId } from "@gent/core-internal/domain/event"
import { emptyQueueSnapshot } from "@gent/sdk"
import { createMockClient, renderWithProviders } from "./render-harness-boundary"
import { type ClientContextValue, useClient } from "../src/client"

class ClientMetricsTestError extends Schema.TaggedError<ClientMetricsTestError>()(
  "ClientMetricsTestError",
  { message: Schema.String },
) {}

const absent = Option.getOrUndefined(Option.none())
const nullValue = Option.getOrNull(Option.none())

const requireClient = (
  context: Option.Option<ClientContextValue>,
): Effect.Effect<ClientContextValue, ClientMetricsTestError> => {
  if (Option.isNone(context)) {
    return Effect.fail(new ClientMetricsTestError({ message: "client context not ready" }))
  }
  return Effect.succeed(context.value)
}

function ClientProbe(props: { readonly onReady: (client: ClientContextValue) => void }) {
  const client = useClient()
  onMount(() => {
    props.onReady(client)
  })
  return <box />
}

const FIRST = {
  sessionId: SessionId.make("session-metrics-first"),
  branchId: BranchId.make("branch-metrics-first"),
}
const SECOND = {
  sessionId: SessionId.make("session-metrics-second"),
  branchId: BranchId.make("branch-metrics-second"),
}

/** A projection that fills most of the window: the value a reader would see as `ctx 90%`. */
const busyContext = {
  estimatedTokens: 90_000,
  availableInputTokens: 10_000,
  contextLimitTokens: 100_000,
  omittedMessages: 0,
  compactions: 1,
}

const snapshotOf = (
  session: { sessionId: SessionId; branchId: BranchId },
  metrics: {
    costUsd: number
    lastInputTokens: number
    context?: typeof busyContext
  },
): SessionSnapshot => ({
  sessionId: session.sessionId,
  branchId: session.branchId,
  messages: [],
  lastEventId: nullValue,
  reasoningLevel: absent,
  resolvedModelId: ModelId.make("anthropic/claude-sonnet-5"),
  runtime: {
    _tag: "Idle",
    agent: AgentName.make("cowork"),
    queue: emptyQueueSnapshot(),
  },
  metrics: {
    turns: 1,
    durationMs: 10,
    costUsd: metrics.costUsd,
    lastInputTokens: metrics.lastInputTokens,
    context: metrics.context,
  },
})

describe("ClientProvider session metrics", () => {
  it.live("switching sessions drops the previous session's context projection", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const client = createMockClient({
        session: {
          getSnapshot: () =>
            Effect.succeed(
              snapshotOf(FIRST, { costUsd: 4.2, lastInputTokens: 9_000, context: busyContext }),
            ),
        },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(c) => (ctx = Option.some(c))} />, {
          client,
          initialSession: {
            id: FIRST.sessionId,
            activeBranchId: FIRST.branchId,
            name: "First",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      const clientContext = yield* requireClient(ctx)

      // Load the first session's metrics the way a finished turn would.
      clientContext.applySessionSnapshot(
        snapshotOf(FIRST, { costUsd: 4.2, lastInputTokens: 9_000, context: busyContext }),
      )
      yield* Effect.promise(() => setup.renderOnce())
      expect(Option.isSome(clientContext.sessionMetrics().context)).toBe(true)
      expect(clientContext.cost()).toBe(4.2)
      expect(clientContext.sessionMetrics().latestInputTokens).toBe(9_000)

      clientContext.switchSession(SECOND.sessionId, SECOND.branchId, "Second")
      yield* Effect.promise(() => setup.renderOnce())

      // Every metric goes, not just the two that always did.
      expect(clientContext.cost()).toBe(0)
      expect(clientContext.sessionMetrics().latestInputTokens).toBe(0)
      expect(Option.isNone(clientContext.sessionMetrics().context)).toBe(true)

      setup.renderer.destroy()
    }),
  )

  it.live("clearing the session drops the context projection", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(c) => (ctx = Option.some(c))} />, {
          initialSession: {
            id: FIRST.sessionId,
            activeBranchId: FIRST.branchId,
            name: "First",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      const clientContext = yield* requireClient(ctx)

      clientContext.applySessionSnapshot(
        snapshotOf(FIRST, { costUsd: 1.5, lastInputTokens: 5_000, context: busyContext }),
      )
      yield* Effect.promise(() => setup.renderOnce())
      expect(Option.isSome(clientContext.sessionMetrics().context)).toBe(true)

      clientContext.clearSession()
      yield* Effect.promise(() => setup.renderOnce())

      expect(Option.isNone(clientContext.sessionMetrics().context)).toBe(true)
      expect(clientContext.sessionMetrics().latestInputTokens).toBe(0)

      setup.renderer.destroy()
    }),
  )

  it.live("a snapshot reply that arrives after a session switch is dropped", () =>
    Effect.gen(function* () {
      let ctx = Option.none<ClientContextValue>()
      const held = yield* Deferred.make<SessionSnapshot>()
      const asked: Array<string> = []
      const client = createMockClient({
        session: {
          getSnapshot: (input: { sessionId: SessionId; branchId: BranchId }) => {
            asked.push(String(input.sessionId))
            // Hold the first session's reply open so the switch lands first.
            if (input.sessionId === FIRST.sessionId) return Deferred.await(held)
            return Effect.succeed(
              snapshotOf(SECOND, { costUsd: 0, lastInputTokens: 0, context: absent }),
            )
          },
        },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <ClientProbe onReady={(c) => (ctx = Option.some(c))} />, {
          client,
          initialSession: {
            id: FIRST.sessionId,
            activeBranchId: FIRST.branchId,
            name: "First",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          },
        }),
      )
      const clientContext = yield* requireClient(ctx)

      // The product path: a stream that ends with usage refreshes the metrics.
      // Its reply stays in flight because the mock holds this session's answer.
      clientContext.applySessionEvent(
        EventEnvelope.make({
          id: EventId.make(1),
          createdAt: 0,
          event: AgentEvent.cases.StreamEnded.make({
            sessionId: FIRST.sessionId,
            branchId: FIRST.branchId,
            usage: { inputTokens: 9_000, outputTokens: 120 },
          }),
        }),
      )
      yield* Effect.promise(() => setup.renderOnce())
      expect(asked).toContain(String(FIRST.sessionId))

      clientContext.switchSession(SECOND.sessionId, SECOND.branchId, "Second")
      yield* Effect.promise(() => setup.renderOnce())
      expect(clientContext.cost()).toBe(0)
      expect(Option.isNone(clientContext.sessionMetrics().context)).toBe(true)

      // The first session's reply lands now, naming a session nobody is on.
      yield* Deferred.succeed(
        held,
        snapshotOf(FIRST, { costUsd: 4.2, lastInputTokens: 9_000, context: busyContext }),
      )
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() => setup.renderOnce())

      // None of the first session's numbers come back.
      expect(clientContext.cost()).toBe(0)
      expect(clientContext.sessionMetrics().latestInputTokens).toBe(0)
      expect(Option.isNone(clientContext.sessionMetrics().context)).toBe(true)

      setup.renderer.destroy()
    }),
  )
})
