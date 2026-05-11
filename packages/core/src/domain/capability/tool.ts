/**
 * `tool(...)` — typed factory for LLM-callable Capabilities.
 *
 * Authors call `tool({ id, description, params, execute, ... })` directly.
 * The factory enforces the LLM-tool shape at the type level: `params`
 * must be an LLM-JSON-schema-able `Schema.Schema`, `execute` returns an
 * `Effect`, and the request-only fields (`slash`, `input`) are forbidden.
 *
 * Replaces the previous two-step `tool(defineTool({...}))` pattern.
 *
 * Lowering: produces a branded native Effect AI tool annotated with Gent
 * metadata. Runtime code reads Gent-only fields from that annotation instead
 * of widening Effect's tool surface.
 *
 * @module
 */

import { Context, Effect, Schema } from "effect"
import * as AiTool from "effect/unstable/ai/Tool"
import {
  type CapabilityCoreContext,
  type ToolCapability as ToolCapabilityShape,
} from "../capability.js"
import { ToolId, type ToolCallId } from "../ids.js"
import type { PermissionRule } from "../permission.js"
import type { PromptSection } from "../prompt.js"
import { ExtensionContext, type ExtensionContextService } from "../extension-services.js"

const ToolCapabilityBrand: unique symbol = Symbol("@gent/core/ToolCapability")
declare const ToolCapabilityType: unique symbol

/** Minimal context passed to `tool({...}).execute`. Tools are always invoked from the agent
 *  loop with a real call id; the optional shape on `CapabilityCoreContext`
 *  only exists for the audience-neutral case where no tool call is in flight. */
export interface ToolCoreContext extends CapabilityCoreContext {
  readonly toolCallId: ToolCallId
  readonly capabilityContext?: Context.Context<never>
}

export interface GentToolMetadata<Input = unknown, Output = unknown, Error = unknown> {
  readonly id: ToolId
  readonly readonly: boolean
  readonly input: Schema.Decoder<Input, never>
  readonly output: Schema.Encoder<unknown, never>
  readonly promptSnippet?: string
  readonly promptGuidelines?: ReadonlyArray<string>
  readonly interactive?: boolean
  readonly permissionRules?: ReadonlyArray<PermissionRule>
  readonly prompt?: PromptSection
  readonly effect: (input: unknown, ctx: ToolCoreContext) => Effect.Effect<Output, Error, never>
}

const isExtensionContextService = (
  ctx: ToolCoreContext,
): ctx is ToolCoreContext & ExtensionContextService =>
  "Agent" in ctx && "Session" in ctx && "Interaction" in ctx && "Process" in ctx

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
} & ToolCapabilityShape

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
> {
  /** Stable id (extension-local). Used by the LLM as the tool name. */
  readonly id: string
  /** Sent to the LLM as part of the tool schema — describes what the tool does. */
  readonly description: string
  /** Marks a tool as side-effect-free for Effect AI provider metadata.
   *  Defaults to `false`. Read-only tools (e.g. `fs-tools/read`, `grep`,
   *  `glob`) should pass `readonly: true`. */
  readonly readonly?: boolean
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
  /** The tool body. Receives decoded `params`; host capabilities are imported
   *  as constrained Effect services such as `ExtensionContext`. */
  readonly execute: (
    params: Schema.Schema.Type<Params>,
  ) => Effect.Effect<Schema.Schema.Type<Output>, Error, Deps>
}

/**
 * Lower a `ToolInput` to a `ToolCapability` (defaults to a write/destructive
 * tool unless `readonly: true` is set).
 */
export const tool = <
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
  Params extends Schema.Decoder<any, never>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
  Output extends Schema.Encoder<any, never>,
  Error,
  Deps,
>(
  input: ToolInput<Params, Output, Error, Deps>,
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
    readonly: input.readonly === true,
    input: input.params,
    output: input.output,
    ...(input.promptSnippet !== undefined ? { promptSnippet: input.promptSnippet } : {}),
    ...(input.promptGuidelines !== undefined ? { promptGuidelines: input.promptGuidelines } : {}),
    ...(input.interactive !== undefined ? { interactive: input.interactive } : {}),
    ...(input.permissionRules !== undefined ? { permissionRules: input.permissionRules } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    effect: (params, ctx) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- schema and brand factory owns nominal type boundary
      const effect = input.execute(params as Schema.Schema.Type<Params>)
      const provided = isExtensionContextService(ctx)
        ? effect.pipe(Effect.provideService(ExtensionContext, ctx))
        : effect
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- factory erases author service requirements; runtime provides them at execution boundaries.
      return provided as Effect.Effect<Schema.Schema.Type<Output>, Error, never>
    },
  }

  const native = AiTool.dynamic(input.id, {
    description: input.description,
    parameters: params,
    success: input.output,
  })
    .annotate(GentToolMetadataTag, metadata)
    .annotate(AiTool.Readonly, metadata.readonly)
    .annotate(AiTool.Destructive, input.destructive === true)
  const capability: ToolCapabilityShape = {
    _tag: "tool",
    id,
    readonly: metadata.readonly,
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
  }
  const branded = Object.assign(native, capability, { [ToolCapabilityBrand]: true as const })

  return branded
}
