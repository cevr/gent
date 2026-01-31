/**
 * Effect runtime hook for Solid
 * Provides call (tracked) and cast (fire-and-forget) for Effect execution
 */
import { Effect, Runtime, Exit, Fiber, Cause } from "effect"
import { createSignal, onCleanup, type Accessor, type Setter } from "solid-js"
import { type Result, initial, success, failure } from "@gent/atom-solid"
import { tuiError } from "../utils/unified-tracer"

export interface UseRuntimeReturn<R> {
  /** Run Effect, track result in signal. Returns [result accessor, cancel fn] */
  call: <A, E>(effect: Effect.Effect<A, E, R>) => [Accessor<Result<A, E>>, () => void]
  /** Fire and forget - runs Effect without tracking result */
  cast: <A, E>(effect: Effect.Effect<A, E, R>) => void
}

/**
 * Hook to run Effects with a runtime
 * @param runtime - Effect runtime with required services
 */
export function useRuntime<R>(runtime: Runtime.Runtime<R>): UseRuntimeReturn<R> {
  const call = <A, E>(effect: Effect.Effect<A, E, R>): [Accessor<Result<A, E>>, () => void] => {
    const [result, setResult] = createSignal<Result<A, E>>(initial<A, E>(true))

    let cancelled = false
    const fiber = Runtime.runFork(runtime)(effect)

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
      Effect.runFork(Fiber.interruptFork(fiber))
    }

    onCleanup(cancel)

    return [result, cancel]
  }

  const cast = <A, E>(effect: Effect.Effect<A, E, R>): void => {
    const fiber = Runtime.runFork(runtime)(effect)
    fiber.addObserver((exit) => {
      if (Exit.isFailure(exit)) {
        tuiError("cast", Cause.pretty(exit.cause))
      }
    })
  }

  return { call, cast }
}
