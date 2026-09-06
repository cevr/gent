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
import { Cause, Context, Effect, Exit, Fiber } from "effect"
import { createSignal, onCleanup, type Accessor } from "solid-js"
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

  const fork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    // The runtime context is captured at the UI boundary. Its map contains the
    // services required by the caller-supplied effect.
    Effect.runForkWith(Context.makeUnsafe<R>(services.mapUnsafe))(effect)

  const call = <A, E, R>(effect: Effect.Effect<A, E, R>): [Accessor<Result<A, E>>, () => void] => {
    const [result, setResult] = createSignal<Result<A, E>>(initial<A, E>(true))

    let cancelled = false
    const fiber = fork(effect)

    fiber.addObserver((exit) => {
      if (cancelled) return
      if (Exit.isSuccess(exit)) {
        setResult(() => success<A, E>(exit.value, false))
      } else {
        setResult(() => failure<A, E>(exit.cause, false))
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
