import { Clock, Effect, Option, Schema } from "effect"
import { renderFrame, type renderWithProviders } from "../tests/render-harness-boundary"
import type { Session } from "../src/client"
import type { BranchId, SessionId } from "@gent/core/protocol"

export { renderFrame }

class IntegrationWaitError extends Schema.TaggedError<IntegrationWaitError>()(
  "IntegrationWaitError",
  { message: Schema.String },
) {}

export const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "")

type TestSetup = Awaited<ReturnType<typeof renderWithProviders>>

/**
 * Effect-based frame polling for integration tests.
 *
 * Double-flushes renderOnce + microtask between polls to catch
 * deferred Solid state updates from Effect fibers.
 */
export const waitForFrame = (
  setup: TestSetup,
  predicate: (frame: string) => boolean,
  label: string,
  timeoutMs = 5_000,
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    let lastFrame = ""

    while ((yield* Clock.currentTimeMillis) - startedAt < timeoutMs) {
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())

      const frame = renderFrame(setup)
      lastFrame = frame
      if (predicate(frame)) return frame

      // gent/no-sleep: allow render-poll primitive — TUI frame must be re-rendered between observations
      yield* Effect.sleep("10 millis")
    }

    return yield* new IntegrationWaitError({
      message: `timed out waiting for rendered frame: ${label}\n${lastFrame}`,
    })
  })

/**
 * Effect-based condition polling for integration tests.
 *
 * Like waitForFrame but the predicate closes over external state
 * (e.g. reactive signals from a probe component) rather than reading the frame.
 */
export const waitForCondition = (
  setup: TestSetup,
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis

    while ((yield* Clock.currentTimeMillis) - startedAt < timeoutMs) {
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.renderOnce())

      if (predicate()) return

      // gent/no-sleep: allow render-poll primitive — predicate reads reactive signals updated by render
      yield* Effect.sleep("10 millis")
    }

    return yield* new IntegrationWaitError({ message: `timed out waiting for condition: ${label}` })
  })

export const makeSessionState = (created: {
  sessionId: SessionId
  branchId: BranchId
  name: string
}): Session => ({
  sessionId: created.sessionId,
  branchId: created.branchId,
  name: created.name,
  modelId: Option.getOrUndefined(Option.none()),
  reasoningLevel: Option.getOrUndefined(Option.none()),
})
