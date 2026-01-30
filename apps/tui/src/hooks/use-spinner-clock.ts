import { createRoot, createSignal, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"

const ticker = createRoot(() => {
  const [tick, setTick] = createSignal(0)
  const interval = setInterval(() => {
    setTick((current) => current + 1)
  }, 150)
  onCleanup(() => clearInterval(interval))
  return tick
})

export const useSpinnerClock = (): Accessor<number> => ticker
