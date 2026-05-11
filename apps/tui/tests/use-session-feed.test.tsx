import { describe, it, expect } from "effect-bun-test"
import { createRoot, createSignal } from "solid-js"
import { Deferred, Effect, Schema, Stream } from "effect"
import { AgentName } from "@gent/core-internal/domain/agent"
import {
  AgentEvent,
  EventEnvelope,
  EventId,
  type ActiveInteraction,
} from "@gent/core-internal/domain/event"
import {
  BranchId,
  ExtensionId,
  InteractionRequestId,
  MessageId,
  SessionId,
  ToolCallId,
} from "@gent/core-internal/domain/ids"
import { dateFromMillis, Message } from "@gent/core-internal/domain/message"
import type { SessionRuntimeState } from "@gent/core-internal/server/transport-contract"
import { emptyQueueSnapshot, type SessionSnapshot } from "@gent/sdk"
import { useSessionFeed } from "../src/hooks/use-session-feed"
import type { Session } from "../src/client"
import { createMockClient, createMockRuntime } from "./render-harness-boundary"

type FeedClient = Parameters<typeof useSessionFeed>[2]

class FeedTestTimeoutError extends Schema.TaggedErrorClass<FeedTestTimeoutError>()(
  "FeedTestTimeoutError",
  { message: Schema.String },
) {}

const waitFor = (predicate: () => boolean): Effect.Effect<void, FeedTestTimeoutError> => {
  let attempts = 20
  const check = Effect.gen(function* () {
    if (predicate()) return
    attempts -= 1
    if (attempts <= 0) {
      return yield* new FeedTestTimeoutError({ message: "condition did not settle" })
    }
    yield* Effect.sleep("0 millis")
    return yield* check
  }) as Effect.Effect<void, FeedTestTimeoutError>
  return check
}

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

const runtimeSnapshot = (): SessionRuntimeState => ({
  _tag: "Idle",
  agent: AgentName.make("cowork"),
  queue: emptyQueueSnapshot(),
})

const makeEnvelope = (id: number, event: AgentEvent): EventEnvelope =>
  EventEnvelope.make({
    id: EventId.make(id),
    event,
    createdAt: 0,
  })

const makeUserMessage = (sessionId: SessionId, branchId: BranchId): Message =>
  Message.cases.regular.make({
    id: MessageId.make("message-feed-duplicate-user"),
    sessionId,
    branchId,
    role: "user",
    parts: [],
    createdAt: dateFromMillis(0),
  })

const makeSession = (sessionId: SessionId, branchId: BranchId): Session => ({
  sessionId,
  branchId,
  name: "Test Session",
  reasoningLevel: undefined,
})

describe("useSessionFeed", () => {
  it.live("displays repeated event envelopes at most once across visible feed items", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-duplicates")
      const branchId = BranchId.make("branch-feed-duplicates")
      const toolCallId = ToolCallId.make("tool-call-feed-duplicates")
      const messageEnvelope = makeEnvelope(
        1,
        AgentEvent.cases.MessageReceived.make({ message: makeUserMessage(sessionId, branchId) }),
      )
      const streamStartedEnvelope = makeEnvelope(
        2,
        AgentEvent.cases.StreamStarted.make({ sessionId, branchId }),
      )
      const streamChunkEnvelope = makeEnvelope(
        3,
        AgentEvent.cases.StreamChunk.make({
          sessionId,
          branchId,
          chunk: "assistant text",
        }),
      )
      const toolStartedEnvelope = makeEnvelope(
        4,
        AgentEvent.cases.ToolCallStarted.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "bash",
          input: { command: "printf hi" },
        }),
      )
      const toolSucceededEnvelope = makeEnvelope(
        5,
        AgentEvent.cases.ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "bash",
          summary: "printed hi",
          output: "hi",
        }),
      )
      const turnCompletedEnvelope = makeEnvelope(
        6,
        AgentEvent.cases.TurnCompleted.make({
          sessionId,
          branchId,
          durationMs: 1_000,
        }),
      )
      const retryEnvelope = makeEnvelope(
        7,
        AgentEvent.cases.ProviderRetrying.make({
          sessionId,
          branchId,
          attempt: 1,
          maxAttempts: 3,
          delayMs: 100,
          error: "temporary provider failure",
        }),
      )
      const errorEnvelope = makeEnvelope(
        8,
        AgentEvent.cases.ErrorOccurred.make({
          sessionId,
          branchId,
          error: "provider failed",
        }),
      )
      const uniqueEnvelopes = [
        messageEnvelope,
        streamStartedEnvelope,
        streamChunkEnvelope,
        toolStartedEnvelope,
        toolSucceededEnvelope,
        turnCompletedEnvelope,
        retryEnvelope,
        errorEnvelope,
      ]
      const errorSeen = yield* Deferred.make<void>()
      let appliedEvents = 0
      let feed: ReturnType<typeof useSessionFeed> | undefined

      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = {
          session: active,
          client: createMockClient({
            session: {
              getSnapshot: () => Effect.succeed(snapshotFor(sessionId, branchId)),
              events: () =>
                Stream.concat(
                  Stream.make(...uniqueEnvelopes.flatMap((envelope) => [envelope, envelope])),
                  Stream.never,
                ),
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime: createMockRuntime(),
          log: {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: (message: string) => {
              if (message === "sessionFeed.error")
                client.runtime.cast(Deferred.succeed(errorSeen, undefined))
            },
          },
          setConnectionIssue: () => {},
          waitForTransportReady: () => Effect.void,
          applySessionSnapshot: () => {},
          applySessionEvent: () => {
            appliedEvents += 1
          },
          applyBufferedSessionEvent: () => {},
        } satisfies FeedClient

        feed = useSessionFeed(
          () => sessionId,
          () => branchId,
          client,
          client.runtime.cast,
          {
            onInteraction: () => {},
            onInteractionDismissed: () => {},
            onBranchSwitch: () => {},
            onQueueSnapshot: () => {},
          },
        )
        return disposeRoot
      })

      yield* Deferred.await(errorSeen)
      yield* waitFor(
        () =>
          feed?.messages().some((message) => message.role === "assistant") === true &&
          feed?.items().some((item) => item._tag === "error") === true,
      )
      yield* Effect.sync(() => {
        const messages = feed?.messages()
        const userMessages = messages?.filter((message) => message.role === "user")
        const assistantMessage = messages?.find((message) => message.role === "assistant")
        const events = feed
          ?.items()
          .filter(
            (item) =>
              item._tag === "turn-ended" || item._tag === "retrying" || item._tag === "error",
          )
        expect(appliedEvents).toBe(uniqueEnvelopes.length)
        expect(userMessages).toHaveLength(1)
        expect(assistantMessage?.content).toBe("assistant text")
        expect(assistantMessage?.toolCalls).toHaveLength(1)
        expect(assistantMessage?.toolCalls?.[0]?.status).toBe("completed")
        expect(events?.map((event) => event._tag)).toEqual(["turn-ended", "retrying", "error"])
        dispose()
      })
    }),
  )

  it.live("replays buffered event-only state before the snapshot cursor", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-buffered")
      const branchId = BranchId.make("branch-feed-buffered")
      const extensionId = ExtensionId.make("buffered-extension")
      const bufferedPulse = makeEnvelope(
        1,
        AgentEvent.cases.ExtensionStateChanged.make({ sessionId, branchId, extensionId }),
      )
      const bufferedInteraction = makeEnvelope(
        2,
        AgentEvent.cases.InteractionPresented.make({
          sessionId,
          branchId,
          requestId: InteractionRequestId.make("interaction-buffered"),
          text: "approve this",
          metadata: undefined,
        }),
      )
      const bufferedBranchSwitch = makeEnvelope(
        3,
        AgentEvent.cases.BranchSwitched.make({
          sessionId,
          fromBranchId: branchId,
          toBranchId: branchId,
        }),
      )
      const liveEvent = makeEnvelope(
        4,
        AgentEvent.cases.TurnCompleted.make({ sessionId, branchId, durationMs: 1 }),
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
            if (envelope.id === liveEvent.id)
              client.runtime.cast(Deferred.succeed(liveSeen, undefined))
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
              client.runtime.cast(Deferred.succeed(interactionSeen, interaction))
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
