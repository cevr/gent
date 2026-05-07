/**
 * `action(...)` — typed factory for human-driven UI Capabilities.
 *
 * Authors call `action({ id, name, description, surface, execute, ... })`.
 * Surface is `"slash" | "palette" | "both"` — presentation metadata
 * controlling where the action appears in the TUI. Actions always lower to
 * `intent: "write"` (UI affordances always express user intent).
 *
 * The handler context is `ModelCapabilityContext` (the wide host
 * surface), not the narrow `CapabilityCoreContext`, so human actions can
 * use session, agent, and storage helpers directly.
 * Handlers asking for `CapabilityCoreContext` get a structurally-narrower
 * view by virtue of the inheritance chain.
 *
 * @module
 */

import type { Effect, Schema } from "effect"
import type {
  ActionCapability as ActionCapabilityVariant,
  CapabilityEffect,
  CapabilityError,
  ErasedCapabilityEffect,
  ModelCapabilityContext,
} from "../capability.js"
import { Capability } from "../capability.js"
import { CommandId } from "../ids.js"
import type { PermissionRule } from "../permission.js"
import type { PromptSection } from "../prompt.js"

export type ActionSurface = "slash" | "palette" | "both"

/**
 * `ActionCapability` — `action({...})` return type. The
 * `ExtensionContributions.actions` bucket is the discrimination; non-action
 * leaves (`tool`, `request`) cannot be slotted into `actions:`.
 */
const ActionCapabilityBrand: unique symbol = Symbol("@gent/core/ActionCapability")
declare const ActionCapabilityType: unique symbol
export type ActionCapability<Input = unknown, Output = unknown> = ActionCapabilityVariant & {
  readonly [ActionCapabilityBrand]: true
  readonly [ActionCapabilityType]?: {
    readonly input: Input
    readonly output: Output
  }
  readonly id: CommandId
  readonly surface: ReadonlyArray<"slash" | "palette">
  readonly intent: "write"
  readonly description: string
  readonly displayName: string
  readonly category?: string
  readonly keybind?: string
  readonly promptSnippet?: string
  readonly prompt?: PromptSection
  readonly permissionRules?: ReadonlyArray<PermissionRule>
  readonly input: Schema.Schema<Input>
  readonly output: Schema.Schema<Output>
  readonly effect: ErasedCapabilityEffect<CapabilityError>
}

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
  /** Optional one-liner injected into the system prompt's command list. */
  readonly promptSnippet?: string
  /** Optional category for palette grouping. */
  readonly category?: string
  /** Optional keybind hint (display-only — TUI may ignore). */
  readonly keybind?: string
  /** Schema for input — typically `Schema.Struct({})` for no-arg actions. */
  readonly input: Schema.Schema<Input>
  /** Schema for output. */
  readonly output: Schema.Schema<Output>
  /** Action handler. Always called from human input. Receives the wide
   *  `ModelCapabilityContext` for session, agent, and storage helpers. */
  readonly execute: (
    input: Input,
    ctx: ModelCapabilityContext,
  ) => Effect.Effect<Output, CapabilityError, R>
}

const surfaceToSurfaces = (surface: ActionSurface): ReadonlyArray<"slash" | "palette"> => {
  switch (surface) {
    case "slash":
      return ["slash"]
    case "palette":
      return ["palette"]
    case "both":
      return ["slash", "palette"]
  }
  return []
}

/**
 * Lower an `ActionInput` to an `ActionCapability` with the derived surfaces and
 * `intent: "write"`.
 */
export const action = <Input, Output, R>(
  input: ActionInput<Input, Output, R>,
): ActionCapability<Input, Output> => {
  const surface = surfaceToSurfaces(input.surface)
  const capability = Capability.Action.make({
    id: CommandId.make(input.id),
    description: input.description,
    surface,
    intent: "write",
    displayName: input.name,
    input: input.input,
    output: input.output,
    ...(input.promptSnippet !== undefined ? { promptSnippet: input.promptSnippet } : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(input.keybind !== undefined ? { keybind: input.keybind } : {}),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- schema and brand factory owns nominal type boundary
    effect: input.execute as CapabilityEffect<Input, Output, R, CapabilityError>,
  })
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ActionCapability brand applied at factory boundary
  return Object.assign(capability, {
    [ActionCapabilityBrand]: true as const,
  }) as unknown as ActionCapability<Input, Output>
}
