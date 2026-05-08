import { test } from "bun:test"
import { Effect } from "effect"

test("manual cleanup is banned", async () => {
  try {
    return await work()
  } finally {
    cleanup()
  }
})

test("promise chains are banned", () => work().then((value) => value))

test("promise catch is banned", () => work().catch(() => "fallback"))

test("promise finally is banned", () => work().finally(cleanup))

test("promise aggregation is banned", () => Promise.all([work()]))

test("effect runPromise is banned", () => Effect.runPromise(Effect.succeed("work")))

test("effect runPromise in pipe is banned", () => Effect.succeed("work").pipe(Effect.runPromise))

test("runtime runPromise is banned", () => runtime.runPromise(Effect.succeed("work")))

async function work(): Promise<string> {
  return "work"
}

declare const cleanup: () => void
declare const runtime: { runPromise: <A>(effect: Effect.Effect<A>) => Promise<A> }
