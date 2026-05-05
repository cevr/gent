/**
 * `BunGentPlatform` — Bun-runtime implementation of `GentPlatform`. This is
 * the ONLY file in the codebase allowed to reference the `Bun` global; the
 * `no-bun-outside-adapter` lint rule rejects `Bun.*` MemberExpressions
 * everywhere else (modulo a small set of structural exemptions: scripts,
 * tooling, e2e harnesses, `main.ts` entrypoints, and tests).
 *
 * It is also the sole sanctioned home for raw `process.*` access (pid,
 * execPath, kill, exit) and Node `os` info — every other source file routes
 * through `GentPlatform` so the runtime stays portable.
 *
 * Every method here is a thin Effect wrapper over the underlying Bun/Node
 * API. Surrounding runtime code yields `GentPlatform` and stays portable.
 */

import * as os from "node:os"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { GentPlatform, SignalError } from "./gent-platform.js"

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

    osInfo: Effect.sync(() => ({
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      hostname: os.hostname(),
      type: os.type(),
    })),

    pid: Effect.sync(() => process.pid),

    execPath: Effect.sync(() => process.execPath),

    signal: (pid, signal) =>
      Effect.try({
        try: () => {
          process.kill(pid, signal)
        },
        catch: (cause) =>
          new SignalError({
            pid,
            signal,
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
      }),

    // `process.exit` does not return; the cast to `Effect<never>` reflects
    // that the host process is going down. Callers should sequence this as
    // the final step of a scope so Effect finalizers run before exit.
    exit: (code) =>
      Effect.sync(() => {
        process.exit(code)
      }) as Effect.Effect<never>,

    now: Effect.sync(() => performance.now()),
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
