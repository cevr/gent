/**
 * `action(...)` — typed factory for human-driven UI Capabilities.
 *
 * Authors call `action({ id, name, description, surface, execute, ... })`.
 * Surface is `"slash" | "palette" | "both"` — presentation metadata
 * controlling where the action appears in the TUI. The `audiences[]` /
 * `intent` flag matrix is derived: actions always lower to
 * `audiences: ["human-slash" | "human-palette"]` (or both) and
 * `intent: "write"` (UI affordances always express user intent).
 *
 * Currently no callers exist in the codebase — slash commands and the
 * command palette aren't implemented as capabilities yet. The factory
 * is scaffolded here so the substrate has the right shape ready for
 * the TUI integration that lands in B11.6.
 *
 * @module
 */

import type { Effect, Schema } from "effect"
import type {
  AnyCapabilityContribution,
  CapabilityCoreContext,
  CapabilityError,
} from "../capability.js"

export type ActionSurface = "slash" | "palette" | "both"

/** Author-facing input to `action(...)`. */
export interface ActionInput<Input = unknown, Output = unknown, R = never> {
  /** Stable id (extension-local). Used for routing. */
  readonly id: string
  /** Display name in the slash menu / palette (distinct from `id`). */
  readonly name: string
  /** Human-readable description shown alongside the name. */
  readonly description: string
  /** Where the action appears in the TUI. */
  readonly surface: ActionSurface
  /** Optional category for palette grouping. */
  readonly category?: string
  /** Optional keybind hint (display-only — TUI may ignore). */
  readonly keybind?: string
  /** Schema for input — typically `Schema.Struct({})` for no-arg actions. */
  readonly input: Schema.Schema<Input>
  /** Schema for output. */
  readonly output: Schema.Schema<Output>
  /** Action handler. Always called from human input. */
  readonly execute: (
    input: Input,
    ctx: CapabilityCoreContext,
  ) => Effect.Effect<Output, CapabilityError, R>
}

const surfaceToAudiences = (
  surface: ActionSurface,
): ReadonlyArray<"human-slash" | "human-palette"> => {
  switch (surface) {
    case "slash":
      return ["human-slash"]
    case "palette":
      return ["human-palette"]
    case "both":
      return ["human-slash", "human-palette"]
  }
}

/**
 * Lower an `ActionInput` to an `AnyCapabilityContribution` with the
 * derived `audiences[]` (one per surface) and `intent: "write"`. The
 * surface metadata is preserved on the lowered shape via the
 * `description` channel for now; richer metadata (category/keybind)
 * lands when the TUI integration arrives in B11.6.
 */
export const action = <Input, Output, R>(
  input: ActionInput<Input, Output, R>,
): AnyCapabilityContribution => ({
  id: input.id,
  description: input.description,
  audiences: surfaceToAudiences(input.surface),
  intent: "write",
  input: input.input,
  output: input.output,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  effect: input.execute as AnyCapabilityContribution["effect"],
})
