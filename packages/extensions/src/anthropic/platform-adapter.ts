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
  /**
   * Build from a `defineExtension` setup context. `home` is sourced from
   * `host.homeDirectory` (the OS user home), not `ctx.home` (the Gent
   * configured home) — the Claude Code credential file lives at the OS
   * user's home regardless of a `GENT_HOME` override, and earlier
   * refactors regressed this exactly once. Centralizing the lookup here
   * means future callers can't pick the wrong field.
   */
  static readonly fromSetup = (ctx: PublicExtensionSetupContext): AnthropicPlatformShape =>
    AnthropicPlatform.of({
      platform: ctx.host.osInfo.platform,
      home: ctx.host.homeDirectory,
      parentEnv: ctx.Process.parentEnv,
      runProcess: ctx.Process.runProcess,
    })
}
