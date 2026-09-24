/**
 * `BunGentPlatformLive` — Bun-runtime implementation of `GentPlatform`. This is
 * the ONLY file in the codebase allowed to reference the `Bun` global; the
 * platform duplication guards reject `Bun.randomUUIDv7()` everywhere else.
 * The broader no-bun lint keeps other `Bun.*` calls inside adapter-shaped
 * files, scripts, tooling, e2e harnesses, and tests.
 *
 * It is also the sole sanctioned home for raw `process.*` access (pid,
 * execPath, kill, exit) and Node `os` info — every other source file routes
 * through `GentPlatform` so the runtime stays portable.
 *
 * Every method here is a thin Effect wrapper over the underlying Bun/Node
 * API. Surrounding runtime code yields `GentPlatform` and stays portable.
 */

import * as os from "node:os"
import { createHash } from "node:crypto"
import { Effect, Layer, Option, Schema } from "effect"
import { causeMessage } from "../domain/guards.js"
import { BunServices } from "@effect/platform-bun"
import { GentPlatform, type RuntimeModuleSource, SignalError } from "./gent-platform.js"

/** The specifiers bound in this process. Bun keeps a plugin for the process lifetime. */
const boundModules = new Set<string>()

/**
 * `GentPlatform.bindModules` on Bun: a runtime plugin serves each specifier
 * as a virtual module. A Bun host that loads files outside a `GentPlatform`
 * context, the TUI's client extension loader, calls it directly.
 */
export const bindBunModules = Effect.fn("GentPlatform.bindModules")(function* (
  modules: ReadonlyMap<string, RuntimeModuleSource>,
) {
  const added = [...modules].filter(([specifier]) => !boundModules.has(specifier))
  if (added.length === 0) return
  yield* Effect.sync(() => {
    for (const [specifier] of added) boundModules.add(specifier)
    Bun.plugin({
      name: "gent-bound-modules",
      setup: (build) => {
        for (const [specifier, source] of added) {
          build.module(specifier, () =>
            // oxlint-disable-next-line effect/noNewPromise -- Bun reads a virtual module from a promise callback.
            Promise.resolve(source()).then((exports): Bun.OnLoadResultObject => ({
              exports: { ...exports },
              loader: "object",
            })),
          )
        }
      },
    })
  })
})

export const BunGentPlatformLive: Layer.Layer<GentPlatform> = Layer.succeed(
  GentPlatform,
  GentPlatform.of({
    bindModules: bindBunModules,

    randomId: Effect.sync(() => Bun.randomUUIDv7()),

    osInfo: Effect.sync(() => ({
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      hostname: os.hostname(),
      type: os.type(),
    })),

    pid: Effect.sync(() => process.pid),

    execPath: Effect.sync(() => process.execPath),

    homeDirectory: Effect.sync(() => os.homedir()),

    signal: (pid, signal) =>
      Effect.try({
        try: () => {
          process.kill(pid, signal)
        },
        catch: (cause) => {
          const code = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))(
            cause,
          ).pipe(
            Option.map((error) => error.code),
            Option.getOrNull,
          )
          const reason = causeMessage(cause)
          return new SignalError({
            pid,
            signal,
            code,
            reason,
          })
        },
      }),

    hash: (algorithm, input) => createHash(algorithm).update(input).digest("hex"),
  }),
)

/**
 * The complete Bun-runtime platform stack: `@effect/platform-bun`
 * (FileSystem, Path, ChildProcessSpawner, …) bundled with the gent-owned
 * `BunGentPlatformLive`. Production wiring and test harnesses both yield
 * this single Layer so they can't drift on which BunService stack they
 * pull in.
 *
 * Note: this is an output-context bundle (`Layer.merge`), not a dependency
 * wiring — each member either has no requirements or is given its own.
 */
export const BunPlatformLive = Layer.mergeAll(BunServices.layer, BunGentPlatformLive)
