/**
 * `action(...)` — typed factory for human-driven UI Capabilities.
 *
 * Authors call `action({ id, name, description, surface, execute, ... })`.
 * Surface is `"slash" | "palette" | "both"` — presentation metadata
 * controlling where the action appears in the TUI. Actions always lower to
 * `intent: "write"` (UI affordances always express user intent).
 *
 * Host capabilities are imported through `ExtensionContext`; action handlers
 * receive decoded params only.
 *
 * @module
 */

import type { Effect, Schema } from "effect"
import type {
  ActionCapability as ActionCapabilityVariant,
  CapabilityEffect,
  CapabilityError,
  ErasedCapabilityEffect,
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
  readonly slash?: {
    /** Slash trigger without the leading `/`. Defaults to `id`. */
    readonly trigger?: string
    readonly name?: string
    readonly description?: string
    readonly category?: string
    readonly keybind?: string
  }
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
  /** Permission allow/deny rules gating execution. */
  readonly permissionRules?: ReadonlyArray<PermissionRule>
  /** Optional slash presentation metadata. */
  readonly slash?: {
    /** Slash trigger without the leading `/`. Defaults to `id`. */
    readonly trigger?: string
    readonly name?: string
    readonly description?: string
    readonly category?: string
    readonly keybind?: string
  }
  /** Schema for input — typically `Schema.Struct({})` for no-arg actions. */
  readonly input: Schema.Schema<Input>
  /** Schema for output. */
  readonly output: Schema.Schema<Output>
  /** Action handler. Receives decoded params only. */
  readonly execute: (input: Input) => Effect.Effect<Output, CapabilityError, R>
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
export function action<Input, Output, R>(
  input: ActionInput<Input, Output, R>,
): ActionCapability<Input, Output> {
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
    ...(input.permissionRules !== undefined ? { permissionRules: input.permissionRules } : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(input.keybind !== undefined ? { keybind: input.keybind } : {}),
    ...(input.slash !== undefined ? { slash: input.slash } : {}),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- schema and brand factory owns nominal type boundary
    effect: input.execute as CapabilityEffect<Input, Output, R, CapabilityError>,
  })
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ActionCapability brand applied at factory boundary
  return Object.assign(capability, {
    [ActionCapabilityBrand]: true as const,
  }) as unknown as ActionCapability<Input, Output>
}
