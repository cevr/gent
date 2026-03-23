/**
 * Framework-agnostic child session tracking service.
 *
 * Listens for SubagentSpawned/Succeeded/Failed on a parent event stream,
 * opens per-child event subscriptions, and tracks child tool call state.
 * Live-only — replays events from EventStore subscription, no durable bootstrap.
 */
import { Effect, FiberSet, PubSub, Ref, Stream } from "effect"
import type { Scope } from "effect"
import { EventStore, type AgentEvent, type EventEnvelope } from "../domain/event.js"
import type { SessionId, BranchId, ToolCallId } from "../domain/ids.js"

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
  toolCallId: ToolCallId
  agentName: string
  status: "running" | "completed" | "error"
  toolCalls: ChildToolCall[]
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
        }
      })

    const subscribeChild = (childSessionId: string) =>
      FiberSet.run(fiberSet)(
        Stream.runForEach(
          eventStore.subscribe({ sessionId: childSessionId as SessionId }),
          (envelope: EventEnvelope) => handleChildEvent(childSessionId, envelope.event),
        ).pipe(Effect.catchEager(() => Effect.void)),
      )

    const handleParentEvent = (event: AgentEvent) =>
      Effect.gen(function* () {
        switch (event._tag) {
          case "SubagentSpawned": {
            const childId = event.childSessionId as string
            const toolCallId = event.toolCallId
            if (toolCallId === undefined) return

            // Idempotency: skip if already tracking
            const current = yield* Ref.get(entries)
            if (current.has(childId)) return

            const entry: ChildSessionEntry = {
              childSessionId: childId,
              toolCallId,
              agentName: event.agentName,
              status: "running",
              toolCalls: [],
            }
            yield* Ref.update(entries, (m) => new Map(m).set(childId, entry))
            yield* publish({ _tag: "added", entry })
            yield* subscribeChild(childId)
            break
          }

          case "SubagentSucceeded": {
            const childId = event.childSessionId as string
            const current = yield* Ref.get(entries)
            const entry = current.get(childId)
            if (entry === undefined) return

            const updated = { ...entry, status: "completed" as const }
            yield* Ref.update(entries, (m) => new Map(m).set(childId, updated))
            yield* publish({ _tag: "updated", childSessionId: childId, entry: updated })
            break
          }

          case "SubagentFailed": {
            const childId = event.childSessionId as string
            const current = yield* Ref.get(entries)
            const entry = current.get(childId)
            if (entry === undefined) return

            const updated = { ...entry, status: "error" as const }
            yield* Ref.update(entries, (m) => new Map(m).set(childId, updated))
            yield* publish({ _tag: "updated", childSessionId: childId, entry: updated })
            break
          }

          case "ToolCallSucceeded":
          case "ToolCallFailed": {
            // Parent tool call completed — remove all child entries for this toolCallId
            const tcId = event.toolCallId
            const current = yield* Ref.get(entries)
            for (const [childId, entry] of current) {
              if (entry.toolCallId === tcId) {
                yield* Ref.update(entries, (m) => {
                  const next = new Map(m)
                  next.delete(childId)
                  return next
                })
                yield* publish({ _tag: "removed", childSessionId: childId })
              }
            }
            break
          }
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
