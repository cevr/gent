/**
 * Effect-purity regression locks (compile-time).
 *
 * These tests are TYPE-LEVEL only — every `@ts-expect-error` line proves that
 * the contribution surface rejects async/Promise handlers at compile time.
 * If TypeScript ever stops erroring on these, the surface has regressed and
 * Promise edges have leaked back in.
 *
 * Tied to Commit 0 of the planify plan and the project_effect_purity_boundaries
 * memory. After C12 the surface is `defineExtension` + smart constructors
 * (no fluent builder), so the locks are written against those primitives.
 */

import { describe, test, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import {
  busSubscriptionContribution,
  commandContribution,
  defineExtension,
  defineInterceptor,
  defineResource,
  defineTool,
  interceptorContribution,
  onShutdownContribution,
  onStartupContribution,
  toolContribution,
} from "@gent/core/extensions/api"

describe("Effect-purity locks (compile-time)", () => {
  test("defineTool.execute MUST return Effect — async handler rejected", () => {
    defineTool({
      name: "ok",
      description: "ok",
      params: Schema.Struct({}),
      // @ts-expect-error — async handler must not be assignable to Effect-returning execute
      execute: async () => "result",
    })
    expect(true).toBe(true)
  })

  test("commandContribution.handler MUST return Effect — async handler rejected", () => {
    commandContribution({
      name: "deploy",
      // @ts-expect-error — async handler must not be assignable to Effect-returning handler
      handler: async () => undefined,
    })
    expect(true).toBe(true)
  })

  test("defineInterceptor handler MUST return Effect — async handler rejected", () => {
    interceptorContribution(
      // @ts-expect-error — async handler must not be assignable to Effect-returning interceptor
      defineInterceptor("prompt.system", async (input, next) => next(input)),
    )
    expect(true).toBe(true)
  })

  test("busSubscriptionContribution handler MUST return Effect — async handler rejected", () => {
    // @ts-expect-error — async handler must not be assignable to Effect-returning bus handler
    busSubscriptionContribution("agent:*", async () => undefined)
    expect(true).toBe(true)
  })

  test("onStartup/onShutdown contributions MUST be Effects — Promise rejected", () => {
    // @ts-expect-error — Promise must not be assignable to Effect lifecycle contribution
    onStartupContribution(Promise.resolve())
    // @ts-expect-error — Promise must not be assignable to Effect lifecycle contribution
    onShutdownContribution(Promise.resolve())
    expect(true).toBe(true)
  })

  test("contribution lowering compiles for valid Effect handlers", () => {
    // Positive case to ensure the @ts-expect-error lines are guarding real
    // breakage rather than a generally broken type. If this test regresses
    // to a compile error, the surface has narrowed too far.
    const ext = defineExtension({
      id: "purity-positive",
      contributions: () => [
        toolContribution(
          defineTool({
            name: "noop",
            description: "noop",
            params: Schema.Struct({}),
            execute: () => Effect.succeed("ok"),
          }),
        ),
        interceptorContribution(defineInterceptor("prompt.system", (i, next) => next(i))),
        busSubscriptionContribution("agent:*", () => Effect.void),
        onStartupContribution(Effect.void),
        onShutdownContribution(Effect.void),
        commandContribution({ name: "ok", handler: () => Effect.void }),
        defineResource({
          scope: "process",
          layer: Layer.empty,
          schedule: [
            {
              id: "j",
              cron: "0 0 * * *",
              target: { kind: "headless-agent", agent: "cowork" as never, prompt: "hi" },
            },
          ],
        }),
      ],
    })
    expect(ext.manifest.id).toBe("purity-positive")
  })
})
