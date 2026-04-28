/**
 * `action(...)` — typed factory for human-driven UI Capabilities.
 *
 * Authors call `action({ id, name, description, surface, execute, ... })`.
 * Surface is `"slash" | "palette" | "both"` — presentation metadata
 * controlling where the action appears in the TUI. The `audiences[]` /
 * `intent` flag matrix is derived: actions always lower to
 * `audiences: [<surface-derived>]` and `intent: "write"` (UI affordances
 * always express user intent).
 *
 * The handler context is `ModelCapabilityContext` (the wide host
 * surface), not the narrow `CapabilityCoreContext`, so human actions can
 * use session, agent, storage, and typed extension RPC helpers directly.
 * Handlers asking for `CapabilityCoreContext` get a structurally-narrower
 * view by virtue of the inheritance chain.
 *
 * @module
 */

import type { Effect, Schema } from "effect"
import type {
  AnyCapabilityContribution,
  Audience,
  CapabilityError,
  CapabilityToken,
  ModelCapabilityContext,
} from "../capability.js"
import { CommandId } from "../ids.js"

export type ActionSurface = "slash" | "palette" | "both"

/**
 * `ActionToken` — `action({...})` return type. Narrows `CapabilityToken` so
 * `audiences` is fixed to the human-surface cluster (`"human-slash"` and/or
 * `"human-palette"`) at the type level.
 * The `ExtensionContributions.commands` bucket only accepts this narrowed
 * shape — non-action capabilities (`tool`, `request`) cannot be slotted into
 * `commands:`, so the bucket name IS the audience discrimination (consistent
 * with W10-3a's `tools:` bucket).
 *
 * `ActionToken` extends `CapabilityToken`; runtime-loaded extensions can also
 * author capabilities directly without going through `action()`, but the
 * `commands:` bucket only accepts the branded shape.
 */
declare const ActionTokenBrand: unique symbol
export interface ActionToken<Input = unknown, Output = unknown> extends CapabilityToken<
  Input,
  Output
> {
  readonly [ActionTokenBrand]: true
  readonly id: CommandId
  readonly audiences: ReadonlyArray<"human-slash" | "human-palette">
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
   *  `ModelCapabilityContext` for session, agent, storage, and typed RPC
   *  helpers. */
  readonly execute: (
    input: Input,
    ctx: ModelCapabilityContext,
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
 * derived `audiences[]` (one per surface) and `intent: "write"`.
 */
export const action = <Input, Output, R>(
  input: ActionInput<Input, Output, R>,
): ActionToken<Input, Output> => {
  const audiences: ReadonlyArray<Audience> = surfaceToAudiences(input.surface)
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ActionToken brand applied at factory boundary
  return {
    id: CommandId.make(input.id),
    description: input.description,
    audiences,
    intent: "write",
    displayName: input.name,
    input: input.input,
    output: input.output,
    ...(input.promptSnippet !== undefined ? { promptSnippet: input.promptSnippet } : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(input.keybind !== undefined ? { keybind: input.keybind } : {}),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- schema and brand factory owns nominal type boundary
    effect: input.execute as AnyCapabilityContribution["effect"],
  } as unknown as ActionToken<Input, Output>
}
