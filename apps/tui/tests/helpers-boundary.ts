import { renderFrame, type renderWithProviders } from "./render-harness-boundary"
import { Effect, type ManagedRuntime, Schema } from "effect"

export { renderFrame }

type TestSetup = Awaited<ReturnType<typeof renderWithProviders>>

/** Run `effect` against a managed runtime's services, inside the calling test's fiber. */
export const inRuntime = <A, E, R, ER>(
  runtime: ManagedRuntime.ManagedRuntime<R, ER>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ER> =>
  runtime.contextEffect.pipe(Effect.flatMap((context) => Effect.provideContext(effect, context)))

export class RenderWaitTimeoutError extends Schema.TaggedError<RenderWaitTimeoutError>()(
  "RenderWaitTimeoutError",
  {
    message: Schema.String,
  },
) {}

/**
 * Repeat `observe` until it holds or `timeoutMs` passes.
 *
 * The deadline is an `Effect.timeout` on the poll, so the poll stops with the
 * test fiber: an outer timeout or interrupt ends it, and it never touches a
 * torn-down setup. The error message is read at the deadline, so it can carry
 * the last observation.
 */
const pollUntil = (
  observe: Effect.Effect<boolean>,
  describe: () => string,
  timeoutMs: number,
): Effect.Effect<void, RenderWaitTimeoutError> => {
  const poll: Effect.Effect<void> = Effect.gen(function* () {
    if (yield* observe) return
    // gent/no-sleep: allow render-poll primitive — state must settle between observations
    yield* Effect.sleep("10 millis")
    return yield* poll
  })
  return poll.pipe(
    Effect.timeoutOrElse({
      duration: `${timeoutMs} millis`,
      orElse: () => Effect.fail(new RenderWaitTimeoutError({ message: describe() })),
    }),
  )
}

/**
 * Render until `check` holds, then return the frame.
 *
 * Each poll renders twice with a fiber yield between, so a Solid update that an
 * Effect fiber scheduled during the first render lands before the check.
 * `check` may ignore the frame and read other state.
 */
export const waitForFrame = (
  setup: TestSetup,
  check: (frame: string) => boolean,
  label = "condition",
  timeoutMs = 2_000,
): Effect.Effect<string, RenderWaitTimeoutError> => {
  let lastFrame = ""
  return pollUntil(
    Effect.gen(function* () {
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())
      lastFrame = renderFrame(setup)
      return check(lastFrame)
    }),
    () => `timed out waiting for rendered frame: ${label}\n${lastFrame}`,
    timeoutMs,
  ).pipe(Effect.map(() => lastFrame))
}

/**
 * Wait until `check` holds, running `advance` before each look: for work
 * that runs on a test clock, which `advance` moves one step.
 */
export const waitUntilAdvancing = (
  advance: Effect.Effect<void>,
  check: () => boolean,
  label = "condition",
  timeoutMs = 2_000,
): Effect.Effect<void, RenderWaitTimeoutError> =>
  pollUntil(Effect.map(advance, check), () => `timed out waiting for: ${label}`, timeoutMs)

/** Wait, without rendering, until `check` holds: for reactive state outside a render tree. */
export const waitUntil = (
  check: () => boolean,
  label = "condition",
  timeoutMs = 2_000,
): Effect.Effect<void, RenderWaitTimeoutError> =>
  pollUntil(Effect.sync(check), () => `timed out waiting for: ${label}`, timeoutMs)
