import { Context, Layer } from "effect"
import * as os from "node:os"

export interface AnthropicPlatformShape {
  readonly platform: string
  readonly home: string
  readonly parentEnv: Record<string, string | undefined>
}

export class AnthropicPlatform extends Context.Service<AnthropicPlatform, AnthropicPlatformShape>()(
  "@gent/extensions/src/anthropic/platform-adapter/AnthropicPlatform",
) {
  static Live: Layer.Layer<AnthropicPlatform> = Layer.succeed(
    AnthropicPlatform,
    AnthropicPlatform.of({
      platform: process.platform,
      home: os.homedir(),
      parentEnv: Bun.env,
    }),
  )
}
