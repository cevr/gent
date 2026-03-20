/**
 * Manages live subscriptions to child sessions spawned by subagents.
 *
 * Listens for SubagentSpawned/Succeeded/Failed on the parent event stream,
 * opens per-child event subscriptions, and tracks child tool call state.
 * Entries are keyed by childSessionId internally, derived by toolCallId for renderers.
 */
import { createStore, produce } from "solid-js/store"
import { createEffect, on, onCleanup } from "solid-js"
import { Effect, Fiber, Stream } from "effect"
import type { AgentEvent, EventEnvelope, SessionId } from "@gent/core"
import type { ClientContextValue } from "../client/context"

// =============================================================================
// Types
// =============================================================================

export interface ChildToolCall {
  toolCallId: string
  toolName: string
  status: "running" | "completed" | "error"
  input?: unknown
}

export interface ChildSessionEntry {
  childSessionId: string
  toolCallId: string
  agentName: string
  status: "running" | "completed" | "error"
  toolCalls: ChildToolCall[]
}

export interface UseChildSessionsReturn {
  getChildren: (toolCallId: string) => ChildSessionEntry[]
}

// =============================================================================
// Hook
// =============================================================================

export function useChildSessions(client: ClientContextValue): UseChildSessionsReturn {
  const [store, setStore] = createStore<{ entries: Record<string, ChildSessionEntry> }>({
    entries: {},
  })

  // Non-reactive fiber tracking — lifecycle only
  const fibers = new Map<string, Fiber.Fiber<void>>()

  const interruptAll = () => {
    for (const [, fiber] of fibers) {
      Effect.runFork(Fiber.interrupt(fiber))
    }
    fibers.clear()
    setStore({ entries: {} })
  }

  const interruptChild = (childSessionId: string) => {
    const fiber = fibers.get(childSessionId)
    if (fiber !== undefined) {
      Effect.runFork(Fiber.interrupt(fiber))
      fibers.delete(childSessionId)
    }
  }

  const handleParentEvent = (event: AgentEvent): void => {
    switch (event._tag) {
      case "SubagentSpawned": {
        const childId = event.childSessionId as string
        const toolCallId = event.toolCallId
        if (toolCallId === undefined) return
        // Idempotency: skip if already tracking
        if (store.entries[childId] !== undefined) return

        setStore(
          produce((draft) => {
            draft.entries[childId] = {
              childSessionId: childId,
              toolCallId,
              agentName: event.agentName,
              status: "running",
              toolCalls: [],
            }
          }),
        )

        // Fork a fiber to subscribe to child session events
        const fiber = Effect.runForkWith(client.client.services)(
          Stream.runForEach(
            client.client.subscribeEvents({ sessionId: event.childSessionId as SessionId }),
            (envelope: EventEnvelope) =>
              Effect.sync(() => {
                handleChildEvent(childId, envelope.event)
              }),
          ).pipe(Effect.catchEager(() => Effect.void)),
        )
        fibers.set(childId, fiber)
        break
      }

      case "SubagentSucceeded": {
        const childId = event.childSessionId as string
        interruptChild(childId)
        setStore(
          produce((draft) => {
            const entry = draft.entries[childId]
            if (entry !== undefined) entry.status = "completed"
          }),
        )
        break
      }

      case "SubagentFailed": {
        const childId = event.childSessionId as string
        interruptChild(childId)
        setStore(
          produce((draft) => {
            const entry = draft.entries[childId]
            if (entry !== undefined) entry.status = "error"
          }),
        )
        break
      }

      case "ToolCallSucceeded":
      case "ToolCallFailed": {
        // Parent tool call completed — clear all child entries for this toolCallId
        const tcId = event.toolCallId
        setStore(
          produce((draft) => {
            for (const [key, entry] of Object.entries(draft.entries)) {
              if (entry.toolCallId === tcId) {
                delete draft.entries[key]
              }
            }
          }),
        )
        break
      }
    }
  }

  const handleChildEvent = (childSessionId: string, event: AgentEvent): void => {
    switch (event._tag) {
      case "ToolCallStarted":
        setStore(
          produce((draft) => {
            const entry = draft.entries[childSessionId]
            if (entry !== undefined) {
              entry.toolCalls.push({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                status: "running",
                input: event.input,
              })
            }
          }),
        )
        break

      case "ToolCallSucceeded":
        setStore(
          produce((draft) => {
            const entry = draft.entries[childSessionId]
            if (entry !== undefined) {
              const tc = entry.toolCalls.find((t) => t.toolCallId === event.toolCallId)
              if (tc !== undefined) tc.status = "completed"
            }
          }),
        )
        break

      case "ToolCallFailed":
        setStore(
          produce((draft) => {
            const entry = draft.entries[childSessionId]
            if (entry !== undefined) {
              const tc = entry.toolCalls.find((t) => t.toolCallId === event.toolCallId)
              if (tc !== undefined) tc.status = "error"
            }
          }),
        )
        break
    }
  }

  // Subscribe to parent event stream
  const unsub = client.subscribeEvents(handleParentEvent)

  // Reset on session/branch changes — prevents stale child state leaking across sessions
  createEffect(
    on(
      () => client.session(),
      () => {
        interruptAll()
      },
    ),
  )

  onCleanup(() => {
    unsub()
    interruptAll()
  })

  const getChildren = (toolCallId: string): ChildSessionEntry[] => {
    const result: ChildSessionEntry[] = []
    for (const entry of Object.values(store.entries)) {
      if (entry.toolCallId === toolCallId) result.push(entry)
    }
    return result
  }

  return { getChildren }
}
