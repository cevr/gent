import type { Effect } from "effect"

/** Typed, ordered building block for system prompts */
export interface PromptSection {
  readonly id: string
  readonly content: string
  /** Lower = earlier in the prompt. Default sections use 0-80 range. */
  readonly priority: number
}

/** Dynamic prompt section — id and priority are static, content resolved lazily. */
export interface DynamicPromptSection {
  readonly id: string
  readonly priority: number
  readonly resolve: Effect.Effect<string>
}

/** A prompt section can be static or dynamic (content resolved via Effect). */
export type PromptSectionInput = PromptSection | DynamicPromptSection

/** Type guard for dynamic prompt sections */
export const isDynamicPromptSection = (s: PromptSectionInput): s is DynamicPromptSection =>
  "resolve" in s
