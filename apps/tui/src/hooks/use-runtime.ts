/**
 * Effect execution hook for Solid
 * Provides call (tracked) and cast (fire-and-forget) for Effect execution.
 *
 * Effects are forked against the host-provided `services` context — wired
 * once at the TUI root (`<ClientProvider services={uiServices}>`) per
 * [[central-provider-wiring]]. Component effects requiring platform
 * services (`FileSystem`, `ChildProcessSpawner`, …) execute without any
 * per-call-site `Effect.provide`.
 */
import { Effect, Exit, Fiber, Cause } from "effect"
import { createSignal, onCleanup, type Accessor, type Setter } from "solid-js"
import { type Result, initial, success, failure } from "../atom-solid/result"
import { useClientRuntime } from "../client/index"

export interface UseRuntimeReturn {
  /** Run Effect, track result in signal. Returns [result accessor, cancel fn] */
  call: <A, E, R>(effect: Effect.Effect<A, E, R>) => [Accessor<Result<A, E>>, () => void]
  /** Fire and forget - runs Effect without tracking result */
  cast: <A, E, R>(effect: Effect.Effect<A, E, R>) => void
}

/**
 * Hook to run Effects with the host-provided platform context.
 */
export function useRuntime(): UseRuntimeReturn {
  const { services, log } = useClientRuntime()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- platform boundary: caller-supplied services context covers any R the caller declares
  const fork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runForkWith(services as Parameters<typeof Effect.runForkWith<R>>[0])(effect)

  const call = <A, E, R>(effect: Effect.Effect<A, E, R>): [Accessor<Result<A, E>>, () => void] => {
    const [result, setResult] = createSignal<Result<A, E>>(initial<A, E>(true))

    let cancelled = false
    const fiber = fork(effect)

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

  const cast = <A, E, R>(effect: Effect.Effect<A, E, R>): void => {
    const fiber = fork(effect)
    fiber.addObserver((exit) => {
      if (Exit.isFailure(exit)) {
        log.error("cast.failed", { error: Cause.pretty(exit.cause) })
      }
    })
  }

  return { call, cast }
}
