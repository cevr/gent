/** Shared extension callable primitives. Tool/action/request leaves are
 * independent; this file holds only errors, host contexts, and typed request
 * references used across those leaves.
 *
 * @module
 */

import { type Effect, Schema } from "effect"
import type { AgentName } from "./agent.js"
import type { ExtensionHostFacts } from "./extension.js"
import type { ExtensionHostContext } from "./extension-host-context.js"
import { TaggedEnumClass } from "./schema-tagged-enum-class.js"
import {
  ExtensionId,
  CommandId,
  RpcId,
  ToolId,
  type BranchId,
  type SessionId,
  type ToolCallId,
} from "./ids.js"

/** Failure raised by a Capability handler. Carries audience + id for diagnostics. */
export class CapabilityError extends Schema.TaggedErrorClass<CapabilityError>()(
  "@gent/core/src/domain/capability/CapabilityError",
  {
    extensionId: ExtensionId,
    capabilityId: Schema.String,
    reason: Schema.String,
  },
) {}

/** Failure raised when a Capability is invoked with an id that has no contribution. */
export class CapabilityNotFoundError extends Schema.TaggedErrorClass<CapabilityNotFoundError>()(
  "@gent/core/src/domain/capability/CapabilityNotFoundError",
  {
    extensionId: ExtensionId,
    capabilityId: Schema.String,
  },
) {}

/**
 * A single fat `CapabilityContext extends ExtensionHostContext` would expose
 * session mutation, interaction, and follow-up surfaces to every read capability — making
 * the `intent: "read"` fence dishonest at the context level even when lint
 * stops write-shaped service calls.
 *
 * Split: `CapabilityCoreContext` (the always-on minimum) plus the wider
 * `ModelCapabilityContext` for the model audience whose handlers historically
 * have full host access through `ToolCapabilityContext` (and frequently rely on it —
 * spawning subagents, asking for approval, queuing follow-ups).
 *
 * Capability authors pick the surface they need by typing their `effect`'s
 * second parameter:
 *   - `(input, ctx: CapabilityCoreContext) => …` — the default, audience-neutral
 *   - `(input, ctx: ModelCapabilityContext) => …` — model tools that need
 *     subagent / interaction / follow-up surfaces
 *
 * Request/action hosts pass the context required by the leaf type. Tool
 * execution derives host facets from declared `ToolNeeds`, so handlers asking
 * for less get less both at the type surface and at runtime.
 */
export interface CapabilityCoreContext {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName?: AgentName
  /** Present only when this Capability was invoked as a tool by the LLM. */
  readonly toolCallId?: ToolCallId
  readonly cwd: string
  readonly home: string
  readonly host: ExtensionHostFacts
}

/** The wide tool-execution context. Read+write surfaces, agent runner,
 *  session mutations, interaction, and follow-up controls are all reachable. */
export interface ModelCapabilityContext extends ExtensionHostContext {}

/**
 * Default ctx parameter type for request/action host signatures.
 *
 * Kept as an alias for the wide context so callers writing
 * `(input, ctx: CapabilityContext) => …` continue to compile, but new code
 * should choose `CapabilityCoreContext` or `ModelCapabilityContext` explicitly.
 */
export type CapabilityContext = ModelCapabilityContext

export type CapabilityEffect<Input = unknown, Output = unknown, R = never, E = CapabilityError> = {
  bivarianceHack(input: Input, ctx: CapabilityContext): Effect.Effect<Output, E, R>
}["bivarianceHack"]

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- existential runtime leaf boundary; factories keep author-facing input/output typed
export type ErasedCapabilityEffect<E = any> = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- existential runtime leaf boundary; factories keep author-facing input/output typed
  input: any,
  ctx: CapabilityContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- existential runtime leaf boundary; factories keep author-facing input/output typed
) => Effect.Effect<any, E, any>

const CapabilityNeed = Schema.Struct({
  tag: Schema.String,
  access: Schema.Union([Schema.Literal("read"), Schema.Literal("write")]),
})

const CapabilityMetadataFields = {
  intent: Schema.Union([Schema.Literal("read"), Schema.Literal("write")]),
  needs: Schema.optional(Schema.Array(CapabilityNeed)),
  promptSnippet: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.Unknown),
  permissionRules: Schema.optional(Schema.Array(Schema.Unknown)),
} as const

/**
 * Canonical callable leaf shape. Buckets still preserve the product surfaces
 * (`tools`, `actions`, `requests`), but every callable contribution now carries the
 * same discriminator and shared metadata fields.
 */
export const Capability = TaggedEnumClass("Capability", {
  Tool: TaggedEnumClass.variant("tool", {
    id: ToolId,
    ...CapabilityMetadataFields,
    input: Schema.Unknown,
    output: Schema.Unknown,
    native: Schema.Unknown,
    effect: Schema.Unknown,
    description: Schema.String,
    promptGuidelines: Schema.optional(Schema.Array(Schema.String)),
    interactive: Schema.optional(Schema.Boolean),
    metadata: Schema.Unknown,
  }),
  Action: TaggedEnumClass.variant("action", {
    id: CommandId,
    ...CapabilityMetadataFields,
    input: Schema.Unknown,
    output: Schema.Unknown,
    effect: Schema.Unknown,
    surface: Schema.Array(Schema.Union([Schema.Literal("slash"), Schema.Literal("palette")])),
    description: Schema.String,
    displayName: Schema.String,
    category: Schema.optional(Schema.String),
    keybind: Schema.optional(Schema.String),
    slash: Schema.optional(Schema.Unknown),
  }),
  Request: TaggedEnumClass.variant("request", {
    id: RpcId,
    ...CapabilityMetadataFields,
    input: Schema.Unknown,
    output: Schema.Unknown,
    effect: Schema.Unknown,
    public: Schema.Literal(true),
    slash: Schema.optional(Schema.Unknown),
    description: Schema.optional(Schema.String),
    ref: Schema.Unknown,
  }),
})

export type Capability = Schema.Schema.Type<typeof Capability>
export type ToolCapability = Extract<Capability, { readonly _tag: "tool" }>
export type ActionCapability = Extract<Capability, { readonly _tag: "action" }>
export type RequestCapability = Extract<Capability, { readonly _tag: "request" }>

/**
 * Reference object handed to transport callers so they can route + decode
 * through the runtime's public capability dispatcher.
 */
export interface CapabilityRef<Input = unknown, Output = unknown> {
  readonly extensionId: ExtensionId
  readonly capabilityId: RpcId
  readonly intent: "read" | "write"
  readonly input: Schema.Decoder<Input, never>
  readonly output: Schema.Decoder<Output, never>
}
