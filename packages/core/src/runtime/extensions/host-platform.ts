import { Effect, Predicate, Schema } from "effect"
import {
  ExtensionHostProcessError,
  type ExtensionHostPlatform,
  type ExtensionHostSignal,
} from "../../domain/extension.js"
import { ProcessRunner } from "../../utils/run-process.js"
import { GentPlatform } from "../gent-platform.js"
import { hasMessage } from "../../domain/guards.js"

const errorMessage = (error: Parameters<typeof hasMessage>[0]): string => {
  if (Predicate.isError(error)) return error.message
  if (hasMessage(error)) return error.message
  return String(error)
}

const hasTimedOut = Schema.is(Schema.Struct({ timedOut: Schema.Literal(true) }))

const toHostProcessError =
  (command: string) =>
  (error: Parameters<typeof hasMessage>[0]): ExtensionHostProcessError => {
    const fields = {
      command,
      message: errorMessage(error),
      cause: error,
    }
    if (hasTimedOut(error)) {
      return new ExtensionHostProcessError({ ...fields, timedOut: true })
    }
    return new ExtensionHostProcessError(fields)
  }

export const makeExtensionHostPlatform: Effect.Effect<ExtensionHostPlatform, never, GentPlatform> =
  Effect.gen(function* () {
    const platform = yield* GentPlatform
    const processRunner = yield* ProcessRunner
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
      randomId: platform.randomId,
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
        processRunner
          .run(command, args, options)
          .pipe(Effect.mapError(toHostProcessError(command))),
    }
  })
