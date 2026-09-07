/**
 * Session feed — keyed projection of server events into UI state.
 *
 * Takes explicit (sessionId, branchId) and subscribes exactly once per identity.
 * No dependency on client.session() or machine state — immune to the
 * UpdateBypass/UpdateReasoningLevel re-run footgun.
 */

import { batch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { createStore, produce, type SetStoreFunction } from "solid-js/store"
import { Clock, Effect, Equal, Fiber, Option, Predicate, Schedule, Stream } from "effect"
import type {
  ActiveInteraction,
  AgentEvent,
  EventEnvelope,
} from "@gent/core-internal/domain/event.js"
import type { BranchId, SessionId } from "@gent/core-internal/domain/ids.js"
import { projectMessage } from "@gent/core-internal/domain/message.js"
import {
  messagePartImage,
  messagePartReasoning,
  messagePartText,
  messagePartToolCall,
} from "@gent/core-internal/domain/message-part-projection.js"
import {
  extractText,
  extractReasoning,
  extractImages,
  type QueueSnapshot,
  type ProjectedMessage,
  type ToolInteraction,
} from "@gent/sdk"
import type { AssistantSegment, Message, SessionItem } from "../components/message-list"
import type { ToolCall } from "../components/tool-renderers"
import type { SessionEvent } from "../components/session-event-label"
import { formatToolInput } from "../components/message-list-utils"
import { randomId } from "../utils/random-id"
import { formatConnectionIssue } from "../utils/format-error"
import type { ClientLog } from "../utils/client-logger"
import type { ClientSessionValue, ClientTransportValue } from "../client/context"

interface ReconnectOptions<E> {
  readonly label?: string
  readonly log: ClientLog
  readonly onError?: (error: E) => void
  readonly waitForRetry: () => Effect.Effect<void>
}

const reconnectBackoff = Schedule.min([
  Schedule.exponential("1 second", 2),
  Schedule.spaced("30 seconds"),
])

const runWithReconnect = <E, R>(
  effectFactory: () => Effect.Effect<void, E, R>,
  options: ReconnectOptions<E>,
): Effect.Effect<never, never, R> => {
  let attempt = 0
  const label = Option.getOrElse(Option.fromNullishOr(options.label), () => "unknown")
  const log = options.log
  return Effect.gen(function* () {
    attempt++
    log.info("reconnect.attempt", { label, attempt })
    yield* effectFactory().pipe(
      Effect.catchEager((error) =>
        Effect.sync(() => {
          log.warn("reconnect.error", { label, attempt, error: String(error) })
          const onError = Option.fromNullishOr(options.onError)
          if (Option.isSome(onError)) onError.value(error)
        }),
      ),
    )
    log.info("reconnect.stream-ended", { label, attempt })
    log.info("reconnect.wait-for-ready", { label, attempt })
    yield* options.waitForRetry()
    log.info("reconnect.ready", { label, attempt })
  }).pipe(Effect.repeat(reconnectBackoff), Effect.andThen(Effect.never))
}

// ── Types ──

export interface SessionFeedCallbacks {
  onInteraction: (interaction: ActiveInteraction) => void
  onInteractionDismissed: (requestId: string) => void
  onBranchSwitch: (sessionId: SessionId, branchId: BranchId) => void
  onQueueSnapshot: (queue: QueueSnapshot) => void
}

type ToolResultEvent = Extract<AgentEvent, { _tag: "ToolCallSucceeded" | "ToolCallFailed" }>

export interface SessionFeed {
  items: () => SessionItem[]
  messages: () => Message[]
  turnCount: () => number
  // eslint-disable-next-line effect/noNullish -- Solid accessor omits an inactive tool.
  activeTool: () => string | undefined
}

type SessionFeedClient = Pick<ClientSessionValue, "session"> &
  Pick<
    ClientTransportValue,
    | "client"
    | "runtime"
    | "log"
    | "setConnectionIssue"
    | "waitForTransportReady"
    | "applySessionSnapshot"
    | "applySessionEvent"
    | "applyBufferedSessionEvent"
  >

type SessionFeedStore = {
  messages: Message[]
  events: SessionEvent[]
}

const isMessage = Predicate.or(
  Predicate.isTagged("regular-message"),
  Predicate.isTagged("interjection-message"),
)

// ── Build messages from raw ──

const buildSegments = (
  parts: ProjectedMessage["parts"],
  toolInteractions: ReadonlyArray<ToolInteraction>,
): AssistantSegment[] => {
  const segments: AssistantSegment[] = []
  const interactionsById = new Map(
    toolInteractions.map((interaction) => [String(interaction.id), interaction]),
  )
  for (const part of parts) {
    const text = Option.fromNullishOr(messagePartText(part))
    if (Option.isSome(text)) {
      segments.push({ _tag: "text", content: text.value })
      continue
    }

    const reasoning = Option.fromNullishOr(messagePartReasoning(part))
    if (Option.isSome(reasoning)) {
      segments.push({ _tag: "reasoning", content: reasoning.value })
      continue
    }

    const image = Option.fromNullishOr(messagePartImage(part))
    if (Option.isSome(image)) {
      segments.push({ _tag: "image", image: { mediaType: image.value.mediaType } })
      continue
    }

    const tc = Option.fromNullishOr(messagePartToolCall(part))
    if (Option.isSome(tc)) {
      const toolCall = Option.fromNullishOr(interactionsById.get(tc.value.id))
      if (Option.isNone(toolCall)) continue
      segments.push({
        _tag: "tool-call",
        toolCall: toolCall.value,
      })
    }
  }
  return segments
}

const buildMessages = (msgs: readonly ProjectedMessage[]): Message[] => {
  const filteredMsgs = msgs.filter((m) => m.role !== "tool")

  return filteredMsgs.map((m) => {
    const toolCalls = [...m.toolInteractions]
    let toolCallsOption = Option.none<typeof toolCalls>()
    if (toolCalls.length > 0) toolCallsOption = Option.some(toolCalls)
    let segments = Option.none<AssistantSegment[]>()
    if (m.role === "assistant") segments = Option.some(buildSegments(m.parts, m.toolInteractions))
    const message = {
      id: m.id,
      role: m.role,
      content: extractText(m.parts),
      reasoning: extractReasoning(m.parts),
      images: extractImages(m.parts),
      createdAt: m.createdAt.getTime(),
      toolCalls: Option.getOrUndefined(toolCallsOption),
      segments: Option.getOrUndefined(segments),
      metadata: m.metadata,
    }
    if (m._tag === "interjection") {
      return { ...message, _tag: "interjection-message", role: "user" }
    }
    return { ...message, _tag: "regular-message" }
  })
}

const upsertReceivedMessage = (
  setStore: SetStoreFunction<SessionFeedStore>,
  message: ProjectedMessage,
) => {
  const next = buildMessages([message])[0]
  const nextMessage = Option.fromNullishOr(next)
  if (Option.isNone(nextMessage)) return
  setStore(
    produce((draft) => {
      const index = draft.messages.findIndex((candidate) => candidate.id === nextMessage.value.id)
      if (index === -1) {
        draft.messages.push(nextMessage.value)
        return
      }
      draft.messages[index] = nextMessage.value
    }),
  )
}

const createAssistantMessage = (content: string, id: string, createdAt: number): Message => ({
  _tag: "regular-message",
  id,
  role: "assistant",
  content,
  reasoning: "",
  images: [],
  createdAt,
  toolCalls: Option.getOrUndefined(Option.none<ToolCall[]>()),
})

const createInterruptionEvent = (createdAt: number, seq: number): SessionEvent => ({
  _tag: "interruption",
  createdAt,
  seq,
})

const createTurnEndedEvent = (
  durationSeconds: number,
  createdAt: number,
  seq: number,
): SessionEvent => ({
  _tag: "turn-ended",
  durationSeconds,
  createdAt,
  seq,
})

const createRetryingEvent = (
  attempt: number,
  maxAttempts: number,
  delayMs: number,
  createdAt: number,
  seq: number,
): SessionEvent => ({
  _tag: "retrying",
  attempt,
  maxAttempts,
  delayMs,
  resolved: false,
  createdAt,
  seq,
})

const resolveRetryingEvents = (setStore: SetStoreFunction<SessionFeedStore>) => {
  setStore(
    produce((draft) => {
      for (const event of draft.events) {
        if (event._tag === "retrying") event.resolved = true
      }
    }),
  )
}

const createErrorEvent = (error: string, createdAt: number, seq: number): SessionEvent => ({
  _tag: "error",
  error,
  createdAt,
  seq,
})

type MessageWithMetadata = {
  readonly metadata?: {
    readonly customType?: string
  }
}

const isCompactionMessage = (message: MessageWithMetadata): boolean =>
  message.metadata?.customType === "model-compaction"

const appendSessionEvent = (setStore: SetStoreFunction<SessionFeedStore>, event: SessionEvent) => {
  setStore(
    produce((draft) => {
      draft.events.push(event)
    }),
  )
}

const ensureAssistantMessage = (
  setStore: SetStoreFunction<SessionFeedStore>,
  content: string,
  id: string,
  createdAt: number,
) => {
  setStore(
    produce((draft) => {
      const last = draft.messages[draft.messages.length - 1]
      const lastMessage = Option.fromNullishOr(last)
      if (
        Option.isSome(lastMessage) &&
        lastMessage.value.role === "assistant" &&
        !isCompactionMessage(lastMessage.value)
      ) {
        const assistant = lastMessage.value
        assistant.content += content
        // Append to last text segment or create new one
        const segments = Option.fromNullishOr(assistant.segments)
        if (Option.isSome(segments)) {
          const lastSeg = Option.fromNullishOr(segments.value[segments.value.length - 1])
          if (Option.isSome(lastSeg) && lastSeg.value._tag === "text") {
            lastSeg.value.content += content
          } else {
            segments.value.push({ _tag: "text", content })
          }
        }
        return
      }

      const msg = createAssistantMessage(content, id, createdAt)
      msg.segments = [{ _tag: "text", content }]
      draft.messages.push(msg)
    }),
  )
}

const updateLatestToolCall = (
  setStore: SetStoreFunction<SessionFeedStore>,
  updater: (message: Message) => void,
) => {
  setStore(
    produce((draft) => {
      const last = Option.fromNullishOr(draft.messages[draft.messages.length - 1])
      if (Option.isNone(last) || last.value.role !== "assistant") return
      updater(last.value)
    }),
  )
}

const handleToolCallResult = (
  setStore: SetStoreFunction<SessionFeedStore>,
  setActiveTool: (value: Option.Option<string>) => void,
  toolEvent: ToolResultEvent,
) => {
  let status: "error" | "completed" = "completed"
  if (toolEvent._tag === "ToolCallFailed") status = "error"

  setActiveTool(Option.none())
  updateLatestToolCall(setStore, (message) => {
    const toolCalls = Option.fromNullishOr(message.toolCalls)
    if (Option.isNone(toolCalls)) return
    const tc = Option.fromNullishOr(toolCalls.value.find((t) => t.id === toolEvent.toolCallId))
    if (Option.isNone(tc)) return
    tc.value.status = status
    tc.value.summary = toolEvent.summary
    tc.value.output = toolEvent.output
    // Also update the segment's toolCall
    const segments = Option.fromNullishOr(message.segments)
    if (Option.isSome(segments)) {
      const seg = Option.fromNullishOr(
        segments.value.find(
          (s) => s._tag === "tool-call" && s.toolCall.id === toolEvent.toolCallId,
        ),
      )
      if (Option.isSome(seg) && seg.value._tag === "tool-call") {
        seg.value.toolCall.status = tc.value.status
        seg.value.toolCall.summary = tc.value.summary
        seg.value.toolCall.output = tc.value.output
      }
    }
  })
}

const toActiveInteraction = (event: AgentEvent): Option.Option<ActiveInteraction> => {
  if (event._tag === "InteractionPresented") return Option.some(event)
  return Option.none()
}

const isToolResultEvent = Predicate.or(
  Predicate.isTagged("ToolCallSucceeded"),
  Predicate.isTagged("ToolCallFailed"),
)

// ── Hook ──

export function useSessionFeed(
  sessionId: () => SessionId,
  branchId: () => BranchId,
  client: SessionFeedClient,
  cast: <A, E>(effect: Effect.Effect<A, E, never>) => void,
  callbacks: SessionFeedCallbacks,
  initialPrompt?: string,
  canSendPrompt?: () => boolean,
): SessionFeed {
  const [store, setStore] = createStore<{ messages: Message[]; events: SessionEvent[] }>({
    messages: [],
    events: [],
  })
  const [turnCount, setTurnCount] = createSignal(0)
  const [activeTool, setActiveTool] = createSignal<Option.Option<string>>(Option.none())
  const [streamReadyKey, setStreamReadyKey] = createSignal<Option.Option<string>>(Option.none())
  let eventSeq = 0
  const lastSeenEventIdByKey = new Map<string, number>()
  let processedEnvelopeIds = new Set<EventEnvelope["id"]>()

  // Track the active key to guard against stale async writes and reset prompt state
  let currentKey = Option.none<string>()
  const initialPromptValue = Option.fromNullishOr(initialPrompt)
  const canSendPromptValue = Option.fromNullishOr(canSendPrompt)

  const resetProjection = () => {
    setStore({ messages: [], events: [] })
    setTurnCount(0)
    setActiveTool(Option.none())
    setStreamReadyKey(Option.none())
    eventSeq = 0
    processedEnvelopeIds = new Set()
  }

  const items = createMemo((): SessionItem[] => {
    const combined: SessionItem[] = [...store.messages, ...store.events]
    return combined.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
      if (!isMessage(a) && !isMessage(b)) return a.seq - b.seq
      if (a._tag === b._tag) return 0
      if (isMessage(a)) return -1
      return 1
    })
  })

  // Keyed subscription — re-runs only when sessionId:branchId identity changes
  const feedKey = createMemo(() => `${sessionId()}:${branchId()}`)

  // Wait for session to become active before subscribing
  const activeSessionKey = createMemo(
    (): Option.Option<string> => {
      const session = Option.fromNullishOr(client.session())
      if (Option.isNone(session)) return Option.none()
      return Option.some(`${session.value.sessionId}:${session.value.branchId}`)
    },
    Option.none(),
    { equals: Equal.equals },
  )

  // Track which prompts have been sent (keyed by feedKey to handle re-navigation)
  const sentPrompts = new Set<string>()
  const canSendPromptNow = () =>
    Option.getOrElse(
      Option.map(canSendPromptValue, (check) => check()),
      () => true,
    )

  createEffect(
    on(
      [activeSessionKey, feedKey, streamReadyKey, canSendPromptNow],
      ([active, key, readyKey, canSend]) => {
        if (Option.isNone(initialPromptValue) || initialPromptValue.value === "") return
        if (Option.isNone(active) || active.value !== key) return
        if (Option.isNone(readyKey) || readyKey.value !== key || !canSend) return
        if (sentPrompts.has(key)) return

        const session = sessionId()
        const branch = branchId()
        sentPrompts.add(key)
        client.log.info("feed.sendInitialPrompt", {
          sessionId: session,
          branchId: branch,
        })
        client.runtime.cast(
          client.client.message
            .send({
              sessionId: session,
              branchId: branch,
              content: initialPromptValue.value,
            })
            .pipe(
              Effect.catchEager((err) =>
                Effect.sync(() => {
                  if (Option.isNone(currentKey) || currentKey.value !== key) return
                  client.setConnectionIssue(formatConnectionIssue(err))
                }),
              ),
            ),
        )
      },
    ),
  )

  createEffect(
    on([activeSessionKey, feedKey], ([active, key]) => {
      if (Option.isNone(active) || active.value !== key) return

      // Reset all projection state on identity change
      if (Option.isNone(currentKey) || currentKey.value !== key) {
        resetProjection()
        currentKey = Option.some(key)
      }

      const branch = branchId()
      const session = sessionId()
      client.log.info("feed.activate", { key })

      const streamFiber = client.runtime.fork(
        Effect.scoped(
          runWithReconnect(
            () =>
              Effect.gen(function* () {
                client.log.info("feed.snapshot.fetch", { key })
                const snapshot = yield* client.client.session.getSnapshot({
                  sessionId: session,
                  branchId: branch,
                })
                // Pending-interaction hydration on session entry now comes from
                // event-stream replay via the `after` cursor below — there is no
                // more privileged extension-snapshot side-channel. If the
                // interaction extension wants explicit hydration, it should
                // expose a typed query the client polls on session entry.

                client.log.info("feed.snapshot.hydrated", {
                  key,
                  messageCount: snapshot.messages.length,
                  lastEventId: snapshot.lastEventId,
                })

                const snapshotApplied = yield* Effect.sync(() => {
                  if (Option.isNone(currentKey) || currentKey.value !== key) return false
                  client.applySessionSnapshot(snapshot)
                  callbacks.onQueueSnapshot(snapshot.runtime.queue)
                  setStore("messages", buildMessages(snapshot.messages))
                  return true
                })
                if (!snapshotApplied) return yield* Effect.never

                const after = Option.getOrElse(
                  Option.fromNullishOr(lastSeenEventIdByKey.get(key)),
                  () => 0,
                )

                const eventStream = client.client.session.events({
                  sessionId: session,
                  branchId: branch,
                  after,
                })

                client.log.info("feed.stream.open", { key, after })
                const eventsFiber = yield* eventStream.pipe(
                  Stream.runForEach((envelope) =>
                    Effect.gen(function* () {
                      if (Option.isNone(currentKey) || currentKey.value !== key) return
                      client.setConnectionIssue(Option.getOrNull(Option.none()))
                      yield* processEnvelope(
                        envelope,
                        branch,
                        key,
                        Option.fromNullishOr(snapshot.lastEventId),
                      )
                    }),
                  ),
                  Effect.forkScoped,
                )
                const runtimeFiber = yield* client.client.session
                  .watchRuntime({
                    sessionId: session,
                    branchId: branch,
                  })
                  .pipe(
                    Stream.runForEach((next) =>
                      Effect.sync(() => {
                        if (Option.isNone(currentKey) || currentKey.value !== key) return
                        client.setConnectionIssue(Option.getOrNull(Option.none()))
                        if (next._tag === "Idle") resolveRetryingEvents(setStore)
                        callbacks.onQueueSnapshot(next.queue)
                      }),
                    ),
                    Effect.forkScoped,
                  )

                yield* Effect.sync(() => {
                  if (Option.isNone(currentKey) || currentKey.value !== key) return
                  setStreamReadyKey(Option.some(key))
                })

                return yield* Effect.raceFirst(Fiber.join(eventsFiber), Fiber.join(runtimeFiber))
              }),
            {
              label: "feed.events",
              log: client.log,
              onError: (err) => {
                if (Option.isNone(currentKey) || currentKey.value !== key) return
                client.log.error("feed.error", {
                  key,
                  error: formatConnectionIssue(err),
                })
                client.setConnectionIssue(formatConnectionIssue(err))
              },
              waitForRetry: () => client.waitForTransportReady,
            },
          ),
        ),
      )

      onCleanup(() => {
        client.log.info("feed.cleanup", { key })
        client.runtime.cast(Fiber.interrupt(streamFiber))
      })
    }),
  )

  const processEnvelope = (
    envelope: EventEnvelope,
    branch: BranchId,
    key: string,
    snapshotLastEventId: Option.Option<number>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      // Drop events if identity changed
      if (Option.isNone(currentKey) || currentKey.value !== key) return
      if (processedEnvelopeIds.has(envelope.id)) {
        client.log.debug("feed.event.duplicate", { key, eventId: envelope.id })
        return
      }
      processedEnvelopeIds.add(envelope.id)
      const lastSeen = Option.getOrElse(
        Option.fromNullishOr(lastSeenEventIdByKey.get(key)),
        () => 0,
      )
      lastSeenEventIdByKey.set(key, Math.max(lastSeen, envelope.id))
      if (Option.isSome(snapshotLastEventId) && envelope.id <= snapshotLastEventId.value) {
        // Historical navigation must not replace the branch selected for this snapshot.
        if (envelope.event._tag === "BranchSwitched") return
        client.applyBufferedSessionEvent(envelope)
        processBufferedEvent(envelope, key)
        return
      }
      const event = envelope.event
      if (event._tag === "BranchSwitched") {
        // Changing client identity stops this subscription. Route before cleanup.
        batch(() => {
          client.applySessionEvent(envelope)
          if (event.toBranchId !== branch) {
            setStore({ messages: [], events: [] })
            callbacks.onBranchSwitch(event.sessionId, event.toBranchId)
          }
        })
        return
      }
      client.applySessionEvent(envelope)
      yield* processEvent(envelope.event, branch, key)
    })

  const processBufferedEvent = (envelope: EventEnvelope, key: string) => {
    if (Option.isNone(currentKey) || currentKey.value !== key) return
    const event = envelope.event

    if (event._tag === "MessageReceived") {
      if (isCompactionMessage(event.message)) {
        upsertReceivedMessage(setStore, projectMessage(event.message, []))
      }
      return
    }

    if (event._tag === "ProviderRetrying") {
      appendSessionEvent(
        setStore,
        createRetryingEvent(
          event.attempt,
          event.maxAttempts,
          event.delayMs,
          envelope.createdAt,
          eventSeq++,
        ),
      )
      return
    }

    if (event._tag === "StreamStarted") {
      resolveRetryingEvents(setStore)
      return
    }

    if (event._tag === "TurnCompleted") {
      resolveRetryingEvents(setStore)
      const durationSeconds = Math.round(event.durationMs / 1000)
      if (event.interrupted === true) {
        appendSessionEvent(setStore, createInterruptionEvent(envelope.createdAt, eventSeq++))
      } else if (durationSeconds > 0) {
        appendSessionEvent(
          setStore,
          createTurnEndedEvent(durationSeconds, envelope.createdAt, eventSeq++),
        )
      }
      return
    }

    if (event._tag === "ErrorOccurred") {
      resolveRetryingEvents(setStore)
      appendSessionEvent(setStore, createErrorEvent(event.error, envelope.createdAt, eventSeq++))
      return
    }

    // Snapshot data already contains message, lifecycle, and metrics state.
    // Buffered replay only hydrates event-only UI state that is absent from the
    // snapshot, such as pending interactions.

    if (event._tag === "InteractionResolved") {
      callbacks.onInteractionDismissed(event.requestId)
      return
    }

    const interaction = toActiveInteraction(event)
    if (Option.isSome(interaction)) callbacks.onInteraction(interaction.value)
  }

  const processEvent = (event: AgentEvent, branch: BranchId, key: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (Option.isNone(currentKey) || currentKey.value !== key) return
      client.log.debug("feed.event", { key, tag: event._tag })

      if (event._tag === "InteractionResolved") {
        callbacks.onInteractionDismissed(event.requestId)
        return
      }

      const interaction = toActiveInteraction(event)
      if (Option.isSome(interaction)) {
        callbacks.onInteraction(interaction.value)
        return
      }

      if (isToolResultEvent(event)) {
        handleToolCallResult(setStore, setActiveTool, event)
        return
      }

      switch (event._tag) {
        case "MessageReceived":
          if (event.message.role === "user" || isCompactionMessage(event.message)) {
            upsertReceivedMessage(setStore, projectMessage(event.message, []))
          }
          break

        case "StreamStarted":
          resolveRetryingEvents(setStore)
          setTurnCount((n) => n + 1)
          setActiveTool(Option.none())
          ensureAssistantMessage(setStore, "", yield* randomId, yield* Clock.currentTimeMillis)
          break

        case "StreamChunk":
          ensureAssistantMessage(
            setStore,
            event.chunk,
            yield* randomId,
            yield* Clock.currentTimeMillis,
          )
          break

        case "TurnCompleted": {
          resolveRetryingEvents(setStore)
          const durationSeconds = Math.round(event.durationMs / 1000)
          const createdAt = yield* Clock.currentTimeMillis
          if (event.interrupted === true) {
            appendSessionEvent(setStore, createInterruptionEvent(createdAt, eventSeq++))
          } else if (durationSeconds > 0) {
            appendSessionEvent(
              setStore,
              createTurnEndedEvent(durationSeconds, createdAt, eventSeq++),
            )
          }
          break
        }

        case "ToolCallStarted": {
          const inputSummary = formatToolInput(event.toolName, event.input)
          let activeToolLabel = event.toolName
          if (inputSummary.length > 0) activeToolLabel = `${event.toolName}(${inputSummary})`
          setActiveTool(Option.some(activeToolLabel))
          const toolCall = {
            id: event.toolCallId,
            toolName: event.toolName,
            status: "running",
            input: event.input,
            summary: Option.getOrUndefined(Option.none<string>()),
            output: Option.getOrUndefined(Option.none<string>()),
          } satisfies ToolCall
          updateLatestToolCall(setStore, (message) => {
            let toolCalls = Option.fromNullishOr(message.toolCalls)
            // Cold interaction resume starts the same call again, not a new call.
            if (
              Option.isSome(toolCalls) &&
              toolCalls.value.some((call) => call.id === event.toolCallId)
            ) {
              return
            }
            if (Option.isNone(toolCalls)) {
              message.toolCalls = []
              toolCalls = Option.fromNullishOr(message.toolCalls)
            }
            if (Option.isSome(toolCalls)) toolCalls.value.push(toolCall)
            // Also push to segments for interleaved rendering
            let segments = Option.fromNullishOr(message.segments)
            if (Option.isNone(segments)) {
              message.segments = []
              segments = Option.fromNullishOr(message.segments)
            }
            if (Option.isSome(segments)) segments.value.push({ _tag: "tool-call", toolCall })
          })
          break
        }

        case "ProviderRetrying":
          resolveRetryingEvents(setStore)
          appendSessionEvent(
            setStore,
            createRetryingEvent(
              event.attempt,
              event.maxAttempts,
              event.delayMs,
              yield* Clock.currentTimeMillis,
              eventSeq++,
            ),
          )
          break

        case "ErrorOccurred":
          resolveRetryingEvents(setStore)
          client.log.error("sessionFeed.error", { error: event.error, seq: eventSeq })
          appendSessionEvent(
            setStore,
            createErrorEvent(event.error, yield* Clock.currentTimeMillis, eventSeq++),
          )
          break
      }
    })

  return {
    items,
    messages: () => store.messages,
    turnCount,
    activeTool: () => Option.getOrUndefined(activeTool()),
  }
}
