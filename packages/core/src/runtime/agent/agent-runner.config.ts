import type { PromptSection } from "../../domain/prompt.js"

export interface AgentRunnerConfig {
  readonly timeoutMs?: number
  readonly baseSections?: ReadonlyArray<PromptSection>
}
