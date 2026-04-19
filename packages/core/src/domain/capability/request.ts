/**
 * `request(...)` — typed factory for extension-to-extension Capabilities.
 *
 * Authors call:
 *   - `request({ id, input, output, intent: "read", execute })` for read RPCs
 *   - `request({ id, input, output, intent: "write", execute })` for write RPCs
 *
 * Replaces the previous `query(...)` + `mutation(...)` pair. The lowering
 * collapses into one shape with `audiences: ["agent-protocol",
 * "transport-public"]` plus the chosen `intent`. CapabilityHost dispatches
 * by factory-origin metadata; authors never write the audience array.
 *
 * Read-fence: `intent: "read"` capabilities have `R extends ReadOnlyTag`
 * (a structural narrowing of the constraint to the same brand projection
 * R-channels use). Write-capable service Tags fail to compile in the
 * read-intent factory's R, mirroring the projection fence from B11.4.
 *
 * @module
 */

import { type Effect, type Schema } from "effect"
import type {
  AnyCapabilityContribution,
  CapabilityCoreContext,
  CapabilityError,
} from "../capability.js"
import type { PromptSection } from "../prompt.js"
import type { ReadOnlyTag } from "../read-only.js"

/** Author-facing input to `request({ intent: "read", ... })`. R is
 *  fenced read-only by `R extends ReadOnlyTag` — write Tags fail compile. */
export interface ReadRequestInput<
  Input = unknown,
  Output = unknown,
  R extends ReadOnlyTag = never,
> {
  /** Stable id (extension-local). Used for routing. */
  readonly id: string
  /** `intent: "read"` → R is fenced read-only at the type level. */
  readonly intent: "read"
  /** Schema for validating `input` at the boundary. */
  readonly input: Schema.Schema<Input>
  /** Schema for validating `output` at the boundary. */
  readonly output: Schema.Schema<Output>
  /** Static system-prompt section bundled with this request. */
  readonly prompt?: PromptSection
  /** The request handler. R must be ReadOnly-branded. */
  readonly execute: (
    input: Input,
    ctx: CapabilityCoreContext,
  ) => Effect.Effect<Output, CapabilityError, R>
}

/** Author-facing input to `request({ intent: "write", ... })`. R is
 *  unconstrained — write capabilities may yield any service. */
export interface WriteRequestInput<Input = unknown, Output = unknown, R = never> {
  /** Stable id (extension-local). Used for routing. */
  readonly id: string
  /** `intent: "write"` → R is unconstrained. */
  readonly intent: "write"
  /** Schema for validating `input` at the boundary. */
  readonly input: Schema.Schema<Input>
  /** Schema for validating `output` at the boundary. */
  readonly output: Schema.Schema<Output>
  /** Static system-prompt section bundled with this request. */
  readonly prompt?: PromptSection
  /** The request handler. */
  readonly execute: (
    input: Input,
    ctx: CapabilityCoreContext,
  ) => Effect.Effect<Output, CapabilityError, R>
}

/**
 * Lower a `ReadRequestInput | WriteRequestInput` to an
 * `AnyCapabilityContribution` with
 * `audiences: ["agent-protocol", "transport-public"]` and the chosen
 * `intent`. The author never sees those fields.
 *
 * Two overloads — one per intent. Read-intent overload constrains R to
 * `ReadOnlyTag` so the projection-style fence catches write-tagged
 * services in the read RPC's R channel.
 */
export function request<Input, Output, R extends ReadOnlyTag = never>(
  input: ReadRequestInput<Input, Output, R>,
): AnyCapabilityContribution
export function request<Input, Output, R = never>(
  input: WriteRequestInput<Input, Output, R>,
): AnyCapabilityContribution
export function request(input: {
  readonly id: string
  readonly intent: "read" | "write"
  readonly input: Schema.Schema<unknown>
  readonly output: Schema.Schema<unknown>
  readonly prompt?: PromptSection
  readonly execute: AnyCapabilityContribution["effect"]
}): AnyCapabilityContribution {
  return {
    id: input.id,
    audiences: ["agent-protocol", "transport-public"],
    intent: input.intent,
    input: input.input,
    output: input.output,
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    effect: input.execute,
  }
}
