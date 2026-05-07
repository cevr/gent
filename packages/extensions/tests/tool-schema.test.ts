import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { homedir } from "node:os"
import { BunChildProcessSpawner, BunServices } from "@effect/platform-bun"
import { toCodecAnthropic } from "effect/unstable/ai/AnthropicStructuredOutput"
import { getToolId } from "@gent/core/extensions/api"
import { BuiltinExtensions } from "@gent/extensions"
import { GentPlatform } from "../../core/src/runtime/gent-platform"
import { setupExtension } from "../../core/src/runtime/extensions/loader"

const narrowR = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
  effect as Effect.Effect<A, E, never>

describe("builtin tool schemas", () => {
  it.live("are compatible with Anthropic tool structured output", () => {
    const home = homedir()

    return narrowR(
      Effect.gen(function* () {
        const failures: string[] = []

        for (const extension of BuiltinExtensions) {
          const loaded = yield* setupExtension(
            { extension, scope: "builtin", sourcePath: "builtin" },
            process.cwd(),
            home,
          )

          for (const tool of loaded.contributions.tools ?? []) {
            const failure = yield* Effect.sync(() => {
              try {
                const { jsonSchema } = toCodecAnthropic(tool.parametersSchema)
                if (jsonSchema["type"] !== "object") {
                  return `expected top-level object schema, got type ${String(jsonSchema["type"])}`
                }
                return undefined
              } catch (error) {
                return String(error)
              }
            })
            if (failure !== undefined)
              failures.push(`${loaded.manifest.id}/${getToolId(tool)}: ${failure}`)
          }
        }

        expect(failures).toEqual([])
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            BunChildProcessSpawner.layer.pipe(Layer.provide(BunServices.layer)),
            GentPlatform.Test(),
          ),
        ),
      ),
    )
  })
})
