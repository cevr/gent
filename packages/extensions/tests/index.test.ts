import { describe, expect, it } from "effect-bun-test"
import { Effect, FileSystem, Layer, Option, Path } from "effect"
import { getToolId, runProcess } from "@gent/core/extensions/api"
import { BuiltinExtensionModules } from "../src/index.js"
import { BunChildProcessSpawner, BunFileSystem, BunServices } from "@effect/platform-bun"
import { toCodecAnthropic } from "effect/ai/AnthropicStructuredOutput"
import { e2ePreset, shippedPreset } from "./helpers/test-preset.js"
import { BunPlatformLive, GentPlatform } from "@gent/core/host"
import {
  collectTestContributions,
  createRpcHarness,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  textStep,
} from "@gent/core/test-utils"

// ── builtin peer modules ────────────────────────────────────────────────────

/** An `effect`, `effect/*` or `@effect/*` specifier; `effect-encore` is not one. */
const EFFECT_SPECIFIER = /^(?:effect(?:\/.+)?|@effect\/.+)$/
const IMPORT_SOURCE = /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)"([^"]+)"/gm

// oxlint-disable-next-line effect/noDynamicImports -- the test compares each binding with the module its name resolves to here
const importSpecifier = (specifier: string) => Effect.promise(() => import(specifier))

describe("builtin peer modules", () => {
  it.live("bind exactly the effect modules the shipped extensions import", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const testsDirectory = yield* path.fromFileUrl(new URL(".", import.meta.url))
      const roots = [
        path.join(testsDirectory, "..", "src"),
        path.join(testsDirectory, "..", "..", "..", "examples", "extensions"),
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
        let bound = source()
        if (bound instanceof Promise) {
          const pending = bound
          bound = yield* Effect.promise(() => pending)
        }
        expect({ specifier, same: bound === resolved }).toEqual({ specifier, same: true })
      }
    }).pipe(Effect.timeout("20 seconds"), Effect.provide(BunServices.layer)),
  )

  // A test process has loaded the SDKs and bound no module, so these run in a
  // fresh process.
  it.live("importing the shipped extensions loads no provider SDK", () =>
    Effect.gen(function* () {
      const stdout = yield* runFresh(
        [
          `await import("${extensionsEntry}")`,
          `console.log(Object.keys(require.cache).filter((key) => key.includes("/@effect/ai-")).join("\\n"))`,
        ],
        [],
      )
      expect(stdout).toBe("")
    }).pipe(Effect.timeout("25 seconds"), Effect.provide(freshProcessLayer)),
  )

  it.live("a user extension imports a provider SDK the shipped drivers load late", () =>
    Effect.gen(function* () {
      const stdout = yield* runFresh(
        [
          `const { Effect } = await import("${import.meta.resolve("effect")}")`,
          `const { bindBunModules } = await import("${import.meta.resolve("@gent/core/host")}")`,
          `const { BuiltinExtensionModules } = await import("${extensionsEntry}")`,
          `await Effect.runPromise(bindBunModules(BuiltinExtensionModules))`,
          `const { AnthropicClient } = await import("./user-extension.ts")`,
          `console.log(typeof AnthropicClient.layer)`,
        ],
        [["user-extension.ts", `export { AnthropicClient } from "@effect/ai-anthropic"`]],
      )
      expect(stdout).toBe("function")
    }).pipe(Effect.timeout("25 seconds"), Effect.provide(freshProcessLayer)),
  )
})

const extensionsEntry = new URL("../src/index.ts", import.meta.url).href

/** Run `lines` as a script in a fresh Bun beside `files`; its stdout, trimmed. */
const runFresh = (
  lines: ReadonlyArray<string>,
  files: ReadonlyArray<readonly [name: string, text: string]>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const platform = yield* GentPlatform
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-fresh-process-" })
      for (const [name, text] of files) yield* fs.writeFileString(path.join(directory, name), text)
      const script = path.join(directory, "script.ts")
      yield* fs.writeFileString(script, lines.join("\n"))
      const result = yield* runProcess(yield* platform.execPath, ["--config=/dev/null", script], {
        cwd: directory,
      })
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      })
      return result.stdout.trim()
    }),
  )

const freshProcessLayer = Layer.mergeAll(
  BunPlatformLive,
  BunChildProcessSpawner.layer.pipe(Layer.provide(BunServices.layer)),
)

// ── tool schemas ────────────────────────────────────────────────────────────

describe("builtin tool schemas", () => {
  // A temp home and cwd, so the user's own `~/.gent` cannot change the set.
  it.scopedLive("are compatible with Anthropic tool structured output", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("gent-schemas-home-")
      const cwd = yield* makeTempDirectoryScoped("gent-schemas-cwd-")
      const failures: string[] = []

      for (const extension of shippedPreset.extensionInputs) {
        const contributions = yield* collectTestContributions(extension.setup, { cwd, home })

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
    ),
  )
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
