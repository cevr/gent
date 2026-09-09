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
import type { GentNamespacedClient } from "@gent/sdk"
import {
  BranchId,
  SessionId,
  type AgentEvent,
  type AgentName,
  type EventEnvelope,
  type ToolCallId,
} from "@gent/core/protocol"

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
  readonly stop: Effect.Effect<void>
  /** Get children for a specific tool call */
  readonly getChildren: (toolCallId: ToolCallId) => Effect.Effect<ReadonlyArray<ChildSessionEntry>>
  /** Get all tracked children */
  readonly getAll: Effect.Effect<ReadonlyMap<string, ChildSessionEntry>>
  /** Current children plus subsequent state snapshots for reactive consumers */
  readonly changes: Stream.Stream<ReadonlyMap<string, ChildSessionEntry>>
}

export const make = (
  events: GentNamespacedClient["session"]["events"],
): Effect.Effect<ChildSessionTrackerService, never, Scope.Scope> =>
  Effect.gen(function* () {
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
        ): [Option.Option<ChildSessionEntry>, Option.Option<Map<string, ChildSessionEntry>>] => {
          const entry = Option.fromNullishOr(current.get(childSessionId))
          if (Option.isNone(entry)) return [Option.none(), Option.none()]
          const updated = f(entry.value)
          return [Option.some(updated), Option.some(new Map(current).set(childSessionId, updated))]
        },
      )

    const projectChildEvent = (entry: ChildSessionEntry, event: AgentEvent): ChildSessionEntry => {
      switch (event._tag) {
        case "ToolCallStarted": {
          return {
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
        }

        case "ToolCallSucceeded": {
          return {
            ...entry,
            toolCalls: entry.toolCalls.map((tc): ChildToolCall => {
              if (tc.toolCallId === event.toolCallId) return { ...tc, status: "completed" }
              return tc
            }),
          }
        }

        case "ToolCallFailed": {
          return {
            ...entry,
            toolCalls: entry.toolCalls.map((tc): ChildToolCall => {
              if (tc.toolCallId === event.toolCallId) return { ...tc, status: "error" }
              return tc
            }),
          }
        }

        case "StreamChunk": {
          const combined = entry.streamText + event.chunk
          return {
            ...entry,
            streamText: combined.slice(-STREAM_TEXT_MAX_LENGTH),
          }
        }
        default:
          return entry
      }
    }

    const subscribeChild = (childSessionId: string, branchId?: BranchId) =>
      Effect.gen(function* () {
        const fiber = yield* FiberSet.run(fiberSet)(
          Stream.runForEach(
            events({ sessionId: SessionId.make(childSessionId), branchId, after: 0 }),
            (envelope: EventEnvelope) =>
              updateEntry(childSessionId, (entry) => projectChildEvent(entry, envelope.event)),
          ).pipe(Effect.catchEager(() => Effect.void)),
        )
        yield* Ref.update(childFibers, (m) => new Map(m).set(childSessionId, fiber))
      })

    const interruptChild = (childSessionId: string) =>
      Effect.gen(function* () {
        const fiber = yield* Ref.modify(
          childFibers,
          (fibers): [Option.Option<Fiber.Fiber<void>>, Map<string, Fiber.Fiber<void>>] => {
            const fiber = Option.fromNullishOr(fibers.get(childSessionId))
            if (Option.isNone(fiber)) return [Option.none(), fibers]
            const next = new Map(fibers)
            next.delete(childSessionId)
            return [fiber, next]
          },
        )
        if (Option.isSome(fiber)) {
          yield* Fiber.interrupt(fiber.value).pipe(Effect.catchEager(() => Effect.void))
        }
      })

    const handleParentEvent = (event: AgentEvent) =>
      Effect.gen(function* () {
        switch (event._tag) {
          case "AgentRunSpawned": {
            const childId = event.childSessionId
            const toolCallId = Option.fromNullishOr(event.toolCallId)
            if (Option.isNone(toolCallId)) return

            const entry: ChildSessionEntry = {
              childSessionId: childId,
              childBranchId: event.childBranchId,
              toolCallId: toolCallId.value,
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
            // Completion drains saved child history before it closes the subscription.
            yield* subscribeChild(childId, event.childBranchId)
            break
          }

          case "AgentRunSucceeded": {
            const childId = event.childSessionId
            yield* finishChild(childId)
            const updated = yield* updateEntry(childId, (entry): ChildSessionEntry => ({
              ...entry,
              status: "completed",
              usage: event.usage,
              preview: event.preview,
              savedPath: event.savedPath,
            }))
            if (Option.isNone(updated)) return
            break
          }

          case "AgentRunFailed": {
            const childId = event.childSessionId
            yield* finishChild(childId)
            const updated = yield* updateEntry(childId, (entry): ChildSessionEntry => ({
              ...entry,
              status: "error",
            }))
            if (Option.isNone(updated)) return
            break
          }

          // Entries persist after parent tool completion — the tracker is the single
          // source of truth for completed subagent state in the TUI.
        }
      })

    const finishChild = Effect.fn("ChildSessionTracker.finishChild")(function* (
      childSessionId: string,
    ) {
      yield* interruptChild(childSessionId)
      const current = Option.fromUndefinedOr(
        (yield* SubscriptionRef.get(entries)).get(childSessionId),
      )
      if (Option.isNone(current)) return
      const entry = current.value
      // A parent completion can arrive before the child's RPC replay finishes.
      // Fold the final durable history privately, then publish one complete snapshot.
      yield* events({
        sessionId: SessionId.make(childSessionId),
        branchId: Option.getOrUndefined(
          Option.fromUndefinedOr(entry.childBranchId).pipe(Option.map((id) => BranchId.make(id))),
        ),
        after: 0,
      }).pipe(
        Stream.takeUntil((envelope) => envelope.event._tag === "StreamSynchronized"),
        Stream.runFold(
          (): ChildSessionEntry => ({ ...entry, toolCalls: [], streamText: "" }),
          (state, envelope) => projectChildEvent(state, envelope.event),
        ),
        Effect.flatMap((snapshot) => updateEntry(childSessionId, () => snapshot)),
        Effect.catchEager((error) =>
          Effect.logWarning("Child event replay failed").pipe(
            Effect.annotateLogs({ childSessionId, error: String(error) }),
          ),
        ),
      )
    })

    const service: ChildSessionTrackerService = {
      track: ({ sessionId, branchId }) =>
        FiberSet.run(fiberSet)(
          Stream.runForEach(
            events({
              sessionId,
              branchId,
              after: 0,
            }),
            (envelope: EventEnvelope) => handleParentEvent(envelope.event),
          ).pipe(Effect.catchEager(() => Effect.void)),
        ),

      stop: Effect.gen(function* () {
        yield* FiberSet.clear(fiberSet)
        yield* Ref.set(childFibers, new Map())
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

      getAll: SubscriptionRef.get(entries),

      changes: SubscriptionRef.changes(entries),
    }

    return service
  })
