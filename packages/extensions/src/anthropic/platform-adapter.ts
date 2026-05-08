import { BunServices } from "@effect/platform-bun"
import { Context, Effect, Layer } from "effect"
import {
  ExtensionHostProcessError,
  runProcess,
  type ExtensionHostFacts,
  type ExtensionHostPlatform,
  type ExtensionHostRunProcessOptions,
} from "@gent/core/extensions/api"
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
  static readonly fromHost = (
    host: ExtensionHostFacts,
    spawner: ChildProcessSpawner["Service"],
  ): AnthropicPlatformShape =>
    AnthropicPlatform.of({
      platform: host.osInfo.platform,
      home: host.homeDirectory,
      parentEnv: Bun.env,
      runProcess: (command, args, options) =>
        runHostProcess(command, args, options).pipe(
          Effect.provideService(ChildProcessSpawner, spawner),
        ),
    })

  static Live = (host: ExtensionHostFacts): Layer.Layer<AnthropicPlatform> =>
    Layer.effect(
      AnthropicPlatform,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        return AnthropicPlatform.fromHost(host, spawner)
      }),
    ).pipe(Layer.provide(BunServices.layer))
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
