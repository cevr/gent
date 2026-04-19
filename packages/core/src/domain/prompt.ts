/** Typed, ordered building block for system prompts.
 *
 *  Static prompt sections are bundled on `Capability.prompt`. Dynamic content
 *  (resolved per-turn from services) lives on `Projection.prompt(value)`.
 */
export interface PromptSection {
  readonly id: string
  readonly content: string
  /** Lower = earlier in the prompt. Default sections use 0-80 range. */
  readonly priority: number
}
