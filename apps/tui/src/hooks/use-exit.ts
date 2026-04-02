import { useRenderer } from "@opentui/solid"
import { useEnv } from "../env/context"
import { syncLog } from "../utils/client-logger"

const ESC_DOUBLE_TAP_MS = 500

/**
 * Double-ESC quit logic. Returns a function that should be called on ESC press.
 * First ESC records timestamp; second ESC within 500ms exits.
 */
export function useExit() {
  const renderer = useRenderer()
  const env = useEnv()
  let lastEscTime = 0

  const exit = () => {
    // Use syncLog here — renderer.destroy() tears down Solid tree,
    // and env.shutdown() interrupts the fiber. After this point
    // the Effect runtime is shutting down.
    syncLog("exit.renderer-destroy")
    renderer.destroy()
    syncLog("exit.shutdown-signal")
    env.shutdown()
  }

  /** Call on ESC press. Returns true if exiting, false if first tap. */
  const handleEsc = (): boolean => {
    const now = Date.now()
    if (now - lastEscTime < ESC_DOUBLE_TAP_MS) {
      exit()
      return true
    }
    lastEscTime = now
    return false
  }

  return { exit, handleEsc }
}
