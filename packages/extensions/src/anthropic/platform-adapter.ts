import { Context } from "effect"
import type { PublicExtensionSetupContext } from "@gent/core/extensions/api"

type ExtensionHostProcess = PublicExtensionSetupContext["Process"]

/**
 * Env vars for Anthropic keychain, read once at extension setup and
 * carried alongside platform inputs. Previously a module-level `let
 * _env`; promoted onto the platform shape so each extension instance
 * carries its own snapshot.
 */
export interface AnthropicKeychainEnv {
  readonly betaFlags?: string
  readonly cliVersion?: string
  readonly entrypoint?: string
  readonly userAgent?: string
}

export interface AnthropicPlatformShape {
  readonly platform: string
  readonly home: string
  readonly parentEnv: Record<string, string | undefined>
  readonly runProcess: ExtensionHostProcess["runProcess"]
  readonly env: AnthropicKeychainEnv
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
  static readonly fromSetup = (
    ctx: PublicExtensionSetupContext,
    env: AnthropicKeychainEnv,
  ): AnthropicPlatformShape =>
    AnthropicPlatform.of({
      platform: ctx.host.osInfo.platform,
      home: ctx.host.homeDirectory,
      parentEnv: ctx.Process.parentEnv,
      runProcess: ctx.Process.runProcess,
      env,
    })
}
