/**
 * Lock: `loadTuiExtensions` runs Effect-typed `setup` values through the
 * provided `runtime: ManagedRuntime`. C9.1's legacy sync `setup(ctx)` arm
 * was deleted in B11.6 — only the Effect shape is accepted now.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, FileSystem, Layer, ManagedRuntime, Path } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import {
  type AutocompleteContribution,
  autocompleteContribution,
  type ClientRuntime,
  type ExtensionClientModule,
} from "../src/extensions/client-facets.js"
import type { ClientEffect } from "../src/extensions/client-effect.js"
import { loadTuiExtensions } from "../src/extensions/loader-boundary"

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture
const runtime = ManagedRuntime.make(
  Layer.merge(BunFileSystem.layer, BunServices.layer),
) as unknown as ClientRuntime

describe("loadTuiExtensions Effect setup", () => {
  test("Effect setup is run through the runtime; FileSystem is provided", async () => {
    const fxSetup: ClientEffect<ReadonlyArray<AutocompleteContribution>> = Effect.gen(function* () {
      // Prove we can reach a FileSystem from the runtime.
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      // Touch both services so unused imports don't get optimized away.
      expect(typeof fs.readFileString).toBe("function")
      expect(typeof path.join).toBe("function")
      return [
        autocompleteContribution({
          prefix: "!",
          title: "effect",
          items: () => [{ id: "y", label: "y" }],
        }),
      ]
    })
    const ext: ExtensionClientModule = { id: "@test/effect", setup: fxSetup }
    const result = await loadTuiExtensions({
      builtins: [ext],
      userDir: "/tmp/u-c9-1-fx",
      projectDir: "/tmp/p-c9-1-fx",
      runtime,
    })
    expect(result.autocompleteItems.map((c) => c.prefix)).toContain("!")
  })

  // C9.1 codex BLOCK 1 lock — discovered (not pre-imported) modules with an
  // Effect-valued `setup` must pass `importExtension`'s shape validator. The
  // bridge is only reachable if the validator accepts the value; rejecting
  // non-functions silently dropped the entire discovered population.
  describe("discovered Effect-setup modules", () => {
    const tmpRoot = join(import.meta.dir, ".tmp-c9-1-discovery")
    const userDir = join(tmpRoot, "user")
    const projectDir = join(tmpRoot, "project")

    beforeAll(() => {
      rmSync(tmpRoot, { recursive: true, force: true })
      mkdirSync(userDir, { recursive: true })
      mkdirSync(projectDir, { recursive: true })
      // Effect-valued `setup` — exactly the shape C9.1 promises will work.
      writeFileSync(
        join(userDir, "discovered.client.ts"),
        `
import { Effect } from "effect"
import { autocompleteContribution } from "../../../src/extensions/client-facets.js"

export default {
  id: "@test/discovered-effect",
  setup: Effect.gen(function* () {
    return [
      autocompleteContribution({
        prefix: "#",
        title: "discovered",
        items: () => [{ id: "z", label: "z" }],
      }),
    ]
  }),
}
`.trim(),
      )
    })

    afterAll(() => {
      rmSync(tmpRoot, { recursive: true, force: true })
    })

    test("imports + runs an Effect-valued setup discovered from userDir", async () => {
      const result = await loadTuiExtensions({ userDir, projectDir, runtime })
      expect(result.autocompleteItems.map((c) => c.prefix)).toContain("#")
    })
  })
})
