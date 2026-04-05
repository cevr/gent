import { renderFrame, type renderWithProviders } from "./render-harness"

export { renderFrame }

type TestSetup = Awaited<ReturnType<typeof renderWithProviders>>

/**
 * Async frame polling for unit render tests.
 *
 * Polls renderOnce until the predicate matches or the timeout expires.
 * Uses wall-clock timeout (not iteration count) for predictable behavior.
 */
/* eslint-disable no-await-in-loop -- intentional polling loop */
export const waitForRenderedFrame = async (
  setup: TestSetup,
  predicate: (frame: string) => boolean,
  label = "condition",
  timeoutMs = 2_000,
): Promise<string> => {
  const startedAt = Date.now()
  let lastFrame = ""

  while (Date.now() - startedAt < timeoutMs) {
    await setup.renderOnce()
    const frame = renderFrame(setup)
    lastFrame = frame
    if (predicate(frame)) return frame
    await new Promise((r) => setTimeout(r, 10))
  }

  throw new Error(`timed out waiting for rendered frame: ${label}\n${lastFrame}`)
}
/* eslint-enable no-await-in-loop */
