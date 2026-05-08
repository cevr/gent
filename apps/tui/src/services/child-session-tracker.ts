/**
 * Framework-agnostic child session tracking service.
 *
 * Listens for AgentRunSpawned/Succeeded/Failed on a parent event stream,
 * opens per-child event subscriptions, and tracks child tool call state.
 * Entries persist after completion as the single TUI source of truth.
 * Child subscription fibers are interrupted on terminal state.
 */
import { Effect, Fiber, FiberSet, Option, Ref, Stream, SubscriptionRef } from "effect"
import type { Scope } from "effect"
import {
  EventStore,
  type AgentEvent,
  type EventEnvelope,
} from "@gent/core-internal/domain/event.js"
import type { AgentName } from "@gent/core-internal/domain/agent.js"
import { SessionId } from "@gent/core-internal/domain/ids.js"
import type { BranchId, ToolCallId } from "@gent/core-internal/domain/ids.js"

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
  agentName: AgentName
  status: "running" | "completed" | "error"
  toolCalls: ChildToolCall[]
  /** Accumulated stream text (live, during running) */
  streamText: string
  usage?: { input: number; output: number; cost?: number }
  preview?: string
  savedPath?: string
}

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
  /** Current children plus subsequent state snapshots for reactive consumers */
  readonly changes: Stream.Stream<ReadonlyMap<string, ChildSessionEntry>>
}

export const make: Effect.Effect<ChildSessionTrackerService, never, EventStore | Scope.Scope> =
  Effect.gen(function* () {
    const eventStore = yield* EventStore

    const entries = yield* SubscriptionRef.make(new Map<string, ChildSessionEntry>())
    const childFibers = yield* Ref.make(new Map<string, Fiber.Fiber<void>>())
    const fiberSet = yield* FiberSet.make<void>()

    const updateEntry = (
      childSessionId: string,
      f: (entry: ChildSessionEntry) => ChildSessionEntry,
    ) =>
      SubscriptionRef.modifySome(
        entries,
        (
          current,
        ): [ChildSessionEntry | undefined, Option.Option<Map<string, ChildSessionEntry>>] => {
          const entry = current.get(childSessionId)
          if (entry === undefined) return [undefined, Option.none()]
          const updated = f(entry)
          return [updated, Option.some(new Map(current).set(childSessionId, updated))]
        },
      )

    const handleChildEvent = (childSessionId: string, event: AgentEvent) =>
      Effect.gen(function* () {
        switch (event._tag) {
          case "ToolCallStarted": {
            const updated = yield* updateEntry(childSessionId, (entry) => ({
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
            }))
            if (updated === undefined) return
            break
          }

          case "ToolCallSucceeded": {
            const updated = yield* updateEntry(childSessionId, (entry) => ({
              ...entry,
              toolCalls: entry.toolCalls.map((tc) =>
                tc.toolCallId === event.toolCallId ? { ...tc, status: "completed" as const } : tc,
              ),
            }))
            if (updated === undefined) return
            break
          }

          case "ToolCallFailed": {
            const updated = yield* updateEntry(childSessionId, (entry) => ({
              ...entry,
              toolCalls: entry.toolCalls.map((tc) =>
                tc.toolCallId === event.toolCallId ? { ...tc, status: "error" as const } : tc,
              ),
            }))
            if (updated === undefined) return
            break
          }

          case "StreamChunk": {
            const updated = yield* updateEntry(childSessionId, (entry) => {
              const combined = entry.streamText + event.chunk
              return {
                ...entry,
                streamText:
                  combined.length > STREAM_TEXT_MAX_LENGTH
                    ? combined.slice(combined.length - STREAM_TEXT_MAX_LENGTH)
                    : combined,
              }
            })
            if (updated === undefined) return
            break
          }
        }
      })

    const subscribeChild = (childSessionId: string) =>
      Effect.gen(function* () {
        const fiber = yield* FiberSet.run(fiberSet)(
          Stream.runForEach(
            eventStore.subscribe({ sessionId: SessionId.make(childSessionId) }),
            (envelope: EventEnvelope) => handleChildEvent(childSessionId, envelope.event),
          ).pipe(Effect.catchEager(() => Effect.void)),
        )
        yield* Ref.update(childFibers, (m) => new Map(m).set(childSessionId, fiber))
      })

    const interruptChild = (childSessionId: string) =>
      Effect.gen(function* () {
        const fiber = yield* Ref.modify(
          childFibers,
          (fibers): [Fiber.Fiber<void> | undefined, Map<string, Fiber.Fiber<void>>] => {
            const fiber = fibers.get(childSessionId)
            if (fiber === undefined) return [undefined, fibers]
            const next = new Map(fibers)
            next.delete(childSessionId)
            return [fiber, next]
          },
        )
        if (fiber !== undefined) {
          yield* Fiber.interrupt(fiber).pipe(Effect.catchEager(() => Effect.void))
        }
      })

    const handleParentEvent = (event: AgentEvent) =>
      Effect.gen(function* () {
        switch (event._tag) {
          case "AgentRunSpawned": {
            const childId = event.childSessionId as string
            const toolCallId = event.toolCallId
            if (toolCallId === undefined) return

            const entry: ChildSessionEntry = {
              childSessionId: childId,
              childBranchId: event.childBranchId as string | undefined,
              toolCallId,
              agentName: event.agentName,
              status: "running",
              toolCalls: [],
              streamText: "",
            }
            const added = yield* SubscriptionRef.modifySome(
              entries,
              (current): [boolean, Option.Option<Map<string, ChildSessionEntry>>] => {
                if (current.has(childId)) return [false, Option.none()]
                return [true, Option.some(new Map(current).set(childId, entry))]
              },
            )
            if (!added) return
            // Subscribe to child events for tool call hydration.
            // On replay, the subscription replays child history then gets interrupted
            // when AgentRunSucceeded/Failed fires interruptChild.
            yield* subscribeChild(childId)
            break
          }

          case "AgentRunSucceeded": {
            const childId = event.childSessionId as string
            const updated = yield* updateEntry(childId, (entry) => ({
              ...entry,
              status: "completed" as const,
              usage: event.usage,
              preview: event.preview,
              savedPath: event.savedPath,
            }))
            if (updated === undefined) return
            yield* interruptChild(childId)
            break
          }

          case "AgentRunFailed": {
            const childId = event.childSessionId as string
            const updated = yield* updateEntry(childId, (entry) => ({
              ...entry,
              status: "error" as const,
            }))
            if (updated === undefined) return
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
          yield* SubscriptionRef.set(entries, new Map())
        }),

      getChildren: (toolCallId) =>
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(entries)
          const result: ChildSessionEntry[] = []
          for (const entry of current.values()) {
            if (entry.toolCallId === toolCallId) result.push(entry)
          }
          return result
        }),

      getAll: () => SubscriptionRef.get(entries),

      changes: SubscriptionRef.changes(entries),
    }

    return service
  })
