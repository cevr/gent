import { renderFrame, type renderWithProviders } from "./render-harness"
import { Clock, Effect, Schema } from "effect"

export { renderFrame }

type TestSetup = Awaited<ReturnType<typeof renderWithProviders>>

class RenderFrameTimeoutError extends Schema.TaggedErrorClass<RenderFrameTimeoutError>()(
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
      const now = yield* Clock.currentTimeMillis
      if (now - startedAt >= timeoutMs) {
        return yield* new RenderFrameTimeoutError({
          message: `timed out waiting for rendered frame: ${label}\n${lastFrame}`,
        })
      }
      const frame = renderFrame(setup)
      lastFrame = frame
      if (predicate(frame)) return frame
      yield* Effect.sleep("10 millis")
      return yield* loop(startedAt)
    })

  return Effect.runPromise(Clock.currentTimeMillis.pipe(Effect.flatMap(loop)))
}
