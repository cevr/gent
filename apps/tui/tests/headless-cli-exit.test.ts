import { it, describe, expect } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Path } from "effect"
import { Auth, AuthApi } from "@gent/core-internal/domain/auth"
import { createWorkerEnv } from "@gent/core-internal/test-utils/fixtures.js"
const makeTempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped({ prefix: "gent-headless-exit-" })
})
const waitForExit = (proc: Bun.Subprocess, timeoutMs: number) => {
  // gent/no-sleep: allow real-clock timeout fence that kills a wedged subprocess
  const timeout = Effect.sleep(timeoutMs).pipe(
    Effect.tap(() => Effect.sync(() => proc.kill())),
    Effect.as(-1),
  )
  return Effect.race(
    Effect.promise(() => proc.exited),
    timeout,
  )
}
const seedAuth = (directory: string) => {
  const authLayer = Auth.Live(directory).pipe(Layer.provide(BunServices.layer))
  return Effect.gen(function* () {
    const auth = yield* Auth
    yield* auth.set("anthropic", AuthApi.make({ type: "api", key: "test-key" }))
    yield* auth.set("openai", AuthApi.make({ type: "api", key: "test-key" }))
  }).pipe(Effect.provide(authLayer))
}
const makeChildEnv = (homeDir: string, env: ReturnType<typeof createWorkerEnv>) => {
  // eslint-disable-next-line effect/noGlobals -- child process env must inherit the host environment.
  const childEnv = { ...Bun.env }
  delete childEnv["FORCE_COLOR"]
  delete childEnv["NO_COLOR"]
  return {
    ...childEnv,
    HOME: homeDir,
    GENT_PERSISTENCE_MODE: "memory",
    GENT_PROVIDER_MODE: "debug-scripted",
    ...env,
  }
}
describe("headless CLI", () => {
  it.scopedLive(
    "exits after a successful headless turn",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const appDir = path.resolve(import.meta.dir, "..")
        const homeDir = yield* makeTempDir
        const env = createWorkerEnv(homeDir, { providerMode: "debug-scripted" })
        yield* seedAuth(env["GENT_AUTH_DIRECTORY"]!)
        // eslint-disable-next-line effect/noGlobals -- subprocess execution is the integration boundary under test.
        const proc = Bun.spawn(
          [
            "bun",
            "--preload",
            "@opentui/solid/preload",
            "src/main.tsx",
            "--debug",
            "-H",
            "Say hi in 3 words",
          ],
          {
            cwd: appDir,
            env: makeChildEnv(homeDir, env),
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const [exitCode, stdout, stderr] = yield* Effect.all(
          [
            waitForExit(proc, 15000),
            Effect.promise(() => new Response(proc.stdout).text()),
            Effect.promise(() => new Response(proc.stderr).text()),
          ],
          { concurrency: "unbounded" },
        )
        expect(stderr).toBe("")
        expect(exitCode).toBe(0)
        expect(stdout.length).toBeGreaterThan(0)
      }).pipe(Effect.provide(BunServices.layer)),
    20000,
  )
})
