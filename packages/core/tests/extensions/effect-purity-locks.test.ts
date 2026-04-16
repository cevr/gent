/**
 * Effect-purity regression locks.
 *
 * These tests are TYPE-LEVEL only — every `@ts-expect-error` line proves that
 * the contribution surface rejects async/Promise handlers at compile time.
 * If TypeScript ever stops erroring on these, the surface has regressed and
 * Promise edges have leaked back in.
 *
 * Tied to Commit 0 of the planify plan and the project_effect_purity_boundaries
 * memory.
 */

import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { extension } from "@gent/core/extensions/api"

describe("Effect-purity locks (compile-time)", () => {
  test("SimpleToolDef.execute MUST return Effect — async function rejected", () => {
    extension("lock-tool-execute", ({ ext }) =>
      ext.tools({
        name: "ok",
        description: "ok",
        // @ts-expect-error — async handler must not be assignable to Effect-returning execute
        execute: async () => "result",
      }),
    )
    // Sanity: the Effect-returning shape compiles fine
    extension("lock-tool-execute-ok", ({ ext }) =>
      ext.tools({
        name: "ok",
        description: "ok",
        execute: () => Effect.succeed("result"),
      }),
    )
    expect(true).toBe(true)
  })

  test("CommandContribution.handler MUST return Effect — async handler rejected", () => {
    extension("lock-command-handler", ({ ext }) =>
      ext.command("cmd", {
        // @ts-expect-error — async handler must not be assignable to Effect-returning handler
        handler: async (_args, _ctx) => {},
      }),
    )
    extension("lock-command-handler-ok", ({ ext }) =>
      ext.command("cmd", {
        handler: () => Effect.void,
      }),
    )
    expect(true).toBe(true)
  })

  test("ext.on transformer MUST return Effect — async handler rejected", () => {
    extension("lock-prompt-system", ({ ext }) =>
      // @ts-expect-error — async handler must not be assignable to Effect-returning interceptor
      ext.on("prompt.system", async (input, next) => {
        const result = await next(input)
        return `${result}\n-- bad`
      }),
    )
    extension("lock-prompt-system-ok", ({ ext }) =>
      ext.on("prompt.system", (input, next) => next(input).pipe(Effect.map((s) => `${s}\n-- ok`))),
    )
    expect(true).toBe(true)
  })

  test("ext.on observer MUST return Effect — async handler rejected", () => {
    extension("lock-turn-after", ({ ext }) =>
      // @ts-expect-error — async handler must not be assignable to Effect-returning interceptor
      ext.on("turn.after", async () => {}),
    )
    extension("lock-turn-after-ok", ({ ext }) => ext.on("turn.after", () => Effect.void))
    expect(true).toBe(true)
  })

  test("ext.bus handler MUST return Effect — sync void rejected", () => {
    extension("lock-bus", ({ ext }) =>
      // @ts-expect-error — sync void handler must not be assignable to Effect-returning bus handler
      ext.bus("ch", () => {}),
    )
    extension("lock-bus-ok", ({ ext }) => ext.bus("ch", () => Effect.void))
    expect(true).toBe(true)
  })

  test("ext.onStartup MUST take Effect — function value rejected", () => {
    extension("lock-onStartup", ({ ext }) =>
      // @ts-expect-error — function must not be assignable to Effect parameter
      ext.onStartup(() => {}),
    )
    extension("lock-onStartup-ok", ({ ext }) => ext.onStartup(Effect.void))
    expect(true).toBe(true)
  })
})
