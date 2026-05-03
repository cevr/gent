import { describe, it, expect } from "effect-bun-test"
import { createRoot, createSignal } from "solid-js"
import { Deferred, Effect, Stream } from "effect"
import { AgentName } from "@gent/core/domain/agent"
import { AgentEvent, EventEnvelope, EventId, type ActiveInteraction } from "@gent/core/domain/event"
import { BranchId, ExtensionId, InteractionRequestId, SessionId } from "@gent/core/domain/ids"
import { emptyQueueSnapshot, type SessionRuntime, type SessionSnapshot } from "@gent/sdk"
import { useSessionFeed } from "../src/hooks/use-session-feed"
import type { Session } from "../src/client"
import { createMockClient, createMockRuntime } from "./render-harness"

type FeedClient = Parameters<typeof useSessionFeed>[2]

const snapshotFor = (
  sessionId: SessionId,
  branchId: BranchId,
  lastEventId: number | null = null,
): SessionSnapshot => ({
  sessionId,
  branchId,
  messages: [],
  lastEventId,
  reasoningLevel: undefined,
  runtime: {
    _tag: "Idle",
    agent: AgentName.make("cowork"),
    queue: emptyQueueSnapshot(),
  },
  metrics: {
    turns: 0,
    tokens: 0,
    toolCalls: 0,
    retries: 0,
    durationMs: 0,
    costUsd: 0,
    lastInputTokens: 0,
  },
})

const runtimeSnapshot = (): SessionRuntime => ({
  _tag: "Idle",
  agent: AgentName.make("cowork"),
  queue: emptyQueueSnapshot(),
})

const makeEnvelope = (id: number, event: AgentEvent): EventEnvelope =>
  EventEnvelope.make({
    id: EventId.make(id),
    event,
    createdAt: Date.now(),
  })

const makeSession = (sessionId: SessionId, branchId: BranchId): Session => ({
  sessionId,
  branchId,
  name: "Test Session",
  reasoningLevel: undefined,
})

describe("useSessionFeed", () => {
  it.live("replays buffered event-only state before the snapshot cursor", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-buffered")
      const branchId = BranchId.make("branch-feed-buffered")
      const extensionId = ExtensionId.make("buffered-extension")
      const bufferedPulse = makeEnvelope(
        1,
        AgentEvent.ExtensionStateChanged.make({ sessionId, branchId, extensionId }),
      )
      const bufferedInteraction = makeEnvelope(
        2,
        AgentEvent.InteractionPresented.make({
          sessionId,
          branchId,
          requestId: InteractionRequestId.make("interaction-buffered"),
          text: "approve this",
          metadata: undefined,
        }),
      )
      const bufferedBranchSwitch = makeEnvelope(
        3,
        AgentEvent.BranchSwitched.make({
          sessionId,
          fromBranchId: branchId,
          toBranchId: branchId,
        }),
      )
      const liveEvent = makeEnvelope(
        4,
        AgentEvent.TurnCompleted.make({ sessionId, branchId, durationMs: 1 }),
      )
      const interactionSeen = yield* Deferred.make<ActiveInteraction>()
      const liveSeen = yield* Deferred.make<void>()
      let requestedAfter: number | undefined
      const bufferedTags: string[] = []
      const branchSwitches: Array<{ sessionId: SessionId; branchId: BranchId }> = []

      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = {
          session: active,
          client: createMockClient({
            session: {
              getSnapshot: () => Effect.succeed(snapshotFor(sessionId, branchId, 3)),
              events: ({ after }: { readonly after?: number }) => {
                requestedAfter = after
                return Stream.concat(
                  Stream.make(bufferedPulse, bufferedInteraction, bufferedBranchSwitch, liveEvent),
                  Stream.never,
                )
              },
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime: createMockRuntime(),
          log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
          setConnectionIssue: () => {},
          waitForTransportReady: () => Effect.void,
          applySessionSnapshot: () => {},
          applySessionEvent: (envelope) => {
            if (envelope.id === liveEvent.id) Effect.runFork(Deferred.succeed(liveSeen, undefined))
          },
          applyBufferedSessionEvent: (envelope) => {
            bufferedTags.push(envelope.event._tag)
          },
        } satisfies FeedClient

        useSessionFeed(
          () => sessionId,
          () => branchId,
          client,
          client.runtime.cast,
          {
            onInteraction: (interaction) => {
              Effect.runFork(Deferred.succeed(interactionSeen, interaction))
            },
            onInteractionDismissed: () => {},
            onBranchSwitch: (nextSessionId, nextBranchId) => {
              branchSwitches.push({ sessionId: nextSessionId, branchId: nextBranchId })
            },
            onQueueSnapshot: () => {},
          },
        )
        return disposeRoot
      })

      const interaction = yield* Deferred.await(interactionSeen)
      yield* Deferred.await(liveSeen)
      yield* Effect.sync(() => {
        expect(requestedAfter).toBe(0)
        expect(bufferedTags).toEqual([
          "ExtensionStateChanged",
          "InteractionPresented",
          "BranchSwitched",
        ])
        expect(interaction.requestId).toBe(InteractionRequestId.make("interaction-buffered"))
        expect(branchSwitches).toEqual([])
        dispose()
      })
    }),
  )
})
