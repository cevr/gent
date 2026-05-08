import { Context, Effect, Layer } from "effect"
import { createServer } from "node:net"
import * as os from "node:os"

export interface ExecutorPlatformShape {
  readonly execPath: string
  readonly pathListSeparator: string
  readonly binaryName: string
  readonly commandCandidates: (command: string) => ReadonlyArray<string>
  readonly isPortFree: (port: number) => Effect.Effect<boolean>
  readonly isPidAlive: (pid: number) => Effect.Effect<boolean>
  readonly signalPid: (pid: number, signal: NodeJS.Signals) => Effect.Effect<void>
}

export class ExecutorPlatform extends Context.Service<ExecutorPlatform, ExecutorPlatformShape>()(
  "@gent/extensions/src/executor/platform-adapter/ExecutorPlatform",
) {
  static Live: Layer.Layer<ExecutorPlatform> = Layer.succeed(
    ExecutorPlatform,
    ExecutorPlatform.of({
      execPath: process.execPath,
      pathListSeparator: os.platform() === "win32" ? ";" : ":",
      binaryName: os.platform() === "win32" ? "executor.exe" : "executor",
      commandCandidates: (command) =>
        os.platform() === "win32"
          ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command]
          : [command],
      isPortFree: (port) =>
        Effect.callback<boolean>((resume) => {
          const server = createServer()
          server.once("error", () => {
            server.close()
            resume(Effect.succeed(false))
          })
          server.listen(port, "127.0.0.1", () => {
            server.close(() => resume(Effect.succeed(true)))
          })
        }),
      isPidAlive: (pid) =>
        Effect.sync(() => {
          try {
            return process.kill(pid, 0)
          } catch {
            return false
          }
        }),
      signalPid: (pid, signal) =>
        Effect.sync(() => {
          try {
            process.kill(pid, signal)
          } catch {
            // Process may have exited between liveness probe and signal.
          }
        }),
    }),
  )
}
