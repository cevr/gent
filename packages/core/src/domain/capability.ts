/**
 * Capability — typed callable endpoint shared by all "the runtime calls this
 * Effect" contribution kinds (today: tool, query, mutation, command).
 *
 * Will collapse the five per-kind callable contributions (`tool`, `query`,
 * `mutation`, `command`) into one shape distinguished by `audiences` (who
 * may invoke) and `intent` (read vs write). Smart constructors keep the
 * domain names — authors still write `tool(...)`, `query(...)`,
 * `mutation(...)`, `command(...)`.
 *
 * `agent` stays as its own contribution kind (it is a configuration spec
 * with no handler — wrapping it as a Capability would be ceremony).
 *
 * Sequencing per `migrate-callers-then-delete-legacy-apis`:
 *   - C4.1 (here): Capability shape + CapabilityHost skeleton; legacy
 *     tool/query/mutation/command kinds untouched.
 *   - C4.2: migrate query + mutation (only `task-tools` declares them today).
 *   - C4.3: migrate command (only `executor` declares them).
 *   - C4.4: migrate tool (~50 files).
 *   - C4.5: delete legacy types + per-kind registries.
 *
 * Audience surface:
 *
 *   - `"model"`         — LLM may invoke as a tool. Carries the optional
 *                         model-specific fields (`resources`, `idempotent`,
 *                         `promptSnippet`, `promptGuidelines`, `interactive`).
 *   - `"agent-protocol"` — other server extensions may invoke via
 *                         `ctx.extension.query(...)` / `.mutate(...)`.
 *   - `"transport-public"` — any transport client (TUI, SDK, future web UI)
 *                         may invoke via the published transport surface.
 *   - `"human-slash"`   — slash-command surface in the TUI.
 *   - `"human-palette"` — command-palette surface in the TUI.
 *
 * `intent` is a typed mode replacing the query/mutation discriminator.
 * `intent: "read"` is enforced read-only via the lint rule that scans the
 * effect's R channel for write-tagged services (the same rule that fences
 * `ProjectionContribution.query` today).
 *
 * @module
 */

import { type Effect, Schema } from "effect"
import type { ExtensionHostContext } from "./extension-host-context.js"
import type { ToolCallId } from "./ids.js"

/** Failure raised by a Capability handler. Carries audience + id for diagnostics. */
export class CapabilityError extends Schema.TaggedErrorClass<CapabilityError>()(
  "@gent/core/src/domain/capability/CapabilityError",
  {
    extensionId: Schema.String,
    capabilityId: Schema.String,
    reason: Schema.String,
  },
) {}

/** Failure raised when a Capability is invoked with an id that has no contribution. */
export class CapabilityNotFoundError extends Schema.TaggedErrorClass<CapabilityNotFoundError>()(
  "@gent/core/src/domain/capability/CapabilityNotFoundError",
  {
    extensionId: Schema.String,
    capabilityId: Schema.String,
  },
) {}

/** Who may invoke a Capability. Drives dispatch in `CapabilityHost`. */
export type Audience =
  | "model"
  | "agent-protocol"
  | "transport-public"
  | "human-slash"
  | "human-palette"

/** Read vs write. Lint enforces that `intent: "read"` Capabilities may not
 *  declare write-tagged services in their effect's R channel. */
export type Intent = "read" | "write"

/** Context handed to a Capability's `effect`. Extends `ExtensionHostContext`
 *  for the model audience (which needs `agentRunner`, `extension.query`,
 *  etc.); other audiences ignore the extra surface. */
export interface CapabilityContext extends ExtensionHostContext {
  /** Present only when this Capability was invoked as a tool by the LLM. */
  readonly toolCallId?: ToolCallId
}

/** Optional fields meaningful only when `audiences` includes `"model"`. */
export interface ModelAudienceFields {
  /** Named resources this Capability needs exclusive access to while running.
   *  Two Capabilities requesting the same resource name run serially. */
  readonly resources?: ReadonlyArray<string>
  /** Whether this Capability is safe to replay after restart (read-only = true). */
  readonly idempotent?: boolean
  /** One-liner for the system prompt tool list. */
  readonly promptSnippet?: string
  /** Behavioral guidelines injected into the system prompt when this
   *  Capability is active. */
  readonly promptGuidelines?: ReadonlyArray<string>
  /** If true, requires an interactive session — filtered out in headless
   *  mode and subagent contexts. */
  readonly interactive?: boolean
}

/** A typed callable endpoint contributed by an extension.
 *
 *  - `Input` and `Output` are validated at the host boundary
 *  - `R` is the service requirement of the `effect`; provided by the
 *    extension's contributed Resources
 *  - `intent: "read"` is lint-enforced read-only on the R channel
 *  - `audiences` drives dispatch — one Capability may be a tool AND a
 *    transport-public RPC by listing both
 */
export interface CapabilityContribution<
  Input = unknown,
  Output = unknown,
  R = never,
  E = CapabilityError,
> extends ModelAudienceFields {
  /** Stable id (extension-local). Used for routing. */
  readonly id: string
  /** Who may invoke. */
  readonly audiences: ReadonlyArray<Audience>
  /** Read vs write. Lint-enforced on `R` for `"read"`. */
  readonly intent: Intent
  /** Schema for validating `input` at the boundary. */
  readonly input: Schema.Schema<Input>
  /** Schema for validating `output` at the boundary. May be `Schema.Unknown`
   *  when the audience does not require output validation (e.g., the LLM
   *  consumes raw tool output). */
  readonly output: Schema.Schema<Output>
  /** The Capability's effect. */
  readonly effect: (input: Input, ctx: CapabilityContext) => Effect.Effect<Output, E, R>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCapabilityContribution = CapabilityContribution<any, any, any, any>

/** Reference object handed to callers — pairs the extension id with the
 *  Capability so `ctx.extension.invoke(ref, input)` can route + decode. */
export interface CapabilityRef<Input = unknown, Output = unknown> {
  readonly extensionId: string
  readonly capabilityId: string
  readonly input: Schema.Schema<Input>
  readonly output: Schema.Schema<Output>
}
