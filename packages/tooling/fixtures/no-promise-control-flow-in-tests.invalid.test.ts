import { test } from "bun:test"
import { Effect } from "effect"

test("promise chains are banned", () => work().then((value) => value))

test("promise catch is banned", () => work().catch(() => "fallback"))

test("promise finally is banned", () => work().finally(cleanup))

// A capitalised name is not a module namespace unless an import binds it.
test("a capitalised promise variable is still a promise", () => {
  const PromiseResult = work()
  return PromiseResult.catch(() => "fallback")
})

test("effect runPromise is banned", () => Effect.runPromise(Effect.succeed("work")))

test("effect runPromise in pipe is banned", () => Effect.succeed("work").pipe(Effect.runPromise))

test("runtime runPromise is banned", () => runtime.runPromise(Effect.succeed("work")))

declare const work: () => Promise<string>
declare const cleanup: () => void
declare const runtime: { runPromise: <A>(effect: Effect.Effect<A>) => Promise<A> }
