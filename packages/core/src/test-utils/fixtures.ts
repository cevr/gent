/**
 * Shared test fixtures for integration tests across packages.
 * Import from @gent/core-internal/test-utils/fixtures
 */

import { Predicate, Cause, Clock, Effect, Record, Schema } from "effect"
// @effect-diagnostics nodeBuiltinImport:off — test fixture lifecycle comes from bun:test
// oxlint-disable-next-line effect/noNodeBuiltinImport -- This synchronous fixture adapter creates worker files before the child runtime starts.
import * as fs from "node:fs"
import * as os from "node:os"
// oxlint-disable-next-line effect/noNodeBuiltinImport -- This synchronous fixture adapter builds worker paths before the child runtime starts.
import * as path from "node:path"

/** Create a temp directory that is removed when the test scope closes. */
export const makeTempDirectoryScoped = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), prefix))),
    (dir) => Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
  )

export interface WorkerEnvOptions {
  readonly providerMode?: string
  readonly includeAuthFiles?: boolean
  // oxlint-disable-next-line effect/noNullish -- Process environments use undefined values for absent entries.
  readonly extra?: Readonly<Record<string, string | undefined>>
}

/** Create a worker environment with data dir, auth files, and provider mode */
export const createWorkerEnv = (
  root: string,
  { providerMode, includeAuthFiles = true, extra }: WorkerEnvOptions = {},
): Record<string, string> => {
  const dataDir = path.join(root, "data")
  fs.mkdirSync(dataDir, { recursive: true })

  const env = Record.empty<string, string>()
  env["GENT_DATA_DIR"] = dataDir
  if (!Predicate.isUndefined(providerMode)) env["GENT_PROVIDER_MODE"] = providerMode
  if (includeAuthFiles) {
    env["GENT_AUTH_DIRECTORY"] = path.join(root, "auth")
  }
  if (!Predicate.isUndefined(extra)) {
    for (const [key, value] of Object.entries(extra)) {
      if (Predicate.isString(value)) env[key] = value
    }
  }
  return env
}

class WaitForError extends Schema.TaggedError<WaitForError>()(
  "@gent/core-internal/test-utils/fixtures/WaitForError",
  { message: Schema.String },
) {}

// oxlint-disable-next-line effect/noUnknownParameters -- Cause.squash exposes an unknown defect at this test failure boundary.
const toWaitForError = (error: unknown) => {
  if (error instanceof Error) return new WaitForError({ message: error.message })
  return new WaitForError({ message: String(error) })
}

/** Poll an effect until predicate passes or timeout */
export const waitFor = <A, R = never>(
  effect: Effect.Effect<A, unknown, R>,
  predicate: (value: A) => boolean,
  timeoutMs = 5_000,
  label = "condition",
): Effect.Effect<A, WaitForError, R> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
    const loop: Effect.Effect<A, WaitForError, R> = Effect.gen(function* () {
      const attempt = yield* effect.pipe(Effect.exit)
      if (attempt._tag === "Success" && predicate(attempt.value)) {
        return attempt.value
      }
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        let errorMessage = `timed out waiting for ${label}`
        if (attempt._tag === "Failure") {
          errorMessage += `: ${toWaitForError(Cause.squash(attempt.cause)).message}`
        }
        return yield* new WaitForError({ message: errorMessage })
      }
      yield* Effect.sleep("5 millis")
      return yield* loop
    })
    return yield* loop
  })
