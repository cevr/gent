/**
 * Thin Solid wrapper over ChildSessionTracker from @gent/runtime.
 *
 * Creates a tracker, subscribes to changes, writes to Solid store.
 * All event projection logic lives in the runtime service.
 */
import { createStore, produce } from "solid-js/store"
import { createEffect, on, onCleanup } from "solid-js"
import { Effect, Fiber, Stream } from "effect"
import type { SessionId, BranchId } from "@gent/core"
import { makeChildSessionTracker, type ChildSessionEntry, type ChildToolCall } from "@gent/runtime"
import type { ClientContextValue } from "../client/context"

// Re-export types for consumers
export type { ChildToolCall, ChildSessionEntry }

export interface UseChildSessionsReturn {
  getChildren: (toolCallId: string) => ChildSessionEntry[]
}

export function useChildSessions(client: ClientContextValue): UseChildSessionsReturn {
  const [store, setStore] = createStore<{ entries: Record<string, ChildSessionEntry> }>({
    entries: {},
  })

  let fiber: Fiber.Fiber<void> | undefined

  const stopAll = () => {
    if (fiber !== undefined) {
      Effect.runFork(Fiber.interrupt(fiber))
      fiber = undefined
    }
    setStore({ entries: {} })
  }

  const startTracking = (sessionId: SessionId, branchId?: BranchId) => {
    stopAll()

    // Single long-running scoped fiber: creates tracker, subscribes to changes,
    // and blocks on Effect.never so the scope (and FiberSet) stays alive.
    fiber = Effect.runForkWith(client.client.services)(
      Effect.scoped(
        Effect.gen(function* () {
          const tracker = yield* makeChildSessionTracker

          // Fork: pump change stream → Solid store
          yield* Effect.forkScoped(
            Stream.runForEach(tracker.changes, (change) =>
              Effect.sync(() => {
                switch (change._tag) {
                  case "added":
                    setStore(
                      produce((draft) => {
                        draft.entries[change.entry.childSessionId] = change.entry
                      }),
                    )
                    break
                  case "updated":
                    setStore(
                      produce((draft) => {
                        draft.entries[change.childSessionId] = change.entry
                      }),
                    )
                    break
                  case "removed":
                    setStore(
                      produce((draft) => {
                        delete draft.entries[change.childSessionId]
                      }),
                    )
                    break
                }
              }),
            ).pipe(Effect.catchEager(() => Effect.void)),
          )

          // Start tracking (fires internal subscriptions into FiberSet)
          yield* tracker.track({ sessionId, branchId })

          // Block forever — keeps the scope alive until fiber is interrupted
          yield* Effect.never
        }),
      ).pipe(Effect.catchEager(() => Effect.void)),
    )
  }

  // React to session changes
  createEffect(
    on(
      () => client.session(),
      (session) => {
        if (session === null) {
          stopAll()
          return
        }
        startTracking(session.sessionId, session.branchId)
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
