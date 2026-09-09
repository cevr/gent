/**
 * Thin Solid wrapper over the TUI child session tracker.
 *
 * Creates a tracker, subscribes to changes, writes to Solid store.
 * All event projection logic lives in the tracker.
 */
import { createStore } from "solid-js/store"
import { createEffect, on, onCleanup } from "solid-js"
import { Effect, Fiber, Option, Stream } from "effect"
import type { BranchId, SessionId } from "@gent/core/protocol"
import {
  make as makeChildSessionTracker,
  type ChildSessionEntry,
  type ChildToolCall,
} from "../services/child-session-tracker"
import type { ClientSessionValue, ClientTransportValue } from "../client/context"

// Re-export types for consumers
export type { ChildToolCall, ChildSessionEntry }

export interface UseChildSessionsReturn {
  getChildren: (toolCallId: string) => ChildSessionEntry[]
}

type ChildSessionClient = Pick<ClientSessionValue, "session"> &
  Pick<ClientTransportValue, "runtime" | "client">

export function useChildSessions(client: ChildSessionClient): UseChildSessionsReturn {
  const [store, setStore] = createStore<{ entries: Record<string, ChildSessionEntry> }>({
    entries: {},
  })

  let fiber: Option.Option<Fiber.Fiber<void>> = Option.none()

  const stopAll = () => {
    if (Option.isSome(fiber)) {
      Effect.runFork(Fiber.interrupt(fiber.value))
      fiber = Option.none()
    }
    setStore({ entries: {} })
  }

  const startTracking = (sessionId: SessionId, branchId?: BranchId) => {
    stopAll()

    // Single long-running scoped fiber: creates tracker, subscribes to changes,
    // and blocks on Effect.never so the scope (and FiberSet) stays alive.
    fiber = Option.some(
      client.runtime.fork(
        Effect.scoped(
          Effect.gen(function* () {
            const tracker = yield* makeChildSessionTracker(client.client.session.events)

            // Fork: pump tracker snapshots → Solid store
            yield* Effect.forkScoped(
              Stream.runForEach(tracker.changes, (entries) =>
                Effect.sync(() => {
                  setStore({ entries: Object.fromEntries(entries) })
                }),
              ).pipe(Effect.catchEager(() => Effect.void)),
            )

            // Start tracking (fires internal subscriptions into FiberSet)
            yield* tracker.track({ sessionId, branchId })

            // Block forever — keeps the scope alive until fiber is interrupted
            return yield* Effect.never
          }),
        ).pipe(Effect.catchEager(() => Effect.void)),
      ),
    )
  }

  // React to session changes
  createEffect(
    on(
      () => client.session(),
      (session) => {
        const current = Option.fromNullishOr(session)
        if (Option.isNone(current)) {
          stopAll()
          return
        }
        startTracking(current.value.sessionId, current.value.branchId)
      },
    ),
  )

  onCleanup(stopAll)

  const getChildren = (toolCallId: string): ChildSessionEntry[] => {
    const result: ChildSessionEntry[] = []
    for (const entry of Object.values(store.entries)) {
      if (entry.toolCallId === toolCallId) result.push(entry)
    }
    return result
  }

  return { getChildren }
}
