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
import type { AgentEvent } from "@gent/core/domain/event.js"
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
import { clientLog } from "../utils/client-logger"
import { formatError } from "../utils/format-error"
import type { ClientContextValue } from "../client/context"

// ── Types ──

export interface SessionFeedCallbacks {
  onComposerEvent: (event: ComposerFeedEvent) => void
  onBranchSwitch: (sessionId: SessionId, branchId: BranchId) => void
}

export type ComposerFeedEvent =
  | { _tag: "QuestionsAsked"; event: AgentEvent & { _tag: "QuestionsAsked" } }
  | { _tag: "PermissionRequested"; event: AgentEvent & { _tag: "PermissionRequested" } }
  | { _tag: "PromptPresented"; event: AgentEvent & { _tag: "PromptPresented" } }
  | { _tag: "HandoffPresented"; event: AgentEvent & { _tag: "HandoffPresented" } }

type ToolResultEvent = Extract<
  AgentEvent,
  { _tag: "ToolCallCompleted" | "ToolCallSucceeded" | "ToolCallFailed" }
>

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
  const isError =
    toolEvent._tag === "ToolCallFailed" ||
    (toolEvent._tag === "ToolCallCompleted" && toolEvent.isError)

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

const toComposerFeedEvent = (event: AgentEvent): ComposerFeedEvent | undefined => {
  switch (event._tag) {
    case "QuestionsAsked":
      return { _tag: "QuestionsAsked", event }
    case "PermissionRequested":
      return { _tag: "PermissionRequested", event }
    case "PromptPresented":
      return { _tag: "PromptPresented", event }
    case "HandoffPresented":
      return { _tag: "HandoffPresented", event }
    default:
      return undefined
  }
}

const isToolResultEvent = (event: AgentEvent): event is ToolResultEvent =>
  event._tag === "ToolCallCompleted" ||
  event._tag === "ToolCallSucceeded" ||
  event._tag === "ToolCallFailed"

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
      clientLog.info("sessionFeed.activate", { key })

      const watchFiber = Effect.runForkWith(client.client.services)(
        client.client
          .watchSessionState({
            sessionId: session,
            branchId: branch,
          })
          .pipe(
            Stream.runForEach((state) =>
              Effect.sync(() => {
                if (currentKey !== key) return
                setStore("messages", buildMessages(state.messages))
              }),
            ),
            Effect.catchEager((err) =>
              Effect.sync(() => {
                if (currentKey !== key) return
                client.setError(formatError(err))
              }),
            ),
          ),
      )

      const unsubscribe = client.subscribeEvents((event) => {
        // Guard: only process events for our session/branch
        if ("sessionId" in event && event.sessionId !== session) return
        if ("branchId" in event && event.branchId !== branch) return
        processEvent(event, branch, key)
      })

      // Send initial prompt after subscription is established (once per identity)
      if (initialPrompt !== undefined && initialPrompt !== "" && !sentPrompts.has(key)) {
        sentPrompts.add(key)
        clientLog.info("sessionFeed.sendInitialPrompt", {
          sessionId: session,
          branchId: branch,
        })
        cast(
          client.client
            .sendMessage({
              sessionId: session,
              branchId: branch,
              content: initialPrompt,
            })
            .pipe(
              Effect.tapError((err) =>
                Effect.sync(() => {
                  client.setError(formatError(err))
                }),
              ),
            ),
        )
      }

      onCleanup(() => {
        unsubscribe()
        Effect.runFork(Fiber.interrupt(watchFiber))
      })
    }),
  )

  const processEvent = (event: AgentEvent, branch: BranchId, key: string) => {
    // Drop events if identity changed
    if (currentKey !== key) return

    const composerEvent = toComposerFeedEvent(event)
    if (composerEvent !== undefined) {
      callbacks.onComposerEvent(composerEvent)
      return
    }

    if (isToolResultEvent(event)) {
      handleToolCallResult(setStore, setActiveTool, event)
      return
    }

    switch (event._tag) {
      case "MessageReceived":
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
        clientLog.error("sessionFeed.error", { error: event.error, seq: eventSeq })
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
