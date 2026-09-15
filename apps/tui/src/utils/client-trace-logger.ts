/**
 * Client-side Effect trace logger.
 *
 * Writes the SDK's JSON line format to CLIENT_LOG_PATH, the same file
 * `clientLog` appends to, so all TUI logs land in one place and `gent doctor`
 * reads the server and client logs with one parser.
 */

import type { Effect, FileSystem, Logger, PlatformError, Scope } from "effect"
import { makeJsonFileLogger } from "@gent/sdk"
import { CLIENT_LOG_PATH } from "./client-logger"

/** Batched JSON file logger at CLIENT_LOG_PATH; flushes on scope close. */
export const clientTraceLogger: Effect.Effect<
  Logger.Logger<unknown, void>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> = makeJsonFileLogger(CLIENT_LOG_PATH)
