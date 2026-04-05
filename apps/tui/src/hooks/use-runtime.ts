/**
 * Effect execution hook for Solid
 * Provides call (tracked) and cast (fire-and-forget) for Effect execution
 */
import { Exit, Fiber, Cause } from "effect"
import type { Effect } from "effect"
import { createSignal, onCleanup, type Accessor, type Setter } from "solid-js"
import { type Result, initial, success, failure } from "../atom-solid/result"
import { useClient } from "../client/index"

export interface UseRuntimeReturn {
  /** Run Effect, track result in signal. Returns [result accessor, cancel fn] */
  call: <A, E, R>(effect: Effect.Effect<A, E, R>) => [Accessor<Result<A, E>>, () => void]
  /** Fire and forget - runs Effect without tracking result */
  cast: <A, E, R>(effect: Effect.Effect<A, E, R>) => void
}

/**
 * Hook to run Effects via the client's GentRuntime
 */
export function useRuntime(): UseRuntimeReturn {
  const client = useClient()
  const runtime = client.runtime
  const log = client.log

  const call = <A, E, R>(effect: Effect.Effect<A, E, R>): [Accessor<Result<A, E>>, () => void] => {
    const [result, setResult] = createSignal<Result<A, E>>(initial<A, E>(true))

    let cancelled = false
    const fiber = runtime.fork(effect)

    fiber.addObserver((exit) => {
      if (cancelled) return
      if (Exit.isSuccess(exit)) {
        ;(setResult as Setter<Result<A, E>>)(success<A, E>(exit.value, false))
      } else {
        ;(setResult as Setter<Result<A, E>>)(failure<A, E>(exit.cause, false))
      }
    })

    const cancel = () => {
      cancelled = true
      runtime.cast(Fiber.interrupt(fiber))
    }

    onCleanup(cancel)

    return [result, cancel]
  }

  const cast = <A, E, R>(effect: Effect.Effect<A, E, R>): void => {
    const fiber = runtime.fork(effect)
    fiber.addObserver((exit) => {
      if (Exit.isFailure(exit)) {
        log.error("cast.failed", { error: Cause.pretty(exit.cause) })
      }
    })
  }

  return { call, cast }
}
