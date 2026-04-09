/**
 * Framework-agnostic child session tracking service.
 *
 * Listens for AgentRunSpawned/Succeeded/Failed on a parent event stream,
 * opens per-child event subscriptions, and tracks child tool call state.
 * Entries persist after completion as the single TUI source of truth.
 * Child subscription fibers are interrupted on terminal state.
 */
import { Effect, Fiber, FiberSet, PubSub, Ref, Stream } from "effect"
import type { Scope } from "effect"
import { EventStore, type AgentEvent, type EventEnvelope } from "@gent/core/domain/event.js"
import type { SessionId, BranchId, ToolCallId } from "@gent/core/domain/ids.js"

// =============================================================================
// Constants
// =============================================================================

/** Max chars retained in streamText to avoid unbounded memory growth */
const STREAM_TEXT_MAX_LENGTH = 2000

// =============================================================================
// Types (live projection — not durable domain schemas)
// =============================================================================

export interface ChildToolCall {
  toolCallId: ToolCallId
  toolName: string
  status: "running" | "completed" | "error"
  input?: unknown
}

export interface ChildSessionEntry {
  childSessionId: string
  childBranchId?: string
  toolCallId: ToolCallId
  agentName: string
  status: "running" | "completed" | "error"
  toolCalls: ChildToolCall[]
  /** Accumulated stream text (live, during running) */
  streamText: string
  usage?: { input: number; output: number; cost?: number }
  preview?: string
  savedPath?: string
}

export type ChildSessionChange =
  | { _tag: "added"; entry: ChildSessionEntry }
  | { _tag: "updated"; childSessionId: string; entry: ChildSessionEntry }
  | { _tag: "removed"; childSessionId: string }

// =============================================================================
// Service
// =============================================================================

export interface ChildSessionTrackerService {
  /** Start tracking children for a parent session/branch. Subscribes to live events. */
  readonly track: (params: { sessionId: SessionId; branchId?: BranchId }) => Effect.Effect<void>
  /** Stop tracking, interrupt all child fibers */
  readonly stop: () => Effect.Effect<void>
  /** Get children for a specific tool call */
  readonly getChildren: (toolCallId: ToolCallId) => Effect.Effect<ReadonlyArray<ChildSessionEntry>>
  /** Get all tracked children */
  readonly getAll: () => Effect.Effect<ReadonlyMap<string, ChildSessionEntry>>
  /** Stream of child state changes for reactive consumers */
  readonly changes: Stream.Stream<ChildSessionChange>
}

export const make: Effect.Effect<ChildSessionTrackerService, never, EventStore | Scope.Scope> =
  Effect.gen(function* () {
    const eventStore = yield* EventStore

    const entries = yield* Ref.make(new Map<string, ChildSessionEntry>())
    const childFibers = yield* Ref.make(new Map<string, Fiber.Fiber<void>>())
    const pubsub = yield* PubSub.unbounded<ChildSessionChange>()
    const fiberSet = yield* FiberSet.make<void>()

    const publish = (change: ChildSessionChange) => PubSub.publish(pubsub, change)

    const handleChildEvent = (childSessionId: string, event: AgentEvent) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(entries)
        const entry = current.get(childSessionId)
        if (entry === undefined) return

        switch (event._tag) {
          case "ToolCallStarted": {
            const updated: ChildSessionEntry = {
              ...entry,
              toolCalls: [
                ...entry.toolCalls,
                {
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  status: "running",
                  input: event.input,
                },
              ],
            }
            yield* Ref.update(entries, (m) => new Map(m).set(childSessionId, updated))
            yield* publish({ _tag: "updated", childSessionId, entry: updated })
            break
          }

          case "ToolCallSucceeded": {
            const updated: ChildSessionEntry = {
              ...entry,
              toolCalls: entry.toolCalls.map((tc) =>
                tc.toolCallId === event.toolCallId ? { ...tc, status: "completed" as const } : tc,
              ),
            }
            yield* Ref.update(entries, (m) => new Map(m).set(childSessionId, updated))
            yield* publish({ _tag: "updated", childSessionId, entry: updated })
            break
          }

          case "ToolCallFailed": {
            const updated: ChildSessionEntry = {
              ...entry,
              toolCalls: entry.toolCalls.map((tc) =>
                tc.toolCallId === event.toolCallId ? { ...tc, status: "error" as const } : tc,
              ),
            }
            yield* Ref.update(entries, (m) => new Map(m).set(childSessionId, updated))
            yield* publish({ _tag: "updated", childSessionId, entry: updated })
            break
          }

          case "StreamChunk": {
            const combined = entry.streamText + event.chunk
            const updated: ChildSessionEntry = {
              ...entry,
              streamText:
                combined.length > STREAM_TEXT_MAX_LENGTH
                  ? combined.slice(combined.length - STREAM_TEXT_MAX_LENGTH)
                  : combined,
            }
            yield* Ref.update(entries, (m) => new Map(m).set(childSessionId, updated))
            yield* publish({ _tag: "updated", childSessionId, entry: updated })
            break
          }
        }
      })

    const subscribeChild = (childSessionId: string) =>
      Effect.gen(function* () {
        const fiber = yield* FiberSet.run(fiberSet)(
          Stream.runForEach(
            eventStore.subscribe({ sessionId: childSessionId as SessionId }),
            (envelope: EventEnvelope) => handleChildEvent(childSessionId, envelope.event),
          ).pipe(Effect.catchEager(() => Effect.void)),
        )
        yield* Ref.update(childFibers, (m) => new Map(m).set(childSessionId, fiber))
      })

    const interruptChild = (childSessionId: string) =>
      Effect.gen(function* () {
        const fibers = yield* Ref.get(childFibers)
        const fiber = fibers.get(childSessionId)
        if (fiber !== undefined) {
          yield* Fiber.interrupt(fiber).pipe(Effect.catchEager(() => Effect.void))
          yield* Ref.update(childFibers, (m) => {
            const next = new Map(m)
            next.delete(childSessionId)
            return next
          })
        }
      })

    const handleParentEvent = (event: AgentEvent) =>
      Effect.gen(function* () {
        switch (event._tag) {
          case "AgentRunSpawned": {
            const childId = event.childSessionId as string
            const toolCallId = event.toolCallId
            if (toolCallId === undefined) return

            // Idempotency: skip if already tracking
            const current = yield* Ref.get(entries)
            if (current.has(childId)) return

            const entry: ChildSessionEntry = {
              childSessionId: childId,
              childBranchId: event.childBranchId as string | undefined,
              toolCallId,
              agentName: event.agentName,
              status: "running",
              toolCalls: [],
              streamText: "",
            }
            yield* Ref.update(entries, (m) => new Map(m).set(childId, entry))
            yield* publish({ _tag: "added", entry })
            // Subscribe to child events for tool call hydration.
            // On replay, the subscription replays child history then gets interrupted
            // when AgentRunSucceeded/Failed fires interruptChild.
            yield* subscribeChild(childId)
            break
          }

          case "AgentRunSucceeded": {
            const childId = event.childSessionId as string
            const current = yield* Ref.get(entries)
            const entry = current.get(childId)
            if (entry === undefined) return

            const updated: ChildSessionEntry = {
              ...entry,
              status: "completed" as const,
              usage: event.usage,
              preview: event.preview,
              savedPath: event.savedPath,
            }
            yield* Ref.update(entries, (m) => new Map(m).set(childId, updated))
            yield* publish({ _tag: "updated", childSessionId: childId, entry: updated })
            yield* interruptChild(childId)
            break
          }

          case "AgentRunFailed": {
            const childId = event.childSessionId as string
            const current = yield* Ref.get(entries)
            const entry = current.get(childId)
            if (entry === undefined) return

            const updated = { ...entry, status: "error" as const }
            yield* Ref.update(entries, (m) => new Map(m).set(childId, updated))
            yield* publish({ _tag: "updated", childSessionId: childId, entry: updated })
            yield* interruptChild(childId)
            break
          }

          // Entries persist after parent tool completion — the tracker is the single
          // source of truth for completed subagent state in the TUI.
        }
      })

    const service: ChildSessionTrackerService = {
      track: ({ sessionId, branchId }) =>
        FiberSet.run(fiberSet)(
          Stream.runForEach(
            eventStore.subscribe({
              sessionId,
              branchId,
            }),
            (envelope: EventEnvelope) => handleParentEvent(envelope.event),
          ).pipe(Effect.catchEager(() => Effect.void)),
        ),

      stop: () =>
        Effect.gen(function* () {
          yield* FiberSet.clear(fiberSet)
          const current = yield* Ref.get(entries)
          for (const childId of current.keys()) {
            yield* publish({ _tag: "removed", childSessionId: childId })
          }
          yield* Ref.set(entries, new Map())
        }),

      getChildren: (toolCallId) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(entries)
          const result: ChildSessionEntry[] = []
          for (const entry of current.values()) {
            if (entry.toolCallId === toolCallId) result.push(entry)
          }
          return result
        }),

      getAll: () => Ref.get(entries),

      changes: Stream.fromPubSub(pubsub),
    }

    return service
  })
