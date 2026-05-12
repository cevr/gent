/**
 * Session feed — keyed projection of server events into UI state.
 *
 * Takes explicit (sessionId, branchId) and subscribes exactly once per identity.
 * No dependency on client.session() or machine state — immune to the
 * UpdateBypass/UpdateReasoningLevel re-run footgun.
 */

import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { createStore, produce, type SetStoreFunction } from "solid-js/store"
import { Clock, Effect, Fiber, Random, Schedule, Stream } from "effect"
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
import type { SessionEvent } from "../components/session-event-label"
import { formatToolInput } from "../components/message-list-utils"
import { formatConnectionIssue } from "../utils/format-error"
import type { ClientLog } from "../utils/client-logger"
import type { ClientSessionValue, ClientTransportValue } from "../client/context"

interface ReconnectOptions<E> {
  readonly label?: string
  readonly log: ClientLog
  readonly onError?: (error: E) => void
  readonly waitForRetry: () => Effect.Effect<void>
}

const reconnectBackoff = Schedule.exponential("1 second", 2).pipe(
  Schedule.either(Schedule.spaced("30 seconds")),
)

const runWithReconnect = <E, R>(
  effectFactory: () => Effect.Effect<void, E, R>,
  options: ReconnectOptions<E>,
): Effect.Effect<never, never, R> => {
  let attempt = 0
  const label = options.label ?? "unknown"
  const log = options.log
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- TUI adapter narrows heterogeneous framework value shape
  return Effect.gen(function* () {
    attempt++
    log.info("reconnect.attempt", { label, attempt })
    yield* effectFactory().pipe(
      Effect.catchEager((error) =>
        Effect.sync(() => {
          log.warn("reconnect.error", { label, attempt, error: String(error) })
          options.onError?.(error)
        }),
      ),
    )
    log.info("reconnect.stream-ended", { label, attempt })
    log.info("reconnect.wait-for-ready", { label, attempt })
    yield* options.waitForRetry()
    log.info("reconnect.ready", { label, attempt })
  }).pipe(Effect.repeat(reconnectBackoff)) as Effect.Effect<never, never, R>
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
  activeTool: () => string | undefined
  clear: () => void
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

const isMessage = (item: SessionItem): item is Message =>
  item._tag === "regular-message" || item._tag === "interjection-message"

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
    const text = messagePartText(part)
    if (text !== undefined) {
      segments.push({ _tag: "text", content: text })
      continue
    }

    const reasoning = messagePartReasoning(part)
    if (reasoning !== undefined) {
      segments.push({ _tag: "reasoning", content: reasoning })
      continue
    }

    const image = messagePartImage(part)
    if (image !== undefined) {
      segments.push({ _tag: "image", image: { mediaType: image.mediaType } })
      continue
    }

    const tc = messagePartToolCall(part)
    if (tc !== undefined) {
      const toolCall = interactionsById.get(tc.id)
      if (toolCall === undefined) continue
      segments.push({
        _tag: "tool-call",
        toolCall,
      })
    }
  }
  return segments
}

const buildMessages = (msgs: readonly ProjectedMessage[]): Message[] => {
  const filteredMsgs = msgs.filter((m) => m.role !== "tool")

  return filteredMsgs.map((m) => {
    const toolCalls = [...m.toolInteractions]
    const segments = m.role === "assistant" ? buildSegments(m.parts, m.toolInteractions) : undefined
    const message = {
      id: m.id,
      role: m.role,
      content: extractText(m.parts),
      reasoning: extractReasoning(m.parts),
      images: extractImages(m.parts),
      createdAt: m.createdAt.getTime(),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      segments,
      metadata: m.metadata,
    }
    return m._tag === "interjection"
      ? { ...message, _tag: "interjection-message", role: "user" }
      : { ...message, _tag: "regular-message" }
  })
}

const upsertReceivedMessage = (
  setStore: SetStoreFunction<SessionFeedStore>,
  message: ProjectedMessage,
) => {
  const next = buildMessages([message])[0]
  if (next === undefined) return
  setStore(
    produce((draft) => {
      const index = draft.messages.findIndex((candidate) => candidate.id === next.id)
      if (index === -1) {
        draft.messages.push(next)
        return
      }
      draft.messages[index] = next
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
  toolCalls: undefined,
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
  createdAt,
  seq,
})

const createErrorEvent = (error: string, createdAt: number, seq: number): SessionEvent => ({
  _tag: "error",
  error,
  createdAt,
  seq,
})

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
      if (last !== undefined && last.role === "assistant") {
        last.content += content
        // Append to last text segment or create new one
        if (last.segments !== undefined) {
          const lastSeg = last.segments[last.segments.length - 1]
          if (lastSeg !== undefined && lastSeg._tag === "text") {
            lastSeg.content += content
          } else {
            last.segments.push({ _tag: "text", content })
          }
        }
        return
      }

      const msg = createAssistantMessage(content, id, createdAt)
      msg.segments = content.length > 0 ? [{ _tag: "text", content }] : []
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
      const last = draft.messages[draft.messages.length - 1]
      if (last === undefined || last.role !== "assistant") return
      updater(last)
    }),
  )
}

const handleToolCallResult = (
  setStore: SetStoreFunction<SessionFeedStore>,
  setActiveTool: (value: string | undefined) => string | undefined,
  toolEvent: ToolResultEvent,
) => {
  const isError = toolEvent._tag === "ToolCallFailed"

  setActiveTool(undefined)
  updateLatestToolCall(setStore, (message) => {
    if (message.toolCalls === undefined) return
    const tc = message.toolCalls.find((t) => t.id === toolEvent.toolCallId)
    if (tc === undefined) return
    tc.status = isError ? "error" : "completed"
    tc.summary = toolEvent.summary
    tc.output = toolEvent.output
    // Also update the segment's toolCall
    if (message.segments !== undefined) {
      const seg = message.segments.find(
        (s) => s._tag === "tool-call" && s.toolCall.id === toolEvent.toolCallId,
      )
      if (seg !== undefined && seg._tag === "tool-call") {
        seg.toolCall.status = tc.status
        seg.toolCall.summary = tc.summary
        seg.toolCall.output = tc.output
      }
    }
  })
}

const toActiveInteraction = (event: AgentEvent): ActiveInteraction | undefined => {
  if (event._tag === "InteractionPresented") return event
  return undefined
}

const isToolResultEvent = (event: AgentEvent): event is ToolResultEvent =>
  event._tag === "ToolCallSucceeded" || event._tag === "ToolCallFailed"

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
  const [activeTool, setActiveTool] = createSignal<string | undefined>(undefined)
  const [streamReadyKey, setStreamReadyKey] = createSignal<string | null>(null)
  let eventSeq = 0
  const lastSeenEventIdByKey = new Map<string, number>()
  let processedEnvelopeIds = new Set<EventEnvelope["id"]>()

  // Track the active key to guard against stale async writes and reset prompt state
  let currentKey: string | null = null

  const resetProjection = () => {
    setStore({ messages: [], events: [] })
    setTurnCount(0)
    setActiveTool(undefined)
    setStreamReadyKey(null)
    eventSeq = 0
    processedEnvelopeIds = new Set()
  }

  const items = createMemo((): SessionItem[] => {
    const combined: SessionItem[] = [...store.messages, ...store.events]
    return combined.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
      if (!isMessage(a) && !isMessage(b)) return a.seq - b.seq
      if (a._tag === b._tag) return 0
      return isMessage(a) ? -1 : 1
    })
  })

  // Keyed subscription — re-runs only when sessionId:branchId identity changes
  const feedKey = createMemo(() => `${sessionId()}:${branchId()}`)

  // Wait for session to become active before subscribing
  const activeSessionKey = createMemo(() => {
    const s = client.session()
    return s === null ? null : `${s.sessionId}:${s.branchId}`
  })

  // Track which prompts have been sent (keyed by feedKey to handle re-navigation)
  const sentPrompts = new Set<string>()

  createEffect(
    on(
      [activeSessionKey, feedKey, streamReadyKey, () => canSendPrompt?.() ?? true],
      ([active, key, readyKey, canSend]) => {
        if (initialPrompt === undefined || initialPrompt === "") return
        if (active === null || active !== key || readyKey !== key || !canSend) return
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
              content: initialPrompt,
            })
            .pipe(
              Effect.catchEager((err) =>
                Effect.sync(() => {
                  if (currentKey !== key) return
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
      if (active === null || active !== key) return

      // Reset all projection state on identity change
      if (currentKey !== key) {
        resetProjection()
        currentKey = key
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
                  if (currentKey !== key) return false
                  client.applySessionSnapshot(snapshot)
                  callbacks.onQueueSnapshot(snapshot.runtime.queue)
                  setStore("messages", buildMessages(snapshot.messages))
                  return true
                })
                if (!snapshotApplied) return yield* Effect.never

                const after = lastSeenEventIdByKey.get(key) ?? 0

                const eventStream = client.client.session.events({
                  sessionId: session,
                  branchId: branch,
                  after,
                })

                client.log.info("feed.stream.open", { key, after })
                const eventsFiber = yield* eventStream.pipe(
                  Stream.runForEach((envelope) =>
                    Effect.gen(function* () {
                      if (currentKey !== key) return
                      client.setConnectionIssue(null)
                      yield* processEnvelope(envelope, branch, key, snapshot.lastEventId)
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
                        if (currentKey !== key) return
                        client.setConnectionIssue(null)
                        callbacks.onQueueSnapshot(next.queue)
                      }),
                    ),
                    Effect.forkScoped,
                  )

                yield* Effect.sync(() => {
                  if (currentKey !== key) return
                  setStreamReadyKey(key)
                })

                return yield* Effect.raceFirst(Fiber.join(eventsFiber), Fiber.join(runtimeFiber))
              }),
            {
              label: "feed.events",
              log: client.log,
              onError: (err) => {
                if (currentKey !== key) return
                client.log.error("feed.error", {
                  key,
                  error: formatConnectionIssue(err),
                })
                client.setConnectionIssue(formatConnectionIssue(err))
              },
              waitForRetry: () => client.waitForTransportReady(),
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
    snapshotLastEventId: number | null,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      // Drop events if identity changed
      if (currentKey !== key) return
      if (processedEnvelopeIds.has(envelope.id)) {
        client.log.debug("feed.event.duplicate", { key, eventId: envelope.id })
        return
      }
      processedEnvelopeIds.add(envelope.id)
      lastSeenEventIdByKey.set(key, Math.max(lastSeenEventIdByKey.get(key) ?? 0, envelope.id))
      if (snapshotLastEventId !== null && envelope.id <= snapshotLastEventId) {
        client.applyBufferedSessionEvent(envelope)
        processBufferedEvent(envelope.event, branch, key)
        return
      }
      client.applySessionEvent(envelope)
      yield* processEvent(envelope.event, branch, key)
    })

  const processBufferedEvent = (event: AgentEvent, branch: BranchId, key: string) => {
    if (currentKey !== key) return

    // Snapshot data already contains message, lifecycle, and metrics state.
    // Buffered replay only hydrates event-only UI state that is absent from the
    // snapshot, such as pending interactions and route navigation.
    if (event._tag === "BranchSwitched") {
      if (event.toBranchId !== branch) callbacks.onBranchSwitch(event.sessionId, event.toBranchId)
      return
    }

    if (event._tag === "InteractionResolved") {
      callbacks.onInteractionDismissed(event.requestId)
      return
    }

    const interaction = toActiveInteraction(event)
    if (interaction !== undefined) callbacks.onInteraction(interaction)
  }

  const processEvent = (event: AgentEvent, branch: BranchId, key: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (currentKey !== key) return
      client.log.debug("feed.event", { key, tag: event._tag })

      if (event._tag === "InteractionResolved") {
        callbacks.onInteractionDismissed(event.requestId)
        return
      }

      const interaction = toActiveInteraction(event)
      if (interaction !== undefined) {
        callbacks.onInteraction(interaction)
        return
      }

      if (isToolResultEvent(event)) {
        handleToolCallResult(setStore, setActiveTool, event)
        return
      }

      switch (event._tag) {
        case "MessageReceived":
          if (event.message.role === "user") {
            upsertReceivedMessage(setStore, projectMessage(event.message, []))
          }
          break

        case "BranchSwitched":
          if (event.toBranchId !== branch) {
            setStore({ messages: [], events: [] })
            callbacks.onBranchSwitch(event.sessionId, event.toBranchId)
          }
          break

        case "StreamStarted":
          setTurnCount((n) => n + 1)
          setActiveTool(undefined)
          ensureAssistantMessage(
            setStore,
            "",
            yield* Random.nextUUIDv4,
            yield* Clock.currentTimeMillis,
          )
          break

        case "StreamChunk":
          ensureAssistantMessage(
            setStore,
            event.chunk,
            yield* Random.nextUUIDv4,
            yield* Clock.currentTimeMillis,
          )
          break

        case "TurnCompleted": {
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
          setActiveTool(
            inputSummary.length > 0 ? `${event.toolName}(${inputSummary})` : event.toolName,
          )
          const toolCall = {
            id: event.toolCallId,
            toolName: event.toolName,
            status: "running" as const,
            input: event.input,
            summary: undefined,
            output: undefined,
          }
          updateLatestToolCall(setStore, (message) => {
            if (message.toolCalls === undefined) message.toolCalls = []
            message.toolCalls.push(toolCall)
            // Also push to segments for interleaved rendering
            if (message.segments === undefined) message.segments = []
            message.segments.push({ _tag: "tool-call", toolCall })
          })
          break
        }

        case "ProviderRetrying":
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
    activeTool,
    clear: resetProjection,
  }
}
