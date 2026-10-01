import { Clock, Duration, Effect, Exit, Fiber, Option, Scope, Semaphore } from "effect"

/**
 * A memo of started loads, keyed. The first `get` of a key starts its load as
 * a fiber in the memo's scope, and every `get` joins that fiber. A caller that
 * is stopped (an Esc) only stops its own wait: the load goes on, and the next
 * caller joins it. So no caller ever gets another caller's interruption back,
 * which `Effect.cached` and `Effect.cachedWithTTL` do.
 *
 * A finished load is kept for `keep(value)`: `Duration.zero` drops it at once,
 * `Duration.infinity` keeps it for the life of the scope. A failed load is
 * dropped, so the next `get` starts the load again. Closing the scope stops
 * every load still running.
 *
 * Shared by the models.dev catalog (`providers.ts`), the MCP blob prune
 * (`mcp.ts`), and the TUI file finder's scan (through `@gent/extensions/client`).
 */

interface StartedMemo<K, A, E, R> {
  /** The load for `key`: the one running or kept, or a new one. */
  readonly get: (key: K) => Effect.Effect<A, E, R>
}

interface LoadState {
  /** When a kept result stops serving; none while the load runs or when it never expires. */
  expiresAt: Option.Option<number>
  dropped: boolean
}

interface Slot<A, E> {
  readonly fiber: Fiber.Fiber<A, E>
  readonly state: LoadState
}

export const makeStartedMemo = <K, A, E, R>(options: {
  readonly load: (key: K) => Effect.Effect<A, E, R>
  readonly keep: (value: A) => Duration.Duration
}): Effect.Effect<StartedMemo<K, A, E, Exclude<R, Scope.Scope>>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const slots = new Map<K, Slot<A, E>>()
    const starting = yield* Semaphore.make(1)

    const settle = (key: K, state: LoadState, exit: Exit.Exit<A, E>) =>
      Effect.clockWith((clock) =>
        Effect.sync(() => {
          let keepFor = Duration.zero
          if (Exit.isSuccess(exit)) keepFor = options.keep(exit.value)
          if (Duration.isZero(keepFor)) {
            state.dropped = true
            if (slots.get(key)?.state === state) slots.delete(key)
            return
          }
          if (Duration.isFinite(keepFor)) {
            state.expiresAt = Option.some(
              clock.currentTimeMillisUnsafe() + Duration.toMillis(keepFor),
            )
          }
        }),
      )

    // Starting a load and recording it are one step, so a caller stopped
    // between them cannot leave a running load that no later caller finds.
    const start = (key: K) =>
      Effect.gen(function* () {
        const state: LoadState = { expiresAt: Option.none(), dropped: false }
        const fiber = yield* Effect.forkIn(
          options.load(key).pipe(
            Effect.scoped,
            Effect.onExit((exit) => settle(key, state, exit)),
          ),
          scope,
        )
        const slot = { fiber, state }
        if (!state.dropped) slots.set(key, slot)
        return slot
      }).pipe(Effect.uninterruptible)

    const live = (slot: Slot<A, E>, now: number) =>
      !slot.state.dropped && !Option.exists(slot.state.expiresAt, (at) => now >= at)

    const get = (key: K): Effect.Effect<A, E, Exclude<R, Scope.Scope>> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const found = Option.filter(Option.fromUndefinedOr(slots.get(key)), (slot) =>
          live(slot, now),
        )
        if (Option.isSome(found)) return found.value.fiber
        return (yield* start(key)).fiber
      }).pipe((selection) => starting.withPermit(selection), Effect.flatMap(Fiber.join))

    return { get }
  })
