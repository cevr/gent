/**
 * Shared test fixtures for integration tests across packages.
 * Import from @gent/core/test-utils/fixtures
 */

// @effect-diagnostics nodeBuiltinImport:off
import { afterEach } from "bun:test"
import { Clock, Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/** Create a temp directory that is cleaned up after each test */
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

/** Create a worker environment with data dir, auth files, and provider mode */
export const createWorkerEnv = (
  root: string,
  { providerMode, includeAuthFiles = true, extra }: WorkerEnvOptions = {},
): Record<string, string> => {
  const dataDir = path.join(root, "data")
  fs.mkdirSync(dataDir, { recursive: true })

  const env: Record<string, string> = { GENT_DATA_DIR: dataDir }
  if (providerMode !== undefined) env["GENT_PROVIDER_MODE"] = providerMode
  if (includeAuthFiles) {
    env["GENT_AUTH_FILE_PATH"] = path.join(root, "auth.enc")
    env["GENT_AUTH_KEY_PATH"] = path.join(root, "auth.key")
  }
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) env[key] = value
    }
  }
  return env
}

/** Poll an effect until predicate passes or timeout */
// @effect-diagnostics globalErrorInEffectFailure:off
export const waitFor = <A>(
  effect: Effect.Effect<A, unknown>,
  predicate: (value: A) => boolean,
  timeoutMs = 5_000,
  label = "condition",
): Effect.Effect<A, Error> => {
  // @effect-diagnostics-next-line *:off
  const deadline = Date.now() + timeoutMs
  const loop: Effect.Effect<A, Error> = Effect.gen(function* () {
    const value = yield* effect.pipe(Effect.mapError((error) => new Error(String(error))))
    if (predicate(value)) return value
    if ((yield* Clock.currentTimeMillis) >= deadline) {
      return yield* Effect.fail(new Error(`timed out waiting for ${label}`))
    }
    yield* Effect.sleep("25 millis")
    return yield* loop
  })
  return loop
}
