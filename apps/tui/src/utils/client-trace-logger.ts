/**
 * Client-side Effect trace logger.
 *
 * Writes the SDK's JSON line format to CLIENT_LOG_PATH, the same file
 * `clientLog` appends to, so all TUI logs land in one place and `gent doctor`
 * reads the server and client logs with one parser.
 */

import { Effect, FileSystem, type Logger, type PlatformError, type Scope } from "effect"
import { ensureLogDir, makeJsonFileLogger } from "@gent/sdk"
import { CLIENT_LOG_PATH } from "./client-logger"

/**
 * Batched JSON file logger at CLIENT_LOG_PATH; flushes on scope close.
 *
 * Creates the log directory first: `makeJsonFileLogger` opens the file and
 * does not make its parent, so the directory has to exist before the open.
 */
export const makeClientTraceLogger = (
  dir: string,
  path: string,
): Effect.Effect<
  Logger.Logger<unknown, void>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* Effect.ignore(fs.makeDirectory(dir, { recursive: true }))
    return yield* makeJsonFileLogger(path)
  })

export const clientTraceLogger: Effect.Effect<
  Logger.Logger<unknown, void>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> = Effect.andThen(ensureLogDir, makeJsonFileLogger(CLIENT_LOG_PATH))
