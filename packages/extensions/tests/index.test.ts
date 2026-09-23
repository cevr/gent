import { describe, expect, it, test } from "effect-bun-test"
import { Effect, Layer, Option, Schema } from "effect"
import { ExtensionId, getToolId } from "@gent/core/extensions/api"
import { BuiltinExtensions } from "../src/index.js"
import { homedir } from "node:os"
import { BunChildProcessSpawner, BunServices } from "@effect/platform-bun"
import { toCodecAnthropic } from "effect/unstable/ai/AnthropicStructuredOutput"
import { shippedPreset } from "./helpers/test-preset.js"
import { GentPlatform } from "@gent/core/host"
import { collectTestContributions } from "@gent/core/test-utils"

// ── starting extensions ─────────────────────────────────────────────────────

const hasPublicExtensionContract = (extension: (typeof BuiltinExtensions)[number]) =>
  Schema.is(ExtensionId)(extension.manifest.id) && Effect.isEffect(extension.setup)

describe("starting extensions", () => {
  test("exported starting set uses the public extension shape", () => {
    expect(BuiltinExtensions.length).toBeGreaterThan(0)
    expect(BuiltinExtensions.every(hasPublicExtensionContract)).toBe(true)
  })
})

// ── tool schemas ────────────────────────────────────────────────────────────

describe("builtin tool schemas", () => {
  it.live("are compatible with Anthropic tool structured output", () => {
    const home = homedir()

    return Effect.gen(function* () {
      const failures: string[] = []

      for (const extension of shippedPreset.extensionInputs) {
        const contributions = yield* collectTestContributions(extension.setup, {
          cwd: process.cwd(),
          home,
        })

        for (const tool of contributions.tools ?? []) {
          const failure = yield* Effect.try({
            try: () => toCodecAnthropic(tool.parametersSchema),
            catch: (cause) => String(cause),
          }).pipe(
            Effect.match({
              onFailure: Option.some,
              onSuccess: ({ jsonSchema }) => {
                if (jsonSchema["type"] !== "object") {
                  return Option.some(
                    `expected top-level object schema, got type ${String(jsonSchema["type"])}`,
                  )
                }
                return Option.none<string>()
              },
            }),
          )
          if (Option.isSome(failure)) {
            failures.push(`${extension.manifest.id}/${getToolId(tool)}: ${failure.value}`)
          }
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
    )
  })
})
