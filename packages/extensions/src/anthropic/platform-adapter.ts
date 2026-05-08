import { Context, Effect, Layer } from "effect"
import {
  ExtensionHostProcessError,
  type ExtensionHostPlatform,
  type ExtensionHostRunProcessOptions,
} from "@gent/core-internal/domain/extension"
import { runProcess } from "@gent/core-internal/utils/run-process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

export interface AnthropicPlatformShape {
  readonly platform: string
  readonly home: string
  readonly parentEnv: Record<string, string | undefined>
  readonly runProcess: ExtensionHostPlatform["runProcess"]
}

export class AnthropicPlatform extends Context.Service<AnthropicPlatform, AnthropicPlatformShape>()(
  "@gent/extensions/src/anthropic/platform-adapter/AnthropicPlatform",
) {
  static readonly fromHost = (host: ExtensionHostPlatform): AnthropicPlatformShape =>
    AnthropicPlatform.of({
      platform: host.osInfo.platform,
      home: host.homeDirectory,
      parentEnv: host.parentEnv,
      runProcess: host.runProcess,
    })

  static Live = (host: ExtensionHostPlatform): Layer.Layer<AnthropicPlatform> =>
    Layer.effect(AnthropicPlatform, Effect.succeed(AnthropicPlatform.fromHost(host)))
}

export const runHostProcess = (
  command: string,
  args: ReadonlyArray<string>,
  options?: ExtensionHostRunProcessOptions,
) =>
  runProcess(command, args, options).pipe(
    Effect.mapError(
      (e) =>
        new ExtensionHostProcessError({
          command: e.command,
          message: e.message,
          cause: e.cause,
          timedOut: e.timedOut,
        }),
    ),
  )

export const runHostProcessWithSpawner =
  (spawner: ChildProcessSpawner["Service"]): ExtensionHostPlatform["runProcess"] =>
  (command, args, options) =>
    runHostProcess(command, args, options).pipe(Effect.provideService(ChildProcessSpawner, spawner))
