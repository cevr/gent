import { Context } from "effect"
import type { PublicExtensionSetupContext } from "@gent/core/extensions/api"

type ExtensionHostProcess = PublicExtensionSetupContext["Process"]

export interface AnthropicPlatformShape {
  readonly platform: string
  readonly home: string
  readonly parentEnv: Record<string, string | undefined>
  readonly runProcess: ExtensionHostProcess["runProcess"]
}

export class AnthropicPlatform extends Context.Service<AnthropicPlatform, AnthropicPlatformShape>()(
  "@gent/extensions/src/anthropic/platform-adapter/AnthropicPlatform",
) {
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
}
