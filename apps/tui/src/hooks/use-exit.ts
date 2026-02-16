import { useRenderer } from "@opentui/solid"

const ESC_DOUBLE_TAP_MS = 500

/**
 * Double-ESC quit logic. Returns a function that should be called on ESC press.
 * First ESC records timestamp; second ESC within 500ms exits.
 */
export function useExit() {
  const renderer = useRenderer()
  let lastEscTime = 0

  const exit = () => {
    renderer.destroy()
    process.exit(0)
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
