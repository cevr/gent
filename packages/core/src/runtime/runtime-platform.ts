import { Layer, Context } from "effect"

export interface RuntimePlatformShape {
  readonly cwd: string
  readonly home: string
  readonly platform: string
}

export class RuntimePlatform extends Context.Service<RuntimePlatform, RuntimePlatformShape>()(
  "@gent/core/src/runtime/runtime-platform/RuntimePlatform",
) {
  static Live = (config: RuntimePlatformShape): Layer.Layer<RuntimePlatform> =>
    Layer.succeed(RuntimePlatform, config)

  static Test = (config: RuntimePlatformShape): Layer.Layer<RuntimePlatform> =>
    Layer.succeed(RuntimePlatform, config)
}
