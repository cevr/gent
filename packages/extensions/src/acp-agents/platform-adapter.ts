import { Context, Layer } from "effect"

export interface AcpAgentsPlatformShape {
  readonly parentEnv: Record<string, string | undefined>
}

export class AcpAgentsPlatform extends Context.Service<AcpAgentsPlatform, AcpAgentsPlatformShape>()(
  "@gent/extensions/src/acp-agents/platform-adapter/AcpAgentsPlatform",
) {
  static Current: AcpAgentsPlatformShape = AcpAgentsPlatform.of({
    parentEnv: Bun.env,
  })

  static Live: Layer.Layer<AcpAgentsPlatform> = Layer.succeed(AcpAgentsPlatform, this.Current)
}
