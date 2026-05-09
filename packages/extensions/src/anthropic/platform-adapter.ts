import { Context, Layer } from "effect"
import type { GentExtension, PublicExtensionSetupContext } from "@gent/core/extensions/api"

type ExtensionHostPlatform = Parameters<GentExtension["setup"]>[0]["host"]

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

  static readonly fromSetup = (input: {
    readonly platform: string
    readonly home: string
    readonly Process: PublicExtensionSetupContext["Process"]
  }): AnthropicPlatformShape =>
    AnthropicPlatform.of({
      platform: input.platform,
      home: input.home,
      parentEnv: input.Process.parentEnv,
      runProcess: input.Process.runProcess,
    })

  static Live = (host: ExtensionHostPlatform): Layer.Layer<AnthropicPlatform> =>
    Layer.succeed(AnthropicPlatform, AnthropicPlatform.fromHost(host))
}
