import { renderFrame, type renderWithProviders } from "./render-harness"

export { renderFrame }

type TestSetup = Awaited<ReturnType<typeof renderWithProviders>>

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
  const startedAt = Date.now()
  let lastFrame = ""

  const loop = (): Promise<string> =>
    setup.renderOnce().then(() => {
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`timed out waiting for rendered frame: ${label}\n${lastFrame}`)
      }
      const frame = renderFrame(setup)
      lastFrame = frame
      if (predicate(frame)) return frame
      return new Promise<void>((resolve) => {
        setTimeout(resolve, 10)
      }).then(loop)
    })

  return loop()
}
