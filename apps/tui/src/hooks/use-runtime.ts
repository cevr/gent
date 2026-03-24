/**
 * Effect execution hook for Solid
 * Provides call (tracked) and cast (fire-and-forget) for Effect execution
 */
import { Effect, Exit, Fiber, Cause } from "effect"
import { createSignal, onCleanup, type Accessor, type Setter } from "solid-js"
import { type Result, initial, success, failure } from "../atom-solid/result"
import { tuiError } from "../utils/unified-tracer"
import type { GentClient } from "@gent/sdk"

export interface UseRuntimeReturn {
  /** Run Effect, track result in signal. Returns [result accessor, cancel fn] */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call: <A, E>(effect: Effect.Effect<A, E, any>) => [Accessor<Result<A, E>>, () => void]
  /** Fire and forget - runs Effect without tracking result */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cast: <A, E>(effect: Effect.Effect<A, E, any>) => void
}

/**
 * Hook to run Effects via a GentClient
 * @param client - GentClient with runFork/runPromise
 */
export function useRuntime(client: GentClient): UseRuntimeReturn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = <A, E>(effect: Effect.Effect<A, E, any>): [Accessor<Result<A, E>>, () => void] => {
    const [result, setResult] = createSignal<Result<A, E>>(initial<A, E>(true))

    let cancelled = false
    // @effect-diagnostics-next-line *:off
    const fiber = client.runFork(effect)

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
      Effect.runFork(Fiber.interrupt(fiber))
    }

    onCleanup(cancel)

    return [result, cancel]
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cast = <A, E>(effect: Effect.Effect<A, E, any>): void => {
    // @effect-diagnostics-next-line *:off
    const fiber = client.runFork(effect)
    fiber.addObserver((exit) => {
      if (Exit.isFailure(exit)) {
        tuiError("cast", Cause.pretty(exit.cause))
      }
    })
  }

  return { call, cast }
}
