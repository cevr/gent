/**
 * `BunGentPlatformLive` — Bun-runtime implementation of `GentPlatform`. It is the
 * one owner of `Bun.randomUUIDv7()`. The `effect/noGlobals` project bans in
 * `.oxlintrc.json` keep other `Bun.*` calls inside this file, the adapters,
 * tooling, the e2e harness and tests; a deliberate exception elsewhere carries
 * a line-local suppression with its reason.
 *
 * It is also the sole sanctioned home for raw `process.*` access (pid,
 * execPath, kill, exit) and Node `os` info — every other source file routes
 * through `GentPlatform` so the runtime stays portable.
 *
 * Every method here is a thin Effect wrapper over the underlying Bun/Node
 * API. Surrounding runtime code yields `GentPlatform` and stays portable.
 */

import * as os from "node:os"
import { Effect, Layer, Option, Result, Schema } from "effect"
import { causeMessage } from "../domain/guards.js"
import { BunServices } from "@effect/platform-bun"
import { GentBuild, GentPlatform, type RuntimeModuleSource, SignalError } from "./gent-platform.js"

/**
 * The compiled build defines this symbol as `{ id, version }`
 * (`apps/tui/scripts/build.ts`); a source run leaves it undeclared. The
 * builtin extensions read its `id` too, as their artifact identity
 * (`packages/extensions/src/index.ts`).
 */
declare const __GENT_BUILD__: unknown

/** An undeclared symbol throws a ReferenceError: a source run. */
const thisBuild: GentBuild = Result.try(() => __GENT_BUILD__).pipe(
  Result.getSuccess,
  Option.flatMap(
    Schema.decodeUnknownOption(
      Schema.Struct({ id: Schema.NonEmptyString, version: Schema.NonEmptyString }),
    ),
  ),
  Option.match({
    onNone: () => GentBuild.cases.Source.make({}),
    onSome: (fields) => GentBuild.cases.Compiled.make(fields),
  }),
)

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

    // oxlint-disable-next-line effect/noGlobals -- GentPlatform.randomId is the one owner of Bun's UUIDv7
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

    build: Effect.succeed(thisBuild),

    homeDirectory: Effect.sync(() => os.homedir()),

    signal: (pid, signal) =>
      Effect.try({
        try: () => {
          process.kill(pid, signal)
        },
        catch: (cause) => new SignalError({ pid, signal, reason: causeMessage(cause) }),
      }),

    hash: (algorithm, input) => new Bun.CryptoHasher(algorithm).update(input).digest("hex"),
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
