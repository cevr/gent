import { describe, expect, it, test } from "effect-bun-test"
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { ExtensionId, getToolId } from "@gent/core/extensions/api"
import { BuiltinExtensionModules, BuiltinExtensions } from "../src/index.js"
import { homedir } from "node:os"
import { BunChildProcessSpawner, BunFileSystem, BunServices } from "@effect/platform-bun"
import { toCodecAnthropic } from "effect/ai/AnthropicStructuredOutput"
import { e2ePreset, shippedPreset } from "./helpers/test-preset.js"
import { GentPlatform } from "@gent/core/host"
import {
  collectTestContributions,
  createRpcHarness,
  LanguageModelLayers,
  textStep,
} from "@gent/core/test-utils"

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

// ── session deletion ────────────────────────────────────────────────────────

/** The builtin stores that keep one `<branchId>.json` per branch. */
const BRANCH_STATE_DIRECTORIES = ["goals", "wakes", "delegates"] as const

describe("session deletion", () => {
  it.scopedLive.layer(BunFileSystem.layer)(
    "a deleted session's branch files go with it in every branch store; another's stay",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-branch-deleted-" })
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          cwd: directory,
          home: directory,
        })
        const second = yield* client.branch.create({ sessionId })
        const branches = [branchId, second.branchId, "another-session-branch"]
        const files = BRANCH_STATE_DIRECTORIES.map((name) =>
          branches.map((branch) => `${directory}/.gent/${name}/${branch}.json`),
        )
        yield* Effect.forEach(
          BRANCH_STATE_DIRECTORIES,
          (name) => fs.makeDirectory(`${directory}/.gent/${name}`, { recursive: true }),
          { discard: true },
        )
        // The removal reads nothing, so a file of any content goes.
        yield* Effect.forEach(files.flat(), (file) => fs.writeFileString(file, "unread"), {
          discard: true,
        })

        yield* client.session.delete({ sessionId })

        const left = yield* Effect.forEach(files, (store) => Effect.forEach(store, fs.exists))
        expect(left).toEqual(BRANCH_STATE_DIRECTORIES.map(() => [false, false, true]))
      }).pipe(Effect.timeout("4 seconds")),
  )
})
