import { renderFrame, type renderWithProviders } from "./render-harness-boundary"
import { Clock, Effect, type ManagedRuntime, Schema } from "effect"

export { renderFrame }

type TestSetup = Awaited<ReturnType<typeof renderWithProviders>>

/** Run `effect` against a managed runtime's services, inside the calling test's fiber. */
export const inRuntime = <A, E, R, ER>(
  runtime: ManagedRuntime.ManagedRuntime<R, ER>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ER> =>
  runtime.contextEffect.pipe(Effect.flatMap((context) => Effect.provideContext(effect, context)))

class RenderFrameTimeoutError extends Schema.TaggedError<RenderFrameTimeoutError>()(
  "RenderFrameTimeoutError",
  {
    message: Schema.String,
  },
) {}

/**
 * Frame polling for unit render tests.
 *
 * Polls renderOnce until the predicate matches or the timeout expires.
 * Uses wall-clock timeout (not iteration count) for predictable behavior.
 */
export const waitForRenderedFrame = (
  setup: TestSetup,
  predicate: (frame: string) => boolean,
  label = "condition",
  timeoutMs = 2_000,
): Promise<string> => {
  let lastFrame = ""

  const loop = (startedAt: number): Effect.Effect<string, RenderFrameTimeoutError> =>
    Effect.gen(function* () {
      yield* Effect.promise(() => setup.renderOnce())
      // Test the frame we just rendered before consulting the clock. Checking
      // the deadline first throws away an unexamined frame, so a condition that
      // becomes true on the final render is reported as a timeout.
      const frame = renderFrame(setup)
      lastFrame = frame
      if (predicate(frame)) return frame
      const now = yield* Clock.currentTimeMillis
      if (now - startedAt >= timeoutMs) {
        return yield* new RenderFrameTimeoutError({
          message: `timed out waiting for rendered frame: ${label}\n${lastFrame}`,
        })
      }
      // gent/no-sleep: allow render-poll primitive — TUI frame must be re-rendered between observations
      yield* Effect.sleep("10 millis")
      return yield* loop(startedAt)
    })

  return Effect.runPromise(Clock.currentTimeMillis.pipe(Effect.flatMap(loop)))
}
