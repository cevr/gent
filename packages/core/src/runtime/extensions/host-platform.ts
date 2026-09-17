import { Effect, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { ExtensionHostProcessError, type ExtensionHostPlatform } from "../../domain/extension.js"
import { runProcess } from "../../runtime/run-process.js"
import { GentPlatform } from "../gent-platform.js"
import { causeMessage } from "../../domain/guards.js"

const hasTimedOut = Schema.is(Schema.Struct({ timedOut: Schema.Literal(true) }))

const toHostProcessError =
  (command: string) =>
  (error: Parameters<typeof causeMessage>[0]): ExtensionHostProcessError => {
    const fields = {
      command,
      message: causeMessage(error),
      cause: error,
    }
    if (hasTimedOut(error)) {
      return new ExtensionHostProcessError({ ...fields, timedOut: true })
    }
    return new ExtensionHostProcessError(fields)
  }

export const makeExtensionHostPlatform: Effect.Effect<
  ExtensionHostPlatform,
  never,
  GentPlatform | ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const platform = yield* GentPlatform
  // Captured once so the facade's runProcess keeps a `never` R channel.
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
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
    runProcess: (command, args, options) =>
      runProcess(command, args, options).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(toHostProcessError(command)),
      ),
  }
})
