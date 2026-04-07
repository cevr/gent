import type { Effect } from "effect"

/** Typed, ordered building block for system prompts */
export interface PromptSection {
  readonly id: string
  readonly content: string
  /** Lower = earlier in the prompt. Default sections use 0-80 range. */
  readonly priority: number
}

/** Dynamic prompt section — id and priority are static, content resolved lazily.
 *  R defaults to never (no service requirements). The fluent builder constrains
 *  R to the extension's Provides type, giving compile-time safety. */
export interface DynamicPromptSection<R = never> {
  readonly id: string
  readonly priority: number
  readonly resolve: Effect.Effect<string, never, R>
}

/** A prompt section can be static or dynamic (content resolved via Effect). */
export type PromptSectionInput = PromptSection | DynamicPromptSection<never>

/** Type guard for dynamic prompt sections */
export const isDynamicPromptSection = (s: PromptSectionInput): s is DynamicPromptSection<never> =>
  "resolve" in s
