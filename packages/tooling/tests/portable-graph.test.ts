import { BunServices } from "@effect/platform-bun"
import { Effect, Path } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { hostOnlyEdges } from "../src/guards"

/**
 * The bundle check of the portable import graph. A hosted root (a Worker or
 * a Durable Object) loads the authoring entries, the host entry and the
 * shipped extensions; this bundles them for a browser-shaped target, which
 * has neither Bun nor a process, and walks the static edges. The file guard
 * (`findHostOnlyImports`) reads one file; this reads the dependencies too.
 */
const PORTABLE_ENTRIES = [
  "packages/core/src/protocol.ts",
  "packages/core/src/extensions/api.ts",
  "packages/core/src/extensions/branch-tools.ts",
  "packages/core/src/host.ts",
  "packages/extensions/src/index.ts",
]

const graphTest = it.live.layer(BunServices.layer)

describe("the portable import graph", () => {
  graphTest(
    "no portable entry loads a Bun or process module over a static edge",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const root = path.resolve(yield* path.fromFileUrl(new URL("../../..", import.meta.url)))
        const build = yield* Effect.promise(() =>
          Bun.build({
            entrypoints: PORTABLE_ENTRIES.map((entry) => path.join(root, entry)),
            target: "browser",
            conditions: ["workerd", "worker", "browser"],
            format: "esm",
            metafile: true,
            throw: false,
            // A host-only module stays an edge the walk reads, not a resolution error.
            external: [
              "bun",
              "bun:*",
              "node:*",
              "child_process",
              "@effect/platform-bun",
              "@effect/platform-bun/*",
              "@effect/sql-sqlite-bun",
              "@effect/sql-sqlite-bun/*",
            ],
          }),
        )
        expect(build.logs.map(String)).toEqual([])
        // The metafile names a module relative to this process's directory,
        // and an external one by its specifier; the walk reads repo paths.
        const bundled = build.metafile?.inputs ?? {}
        const repoPath = (target: string) => {
          if (!(target in bundled)) return target
          return path.relative(root, path.resolve(target))
        }
        const inputs = Object.fromEntries(
          Object.entries(bundled).map(([key, input]) => [
            repoPath(key),
            {
              imports: input.imports.map((read) => ({
                kind: read.kind,
                original: read.original,
                path: repoPath(read.path),
              })),
            },
          ]),
        )
        expect(Object.keys(inputs).length).toBeGreaterThan(PORTABLE_ENTRIES.length)
        expect(hostOnlyEdges(inputs, PORTABLE_ENTRIES)).toEqual([])
      }).pipe(Effect.timeout("25 seconds")),
    30_000,
  )
})
