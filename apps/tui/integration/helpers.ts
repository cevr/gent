import { Effect } from "effect"
import * as path from "node:path"
import { renderFrame, type renderWithProviders } from "../tests/render-harness"

export { renderFrame }

export const repoRoot = path.resolve(import.meta.dir, "../../..")

type TestSetup = Awaited<ReturnType<typeof renderWithProviders>>

/**
 * Effect-based frame polling for integration tests.
 *
 * Double-flushes renderOnce + microtask between polls to catch
 * async Solid state updates from Effect fibers.
 */
export const waitForFrame = (
  setup: TestSetup,
  predicate: (frame: string) => boolean,
  label: string,
  timeoutMs = 5_000,
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const startedAt = Date.now()
    let lastFrame = ""

    while (Date.now() - startedAt < timeoutMs) {
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() => Promise.resolve())
      yield* Effect.promise(() => setup.renderOnce())

      const frame = renderFrame(setup)
      lastFrame = frame
      if (predicate(frame)) return frame

      yield* Effect.sleep("10 millis")
    }

    return yield* Effect.fail(
      new Error(`timed out waiting for rendered frame: ${label}\n${lastFrame}`),
    )
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
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() => Promise.resolve())
      yield* Effect.promise(() => setup.renderOnce())

      if (predicate()) return

      yield* Effect.sleep("10 millis")
    }

    return yield* Effect.fail(new Error(`timed out waiting for condition: ${label}`))
  })

export const makeSessionState = (created: {
  sessionId: string
  branchId: string
  name: string
}) => ({
  sessionId: created.sessionId,
  branchId: created.branchId,
  name: created.name,
  reasoningLevel: undefined,
})
