import { createRoot, createSignal, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import { Effect, Fiber, Schedule } from "effect"

const ticker = createRoot(() => {
  const [tick, setTick] = createSignal(0)
  const fiber = Effect.runFork(
    Effect.sync(() => {
      setTick((current) => current + 1)
    }).pipe(Effect.repeat(Schedule.spaced("60 millis"))),
  )
  onCleanup(() => {
    Effect.runFork(Fiber.interrupt(fiber))
  })
  return tick
})

export const useSpinnerClock = (): Accessor<number> => ticker
