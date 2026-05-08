import { Context, Effect, Layer } from "effect"
import type { ExtensionHostPlatform } from "@gent/core/extensions/api"

export interface AcpAgentsPlatformShape {
  readonly parentEnv: Record<string, string | undefined>
}

export class AcpAgentsPlatform extends Context.Service<AcpAgentsPlatform, AcpAgentsPlatformShape>()(
  "@gent/extensions/src/acp-agents/platform-adapter/AcpAgentsPlatform",
) {
  static readonly fromHost = (host: ExtensionHostPlatform): AcpAgentsPlatformShape =>
    AcpAgentsPlatform.of({ parentEnv: host.parentEnv })

  static Live = (host: ExtensionHostPlatform): Layer.Layer<AcpAgentsPlatform> =>
    Layer.effect(AcpAgentsPlatform, Effect.succeed(AcpAgentsPlatform.fromHost(host)))
}
