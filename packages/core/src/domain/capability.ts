/** Shared extension callable primitives. Tool/action/request leaves are
 * independent; this file holds only errors, host contexts, and typed request
 * references used across those leaves.
 *
 * @module
 */

import { type Effect, Schema } from "effect"
import type { ExtensionHostContext } from "./extension-host-context.js"
import { ExtensionId, type BranchId, type RpcId, type SessionId, type ToolCallId } from "./ids.js"

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
 * typed request dispatch, session mutation,
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

/** The wide tool-execution context. Read+write surfaces, agent runner,
 *  session mutations, interaction, and turn-control are all reachable. */
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

/**
 * Reference object handed to callers so they can route + decode through the
 * runtime's Capability dispatcher. The public invoker is
 * `ExtensionHostContext.Extension.request(ref, input)`.
 */
export interface CapabilityRef<Input = unknown, Output = unknown> {
  readonly extensionId: ExtensionId
  readonly capabilityId: RpcId
  readonly intent: "read" | "write"
  readonly input: Schema.Decoder<Input, never>
  readonly output: Schema.Decoder<Output, never>
}
