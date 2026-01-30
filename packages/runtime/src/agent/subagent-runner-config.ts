import { Context, Layer } from "effect"

export class SubagentRunnerConfig extends Context.Tag(
  "@gent/runtime/src/agent/subagent-runner-config/SubagentRunnerConfig",
)<
  SubagentRunnerConfig,
  {
    readonly subprocessBinaryPath?: string
    readonly systemPrompt: string
    readonly defaultModel: string
    readonly maxAttempts: number
    readonly retryInitialDelayMs: number
    readonly retryMaxDelayMs: number
    readonly timeoutMs?: number
  }
>() {
  static Live = (config: {
    subprocessBinaryPath?: string
    systemPrompt: string
    defaultModel: string
    maxAttempts?: number
    retryInitialDelayMs?: number
    retryMaxDelayMs?: number
    timeoutMs?: number
  }) =>
    Layer.succeed(SubagentRunnerConfig, {
      subprocessBinaryPath: config.subprocessBinaryPath,
      systemPrompt: config.systemPrompt,
      defaultModel: config.defaultModel,
      maxAttempts: Math.max(1, config.maxAttempts ?? 1),
      retryInitialDelayMs: Math.max(0, config.retryInitialDelayMs ?? 250),
      retryMaxDelayMs: Math.max(0, config.retryMaxDelayMs ?? 5_000),
      timeoutMs: config.timeoutMs,
    })
}
