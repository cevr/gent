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
        catch: (cause) => {
          const code =
            cause !== null &&
            typeof cause === "object" &&
            "code" in cause &&
            typeof cause.code === "string"
              ? cause.code
              : null
          return new SignalError({
            pid,
            signal,
            code,
            reason: cause instanceof Error ? cause.message : String(cause),
          })
        },
      }),

    // `process.exit` is synchronous and bypasses Effect finalizers — there
    // is no portable, in-Effect way to run finalizers before the host goes
    // down. This adapter therefore exposes `exit` as a *signal*: it yields
    // to Effect once (`Effect.yieldNow`) so any pending microtasks drain,
    // then calls `process.exit`. Code that needs deterministic finalizer
    // ordering must surface its exit code through the Effect result and
    // let the entrypoint's `BunRuntime.runMain` translate it (see audit
    // note in `apps/tui/src/main.tsx:520-536`).
    exit: (code) =>
      Effect.yieldNow.pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exit(code)
          }),
        ),
      ) as Effect.Effect<never>,

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
