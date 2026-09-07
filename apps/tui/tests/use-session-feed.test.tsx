import { describe, it, expect } from "effect-bun-test"
import { createRoot, createSignal } from "solid-js"
import { Deferred, Effect, Option, Predicate, Schema, Stream } from "effect"
import { AgentName } from "@gent/core-internal/domain/agent"
import * as Prompt from "effect/unstable/ai/Prompt"
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
const absent = Option.getOrUndefined(Option.none())

class FeedTestTimeoutError extends Schema.TaggedError<FeedTestTimeoutError>()(
  "FeedTestTimeoutError",
  { message: Schema.String },
) {}

const waitFor = (predicate: () => boolean): Effect.Effect<void, FeedTestTimeoutError> => {
  let attempts = 20
  const check: Effect.Effect<void, FeedTestTimeoutError> = Effect.gen(function* () {
    if (predicate()) return
    attempts -= 1
    if (attempts <= 0) {
      return yield* new FeedTestTimeoutError({ message: "condition did not settle" })
    }
    // gent/no-sleep: allow yield-then-retry primitive — Solid signal microtasks must drain between checks
    yield* Effect.sleep("0 millis")
    return yield* check
  })
  return check
}

const snapshotFor = (
  sessionId: SessionId,
  branchId: BranchId,
  lastEventId?: number,
): SessionSnapshot => ({
  sessionId,
  branchId,
  messages: [],
  lastEventId: Option.getOrNull(Option.fromNullishOr(lastEventId)),
  reasoningLevel: Option.getOrUndefined(Option.none()),
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

const makeCompactionMessage = (sessionId: SessionId, branchId: BranchId): Message =>
  Message.cases.regular.make({
    id: MessageId.make("model-compaction:branch-feed-compaction:revision"),
    sessionId,
    branchId,
    role: "assistant",
    parts: [Prompt.textPart({ text: "Historical context summary: stored summary" })],
    metadata: {
      customType: "model-compaction",
      details: {
        _tag: "model-compaction",
        sourceMessageIds: [],
        sourceRevision: "revision",
      },
    },
    createdAt: dateFromMillis(0),
  })

const makeSession = (sessionId: SessionId, branchId: BranchId): Session => ({
  sessionId,
  branchId,
  name: "Test Session",
  reasoningLevel: Option.getOrUndefined(Option.none()),
})

const isSessionEvent = Predicate.or(
  Predicate.isTagged("turn-ended"),
  Predicate.or(Predicate.isTagged("retrying"), Predicate.isTagged("error")),
)

describe("useSessionFeed", () => {
  it.live("changes route when a branch event changes the active client identity", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("branch-navigation-session")
      const branchId = BranchId.make("branch-navigation-first")
      const nextBranchId = BranchId.make("branch-navigation-second")
      const switched = yield* Deferred.make<void>()
      let snapshotCount = 0
      const dispose = createRoot((disposeRoot) => {
        const [active, setActive] = createSignal(makeSession(sessionId, branchId))
        const runtime = createMockRuntime()
        const client = {
          session: active,
          client: createMockClient({
            session: {
              getSnapshot: () => Effect.succeed(snapshotFor(sessionId, branchId)),
              events: () =>
                Stream.concat(
                  Stream.make(
                    makeEnvelope(
                      1,
                      AgentEvent.cases.BranchSwitched.make({
                        sessionId,
                        fromBranchId: branchId,
                        toBranchId: nextBranchId,
                      }),
                    ),
                  ),
                  Stream.never,
                ),
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime,
          log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
          setConnectionIssue: () => {},
          waitForTransportReady: Effect.void,
          applySessionSnapshot: () => {
            snapshotCount += 1
            setActive(makeSession(sessionId, branchId))
          },
          applySessionEvent: () => setActive(makeSession(sessionId, nextBranchId)),
          applyBufferedSessionEvent: () => {},
        } satisfies FeedClient
        useSessionFeed(
          () => sessionId,
          () => branchId,
          client,
          runtime.cast,
          {
            onInteraction: () => {},
            onInteractionDismissed: () => {},
            onQueueSnapshot: () => {},
            onBranchSwitch: (nextSession, nextBranch) => {
              expect(nextSession).toBe(sessionId)
              expect(nextBranch).toBe(nextBranchId)
              runtime.cast(Deferred.succeed(switched, void 0))
            },
          },
        )
        return disposeRoot
      })
      yield* Deferred.await(switched).pipe(
        Effect.timeout("1 second"),
        Effect.ensuring(Effect.sync(dispose)),
      )
      expect(snapshotCount).toBe(1)
    }),
  )

  it.live("displays repeated events and resumed tool calls once with their final status", () =>
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
        6,
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
        7,
        AgentEvent.cases.TurnCompleted.make({
          sessionId,
          branchId,
          durationMs: 1_000,
        }),
      )
      const retryEnvelope = makeEnvelope(
        8,
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
        9,
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
        makeEnvelope(5, toolStartedEnvelope.event),
        toolSucceededEnvelope,
        turnCompletedEnvelope,
        retryEnvelope,
        errorEnvelope,
      ]
      const errorSeen = yield* Deferred.make<void>()
      let appliedEvents = 0
      let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()

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
                client.runtime.cast(Deferred.succeed(errorSeen, void 0))
            },
          },
          setConnectionIssue: () => {},
          waitForTransportReady: Effect.void,
          applySessionSnapshot: () => {},
          applySessionEvent: () => {
            appliedEvents += 1
          },
          applyBufferedSessionEvent: () => {},
        } satisfies FeedClient

        feed = Option.some(
          useSessionFeed(
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
          ),
        )
        return disposeRoot
      })

      yield* Deferred.await(errorSeen)
      yield* waitFor(
        () =>
          Option.isSome(feed) &&
          feed.value.messages().some((message) => message.role === "assistant") &&
          feed.value.items().some((item) => item._tag === "error"),
      )
      yield* Effect.sync(() => {
        if (Option.isNone(feed)) return
        const messages = feed.value.messages()
        const userMessages = messages.filter((message) => message.role === "user")
        const assistantMessage = messages.find((message) => message.role === "assistant")
        const events = feed.value.items().filter(isSessionEvent)
        expect(appliedEvents).toBe(uniqueEnvelopes.length)
        expect(userMessages).toHaveLength(1)
        expect(assistantMessage?.content).toBe("assistant text")
        expect(assistantMessage?.toolCalls).toHaveLength(1)
        expect(assistantMessage?.toolCalls?.[0]?.status).toBe("completed")
        const toolSegments = assistantMessage?.segments?.filter(
          (segment) => segment._tag === "tool-call",
        )
        expect(toolSegments).toHaveLength(1)
        expect(toolSegments?.[0]?.toolCall.status).toBe("completed")
        expect(events?.map((event) => event._tag)).toEqual(["turn-ended", "retrying", "error"])
        const retry = events?.find((event) => event._tag === "retrying")
        expect(retry?._tag === "retrying" && retry.resolved).toBe(true)
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
          metadata: absent,
        }),
      )
      const bufferedBranchSwitch = makeEnvelope(
        3,
        AgentEvent.cases.BranchSwitched.make({
          sessionId,
          fromBranchId: branchId,
          toBranchId: BranchId.make("historical-other-branch"),
        }),
      )
      const liveEvent = makeEnvelope(
        4,
        AgentEvent.cases.TurnCompleted.make({ sessionId, branchId, durationMs: 1 }),
      )
      const interactionSeen = yield* Deferred.make<ActiveInteraction>()
      const liveSeen = yield* Deferred.make<void>()
      let requestedAfter: Option.Option<number> = Option.none()
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
                requestedAfter = Option.fromNullishOr(after)
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
          waitForTransportReady: Effect.void,
          applySessionSnapshot: () => {},
          applySessionEvent: (envelope) => {
            if (envelope.id === liveEvent.id)
              client.runtime.cast(Deferred.succeed(liveSeen, void 0))
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
        expect(Option.getOrElse(requestedAfter, () => -1)).toBe(0)
        expect(bufferedTags).toEqual(["ExtensionStateChanged", "InteractionPresented"])
        expect(interaction.requestId).toBe(InteractionRequestId.make("interaction-buffered"))
        expect(branchSwitches).toEqual([])
        dispose()
      })
    }),
  )

  it.live("shows a live compaction message as soon as its event arrives", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-compaction-live")
      const branchId = BranchId.make("branch-feed-compaction-live")
      const messageEnvelope = makeEnvelope(
        1,
        AgentEvent.cases.MessageReceived.make({
          message: makeCompactionMessage(sessionId, branchId),
        }),
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
          chunk: "native response",
        }),
      )
      let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()
      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = {
          session: active,
          client: createMockClient({
            session: {
              getSnapshot: () => Effect.succeed(snapshotFor(sessionId, branchId)),
              events: () =>
                Stream.concat(
                  Stream.make(messageEnvelope, streamStartedEnvelope, streamChunkEnvelope),
                  Stream.never,
                ),
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime: createMockRuntime(),
          log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
          setConnectionIssue: () => {},
          waitForTransportReady: Effect.void,
          applySessionSnapshot: () => {},
          applySessionEvent: () => {},
          applyBufferedSessionEvent: () => {},
        } satisfies FeedClient
        feed = Option.some(
          useSessionFeed(
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
          ),
        )
        return disposeRoot
      })

      yield* waitFor(
        () =>
          Option.isSome(feed) &&
          feed.value.messages().some((message) => message.content.includes("native response")),
      )
      if (Option.isNone(feed)) return yield* Effect.die("feed did not initialize")
      expect(feed.value.messages()).toHaveLength(2)
      const summary = feed.value
        .messages()
        .find((message) => message.metadata?.customType === "model-compaction")
      const response = feed.value
        .messages()
        .find((message) => message.content.includes("native response"))
      expect(summary?.content).toBe("Historical context summary: stored summary")
      expect(response?.id).toBeDefined()
      expect(response?.id).not.toBe(summary?.id)
      expect(response?.content).toBe("native response")
      dispose()
    }),
  )

  it.live("reconstructs retry history and completion state during reload", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-compaction-reload")
      const branchId = BranchId.make("branch-feed-compaction-reload")
      const retryEnvelope = makeEnvelope(
        1,
        AgentEvent.cases.ProviderRetrying.make({
          sessionId,
          branchId,
          attempt: 1,
          maxAttempts: 3,
          delayMs: 100,
          error: "temporary provider failure",
        }),
      )
      const interruptedEnvelope = makeEnvelope(
        2,
        AgentEvent.cases.TurnCompleted.make({
          sessionId,
          branchId,
          durationMs: 1_000,
          interrupted: true,
        }),
      )
      const compactionEnvelope = makeEnvelope(
        3,
        AgentEvent.cases.MessageReceived.make({
          message: makeCompactionMessage(sessionId, branchId),
        }),
      )
      let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()
      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = {
          session: active,
          client: createMockClient({
            session: {
              getSnapshot: () => Effect.succeed(snapshotFor(sessionId, branchId, 3)),
              events: () =>
                Stream.concat(
                  Stream.make(retryEnvelope, interruptedEnvelope, compactionEnvelope),
                  Stream.never,
                ),
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime: createMockRuntime(),
          log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
          setConnectionIssue: () => {},
          waitForTransportReady: Effect.void,
          applySessionSnapshot: () => {},
          applySessionEvent: () => {},
          applyBufferedSessionEvent: () => {},
        } satisfies FeedClient
        feed = Option.some(
          useSessionFeed(
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
          ),
        )
        return disposeRoot
      })

      yield* waitFor(
        () =>
          Option.isSome(feed) &&
          feed.value.items().some((item) => item._tag === "interruption") &&
          feed.value
            .messages()
            .some((message) => message.metadata?.customType === "model-compaction"),
      )
      if (Option.isNone(feed)) return yield* Effect.die("feed did not initialize")
      const retry = feed.value.items().find((item) => item._tag === "retrying")
      expect(retry?._tag === "retrying" && retry.resolved).toBe(true)
      expect(feed.value.items().some((item) => item._tag === "interruption")).toBe(true)
      expect(feed.value.messages()[0]?.content).toContain("stored summary")
      dispose()
    }),
  )
})
