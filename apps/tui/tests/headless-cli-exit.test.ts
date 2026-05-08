import { afterEach } from "bun:test"
import { it, describe, expect } from "effect-bun-test"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as path from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Auth, AuthApi } from "@gent/core-internal/domain/auth"
import { createWorkerEnv } from "@gent/core-internal/test-utils/fixtures.js"
const tempDirs: string[] = []
const makeTempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gent-headless-exit-"))
  tempDirs.push(dir)
  return dir
}
const waitForExit = (proc: Bun.Subprocess, timeoutMs: number) => {
  const timeout = Effect.sleep(timeoutMs).pipe(
    Effect.tap(() => Effect.sync(() => proc.kill())),
    Effect.as(-1),
  )
  return Effect.race(
    Effect.promise(() => proc.exited),
    timeout,
  )
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})
const seedAuth = (directory: string) => {
  const authLayer = Auth.Live(directory).pipe(Layer.provide(BunServices.layer))
  return Effect.gen(function* () {
    const auth = yield* Auth
    yield* auth.set("anthropic", AuthApi.make({ type: "api", key: "test-key" }))
    yield* auth.set("openai", AuthApi.make({ type: "api", key: "test-key" }))
  }).pipe(Effect.provide(authLayer))
}
const makeChildEnv = (homeDir: string, env: ReturnType<typeof createWorkerEnv>) => {
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
  it.live(
    "exits after a successful headless turn",
    () =>
      Effect.gen(function* () {
        const appDir = path.resolve(import.meta.dir, "..")
        const homeDir = makeTempDir()
        const env = createWorkerEnv(homeDir, { providerMode: "debug-scripted" })
        yield* seedAuth(env["GENT_AUTH_DIRECTORY"]!)
        const proc = Bun.spawn(
          [
            "bun",
            "--preload",
            "./node_modules/@opentui/solid/scripts/preload.ts",
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
      }),
    20000,
  )
})
