/**
 * Session feed — keyed projection of server events into UI state.
 *
 * Takes explicit (sessionId, branchId) and subscribes exactly once per identity.
 * No dependency on client.session() or machine state — immune to the
 * UpdateBypass/UpdateReasoningLevel re-run footgun.
 */

import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { createStore, produce, type SetStoreFunction } from "solid-js/store"
import { Effect, Fiber, Stream } from "effect"
import type { ActiveInteraction, AgentEvent } from "@gent/core/domain/event.js"
import type { BranchId, SessionId } from "@gent/core/domain/ids.js"
import {
  extractText,
  extractReasoning,
  extractImages,
  buildToolResultMap,
  extractToolCallsWithResults,
  type MessageInfoReadonly,
} from "@gent/sdk"
import type { Message, SessionItem } from "../components/message-list"
import type { SessionEvent } from "../components/session-event-label"
import { formatToolInput } from "../components/message-list-utils"
import { formatConnectionIssue } from "../utils/format-error"
import { runWithReconnect } from "../utils/run-with-reconnect"
import type { ClientContextValue } from "../client/context"

// ── Types ──

export interface SessionFeedCallbacks {
  onInteraction: (interaction: ActiveInteraction) => void
  onInteractionDismissed: (requestId: string) => void
  onBranchSwitch: (sessionId: SessionId, branchId: BranchId) => void
}

type ToolResultEvent = Extract<AgentEvent, { _tag: "ToolCallSucceeded" | "ToolCallFailed" }>

export interface SessionFeed {
  items: () => SessionItem[]
  messages: () => Message[]
  turnCount: () => number
  activeTool: () => string | undefined
  clear: () => void
}

type SessionFeedStore = {
  messages: Message[]
  events: SessionEvent[]
}

// ── Build messages from raw ──

const buildMessages = (msgs: readonly MessageInfoReadonly[]): Message[] => {
  const resultMap = buildToolResultMap(msgs)
  const filteredMsgs = msgs.filter((m) => m.role !== "tool")

  return filteredMsgs.map((m) => {
    const toolCalls = extractToolCallsWithResults(m.parts, resultMap)
    return {
      _tag: "message" as const,
      id: m.id,
      role: m.role,
      kind: (m.kind ?? "regular") as "regular" | "interjection",
      content: extractText(m.parts),
      reasoning: extractReasoning(m.parts),
      images: extractImages(m.parts),
      createdAt: m.createdAt,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      metadata: m.metadata,
    }
  })
}

const createAssistantMessage = (content: string): Message => ({
  _tag: "message",
  id: crypto.randomUUID(),
  role: "assistant",
  kind: "regular",
  content,
  reasoning: "",
  images: [],
  createdAt: Date.now(),
  toolCalls: undefined,
})

const createInterruptionEvent = (seq: number): SessionEvent => ({
  _tag: "event",
  kind: "interruption",
  createdAt: Date.now(),
  seq,
})

const createTurnEndedEvent = (durationSeconds: number, seq: number): SessionEvent => ({
  _tag: "event",
  kind: "turn-ended",
  durationSeconds,
  createdAt: Date.now(),
  seq,
})

const createRetryingEvent = (
  attempt: number,
  maxAttempts: number,
  delayMs: number,
  seq: number,
): SessionEvent => ({
  _tag: "event",
  kind: "retrying",
  attempt,
  maxAttempts,
  delayMs,
  createdAt: Date.now(),
  seq,
})

const createErrorEvent = (error: string, seq: number): SessionEvent => ({
  _tag: "event",
  kind: "error",
  error,
  createdAt: Date.now(),
  seq,
})

const appendSessionEvent = (setStore: SetStoreFunction<SessionFeedStore>, event: SessionEvent) => {
  setStore(
    produce((draft) => {
      draft.events.push(event)
    }),
  )
}

const ensureAssistantMessage = (setStore: SetStoreFunction<SessionFeedStore>, content: string) => {
  setStore(
    produce((draft) => {
      const last = draft.messages[draft.messages.length - 1]
      if (last !== undefined && last.role === "assistant") {
        last.content += content
        return
      }

      draft.messages.push(createAssistantMessage(content))
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
  })
}

const toActiveInteraction = (event: AgentEvent): ActiveInteraction | undefined => {
  switch (event._tag) {
    case "QuestionsAsked":
    case "PromptPresented":
    case "HandoffPresented":
      return event as ActiveInteraction
    default:
      return undefined
  }
}

const isToolResultEvent = (event: AgentEvent): event is ToolResultEvent =>
  event._tag === "ToolCallSucceeded" || event._tag === "ToolCallFailed"

// ── Hook ──

export function useSessionFeed(
  sessionId: () => SessionId,
  branchId: () => BranchId,
  client: ClientContextValue,
  cast: <A, E>(effect: Effect.Effect<A, E, never>) => void,
  callbacks: SessionFeedCallbacks,
  initialPrompt?: string,
): SessionFeed {
  const [store, setStore] = createStore<{ messages: Message[]; events: SessionEvent[] }>({
    messages: [],
    events: [],
  })
  const [turnCount, setTurnCount] = createSignal(0)
  const [activeTool, setActiveTool] = createSignal<string | undefined>(undefined)
  let eventSeq = 0

  // Track the active key to guard against stale async writes and reset prompt state
  let currentKey: string | null = null

  const resetProjection = () => {
    setStore({ messages: [], events: [] })
    setTurnCount(0)
    setActiveTool(undefined)
    eventSeq = 0
  }

  const items = createMemo((): SessionItem[] => {
    const combined: SessionItem[] = [...store.messages, ...store.events]
    return combined.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
      if (a._tag === "event" && b._tag === "event") return a.seq - b.seq
      if (a._tag === b._tag) return 0
      return a._tag === "message" ? -1 : 1
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
        runWithReconnect(
          () =>
            Effect.gen(function* () {
              client.log.info("feed.snapshot.fetch", { key })
              const snapshot = yield* client.client.session.getSnapshot({
                sessionId: session,
                branchId: branch,
              })
              client.log.info("feed.snapshot.hydrated", {
                key,
                messageCount: snapshot.messages.length,
                lastEventId: snapshot.lastEventId,
                hasInteraction: snapshot.activeInteraction !== undefined,
              })

              yield* Effect.sync(() => {
                if (currentKey !== key) return
                client.setConnectionIssue(null)
                setStore("messages", buildMessages(snapshot.messages))
                // Hydrate pending interaction from snapshot (reconnect scenario)
                if (snapshot.activeInteraction !== undefined) {
                  const event = snapshot.activeInteraction.event as ActiveInteraction | undefined
                  if (event !== undefined) {
                    callbacks.onInteraction(event)
                  }
                }
              })

              const eventStream = client.client.session.events({
                sessionId: session,
                branchId: branch,
                ...(snapshot.lastEventId !== null ? { after: snapshot.lastEventId } : {}),
              })

              client.log.info("feed.stream.open", { key, after: snapshot.lastEventId })
              const eventsFiber = yield* eventStream.pipe(
                Stream.runForEach((envelope) =>
                  Effect.sync(() => {
                    if (currentKey !== key) return
                    client.setConnectionIssue(null)
                    processEvent(envelope.event, branch, key)
                  }),
                ),
                Effect.forkScoped,
              )

              // Send the prompt only after the event stream is established.
              if (initialPrompt !== undefined && initialPrompt !== "" && !sentPrompts.has(key)) {
                sentPrompts.add(key)
                client.log.info("feed.sendInitialPrompt", {
                  sessionId: session,
                  branchId: branch,
                })
                yield* client.client.message.send({
                  sessionId: session,
                  branchId: branch,
                  content: initialPrompt,
                })
              }

              return yield* Fiber.join(eventsFiber)
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
      )

      onCleanup(() => {
        client.log.info("feed.cleanup", { key })
        Effect.runFork(Fiber.interrupt(streamFiber))
      })
    }),
  )

  const processEvent = (event: AgentEvent, branch: BranchId, key: string) => {
    // Drop events if identity changed
    if (currentKey !== key) return

    client.log.debug("feed.event", { key, tag: event._tag })

    if (event._tag === "InteractionDismissed") {
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
        // User messages from other sources (interjections, multi-client) need fetching
        if (event.role === "user") {
          void Effect.runPromise(
            client.client.message.list({ branchId: event.branchId }).pipe(
              Effect.tap((msgs) =>
                Effect.sync(() => {
                  if (currentKey !== key) return
                  setStore("messages", buildMessages(msgs))
                }),
              ),
              Effect.catchEager(() => Effect.void),
            ),
          )
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
        ensureAssistantMessage(setStore, "")
        break

      case "StreamChunk":
        ensureAssistantMessage(setStore, event.chunk)
        break

      case "TurnCompleted": {
        const durationSeconds = Math.round(event.durationMs / 1000)
        if (event.interrupted === true) {
          appendSessionEvent(setStore, createInterruptionEvent(eventSeq++))
        } else if (durationSeconds > 0) {
          appendSessionEvent(setStore, createTurnEndedEvent(durationSeconds, eventSeq++))
        }
        break
      }

      case "ToolCallStarted": {
        const inputSummary = formatToolInput(event.toolName, event.input)
        setActiveTool(
          inputSummary.length > 0 ? `${event.toolName}(${inputSummary})` : event.toolName,
        )
        updateLatestToolCall(setStore, (message) => {
          if (message.toolCalls === undefined) message.toolCalls = []
          message.toolCalls.push({
            id: event.toolCallId,
            toolName: event.toolName,
            status: "running" as const,
            input: event.input,
            summary: undefined,
            output: undefined,
          })
        })
        break
      }

      case "ProviderRetrying":
        appendSessionEvent(
          setStore,
          createRetryingEvent(event.attempt, event.maxAttempts, event.delayMs, eventSeq++),
        )
        break

      case "ErrorOccurred":
        client.log.error("sessionFeed.error", { error: event.error, seq: eventSeq })
        appendSessionEvent(setStore, createErrorEvent(event.error, eventSeq++))
        break
    }
  }

  return {
    items,
    messages: () => store.messages,
    turnCount,
    activeTool,
    clear: resetProjection,
  }
}
