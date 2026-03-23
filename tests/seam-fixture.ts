import { afterEach } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { makeWorkerHttpClient, startWorkerSupervisor } from "../apps/tui/src/worker/supervisor"

export const createTempDirFixture = (prefix: string): (() => string) => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  return () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }
}

export interface WorkerEnvOptions {
  readonly providerMode?: string
  readonly includeAuthFiles?: boolean
  readonly extra?: Readonly<Record<string, string | undefined>>
}

export const createWorkerEnv = (
  root: string,
  { providerMode, includeAuthFiles = true, extra }: WorkerEnvOptions = {},
): Record<string, string> => {
  const dataDir = path.join(root, "data")
  fs.mkdirSync(dataDir, { recursive: true })

  const env: Record<string, string> = {
    GENT_DATA_DIR: dataDir,
  }

  if (providerMode !== undefined) env.GENT_PROVIDER_MODE = providerMode
  if (includeAuthFiles) {
    env.GENT_AUTH_FILE_PATH = path.join(root, "auth.enc")
    env.GENT_AUTH_KEY_PATH = path.join(root, "auth.key")
  }

  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) env[key] = value
    }
  }

  return env
}

export const startWorkerWithClient = (options: Parameters<typeof startWorkerSupervisor>[0]) =>
  Effect.gen(function* () {
    const worker = yield* startWorkerSupervisor(options)
    const client = yield* makeWorkerHttpClient(worker)
    return { ...worker, client }
  })

export const waitFor = <A>(
  effect: Effect.Effect<A, unknown>,
  predicate: (value: A) => boolean,
  timeoutMs = 5_000,
  label = "condition",
): Effect.Effect<A, Error> => {
  const deadline = Date.now() + timeoutMs

  const loop: Effect.Effect<A, Error> = Effect.gen(function* () {
    const value = yield* effect.pipe(Effect.mapError((error) => new Error(String(error))))
    if (predicate(value)) return value
    if (Date.now() >= deadline) {
      return yield* Effect.fail(new Error(`timed out waiting for ${label}`))
    }
    yield* Effect.sleep("100 millis")
    return yield* loop
  })

  return loop
}
