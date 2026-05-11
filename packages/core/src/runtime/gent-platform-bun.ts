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
import { createServer } from "node:net"
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto"
import { fileURLToPath as nodeFileURLToPath } from "node:url"
import { Effect, Layer, Schema } from "effect"
import { BunServices } from "@effect/platform-bun"
import { GentPlatform, SignalError } from "./gent-platform.js"
import { CronRuntime, SchedulerRuntimeError } from "./extensions/resource-host/schedule-engine.js"

const bunCronFunction = (): Function | undefined => {
  const bun = Reflect.get(globalThis, "Bun")
  if (typeof bun !== "object" || bun === null) return undefined
  const cron = Reflect.get(bun, "cron")
  return typeof cron === "function" ? cron : undefined
}

const bunCronRemoveFunction = (cron: Function): Function | undefined => {
  const remove = Reflect.get(cron, "remove")
  return typeof remove === "function" ? remove : undefined
}

const missingCronRuntime = (operation: "install" | "remove", jobName: string) =>
  new SchedulerRuntimeError({
    operation,
    jobName,
    cause: "Bun.cron is unavailable",
  })

export const BunCronRuntimeLive: Layer.Layer<CronRuntime> = Layer.succeed(
  CronRuntime,
  CronRuntime.of({
    install: (entryPath, schedule, name) =>
      Effect.try({
        try: () => {
          const cron = bunCronFunction()
          if (cron === undefined) throw missingCronRuntime("install", name)
          Reflect.apply(cron, undefined, [entryPath, schedule, name])
        },
        catch: (cause) =>
          Schema.is(SchedulerRuntimeError)(cause)
            ? cause
            : new SchedulerRuntimeError({ operation: "install", jobName: name, cause }),
      }),
    remove: (name) =>
      Effect.try({
        try: () => {
          const cron = bunCronFunction()
          if (cron === undefined) throw missingCronRuntime("remove", name)
          const remove = bunCronRemoveFunction(cron)
          if (remove === undefined) throw missingCronRuntime("remove", name)
          Reflect.apply(remove, cron, [name])
        },
        catch: (cause) =>
          Schema.is(SchedulerRuntimeError)(cause)
            ? cause
            : new SchedulerRuntimeError({ operation: "remove", jobName: name, cause }),
      }),
  }),
)

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

    homeDirectory: Effect.sync(() => os.homedir()),

    env: Effect.sync(() => Bun.env),

    pathListSeparator: Effect.sync(() => (os.platform() === "win32" ? ";" : ":")),

    commandCandidates: (command) =>
      os.platform() === "win32"
        ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command]
        : [command],

    isPortFree: (port) =>
      Effect.callback<boolean>((resume) => {
        const server = createServer()
        server.once("error", () => {
          server.close()
          resume(Effect.succeed(false))
        })
        server.listen(port, "127.0.0.1", () => {
          server.close(() => resume(Effect.succeed(true)))
        })
      }),

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
 * `BunGentPlatformLive`. Production wiring and test harnesses both yield
 * this single Layer so they can't drift on which BunService stack they
 * pull in.
 *
 * Note: `BunGentPlatformLive` is `Layer.succeed` with no requirements,
 * so this is purely an output-context bundle (`Layer.merge`), not a
 * dependency wiring (`Layer.provideMerge`).
 */
export const BunPlatformLive = Layer.mergeAll(
  BunServices.layer,
  BunGentPlatformLive,
  BunCronRuntimeLive,
)
