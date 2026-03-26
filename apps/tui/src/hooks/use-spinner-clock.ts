import { createRoot, createSignal, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"

let disposeTicker: (() => void) | undefined

const ticker = createRoot((dispose) => {
  disposeTicker = dispose
  const [tick, setTick] = createSignal(0)
  const interval = setInterval(() => {
    setTick((current) => current + 1)
  }, 150)
  onCleanup(() => clearInterval(interval))
  return tick
})

export const useSpinnerClock = (): Accessor<number> => ticker

/** Dispose the spinner root — call during shutdown to stop the interval */
export const disposeSpinnerClock = () => disposeTicker?.()
