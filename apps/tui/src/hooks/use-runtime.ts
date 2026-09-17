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
import { onCleanup } from "solid-js"
import { useClient } from "../client/index"

interface UseRuntimeReturn {
  /** Run Effect, interrupting it when the owning component unmounts. */
  call: <A, E, R>(effect: Effect.Effect<A, E, R>) => void
  /** Fire and forget - runs Effect without tracking result */
  cast: <A, E, R>(effect: Effect.Effect<A, E, R>) => void
}

/**
 * Hook to run Effects with the host-provided platform context.
 */
export function useRuntime(): UseRuntimeReturn {
  const { services, log } = useClient()

  const fork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    // The runtime context is captured at the UI boundary. Its map contains the
    // services required by the caller-supplied effect.
    Effect.runForkWith(Context.makeUnsafe<R>(services.mapUnsafe))(effect)

  const call = <A, E, R>(effect: Effect.Effect<A, E, R>): void => {
    const fiber = fork(effect)

    fiber.addObserver((exit) => {
      if (Exit.isFailure(exit)) {
        log.error("call.failed", { error: Cause.pretty(exit.cause) })
      }
    })

    onCleanup(() => {
      Effect.runFork(Fiber.interrupt(fiber))
    })
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
