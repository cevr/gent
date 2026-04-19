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
import type { BranchId, SessionId, ToolCallId } from "./ids.js"

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

/**
 * Per codex BLOCK on C4.1: a single fat `CapabilityContext extends
 * ExtensionHostContext` would expose `extension.mutate`, session mutation,
 * interaction, and turn-control surfaces to every read capability — making
 * the `intent: "read"` fence dishonest at the context level even when lint
 * stops write-shaped service calls.
 *
 * Split: `CapabilityCoreContext` (the always-on minimum) plus the wider
 * `ModelCapabilityContext` for the model audience whose handlers historically
 * have full host access through `ToolContext` (and frequently rely on it —
 * spawning subagents, asking for approval, queuing follow-ups).
 *
 * Capability authors pick the surface they need by typing their `effect`'s
 * second parameter:
 *   - `(input, ctx: CapabilityCoreContext) => …` — the default, audience-neutral
 *   - `(input, ctx: ModelCapabilityContext) => …` — model tools that need
 *     subagent / interaction / turn-control surfaces
 *
 * The host always passes the full `ModelCapabilityContext`; the structural
 * subtype relationship guarantees that handlers asking for less get less in
 * their type-level surface, and any attempt to call wider-surface methods
 * (e.g., `ctx.interaction.approve(…)`) on a `CapabilityCoreContext` fails to
 * type-check.
 */
export interface CapabilityCoreContext {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  /** Present only when this Capability was invoked as a tool by the LLM. */
  readonly toolCallId?: ToolCallId
  readonly cwd: string
  readonly home: string
}

/** The wide audience-specific context for `audiences: ["model"]` capabilities
 *  (today's `ToolContext` shape). Read+write surfaces, agent runner, session
 *  mutations, interaction, and turn-control are all reachable. */
export interface ModelCapabilityContext extends ExtensionHostContext, CapabilityCoreContext {}

/**
 * Default ctx parameter type for the host's `run` signature — the host always
 * passes a value that satisfies `ModelCapabilityContext`. Handlers that ask
 * for `CapabilityCoreContext` get a structurally-narrower view.
 *
 * Kept as an alias for the wide context so callers writing
 * `(input, ctx: CapabilityContext) => …` continue to compile, but new code
 * should choose `CapabilityCoreContext` or `ModelCapabilityContext` explicitly.
 */
export type CapabilityContext = ModelCapabilityContext

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
  /** Human-readable description. For `audiences:["model"]`, this is sent to
   *  the LLM as part of the tool schema (so the model knows what the
   *  capability does); for other audiences it is informational. Distinct
   *  from `promptSnippet`, which is the one-liner injected into the system
   *  prompt's tool list. */
  readonly description?: string
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

/**
 * Reference object handed to callers so they can route + decode through the
 * runtime's Capability dispatcher. The actual invoker on
 * `ExtensionHostContext.Extension` is wired in C4.2 (when query/mutation
 * migrate); until then this type is consumed only by C4-internal code. The
 * `query` / `mutate` methods on `ExtensionHostContext.Extension` keep their
 * existing typed-RPC role for the duration of the C4.2-4 migration.
 */
export interface CapabilityRef<Input = unknown, Output = unknown> {
  readonly extensionId: string
  readonly capabilityId: string
  readonly input: Schema.Schema<Input>
  readonly output: Schema.Schema<Output>
}
