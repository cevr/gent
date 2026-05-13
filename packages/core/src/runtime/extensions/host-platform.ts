import { Effect } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import {
  ExtensionHostProcessError,
  type ExtensionHostPlatform,
  type ExtensionHostSignal,
} from "../../domain/extension.js"
import { makeProcessRunner } from "../../utils/run-process.js"
import { GentPlatform } from "../gent-platform.js"

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message
  }
  return String(error)
}

const toHostProcessError =
  (command: string) =>
  (error: unknown): ExtensionHostProcessError =>
    new ExtensionHostProcessError({
      command,
      message: errorMessage(error),
      cause: error,
      ...(typeof error === "object" &&
      error !== null &&
      "timedOut" in error &&
      error.timedOut === true
        ? { timedOut: true }
        : {}),
    })

export const makeExtensionHostPlatform: Effect.Effect<
  ExtensionHostPlatform,
  never,
  ChildProcessSpawner | GentPlatform
> = Effect.gen(function* () {
  const platform = yield* GentPlatform
  const processRunner = yield* makeProcessRunner
  const osInfo = yield* platform.osInfo
  const execPath = yield* platform.execPath
  const homeDirectory = yield* platform.homeDirectory
  const parentEnv = yield* platform.env
  const pathListSeparator = yield* platform.pathListSeparator
  return {
    osInfo,
    execPath,
    homeDirectory,
    parentEnv,
    pathListSeparator,
    commandCandidates: platform.commandCandidates,
    isPortFree: platform.isPortFree,
    isPidAlive: (pid: number) =>
      platform.signal(pid, 0).pipe(
        Effect.as(true),
        Effect.catchEager(() => Effect.succeed(false)),
      ),
    signalPid: (pid: number, signal: ExtensionHostSignal) =>
      platform.signal(pid, signal).pipe(Effect.catchEager(() => Effect.void)),
    runProcess: (command, args, options) =>
      processRunner.run(command, args, options).pipe(Effect.mapError(toHostProcessError(command))),
  }
})
