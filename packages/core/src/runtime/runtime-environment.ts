import { Layer, Context } from "effect"

export interface RuntimeEnvironmentShape {
  readonly cwd: string
  readonly home: string
  readonly platform: string
}

export class RuntimeEnvironment extends Context.Service<
  RuntimeEnvironment,
  RuntimeEnvironmentShape
>()("@gent/core/src/runtime/runtime-environment/RuntimeEnvironment") {
  static Live = (config: RuntimeEnvironmentShape): Layer.Layer<RuntimeEnvironment> =>
    Layer.succeed(RuntimeEnvironment, config)

  static Test = (config: RuntimeEnvironmentShape): Layer.Layer<RuntimeEnvironment> =>
    Layer.succeed(RuntimeEnvironment, config)
}
