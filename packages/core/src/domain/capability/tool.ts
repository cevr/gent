/**
 * `tool(...)` — typed factory for LLM-callable Capabilities.
 *
 * Authors call `tool({ id, description, params, execute, ... })` directly.
 * The factory enforces the LLM-tool shape at the type level: `params`
 * must be an LLM-JSON-schema-able `Schema.Schema`, `execute` returns an
 * `Effect`, and the action/request-only fields (`surface`, `intent`,
 * `input`) are forbidden.
 *
 * Replaces the previous two-step `tool(defineTool({...}))` pattern.
 *
 * Lowering: produces a branded native Effect AI tool annotated with Gent
 * metadata. Runtime code reads Gent-only fields from that annotation instead
 * of widening Effect's tool surface.
 *
 * @module
 */

import { Context, type Effect, Schema } from "effect"
import * as AiTool from "effect/unstable/ai/Tool"
import {
  Capability,
  type CapabilityCoreContext,
  type ModelCapabilityContext,
  type ToolCapability as ToolCapabilityVariant,
} from "../capability.js"
import { ToolId, type ToolCallId } from "../ids.js"
import type { PermissionRule } from "../permission.js"
import type { PromptSection } from "../prompt.js"

export type ToolNeedAccess = "read" | "write"

export const LOCK_REGISTRY = [
  // Shared subagent budget: review/research/audit/delegate/handoff/plan all
  // spawn agent work and intentionally serialize against each other.
  "agent",
  "artifact",
  "auto",
  "fs",
  "interaction",
  "memory",
  "network",
  "process",
  "recovery",
  "repo",
  "session",
  "skills",
  "task",
  "test-serial",
] as const

export type ToolNeedTag = (typeof LOCK_REGISTRY)[number]

export interface ToolNeed {
  readonly tag: ToolNeedTag
  readonly access: ToolNeedAccess
}

export const ToolNeeds = {
  read: (tag: ToolNeedTag): ToolNeed => ({ tag, access: "read" }),
  write: (tag: ToolNeedTag): ToolNeed => ({ tag, access: "write" }),
} as const

const ToolCapabilityBrand: unique symbol = Symbol("@gent/core/ToolCapability")
declare const ToolCapabilityType: unique symbol

/** Minimal context passed to `tool({...}).execute` unless the author opts into
 *  the wider `ToolCapabilityContext`. Tools are always invoked from the agent
 *  loop with a real call id; the optional shape on `CapabilityCoreContext`
 *  only exists for the audience-neutral case where no tool call is in flight. */
export interface ToolCoreContext extends CapabilityCoreContext {
  readonly toolCallId: ToolCallId
  readonly capabilityContext?: Context.Context<never>
}

export interface GentToolMetadata<Input = unknown, Output = unknown, Error = unknown> {
  readonly id: ToolId
  readonly intent: "read" | "write"
  readonly input: Schema.Decoder<Input, never>
  readonly output: Schema.Encoder<unknown, never>
  readonly needs?: ReadonlyArray<ToolNeed>
  readonly promptSnippet?: string
  readonly promptGuidelines?: ReadonlyArray<string>
  readonly interactive?: boolean
  readonly permissionRules?: ReadonlyArray<PermissionRule>
  readonly prompt?: PromptSection
  readonly effect: (input: unknown, ctx: ToolCoreContext) => Effect.Effect<Output, Error, never>
}

export const GentToolMetadataTag = Context.Reference<GentToolMetadata | undefined>(
  "@gent/core/src/domain/capability/tool/GentToolMetadata",
  { defaultValue: () => undefined },
)

/**
 * `ToolCapability` — `tool({...})` return type. Gent tools are native Effect AI
 * tools annotated with Gent execution metadata. Runtime code reads Gent-only
 * fields from the annotation instead of widening Effect's tool surface.
 */
export type ToolCapability<Input = unknown, Output = unknown, Error = unknown> = AiTool.Any & {
  readonly [ToolCapabilityBrand]: true
  readonly [ToolCapabilityType]?: {
    readonly input: Input
    readonly output: Output
    readonly error: Error
  }
} & ToolCapabilityVariant

export const getToolMetadataOption = (tool: AiTool.Any): GentToolMetadata | undefined =>
  Context.get(tool.annotations, GentToolMetadataTag)

export const isToolCapability = (value: unknown): value is ToolCapability => {
  const tag =
    typeof value === "object" && value !== null && "_tag" in value ? value._tag : undefined
  if (
    !(AiTool.isUserDefined(value) || AiTool.isDynamic(value) || AiTool.isProviderDefined(value)) ||
    !(ToolCapabilityBrand in value) ||
    tag !== "tool"
  ) {
    return false
  }
  return getToolMetadataOption(value) !== undefined
}

/**
 * Invariant violation: a `ToolCapability` should always carry `GentToolMetadata`.
 * Surfaces as a typed defect (via `Effect.die`) when callers thread through
 * an Effect; surfaces as a synchronous throw otherwise. Either path is a
 * programmer-misuse-only signal — no runtime code can construct a `ToolCapability`
 * without metadata through the public `tool({...})` factory.
 */
export class ToolMetadataMissingError extends Schema.TaggedErrorClass<ToolMetadataMissingError>()(
  "ToolMetadataMissingError",
  {
    toolName: Schema.String,
  },
) {
  override get message(): string {
    return `Tool "${this.toolName}" is missing Gent metadata`
  }
}

export const getToolMetadata = <Input, Output, Error>(
  tool: ToolCapability<Input, Output, Error>,
): GentToolMetadata<Input, Output, Error> => {
  const metadata = getToolMetadataOption(tool)
  if (metadata === undefined) {
    throw new ToolMetadataMissingError({ toolName: tool.name })
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ToolCapability carries Input/Output as a phantom type; annotation storage is intentionally heterogeneous.
  return metadata as GentToolMetadata<Input, Output, Error>
}

export const getToolId = (tool: ToolCapability): ToolId => getToolMetadata(tool).id

export const getToolEffect = <Input, Output, Error>(
  tool: ToolCapability<Input, Output, Error>,
): GentToolMetadata<Input, Output, Error>["effect"] => getToolMetadata(tool).effect

/** Wide context for tools that explicitly need model host authority
 *  (agent runner, session mutation, interaction). Authors opt in by declaring
 *  matching `ToolNeeds` and annotating the second execute parameter as
 *  `ToolCapabilityContext`. */
export interface ToolCapabilityContext extends ModelCapabilityContext {
  readonly toolCallId: ToolCallId
}

/** Author-facing input to `tool(...)`. Mirrors the LLM-tool fields as a
 *  standalone leaf with no shared capability parent.
 *
 *  `Params` is a `Schema.Decoder<I, never>` — the tool adapter needs to
 *  decode JSON synchronously without resolving services, so the decoder
 *  may not have a context requirement. */
export interface ToolInput<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
  Params extends Schema.Decoder<any, never> = Schema.Decoder<any, never>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
  Output extends Schema.Encoder<any, never> = Schema.Encoder<any, never>,
  Error = never,
  Deps = never,
  Ctx extends ToolCoreContext = ToolCoreContext,
> {
  /** Stable id (extension-local). Used by the LLM as the tool name. */
  readonly id: string
  /** Sent to the LLM as part of the tool schema — describes what the tool does. */
  readonly description: string
  /** Read vs write. Defaults to `"write"`. Read-only tools (e.g. `fs-tools/read`,
   *  `grep`, `glob`) should pass `intent: "read"`. */
  readonly intent?: "read" | "write"
  /** Marks a write tool as destructive for Effect AI provider metadata. */
  readonly destructive?: boolean
  /**
   * Schema for `execute` input. Must have no context requirement so the
   * tool adapter can decode JSON synchronously without resolving services.
   * `Schema.Decoder<I, never>` ⊆ `Schema.Schema<I, _, never>`.
   */
  readonly params: Params
  /** Schema for successful `execute` output. Effect AI owns result encoding
   *  through this schema, and Gent stores the same schema in metadata for
   *  lifecycle reactions and direct tool-runner invocation. */
  readonly output: Output
  /**
   * Service/resource needs this tool touches while running. Read needs can
   * share; write needs exclude both reads and writes for the same tag.
   * Empty/undefined = fully parallel.
   */
  readonly needs?: ReadonlyArray<ToolNeed>
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
   *  prompt fragments resolved per-turn from services, use a turn projection reaction. */
  readonly prompt?: PromptSection
  /** The tool body. Receives decoded `params` and the minimal
   *  `ToolCoreContext` by default. Tools that need subagents, interaction, or
   *  session mutation must both declare matching `ToolNeeds` and annotate
   *  `ctx: ToolCapabilityContext` explicitly. */
  readonly execute: (
    params: Schema.Schema.Type<Params>,
    ctx: Ctx,
  ) => Effect.Effect<Schema.Schema.Type<Output>, Error, Deps>
}

/**
 * Lower a `ToolInput` to a `ToolCapability` with `intent: "write"` by default.
 */
export const tool = <
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
  Params extends Schema.Decoder<any, never>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
  Output extends Schema.Encoder<any, never>,
  Error,
  Deps,
  Ctx extends ToolCoreContext = ToolCoreContext,
>(
  input: ToolInput<Params, Output, Error, Deps, Ctx>,
): ToolCapability<Schema.Schema.Type<Params>, Schema.Schema.Type<Output>, Error> => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- schema and brand factory owns nominal type boundary
  const params = input.params as Schema.Schema<Schema.Schema.Type<Params>>
  const id = ToolId.make(input.id)
  const metadata: GentToolMetadata<
    Schema.Schema.Type<Params>,
    Schema.Schema.Type<Output>,
    Error
  > = {
    id,
    intent: input.intent ?? "write",
    input: input.params,
    output: input.output,
    ...(input.needs !== undefined ? { needs: input.needs } : {}),
    ...(input.promptSnippet !== undefined ? { promptSnippet: input.promptSnippet } : {}),
    ...(input.promptGuidelines !== undefined ? { promptGuidelines: input.promptGuidelines } : {}),
    ...(input.interactive !== undefined ? { interactive: input.interactive } : {}),
    ...(input.permissionRules !== undefined ? { permissionRules: input.permissionRules } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    // ToolCapabilityContext extends ModelCapabilityContext and narrows
    // `toolCallId` to required — `tool` execute signatures satisfy the
    // capability `effect` signature contravariantly.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- schema and brand factory owns nominal type boundary
    effect: input.execute as unknown as GentToolMetadata<
      Schema.Schema.Type<Params>,
      Schema.Schema.Type<Output>,
      Error
    >["effect"],
  }

  const native = AiTool.dynamic(input.id, {
    description: input.description,
    parameters: params,
    success: input.output,
  })
    .annotate(GentToolMetadataTag, metadata)
    .annotate(AiTool.Readonly, metadata.intent === "read")
    .annotate(AiTool.Destructive, input.destructive === true)
  const capability = Capability.Tool.make({
    id,
    intent: metadata.intent,
    ...(metadata.needs !== undefined ? { needs: metadata.needs } : {}),
    input: metadata.input,
    output: metadata.output,
    native,
    effect: metadata.effect,
    description: input.description,
    ...(metadata.promptSnippet !== undefined ? { promptSnippet: metadata.promptSnippet } : {}),
    ...(metadata.promptGuidelines !== undefined
      ? { promptGuidelines: metadata.promptGuidelines }
      : {}),
    ...(metadata.interactive !== undefined ? { interactive: metadata.interactive } : {}),
    ...(metadata.permissionRules !== undefined
      ? { permissionRules: metadata.permissionRules }
      : {}),
    ...(metadata.prompt !== undefined ? { prompt: metadata.prompt } : {}),
    metadata,
  })
  const branded = Object.assign(native, capability, { [ToolCapabilityBrand]: true as const })

  return branded
}
