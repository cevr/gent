/**
 * `BunGentPlatform` — Bun-runtime implementation of `GentPlatform`. This is
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
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto"
import { fileURLToPath as nodeFileURLToPath, pathToFileURL } from "node:url"
import { Effect, Layer, Option, Schema } from "effect"
import { causeMessage } from "../domain/guards.js"
import { BunServices } from "@effect/platform-bun"
import { GentPlatform, SignalError } from "./gent-platform.js"
import { ProcessRunnerLive } from "./run-process.js"

declare const __GENT_COMPILED__: boolean

export const BunGentPlatformLive: Layer.Layer<GentPlatform> = Layer.succeed(
  GentPlatform,
  GentPlatform.of({
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

    siblingBinaryPath: (name: string) =>
      Effect.sync(() => {
        // oxlint-disable-next-line effect/noRuntimeTypeof -- This build symbol is absent in source runs; it is not external input.
        if (typeof __GENT_COMPILED__ !== "undefined" && __GENT_COMPILED__) {
          return nodeFileURLToPath(new URL(name, pathToFileURL(process.execPath)))
        }
        return nodeFileURLToPath(new URL(`../../dist/${name}`, import.meta.url))
      }),

    homeDirectory: Effect.sync(() => os.homedir()),

    env: Effect.sync(() => Bun.env),

    pathListSeparator: Effect.sync(() => {
      if (os.platform() === "win32") {
        return ";"
      }
      return ":"
    }),

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

    randomBytes: (length) =>
      Effect.sync(() => {
        const node = nodeRandomBytes(length)
        return new Uint8Array(node.buffer, node.byteOffset, node.byteLength)
      }),

    fileURLToPath: (url) => nodeFileURLToPath(url),
  }),
)

/**
 * The complete Bun-runtime platform stack: `@effect/platform-bun`
 * (FileSystem, Path, ChildProcessSpawner, …) bundled with the gent-owned
 * `BunGentPlatformLive` and `ProcessRunnerLive`. Production wiring and test
 * harnesses both yield
 * this single Layer so they can't drift on which BunService stack they
 * pull in.
 *
 * Note: this is an output-context bundle (`Layer.merge`), not a dependency
 * wiring — each member either has no requirements or is given its own.
 */
export const BunPlatformLive = Layer.mergeAll(
  BunServices.layer,
  BunGentPlatformLive,
  ProcessRunnerLive.pipe(Layer.provide(BunServices.layer)),
)
