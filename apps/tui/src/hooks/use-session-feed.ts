/**
 * Session feed — keyed projection of server events into UI state.
 *
 * Takes explicit (sessionId, branchId) and subscribes exactly once per identity.
 * No dependency on client.session() or machine state — immune to the
 * UpdateBypass/UpdateReasoningLevel re-run footgun.
 */

import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Effect } from "effect"
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
import type { SessionEvent } from "../components/session-event-indicator"
import { formatToolInput } from "../components/message-list-utils"
import { clientLog } from "../utils/client-logger"
import { formatError } from "../utils/format-error"
import type { ClientContextValue } from "../client/context"

// ── Types ──

export interface SessionFeedCallbacks {
  onInputEvent: (event: InputFeedEvent) => void
  onBranchSwitch: (sessionId: SessionId, branchId: BranchId) => void
}

export type InputFeedEvent =
  | { _tag: "QuestionsAsked"; event: AgentEvent & { _tag: "QuestionsAsked" } }
  | { _tag: "PermissionRequested"; event: AgentEvent & { _tag: "PermissionRequested" } }
  | { _tag: "PromptPresented"; event: AgentEvent & { _tag: "PromptPresented" } }
  | { _tag: "HandoffPresented"; event: AgentEvent & { _tag: "HandoffPresented" } }

export interface SessionFeed {
  items: () => SessionItem[]
  messages: () => Message[]
  turnCount: () => number
  activeTool: () => string | undefined
  clear: () => void
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

  const loadMessages = (branch: BranchId, key: string) => {
    cast(
      client.client.listMessages(branch).pipe(
        Effect.map((msgs) => buildMessages(msgs)),
        Effect.tap((msgs) =>
          Effect.sync(() => {
            // Drop stale results if identity changed while async was in flight
            if (currentKey !== key) return
            setStore("messages", msgs)
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
  }

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
      loadMessages(branch, key)

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

      onCleanup(unsubscribe)
    }),
  )

  const processEvent = (event: AgentEvent, branch: BranchId, key: string) => {
    // Drop events if identity changed
    if (currentKey !== key) return

    switch (event._tag) {
      case "MessageReceived":
        loadMessages(branch, key)
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
        setStore(
          produce((draft) => {
            draft.messages.push({
              _tag: "message",
              id: crypto.randomUUID(),
              role: "assistant",
              kind: "regular",
              content: "",
              reasoning: "",
              images: [],
              createdAt: Date.now(),
              toolCalls: undefined,
            })
          }),
        )
        break

      case "StreamChunk":
        setStore(
          produce((draft) => {
            const last = draft.messages[draft.messages.length - 1]
            if (last !== undefined && last.role === "assistant") {
              last.content += event.chunk
            } else {
              draft.messages.push({
                _tag: "message",
                id: crypto.randomUUID(),
                role: "assistant",
                kind: "regular",
                content: event.chunk,
                reasoning: "",
                images: [],
                createdAt: Date.now(),
                toolCalls: undefined,
              })
            }
          }),
        )
        break

      case "TurnCompleted": {
        const durationSeconds = Math.round(event.durationMs / 1000)
        if (event.interrupted === true) {
          setStore(
            produce((draft) => {
              draft.events.push({
                _tag: "event",
                kind: "interruption",
                createdAt: Date.now(),
                seq: eventSeq++,
              })
            }),
          )
        } else if (durationSeconds > 0) {
          setStore(
            produce((draft) => {
              draft.events.push({
                _tag: "event",
                kind: "turn-ended",
                durationSeconds,
                createdAt: Date.now(),
                seq: eventSeq++,
              })
            }),
          )
        }
        break
      }

      case "ToolCallStarted": {
        const inputSummary = formatToolInput(event.toolName, event.input)
        setActiveTool(
          inputSummary.length > 0 ? `${event.toolName}(${inputSummary})` : event.toolName,
        )
        setStore(
          produce((draft) => {
            const last = draft.messages[draft.messages.length - 1]
            if (last !== undefined && last.role === "assistant") {
              if (last.toolCalls === undefined) last.toolCalls = []
              last.toolCalls.push({
                id: event.toolCallId,
                toolName: event.toolName,
                status: "running" as const,
                input: event.input,
                summary: undefined,
                output: undefined,
              })
            }
          }),
        )
        break
      }

      case "ToolCallCompleted":
      case "ToolCallSucceeded":
      case "ToolCallFailed": {
        const isError =
          event._tag === "ToolCallFailed" || (event._tag === "ToolCallCompleted" && event.isError)
        setActiveTool(undefined)
        setStore(
          produce((draft) => {
            const last = draft.messages[draft.messages.length - 1]
            if (last !== undefined && last.role === "assistant" && last.toolCalls !== undefined) {
              const tc = last.toolCalls.find((t) => t.id === event.toolCallId)
              if (tc !== undefined) {
                tc.status = isError ? "error" : "completed"
                tc.summary = event.summary
                tc.output = event.output
              }
            }
          }),
        )
        break
      }

      case "QuestionsAsked":
        callbacks.onInputEvent({ _tag: "QuestionsAsked", event })
        break

      case "PermissionRequested":
        callbacks.onInputEvent({ _tag: "PermissionRequested", event })
        break

      case "PromptPresented":
        callbacks.onInputEvent({ _tag: "PromptPresented", event })
        break

      case "HandoffPresented":
        callbacks.onInputEvent({ _tag: "HandoffPresented", event })
        break

      case "ErrorOccurred":
        clientLog.error("sessionFeed.error", { error: event.error, seq: eventSeq })
        setStore(
          produce((draft) => {
            draft.events.push({
              _tag: "event",
              kind: "error",
              error: event.error,
              createdAt: Date.now(),
              seq: eventSeq++,
            })
          }),
        )
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
