/**
 * Lock: `loadTuiExtensions` runs Effect-typed `setup` values through the
 * provided `runtime: ManagedRuntime`. Only the Effect setup shape is accepted.
 */
import { describe, it, expect } from "effect-bun-test"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdirSync, rmSync, writeFileSync } from "node:fs" // eslint-disable-line effect/noNodeBuiltinImport -- synchronous filesystem fixture setup is a test boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path" // eslint-disable-line effect/noNodeBuiltinImport -- synchronous path fixture setup is a test boundary.
import { Effect, FileSystem, Path, Predicate } from "effect"
import {
  autocompleteContribution,
  type ClientContributions,
  type ExtensionClientModule,
} from "../src/extensions/client-facets.js"
import type { ClientEffect } from "../src/extensions/client-effect.js"
import { ClientSetupError } from "../src/extensions/client-effect.js"
import { loadTuiExtensions } from "../src/extensions/loader-boundary"
import { makeClientExtensionRuntime } from "./extension-test-harness-boundary"
const runtime = makeClientExtensionRuntime()
describe("loadTuiExtensions Effect setup", () => {
  it.live("Effect setup is run through the runtime; FileSystem is provided", () =>
    Effect.gen(function* () {
      const fxSetup: ClientEffect<ClientContributions> = Effect.gen(function* () {
        // Prove we can reach a FileSystem from the runtime.
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        // Touch both services so unused imports don't get optimized away.
        expect(Predicate.isFunction(fs.readFileString)).toBe(true)
        expect(Predicate.isFunction(path.join)).toBe(true)
        return autocompleteContribution({
          prefix: "!",
          title: "effect",
          items: () => [{ id: "y", label: "y" }],
        })
      })
      const ext: ExtensionClientModule = { id: "@test/effect", setup: fxSetup }
      const result = yield* Effect.promise(() =>
        loadTuiExtensions({
          builtins: [ext],
          userDir: "/tmp/u-c9-1-fx",
          projectDir: "/tmp/p-c9-1-fx",
          runtime,
        }),
      )
      expect(result.autocompleteItems.map((c) => c.prefix)).toContain("!")
    }),
  )
  it.live("isolates enabled setup failures and keeps healthy contributions", () =>
    Effect.gen(function* () {
      const good: ExtensionClientModule = {
        id: "@test/good",
        setup: Effect.succeed(
          autocompleteContribution({
            prefix: "!",
            title: "good",
            items: () => [{ id: "good", label: "good" }],
          }),
        ),
      }
      const broken: ExtensionClientModule = {
        id: "@test/broken",
        setup: Effect.fail(
          new ClientSetupError({
            extensionId: "@test/broken",
            message: "setup failed",
          }),
        ),
      }
      const result = yield* Effect.promise(() =>
        loadTuiExtensions({
          builtins: [good, broken],
          userDir: "/tmp/u-c9-1-fx-failure",
          projectDir: "/tmp/p-c9-1-fx-failure",
          runtime,
        }),
      )
      expect(result.autocompleteItems.map((c) => c.prefix)).toContain("!")
    }),
  )
  // Regression lock — discovered (not pre-imported) modules with an
  // Effect-valued `setup` must pass `importExtension`'s shape validator.
  // Rejecting Effect values silently drops the entire discovered population.
  describe("discovered Effect-setup modules", () => {
    const tmpRoot = join(import.meta.dir, "../.tmp-c9-1-discovery")
    const userDir = join(tmpRoot, "user")
    const projectDir = join(tmpRoot, "project")
    const discoveryFixture = Effect.acquireRelease(
      Effect.sync(() => {
        rmSync(tmpRoot, { recursive: true, force: true })
        mkdirSync(userDir, { recursive: true })
        mkdirSync(projectDir, { recursive: true })
        // Effect-valued `setup` — exactly the accepted shape.
        writeFileSync(
          join(userDir, "discovered.client.ts"),
          `
import { Effect } from "effect"
import { autocompleteContribution } from "../../src/extensions/client-facets.js"

export default {
  id: "@test/discovered-effect",
  setup: Effect.gen(function* () {
    return autocompleteContribution({
        prefix: "#",
        title: "discovered",
        items: () => [{ id: "z", label: "z" }],
      })
  }),
}
`.trim(),
        )
      }),
      () => Effect.sync(() => rmSync(tmpRoot, { recursive: true, force: true })),
    )
    it.scopedLive("imports + runs an Effect-valued setup discovered from userDir", () =>
      Effect.gen(function* () {
        yield* discoveryFixture
        const result = yield* Effect.promise(() =>
          loadTuiExtensions({ userDir, projectDir, runtime }),
        )
        expect(result.autocompleteItems.map((c) => c.prefix)).toContain("#")
      }),
    )
  })
})
