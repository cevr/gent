import { describe, it, expect, test } from "effect-bun-test"
import { Effect } from "effect"

const throwCleanup = (): never => Effect.runSync(Effect.die("boom"))

describe("transport-only extension widgets", () => {
  test("cleanups fire in registration order", () => {
    const calls: string[] = []
    const cleanups: Array<() => void> = []
    const lifecycle = { addCleanup: (fn: () => void) => cleanups.push(fn) }
    lifecycle.addCleanup(() => calls.push("first"))
    lifecycle.addCleanup(() => calls.push("second"))
    lifecycle.addCleanup(() => calls.push("third"))
    for (const cleanup of cleanups) cleanup()
    expect(calls).toEqual(["first", "second", "third"])
  })
  it.live("a thrown cleanup does not block later cleanups", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const cleanups: Array<() => void> = []
      const lifecycle = { addCleanup: (fn: () => void) => cleanups.push(fn) }
      lifecycle.addCleanup(() => calls.push("before-throw"))
      lifecycle.addCleanup(throwCleanup)
      lifecycle.addCleanup(() => calls.push("after-throw"))
      yield* Effect.forEach(cleanups, (cleanup) => Effect.sync(cleanup).pipe(Effect.ignoreCause))
      expect(calls).toEqual(["before-throw", "after-throw"])
    }),
  )
})
