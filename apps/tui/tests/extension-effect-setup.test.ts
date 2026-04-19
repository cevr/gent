/**
 * C9.1/C9.3 lock: `loadTuiExtensions` accepts both legacy sync `setup(ctx)` AND
 * Effect-typed `setup` shapes via the new `runtime: ManagedRuntime` opt.
 *
 * This proves the bridge in `loader-boundary.ts` (`invokeSetup`) routes
 * correctly based on `Effect.isEffect` and that an Effect-typed setup whose
 * deps are `FileSystem | Path` resolves through the platform runtime.
 *
 * C9.3: the loader no longer takes `fs`/`path` parameters — discovery runs
 * through the runtime so any runtime that satisfies `FileSystem | Path`
 * works. The legacy `AsyncFileSystem` proxy is gone.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, FileSystem, Layer, ManagedRuntime, Path } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import {
  type AutocompleteContribution,
  autocompleteContribution,
  type ExtensionClientContext,
  type ExtensionClientModule,
} from "@gent/core/domain/extension-client.js"
import type { ClientEffect } from "@gent/core/domain/client-effect.js"
import { loadTuiExtensions } from "../src/extensions/loader-boundary"

const runtime = ManagedRuntime.make(Layer.merge(BunFileSystem.layer, BunServices.layer))

const noopCtx = (cwd = "/tmp"): ExtensionClientContext =>
  ({
    cwd,
    home: "/tmp",
    openOverlay: () => {},
    closeOverlay: () => {},
    send: () => {},
    getSnapshotRaw: () => undefined,
    sendMessage: () => {},
    composerState: () => ({
      draft: "",
      mode: "editing",
      inputFocused: false,
      autocompleteOpen: false,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

describe("loadTuiExtensions setup-shape bridge (C9.1/C9.3)", () => {
  test("legacy sync setup(ctx) returning array is invoked with the ctx", async () => {
    const seen: ExtensionClientContext[] = []
    const legacy: ExtensionClientModule = {
      id: "@test/legacy",
      setup: (ctx) => {
        seen.push(ctx)
        return [
          autocompleteContribution({
            prefix: "?",
            title: "legacy",
            items: () => [{ id: "x", label: "x" }],
          }),
        ]
      },
    }
    const result = await loadTuiExtensions(
      {
        builtins: [legacy],
        userDir: "/tmp/u-c9-1",
        projectDir: "/tmp/p-c9-1",
        runtime,
      },
      noopCtx,
    )
    expect(seen).toHaveLength(1)
    expect(result.autocompleteItems.map((c) => c.prefix)).toContain("?")
  })

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
    const result = await loadTuiExtensions(
      {
        builtins: [ext],
        userDir: "/tmp/u-c9-1-fx",
        projectDir: "/tmp/p-c9-1-fx",
        runtime,
      },
      noopCtx,
    )
    expect(result.autocompleteItems.map((c) => c.prefix)).toContain("!")
  })

  // C9.1 codex BLOCK 1 lock — discovered (not pre-imported) modules with an
  // Effect-valued `setup` must pass `importExtension`'s shape validator. The
  // bridge in `invokeSetup` is only reachable if the validator accepts the
  // value; rejecting non-functions silently dropped the entire discovered
  // population for the new shape.
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
import { autocompleteContribution } from "@gent/core/domain/extension-client.js"

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
      const result = await loadTuiExtensions({ userDir, projectDir, runtime }, noopCtx)
      expect(result.autocompleteItems.map((c) => c.prefix)).toContain("#")
    })
  })
})
