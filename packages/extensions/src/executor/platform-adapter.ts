import { Context, Layer, type Effect } from "effect"
import type { GentExtension } from "@gent/core/extensions/api"

type ExtensionHostPlatform = Parameters<GentExtension["setup"]>[0]["host"]

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
  static Live = (host: ExtensionHostPlatform) =>
    Layer.succeed(
      ExecutorPlatform,
      ExecutorPlatform.of({
        execPath: host.execPath,
        pathListSeparator: host.pathListSeparator,
        binaryName: host.osInfo.platform === "win32" ? "executor.exe" : "executor",
        commandCandidates: host.commandCandidates,
        isPortFree: host.isPortFree,
        isPidAlive: host.isPidAlive,
        signalPid: host.signalPid,
        runProcess: host.runProcess,
      }),
    )
}
