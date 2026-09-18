/**
 * Session feed — keyed projection of server events into UI state.
 *
 * Takes explicit (sessionId, branchId) and subscribes exactly once per identity.
 * No dependency on client.session() or machine state — immune to the
 * UpdateBypass/UpdateSettings re-run footgun.
 */

import { batch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { createStore, produce, type SetStoreFunction } from "solid-js/store"
import { Clock, Effect, Equal, Fiber, Match, Option, Predicate, Schedule, Stream } from "effect"
import {
  assistantMessageIdForTurn,
  projectMessage,
  type ActiveInteraction,
  type AgentEvent,
  type BranchId,
  type EventEnvelope,
  type SessionId,
} from "@gent/core/protocol"
import {
  extractText,
  extractReasoning,
  extractImages,
  type MessageSegment,
  type QueueSnapshot,
  type ProjectedMessage,
  type ToolInteraction,
} from "@gent/sdk"
import type { AssistantSegment, Message, SessionItem } from "../components/message-list"
import type { ToolCall } from "../components/tool-renderers"
import { addStep, emptyTurnSteps, type SessionEvent } from "../components/session-event-label"
import { formatConnectionIssue, formatToolInput, randomId } from "../utils"
import type { ClientLog } from "../utils/client-logger"
import type { ClientContextValue } from "../client/context"
import type { StartupPrompt } from "../session-shell"

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

interface SessionFeedCallbacks {
  onInteraction: (interaction: ActiveInteraction) => void
  onInteractionDismissed: (requestId: string) => void
  onBranchSwitch: (sessionId: SessionId, branchId: BranchId) => void
  onQueueSnapshot: (queue: QueueSnapshot) => void
}

type ToolResultEvent = Extract<AgentEvent, { _tag: "ToolCallSucceeded" | "ToolCallFailed" }>

interface SessionFeed {
  items: () => SessionItem[]
  messages: () => Message[]
  turnCount: () => number
  // eslint-disable-next-line effect/noNullish -- Solid accessor omits an inactive tool.
  activeTool: () => string | undefined
}

type SessionFeedClient = Pick<
  ClientContextValue,
  | "sessionIdentity"
  | "client"
  | "runtime"
  | "log"
  | "setConnectionIssue"
  | "waitForTransportReady"
  | "applySessionRuntime"
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

/** Widen the projected segments with the live tool payloads they name. */
const buildSegments = (
  projected: ReadonlyArray<MessageSegment>,
  toolInteractions: ReadonlyArray<ToolInteraction>,
): AssistantSegment[] => {
  const interactionsById = new Map(
    toolInteractions.map((interaction) => [String(interaction.id), interaction]),
  )
  return projected.flatMap((segment) =>
    Match.value(segment).pipe(
      Match.tagsExhaustive({
        Text: (value): AssistantSegment[] => [{ _tag: "text", content: value.content }],
        Reasoning: (value): AssistantSegment[] => [{ _tag: "reasoning", content: value.content }],
        Image: (value): AssistantSegment[] => [
          { _tag: "image", image: { mediaType: value.mediaType } },
        ],
        ToolCall: (value): AssistantSegment[] => {
          const toolCall = Option.fromNullishOr(interactionsById.get(String(value.toolCallId)))
          if (Option.isNone(toolCall)) return []
          return [{ _tag: "tool-call", toolCall: toolCall.value }]
        },
      }),
    ),
  )
}

const buildMessages = (msgs: readonly ProjectedMessage[]): Message[] => {
  const filteredMsgs = msgs.filter((m) => m.role !== "tool")

  return filteredMsgs.map((m) => {
    const toolCalls = [...m.toolInteractions]
    let toolCallsOption = Option.none<typeof toolCalls>()
    if (toolCalls.length > 0) toolCallsOption = Option.some(toolCalls)
    let segments = Option.none<AssistantSegment[]>()
    if (m.role === "assistant")
      segments = Option.some(buildSegments(m.segments, m.toolInteractions))
    if (m._tag === "interjection")
      return {
        _tag: "interjection-message",
        id: m.id,
        role: "user",
        content: extractText(m.parts),
        reasoning: extractReasoning(m.parts),
        images: extractImages(m.parts),
        createdAt: m.createdAt.getTime(),
        toolCalls: Option.getOrUndefined(toolCallsOption),
        segments: Option.getOrUndefined(segments),
        metadata: m.metadata,
      }
    return {
      _tag: "regular-message",
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

const resolveRetryingEvents = (setStore: SetStoreFunction<SessionFeedStore>) => {
  setStore(
    produce((draft) => {
      for (const event of draft.events) {
        if (event._tag === "retrying") event.resolved = true
      }
    }),
  )
}

type MessageWithMetadata = {
  readonly metadata?: {
    readonly customType?: string
    readonly hidden?: boolean
  }
}

const isStandaloneMessage = (message: MessageWithMetadata): boolean =>
  message.metadata?.hidden === true

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
      const last = draft.messages.find((message) => message.id === id)
      const lastMessage = Option.fromNullishOr(last)
      if (
        Option.isSome(lastMessage) &&
        lastMessage.value.role === "assistant" &&
        !isStandaloneMessage(lastMessage.value)
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

      draft.messages.push({
        _tag: "regular-message",
        id,
        role: "assistant",
        content,
        reasoning: "",
        images: [],
        createdAt,
        toolCalls: Option.getOrUndefined(Option.none<ToolCall[]>()),
        segments: [{ _tag: "text", content }],
        metadata: Option.getOrUndefined(Option.none<Message["metadata"]>()),
      })
    }),
  )
}

const updateToolMessage = (
  setStore: SetStoreFunction<SessionFeedStore>,
  updater: (message: Message) => void,
  matches: (message: Message) => boolean,
) => {
  setStore(
    produce((draft) => {
      const last = Option.fromNullishOr(
        draft.messages.findLast((message) => !isStandaloneMessage(message) && matches(message)),
      )
      if (Option.isNone(last) || last.value.role !== "assistant") return
      updater(last.value)
    }),
  )
}

/** Find a tool call by id among direct calls and cell-admitted operations. */
const locateToolCall = (
  calls: Option.Option<ReadonlyArray<ToolCall>>,
  toolCallId: string,
): Option.Option<ToolCall> => {
  if (Option.isNone(calls)) return Option.none()
  for (const call of calls.value) {
    if (call.id === toolCallId) return Option.some(call)
    const nested = locateToolCall(Option.fromNullishOr(call.operations), toolCallId)
    if (Option.isSome(nested)) return nested
  }
  return Option.none()
}

/** The tool calls a message shows inline, in segment order. */
const segmentToolCalls = (message: Message): Option.Option<ReadonlyArray<ToolCall>> =>
  Option.map(Option.fromNullishOr(message.segments), (segments) =>
    segments.flatMap((segment) => {
      if (segment._tag === "tool-call") return [segment.toolCall]
      return []
    }),
  )

/** Attach a cell-admitted call under its parent instead of the transcript top level. */
const attachOperation = (
  calls: Option.Option<ReadonlyArray<ToolCall>>,
  parentToolCallId: string,
  operation: ToolCall,
) => {
  const parent = locateToolCall(calls, parentToolCallId)
  if (Option.isNone(parent)) return
  let operations = Option.fromNullishOr(parent.value.operations)
  if (Option.isNone(operations)) {
    parent.value.operations = []
    operations = Option.fromNullishOr(parent.value.operations)
  }
  if (Option.isNone(operations)) return
  if (operations.value.some((call) => call.id === operation.id)) return
  operations.value.push(operation)
}

const applyToolCallResult = (
  call: Option.Option<ToolCall>,
  status: ToolCall["status"],
  toolEvent: ToolResultEvent,
  completedAt: number,
) => {
  if (Option.isNone(call)) return
  call.value.status = status
  call.value.summary = toolEvent.summary
  call.value.output = toolEvent.output
  if (Predicate.isNotUndefined(call.value.startedAt)) {
    call.value.durationMs = Math.max(0, completedAt - call.value.startedAt)
  }
}

const handleToolCallResult = (
  setStore: SetStoreFunction<SessionFeedStore>,
  setActiveTool: (value: Option.Option<string>) => void,
  toolEvent: ToolResultEvent,
  completedAt: number,
) => {
  let status: "error" | "completed" = "completed"
  if (toolEvent._tag === "ToolCallFailed") status = "error"

  if (Predicate.isUndefined(toolEvent.parentToolCallId)) setActiveTool(Option.none())
  updateToolMessage(
    setStore,
    (message) => {
      applyToolCallResult(
        locateToolCall(Option.fromNullishOr(message.toolCalls), toolEvent.toolCallId),
        status,
        toolEvent,
        completedAt,
      )
      // The same call also renders inline as a segment.
      applyToolCallResult(
        locateToolCall(segmentToolCalls(message), toolEvent.toolCallId),
        status,
        toolEvent,
        completedAt,
      )
    },
    (message) =>
      Option.isSome(locateToolCall(Option.fromNullishOr(message.toolCalls), toolEvent.toolCallId)),
  )
}

const toActiveInteraction = (event: AgentEvent): Option.Option<ActiveInteraction> => {
  if (event._tag === "InteractionPresented") return Option.some(event)
  return Option.none()
}

/**
 * Events whose effect the session snapshot already carries. Replay skips them
 * so a reload does not re-count turns or re-append settled tool payloads.
 */
const isSnapshotHeldEvent = Predicate.or(
  Predicate.isTagged("StreamChunk"),
  Predicate.or(
    Predicate.isTagged("ToolCallStarted"),
    Predicate.or(Predicate.isTagged("ToolCallSucceeded"), Predicate.isTagged("ToolCallFailed")),
  ),
)

const isToolResultEvent = Predicate.or(
  Predicate.isTagged("ToolCallSucceeded"),
  Predicate.isTagged("ToolCallFailed"),
)

type ToolStartedEvent = Extract<AgentEvent, { _tag: "ToolCallStarted" }>

/** The status-line label for a running tool: its name plus a short input. */
const activeToolLabel = (event: ToolStartedEvent): string => {
  const inputSummary = formatToolInput(event.toolName, event.input)
  if (inputSummary.length === 0) return event.toolName
  return `${event.toolName}(${inputSummary})`
}

/** Put a new call on its owning message, or under the cell that admitted it. */
const startToolCall = (
  setStore: SetStoreFunction<SessionFeedStore>,
  event: ToolStartedEvent,
  startedAt: number,
) => {
  const toolCall = {
    id: event.toolCallId,
    toolName: event.toolName,
    status: "running",
    input: event.input,
    summary: Option.getOrUndefined(Option.none<string>()),
    output: Option.getOrUndefined(Option.none<string>()),
    startedAt,
  } satisfies ToolCall
  const parentToolCallId = Option.fromUndefinedOr(event.parentToolCallId)
  updateToolMessage(
    setStore,
    (message) => {
      if (Option.isSome(parentToolCallId)) {
        attachOperation(Option.fromNullishOr(message.toolCalls), parentToolCallId.value, toolCall)
        attachOperation(segmentToolCalls(message), parentToolCallId.value, { ...toolCall })
        return
      }
      const existing = Option.fromNullishOr(message.toolCalls)
      // Cold interaction resume starts the same call again, not a new call.
      if (Option.isSome(existing) && existing.value.some((call) => call.id === event.toolCallId))
        return
      if (Option.isNone(existing)) message.toolCalls = []
      message.toolCalls?.push(toolCall)
      // Also push to segments for interleaved rendering.
      if (Option.isNone(Option.fromNullishOr(message.segments))) message.segments = []
      message.segments?.push({ _tag: "tool-call", toolCall })
    },
    (message) => {
      if (Option.isSome(parentToolCallId)) {
        return Option.isSome(
          locateToolCall(Option.fromNullishOr(message.toolCalls), parentToolCallId.value),
        )
      }
      // A late receipt names the message it belongs to; it must not land on a newer one.
      if (Predicate.isNotUndefined(event.assistantMessageId))
        return message.id === event.assistantMessageId
      return true
    },
  )
}

/** A send that fails is tried again four times, from 200 ms, before the shell takes the prompt back. */
const STARTUP_PROMPT_RETRY = { schedule: Schedule.exponential("200 millis"), times: 4 }

// ── Hook ──

export function useSessionFeed(
  sessionId: () => SessionId,
  branchId: () => BranchId,
  client: SessionFeedClient,
  cast: <A, E>(effect: Effect.Effect<A, E, never>) => void,
  callbacks: SessionFeedCallbacks,
  /** Read at send time, so the owner decides whether the prompt is still unsent. */
  takeInitialPrompt?: () => Option.Option<StartupPrompt>,
  canSendPrompt?: () => boolean,
): SessionFeed {
  const [store, setStore] = createStore<{ messages: Message[]; events: SessionEvent[] }>({
    messages: [],
    events: [],
  })
  const [turnCount, setTurnCount] = createSignal(0)
  const [activeTool, setActiveTool] = createSignal<Option.Option<string>>(Option.none())
  const [streamReadyKey, setStreamReadyKey] = createSignal<Option.Option<string>>(Option.none())
  let streamMessageId = Option.none<string>()
  let eventSeq = 0
  // The steps of the turn in flight; TurnCompleted spends them on its label.
  let turnSteps = emptyTurnSteps
  const takeTurnSteps = () => {
    const steps = turnSteps
    turnSteps = emptyTurnSteps
    return steps
  }
  /**
   * Every event that needs no streaming state: a message, a turn boundary, a
   * tool start, or a transcript notice.
   */
  const applySettledEvent = (
    event: AgentEvent,
    receivedAt: number,
    stampedAt: number,
    live: boolean,
  ) => {
    switch (event._tag) {
      case "MessageReceived":
        // A replayed message is already in the snapshot unless it is standalone.
        if (isStandaloneMessage(event.message) || (live && event.message.role === "user")) {
          upsertReceivedMessage(setStore, projectMessage(event.message, []))
        }
        return

      case "StreamEnded":
        streamMessageId = Option.none()
        turnSteps = addStep(turnSteps, event)
        return

      case "TurnCompleted":
        streamMessageId = Option.none()
        resolveRetryingEvents(setStore)
        appendTurnEndRow(event, stampedAt)
        return

      case "ToolCallStarted":
        setActiveTool(Option.some(activeToolLabel(event)))
        startToolCall(setStore, event, receivedAt)
        return

      case "ProviderRetrying":
        if (live) resolveRetryingEvents(setStore)
        appendSessionEvent(setStore, {
          _tag: "retrying",
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          resolved: false,
          createdAt: stampedAt,
          seq: eventSeq++,
        })
        return

      case "ErrorOccurred":
        resolveRetryingEvents(setStore)
        if (live) client.log.error("sessionFeed.error", { error: event.error, seq: eventSeq })
        appendSessionEvent(setStore, {
          _tag: "error",
          error: event.error,
          createdAt: stampedAt,
          seq: eventSeq++,
        })
        return

      default:
        return
    }
  }

  /** Hand an interaction event to the composer. Reports whether it consumed the event. */
  const routeInteraction = (event: AgentEvent): boolean => {
    if (event._tag === "InteractionResolved") {
      callbacks.onInteractionDismissed(event.requestId)
      return true
    }
    const interaction = toActiveInteraction(event)
    if (Option.isNone(interaction)) return false
    callbacks.onInteraction(interaction.value)
    return true
  }

  /**
   * Start the message this turn's answer belongs to. The durable input id and
   * step name it, so a later chunk or receipt finds the same owner.
   */
  const openStreamedAnswer = (
    event: Extract<AgentEvent, { _tag: "StreamStarted" }>,
    stampedAt: number,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const id = yield* Option.fromUndefinedOr(event.messageId).pipe(
        Option.match({
          onNone: () => randomId,
          onSome: (inputId) => Effect.succeed(assistantMessageIdForTurn(inputId, event.step)),
        }),
      )
      streamMessageId = Option.some(id)
      ensureAssistantMessage(setStore, "", id, stampedAt)
    })

  /** A chunk extends the open answer. A history stream without one gets a local id. */
  const appendStreamedChunk = (chunk: string, stampedAt: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      const id = yield* streamMessageId.pipe(
        Option.match({ onNone: () => randomId, onSome: Effect.succeed }),
      )
      streamMessageId = Option.some(id)
      ensureAssistantMessage(setStore, chunk, id, stampedAt)
    })

  /** The transcript row that closes a turn: an interruption or a duration. */
  const appendTurnEndRow = (
    event: Extract<AgentEvent, { _tag: "TurnCompleted" }>,
    stampedAt: number,
  ) => {
    const steps = takeTurnSteps()
    if (event.interrupted === true) {
      appendSessionEvent(setStore, { _tag: "interruption", createdAt: stampedAt, seq: eventSeq++ })
      return
    }
    const durationSeconds = Math.round(event.durationMs / 1000)
    // A turn shorter than a second gets no row.
    if (durationSeconds <= 0) return
    appendSessionEvent(setStore, {
      _tag: "turn-ended",
      durationSeconds,
      steps,
      createdAt: stampedAt,
      seq: eventSeq++,
    })
  }
  const lastSeenEventIdByKey = new Map<string, number>()
  let processedEnvelopeIds = new Set<EventEnvelope["id"]>()

  // Track the active key to guard against stale async writes and reset prompt state
  let currentKey = Option.none<string>()
  const takeInitialPromptValue = Option.fromNullishOr(takeInitialPrompt)
  const canSendPromptValue = Option.fromNullishOr(canSendPrompt)

  const resetProjection = () => {
    setStore({ messages: [], events: [] })
    setTurnCount(0)
    setActiveTool(Option.none())
    setStreamReadyKey(Option.none())
    streamMessageId = Option.none()
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
    (): Option.Option<string> =>
      Option.map(
        client.sessionIdentity(),
        (identity) => `${identity.sessionId}:${identity.branchId}`,
      ),
    Option.none(),
    { equals: Equal.equals },
  )

  const canSendPromptNow = () =>
    Option.getOrElse(
      Option.map(canSendPromptValue, (check) => check()),
      () => true,
    )

  createEffect(
    on(
      [activeSessionKey, feedKey, streamReadyKey, canSendPromptNow],
      ([active, key, readyKey, canSend]) => {
        if (Option.isNone(active) || active.value !== key) return
        if (Option.isNone(readyKey) || readyKey.value !== key || !canSend) return
        const startup = Option.flatMap(takeInitialPromptValue, (take) => take())
        if (Option.isNone(startup)) return
        const prompt = startup.value
        if (prompt.content === "") return

        const session = sessionId()
        const branch = branchId()
        client.log.info("feed.sendInitialPrompt", {
          sessionId: session,
          branchId: branch,
        })
        client.runtime.cast(
          Effect.gen(function* () {
            const requestId = yield* Option.match(prompt.requestId, {
              onNone: () => randomId,
              onSome: Effect.succeed,
            })
            yield* client.client.message
              .send({ sessionId: session, branchId: branch, content: prompt.content, requestId })
              .pipe(
                // One request id for every attempt, so an attempt that landed
                // with a lost reply cannot run the prompt a second time.
                Effect.retry(STARTUP_PROMPT_RETRY),
                Effect.andThen(Effect.sync(() => prompt.settle(true, requestId))),
                Effect.catchEager((err) =>
                  Effect.sync(() => {
                    // The shell holds the prompt again; the next ready stream sends it.
                    prompt.settle(false, requestId)
                    if (Option.isNone(currentKey) || currentKey.value !== key) return
                    client.setConnectionIssue(formatConnectionIssue(err))
                  }),
                ),
              )
          }),
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
                        client.applySessionRuntime({
                          sessionId: session,
                          branchId: branch,
                          runtime: next,
                        })
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
      if (envelope.event._tag === "StreamSynchronized") {
        // Replay is complete; later envelopes are live. The marker shares the cursor id
        // with the last replayed event, so it must not enter the duplicate set.
        const lastSeen = Option.getOrElse(
          Option.fromNullishOr(lastSeenEventIdByKey.get(key)),
          () => 0,
        )
        lastSeenEventIdByKey.set(key, Math.max(lastSeen, envelope.event.lastEventId))
        client.log.info("feed.stream.synchronized", {
          key,
          lastEventId: envelope.event.lastEventId,
        })
        return
      }
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
        yield* processEvent(envelope, key, "replay")
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
      yield* processEvent(envelope, key, "live")
    })

  /**
   * One event handler for both passes.
   *
   * `replay` covers envelopes at or before the snapshot cursor: the snapshot
   * already holds their message, tool, and metric state, so replay only
   * rebuilds the event-only UI rows and stamps them with the recorded time.
   * `live` covers everything after it and stamps rows with the current time so
   * they sort after the snapshot's own rows.
   */
  const processEvent = (
    envelope: EventEnvelope,
    key: string,
    pass: "replay" | "live",
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const event = envelope.event
      if (Option.isNone(currentKey) || currentKey.value !== key) return
      const live = pass === "live"
      if (live) client.log.debug("feed.event", { key, tag: event._tag })
      // A replayed row keeps the time it happened; a live row takes the clock.
      let stampedAt = envelope.createdAt
      if (live) stampedAt = yield* Clock.currentTimeMillis

      // Interactions belong to the composer, not the transcript.
      if (routeInteraction(event)) return

      // The snapshot carries every settled message, tool result, and metric.
      if (!live && isSnapshotHeldEvent(event)) return

      if (isToolResultEvent(event)) {
        handleToolCallResult(setStore, setActiveTool, event, envelope.createdAt)
        return
      }

      switch (event._tag) {
        case "StreamStarted":
          resolveRetryingEvents(setStore)
          if (!live) break
          setTurnCount((n) => n + 1)
          setActiveTool(Option.none())
          yield* openStreamedAnswer(event, stampedAt)
          break

        case "StreamChunk":
          yield* appendStreamedChunk(event.chunk, stampedAt)
          break

        default:
          applySettledEvent(event, envelope.createdAt, stampedAt, live)
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
