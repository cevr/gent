/**
 * `BunGentPlatform` — Bun-runtime implementation of `GentPlatform`. This is
 * the ONLY file in the codebase allowed to reference the `Bun` global; the
 * `no-bun-outside-adapter` lint rule rejects `Bun.*` MemberExpressions
 * everywhere else (modulo a small set of structural exemptions: scripts,
 * tooling, e2e harnesses, `main.ts` entrypoints, and tests).
 *
 * Every method here is a thin Effect wrapper over the underlying Bun API.
 * Surrounding runtime code yields `GentPlatform` and stays portable.
 */

import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { GentPlatform } from "./gent-platform.js"

export const BunGentPlatformLive: Layer.Layer<GentPlatform> = Layer.succeed(
  GentPlatform,
  GentPlatform.of({
    randomId: Effect.sync(() => Bun.randomUUIDv7()),

    which: (command) => Effect.sync(() => Bun.which(command)),

    inspect: (value) => Bun.inspect(value),

    serve: (options) =>
      Effect.acquireRelease(
        Effect.sync(() => Bun.serve({ port: 0, fetch: options.fetch })),
        (server) => Effect.promise(() => Promise.resolve(server.stop())),
      ).pipe(
        Effect.map((server) => ({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- port is always defined when Bun.serve succeeds
          port: server.port as number,
        })),
      ),

    readFileText: (path) =>
      Effect.tryPromise(() => {
        const file = Bun.file(path)
        return file.exists().then((exists) => (exists ? file.text() : null))
      }).pipe(Effect.orElseSucceed(() => null)),

    spawnSync: (command, options) =>
      Effect.sync(() => {
        const result = Bun.spawnSync([...command], {
          stdout: options?.stdout ?? "pipe",
          stderr: options?.stderr ?? "pipe",
        })
        return { exitCode: result.exitCode }
      }),
  }),
)

/**
 * The complete Bun-runtime platform stack: `@effect/platform-bun`
 * (FileSystem, Path, ChildProcessSpawner, …) bundled with the gent-owned
 * `BunGentPlatformLive`. Production wiring and test harnesses both yield
 * this single Layer so they can't drift on which BunService stack they
 * pull in.
 *
 * Note: `BunGentPlatformLive` is `Layer.succeed` with no requirements,
 * so this is purely an output-context bundle (`Layer.merge`), not a
 * dependency wiring (`Layer.provideMerge`).
 */
export const BunPlatformLive = Layer.merge(BunServices.layer, BunGentPlatformLive)
