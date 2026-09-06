import { Context, Layer, type Effect } from "effect"
import type { PublicExtensionSetupContext } from "@gent/core/extensions/api"

type PublicHost = PublicExtensionSetupContext["host"]
type PublicProcess = PublicExtensionSetupContext["Process"]

const executorBinaryName = (platform: string): string => {
  if (platform === "win32") return "executor.exe"
  return "executor"
}

export interface ExecutorPlatformApi {
  readonly execPath: string
  readonly pathListSeparator: string
  readonly binaryName: string
  readonly commandCandidates: (command: string) => ReadonlyArray<string>
  readonly isPortFree: (port: number) => Effect.Effect<boolean>
  readonly isPidAlive: (pid: number) => Effect.Effect<boolean>
  readonly signalPid: (pid: number, signal: NodeJS.Signals) => Effect.Effect<void>
  readonly runProcess: PublicProcess["runProcess"]
}

export class ExecutorPlatform extends Context.Service<ExecutorPlatform, ExecutorPlatformApi>()(
  "@gent/extensions/src/executor/platform-adapter/ExecutorPlatform",
) {
  static Live = (input: { readonly host: PublicHost; readonly Process: PublicProcess }) =>
    Layer.succeed(
      ExecutorPlatform,
      ExecutorPlatform.of({
        execPath: input.host.execPath,
        pathListSeparator: input.host.pathListSeparator,
        binaryName: executorBinaryName(input.host.osInfo.platform),
        commandCandidates: input.Process.commandCandidates,
        isPortFree: input.Process.isPortFree,
        isPidAlive: input.Process.isPidAlive,
        signalPid: input.Process.signalPid,
        runProcess: input.Process.runProcess,
      }),
    )

  static LiveFromSetup = (input: {
    readonly execPath: string
    readonly pathListSeparator: string
    readonly platform: string
    readonly Process: PublicProcess
  }) =>
    Layer.succeed(
      ExecutorPlatform,
      ExecutorPlatform.of({
        execPath: input.execPath,
        pathListSeparator: input.pathListSeparator,
        binaryName: executorBinaryName(input.platform),
        commandCandidates: input.Process.commandCandidates,
        isPortFree: input.Process.isPortFree,
        isPidAlive: input.Process.isPidAlive,
        signalPid: input.Process.signalPid,
        runProcess: input.Process.runProcess,
      }),
    )
}
