import { Layer, Context } from "effect"

export interface RuntimeEnvironmentApi {
  readonly cwd: string
  readonly home: string
  readonly platform: string
}

export class RuntimeEnvironment extends Context.Service<
  RuntimeEnvironment,
  RuntimeEnvironmentApi
>()("@gent/core/src/runtime/runtime-environment/RuntimeEnvironment") {
  static Live = (config: RuntimeEnvironmentApi): Layer.Layer<RuntimeEnvironment> =>
    Layer.succeed(RuntimeEnvironment, config)

  static Test = (config: RuntimeEnvironmentApi): Layer.Layer<RuntimeEnvironment> =>
    Layer.succeed(RuntimeEnvironment, config)
}
