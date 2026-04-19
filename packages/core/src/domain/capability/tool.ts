/**
 * `tool(...)` — typed factory for LLM-callable Capabilities.
 *
 * Authors call `tool({ id, description, params, execute, ... })` directly.
 * The factory enforces the LLM-tool shape at the type level: `params`
 * must be an LLM-JSON-schema-able `Schema.Schema`, `execute` returns an
 * `Effect`, and the action/request-only fields (`surface`, `intent`,
 * `input`, `output`) are forbidden.
 *
 * Replaces the previous two-step `tool(defineTool({...}))` pattern. The
 * old `defineTool` carrier dies in B11.5d.
 *
 * Lowering: produces an `AnyCapabilityContribution` with
 * `audiences: ["model"]`, `intent: "write"` (legacy default — tools
 * that are genuinely read-only should be authored as `request({ intent:
 * "read" })` for extension-to-extension messaging or fold their
 * idempotence into the actor reducer). The internal Capability shape
 * stays unchanged; `audiences` + `intent` are derived from the factory
 * choice and never appear in the author surface.
 *
 * @module
 */

import { type Effect, Schema } from "effect"
import type { AnyCapabilityContribution, ModelCapabilityContext } from "../capability.js"
import type { PermissionRule } from "../permission.js"
import type { PromptSection } from "../prompt.js"
import type { AnyToolDefinition } from "../tool.js"

/** Author-facing input to `tool(...)`. Mirrors the LLM-tool fields without
 *  the `audiences[]` / `intent` flag matrix.
 *
 *  `Params` is a `Schema.Decoder<I, never>` — the LLM bridge needs to
 *  decode JSON synchronously without resolving services, so the decoder
 *  may not have a context requirement. */
export interface ToolInput<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Params extends Schema.Decoder<any, never> = Schema.Decoder<any, never>,
  Result = unknown,
  Error = never,
  Deps = never,
> {
  /** Stable id (extension-local). Used by the LLM as the tool name. */
  readonly id: string
  /** Sent to the LLM as part of the tool schema — describes what the tool does. */
  readonly description: string
  /**
   * Schema for `execute` input. Must have no context requirement so the
   * LLM-bridge can decode JSON synchronously without resolving services.
   * `Schema.Decoder<I, never>` ⊆ `Schema.Schema<I, _, never>`.
   */
  readonly params: Params
  /**
   * Named resources this tool needs exclusive access to while running.
   * Two tools requesting the same resource name run serially; tools with
   * disjoint resource sets run in parallel. Empty/undefined = fully parallel.
   */
  readonly resources?: ReadonlyArray<string>
  /** Whether this tool is safe to replay after restart. */
  readonly idempotent?: boolean
  /** One-liner for the system prompt tool list (distinct from `description`,
   *  which is sent to the LLM as part of the tool schema). */
  readonly promptSnippet?: string
  /** Behavioral guidelines injected into the system prompt when this tool is active. */
  readonly promptGuidelines?: ReadonlyArray<string>
  /** If true, requires an interactive session — filtered out in headless
   *  mode and subagent contexts. */
  readonly interactive?: boolean
  /** Permission allow/deny rules gating execution. */
  readonly permissionRules?: ReadonlyArray<PermissionRule>
  /** Static system-prompt section bundled with this tool. For dynamic
   *  prompt fragments (resolved per-turn from services), use a `Projection`. */
  readonly prompt?: PromptSection
  /** The tool body. Receives decoded `params` and a `ModelCapabilityContext`
   *  (the wide host context — subagents, interaction, turn-control all reachable). */
  readonly execute: (
    params: Schema.Schema.Type<Params>,
    ctx: ModelCapabilityContext,
  ) => Effect.Effect<Result, Error, Deps>
}

/**
 * Lower a `ToolInput` (B11.5 shape) OR a legacy `AnyToolDefinition`
 * (from `defineTool({...})`) to an `AnyCapabilityContribution` with
 * `audiences: ["model"], intent: "write"`. The author never sees the
 * audience/intent fields.
 *
 * Two overloads — the new `{ id, ... }` shape is preferred; the legacy
 * `{ name, ... }` shape stays callable during the B11.5 migration
 * window. The legacy branch + `defineTool` + `ToolDefinition` interface
 * are deleted in B11.5d once all ~70 call sites migrate.
 *
 * Generic over `<Params, Result, Error, Deps>` so authors keep their
 * typed handler shape; the leaf is widened to `AnyCapabilityContribution`
 * at the bucket boundary (same variance hole as `pipeline`/`subscription`).
 */
export function tool<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Params extends Schema.Decoder<any, never>,
  Result,
  Error,
  Deps,
>(input: ToolInput<Params, Result, Error, Deps>): AnyCapabilityContribution
export function tool(definition: AnyToolDefinition): AnyCapabilityContribution
export function tool(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arg: ToolInput<Schema.Decoder<any, never>, unknown, unknown, unknown> | AnyToolDefinition,
): AnyCapabilityContribution {
  // Discriminate by shape: new factory has `id`; legacy `defineTool`
  // result has `name`. Migration window only — collapses to single
  // branch in B11.5d.
  const isLegacy = "name" in arg && !("id" in arg)
  if (isLegacy) {
    const t = arg as AnyToolDefinition
    return {
      id: t.name,
      description: t.description,
      audiences: ["model"],
      intent: "write",
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      input: t.params as Schema.Schema<unknown>,
      output: Schema.Unknown,
      ...(t.resources !== undefined ? { resources: t.resources } : {}),
      ...(t.idempotent !== undefined ? { idempotent: t.idempotent } : {}),
      ...(t.promptSnippet !== undefined ? { promptSnippet: t.promptSnippet } : {}),
      ...(t.promptGuidelines !== undefined ? { promptGuidelines: t.promptGuidelines } : {}),
      ...(t.interactive !== undefined ? { interactive: t.interactive } : {}),
      ...(t.permissionRules !== undefined ? { permissionRules: t.permissionRules } : {}),
      ...(t.prompt !== undefined ? { prompt: t.prompt } : {}),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      effect: t.execute as AnyCapabilityContribution["effect"],
    }
  }
  const input = arg as ToolInput<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Schema.Decoder<any, never>,
    unknown,
    unknown,
    unknown
  >
  return {
    id: input.id,
    description: input.description,
    audiences: ["model"],
    intent: "write",
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    input: input.params as Schema.Schema<unknown>,
    // ToolRunner consumes raw JSON output — Schema.Unknown is a no-op encode.
    // Tools needing typed-output validation should author through `request(...)`.
    output: Schema.Unknown,
    ...(input.resources !== undefined ? { resources: input.resources } : {}),
    ...(input.idempotent !== undefined ? { idempotent: input.idempotent } : {}),
    ...(input.promptSnippet !== undefined ? { promptSnippet: input.promptSnippet } : {}),
    ...(input.promptGuidelines !== undefined ? { promptGuidelines: input.promptGuidelines } : {}),
    ...(input.interactive !== undefined ? { interactive: input.interactive } : {}),
    ...(input.permissionRules !== undefined ? { permissionRules: input.permissionRules } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    // ModelCapabilityContext is the wide ctx — `tool` execute signatures
    // satisfy the capability `effect` signature contravariantly.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    effect: input.execute as AnyCapabilityContribution["effect"],
  }
}
