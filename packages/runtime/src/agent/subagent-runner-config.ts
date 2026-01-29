import { Context, Layer } from "effect"

export class SubagentRunnerConfig extends Context.Tag(
  "@gent/runtime/src/agent/subagent-runner-config/SubagentRunnerConfig",
)<
  SubagentRunnerConfig,
  {
    readonly subprocessBinaryPath?: string
    readonly systemPrompt: string
    readonly defaultModel: string
  }
>() {
  static Live = (config: {
    subprocessBinaryPath?: string
    systemPrompt: string
    defaultModel: string
  }) =>
    Layer.succeed(SubagentRunnerConfig, {
      subprocessBinaryPath: config.subprocessBinaryPath,
      systemPrompt: config.systemPrompt,
      defaultModel: config.defaultModel,
    })
}
