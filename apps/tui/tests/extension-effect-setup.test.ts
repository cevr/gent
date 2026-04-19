/**
 * C9.1 lock: `loadTuiExtensions` accepts both legacy sync `setup(ctx)` AND
 * Effect-typed `setup` shapes via the new `runtime: ManagedRuntime` opt.
 *
 * This proves the bridge in `loader.ts` (`invokeSetup`) routes correctly
 * based on `Effect.isEffect` and that an Effect-typed setup whose deps are
 * `FileSystem | Path` resolves through the platform runtime.
 */
import { describe, test, expect } from "bun:test"
import { Effect, FileSystem, Layer, ManagedRuntime, Path } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { makeAsyncFs } from "@gent/core/runtime/platform-proxy"
import {
  type AutocompleteContribution,
  autocompleteContribution,
  type ExtensionClientContext,
  type ExtensionClientModule,
} from "@gent/core/domain/extension-client.js"
import type { ClientEffect } from "@gent/core/domain/client-effect.js"
import { loadTuiExtensions } from "../src/extensions/loader"

const runtime = ManagedRuntime.make(Layer.merge(BunFileSystem.layer, BunServices.layer))
const { fsRaw, pathSvc } = Effect.runSync(
  Effect.provide(
    Effect.gen(function* () {
      const fsRaw = yield* FileSystem.FileSystem
      const pathSvc = yield* Path.Path
      return { fsRaw, pathSvc }
    }),
    Layer.merge(BunFileSystem.layer, BunServices.layer),
  ),
)
const asyncFs = makeAsyncFs(fsRaw, (effect) => runtime.runPromise(effect))

const noopCtx = (cwd = "/tmp"): ExtensionClientContext =>
  ({
    cwd,
    home: "/tmp",
    fs: undefined,
    path: undefined,
    openOverlay: () => {},
    closeOverlay: () => {},
    send: () => {},
    ask: async () => undefined,
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

describe("loadTuiExtensions setup-shape bridge (C9.1)", () => {
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
      asyncFs,
      pathSvc,
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
      asyncFs,
      pathSvc,
    )
    expect(result.autocompleteItems.map((c) => c.prefix)).toContain("!")
  })
})
