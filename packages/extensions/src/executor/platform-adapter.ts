import { Context, Effect, Layer } from "effect"
import {
  ExtensionHostProcessError,
  runProcess,
  type ExtensionHostFacts,
  type ExtensionHostPlatform,
} from "@gent/core/extensions/api"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

export interface ExecutorPlatformShape {
  readonly execPath: string
  readonly pathListSeparator: string
  readonly binaryName: string
  readonly commandCandidates: (command: string) => ReadonlyArray<string>
  readonly isPortFree: (port: number) => Effect.Effect<boolean>
  readonly isPidAlive: (pid: number) => Effect.Effect<boolean>
  readonly signalPid: (pid: number, signal: NodeJS.Signals) => Effect.Effect<void>
  readonly runProcess: ExtensionHostPlatform["runProcess"]
}

export class ExecutorPlatform extends Context.Service<ExecutorPlatform, ExecutorPlatformShape>()(
  "@gent/extensions/src/executor/platform-adapter/ExecutorPlatform",
) {
  static Live = (host: ExtensionHostFacts) =>
    Layer.effect(
      ExecutorPlatform,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        const isWindows = host.osInfo.platform === "win32"
        return ExecutorPlatform.of({
          execPath: host.execPath,
          pathListSeparator: host.pathListSeparator,
          binaryName: isWindows ? "executor.exe" : "executor",
          commandCandidates: host.commandCandidates,
          isPortFree: host.isPortFree,
          isPidAlive: host.isPidAlive,
          signalPid: (pid, signal) =>
            Effect.sync(() => {
              process.kill(pid, signal)
            }),
          runProcess: (command, args, options) =>
            runProcess(command, args, options).pipe(
              Effect.provideService(ChildProcessSpawner, spawner),
              Effect.mapError(
                (e) =>
                  new ExtensionHostProcessError({
                    command: e.command,
                    message: e.message,
                    cause: e.cause,
                    timedOut: e.timedOut,
                  }),
              ),
            ),
        })
      }),
    )
}
