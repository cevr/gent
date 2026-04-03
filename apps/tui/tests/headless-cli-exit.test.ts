import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { AuthStorage } from "@gent/core/domain/auth-storage.js"
import { createWorkerEnv } from "@gent/core/test-utils/fixtures.js"

const tempDirs: string[] = []

const makeTempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gent-headless-exit-"))
  tempDirs.push(dir)
  return dir
}

const waitForExit = async (proc: Bun.Subprocess, timeoutMs: number) => {
  const timeout = new Promise<number>((resolve) => {
    const handle = setTimeout(() => {
      proc.kill()
      resolve(-1)
    }, timeoutMs)
    handle.unref?.()
  })

  return await Promise.race([proc.exited, timeout])
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

const seedAuth = async (authFilePath: string, authKeyPath: string) => {
  const authLayer = AuthStorage.LiveEncryptedFile(authFilePath, authKeyPath).pipe(
    Layer.provide(Layer.merge(BunServices.layer, BunFileSystem.layer)),
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* AuthStorage
      yield* auth.set("anthropic", "test-key")
      yield* auth.set("openai", "test-key")
    }).pipe(Effect.provide(authLayer)),
  )
}

const makeChildEnv = (homeDir: string, env: ReturnType<typeof createWorkerEnv>) => {
  const childEnv = { ...Bun.env }
  delete childEnv.FORCE_COLOR
  delete childEnv.NO_COLOR

  return {
    ...childEnv,
    HOME: homeDir,
    GENT_PERSISTENCE_MODE: "memory",
    GENT_PROVIDER_MODE: "debug-scripted",
    ...env,
  }
}

describe("headless CLI", () => {
  test("exits after a successful headless turn", async () => {
    const appDir = path.resolve(import.meta.dir, "..")
    const homeDir = makeTempDir()
    const env = createWorkerEnv(homeDir, { providerMode: "debug-scripted" })

    await seedAuth(env["GENT_AUTH_FILE_PATH"]!, env["GENT_AUTH_KEY_PATH"]!)

    const proc = Bun.spawn(
      [
        "bun",
        "--preload",
        "./node_modules/@opentui/solid/scripts/preload.ts",
        "src/main.tsx",
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

    const [exitCode, stdout, stderr] = await Promise.all([
      waitForExit(proc, 15_000),
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    expect(stdout.length).toBeGreaterThan(0)
  }, 20_000)
})
