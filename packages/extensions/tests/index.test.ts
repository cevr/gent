import { describe, expect, it, test } from "effect-bun-test"
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { ExtensionId, getToolId } from "@gent/core/extensions/api"
import { BuiltinExtensionModules, BuiltinExtensions } from "../src/index.js"
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

// ── builtin peer modules ────────────────────────────────────────────────────

/** An `effect`, `effect/*` or `@effect/*` specifier; `effect-encore` is not one. */
const EFFECT_SPECIFIER = /^(?:effect(?:\/.+)?|@effect\/.+)$/
const IMPORT_SOURCE = /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)"([^"]+)"/gm

// gent/no-dynamic-imports: allow the test compares each binding with the module its name resolves to here
const importSpecifier = (specifier: string) => Effect.promise(() => import(specifier))

describe("builtin peer modules", () => {
  it.live("bind exactly the effect modules the shipped extensions import", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const roots = [
        path.join(import.meta.dirname, "..", "src"),
        path.join(import.meta.dirname, "..", "..", "..", "examples", "extensions"),
      ]
      const imported = new Set<string>()
      for (const root of roots) {
        const files = yield* fs.readDirectory(root, { recursive: true })
        for (const file of files.filter((name) => /\.tsx?$/.test(name))) {
          const source = yield* fs.readFileString(path.join(root, file))
          for (const [, specifier = ""] of source.matchAll(IMPORT_SOURCE)) {
            if (EFFECT_SPECIFIER.test(specifier)) imported.add(specifier)
          }
        }
      }
      expect(imported.size).toBeGreaterThan(0)
      expect([...BuiltinExtensionModules.keys()].sort()).toEqual([...imported].sort())

      for (const [specifier, source] of BuiltinExtensionModules) {
        const resolved: object = yield* importSpecifier(specifier)
        expect({ specifier, same: source() === resolved }).toEqual({ specifier, same: true })
      }
    }).pipe(Effect.timeout("20 seconds"), Effect.provide(BunServices.layer)),
  )
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
