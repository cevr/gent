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
 * `audiences: ["model"]` and the author-supplied `intent` (default
 * `"write"`). Read-only tools (`fs-tools/read.ts`, `grep.ts`,
 * `glob.ts`) pass `intent: "read"` so future read-only sub-agent gates
 * can filter honestly.
 *
 * @module
 */

import { type Effect, Schema } from "effect"
import type {
  AnyCapabilityContribution,
  CapabilityToken,
  Intent,
  ModelCapabilityContext,
} from "../capability.js"
import type { ToolCallId } from "../ids.js"
import type { PermissionRule } from "../permission.js"
import type { PromptSection } from "../prompt.js"

/** Context passed to `tool({...}).execute`. Same shape as the wide
 *  `ModelCapabilityContext` but with `toolCallId` narrowed to required.
 *  Tools are always invoked from the agent loop with a real call id;
 *  the optional shape on `CapabilityCoreContext` only exists for the
 *  audience-neutral case where no tool call is in flight. */
export interface ToolCapabilityContext extends ModelCapabilityContext {
  readonly toolCallId: ToolCallId
}

/** Author-facing input to `tool(...)`. Mirrors the LLM-tool fields without
 *  the `audiences[]` / `intent` flag matrix.
 *
 *  `Params` is a `Schema.Decoder<I, never>` — the LLM bridge needs to
 *  decode JSON synchronously without resolving services, so the decoder
 *  may not have a context requirement. */
export interface ToolInput<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
  Params extends Schema.Decoder<any, never> = Schema.Decoder<any, never>,
  Result = unknown,
  Error = never,
  Deps = never,
> {
  /** Stable id (extension-local). Used by the LLM as the tool name. */
  readonly id: string
  /** Sent to the LLM as part of the tool schema — describes what the tool does. */
  readonly description: string
  /** Read vs write. Defaults to `"write"`. Read-only tools (e.g. `fs-tools/read`,
   *  `grep`, `glob`) should pass `intent: "read"` so that future read-only
   *  sub-agent gates can filter honestly. */
  readonly intent?: Intent
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
  /** The tool body. Receives decoded `params` and a `ToolCapabilityContext`
   *  (the wide host context — subagents, interaction, turn-control all reachable —
   *  with `toolCallId` narrowed to required). */
  readonly execute: (
    params: Schema.Schema.Type<Params>,
    ctx: ToolCapabilityContext,
  ) => Effect.Effect<Result, Error, Deps>
}

/**
 * Lower a `ToolInput` to an `AnyCapabilityContribution` with
 * `audiences: ["model"], intent: "write"`. The author never sees the
 * audience/intent fields.
 *
 * Generic over `<Params, Result, Error, Deps>` so authors keep their
 * typed handler shape; the leaf is widened to `AnyCapabilityContribution`
 * at the bucket boundary.
 *
 * The legacy `defineTool` carrier was deleted in B11.5d.
 */
export const tool = <
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
  Params extends Schema.Decoder<any, never>,
  Result,
  Error,
  Deps,
>(
  input: ToolInput<Params, Result, Error, Deps>,
): CapabilityToken =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- CapabilityToken brand applied at factory boundary
  ({
    id: input.id,
    description: input.description,
    audiences: ["model"],
    intent: input.intent ?? "write",
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- schema and brand factory owns nominal type boundary
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
    // ToolCapabilityContext extends ModelCapabilityContext and narrows
    // `toolCallId` to required — `tool` execute signatures satisfy the
    // capability `effect` signature contravariantly.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- schema and brand factory owns nominal type boundary
    effect: input.execute as AnyCapabilityContribution["effect"],
  }) as unknown as CapabilityToken
