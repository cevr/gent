/** Shared extension callable primitives. Tool and request leaves are
 * independent; this file holds only errors, host contexts, and typed request
 * references used across those leaves.
 *
 * @module
 */

import { type Effect, Schema } from "effect"
import type { PromptSection } from "./prompt.js"
import { ExtensionId, type RpcId, type ToolId } from "./ids.js"

/** Failure raised by a Capability handler. Carries audience + id for diagnostics. */
export class CapabilityError extends Schema.TaggedError<CapabilityError>()(
  "@gent/core/src/domain/capability/CapabilityError",
  {
    extensionId: ExtensionId,
    capabilityId: Schema.String,
    reason: Schema.String,
  },
) {}

/** Failure raised when a Capability is invoked with an id that has no contribution. */
export class CapabilityNotFoundError extends Schema.TaggedError<CapabilityNotFoundError>()(
  "@gent/core/src/domain/capability/CapabilityNotFoundError",
  {
    extensionId: ExtensionId,
    capabilityId: Schema.String,
  },
) {}

export type CapabilityEffect<Input = unknown, Output = unknown, R = never, E = CapabilityError> = {
  bivarianceHack(input: Input): Effect.Effect<Output, E, R>
}["bivarianceHack"]

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- existential runtime leaf boundary; factories keep author-facing input/output typed
export type ErasedCapabilityEffect<E = any> = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- existential runtime leaf boundary; factories keep author-facing input/output typed
  input: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- existential runtime leaf boundary; factories keep author-facing input/output typed
) => Effect.Effect<any, E, any>

/**
 * What a tool may declare about itself beyond its schemas and body.
 *
 * Every one is optional, and each travels the same route: the author's input,
 * the metadata annotation, the capability. Declaring them once here means a
 * new one is added in a single place rather than three, where forgetting a
 * site drops the declaration silently instead of failing to compile.
 */
export interface ToolDeclarations {
  /** One-liner for the system prompt tool list (distinct from `description`,
   *  which is sent to the LLM as part of the tool schema). */
  readonly promptSnippet?: string
  /** Behavioral guidelines injected into the system prompt when this tool is active. */
  readonly promptGuidelines?: ReadonlyArray<string>
  /** If true, requires an interactive session — filtered out in headless
   *  mode and subagent contexts. */
  readonly interactive?: boolean
  /**
   * If true, this tool runs other tools inside itself.
   *
   * The loop restores host tool bindings for a dispatching tool on crash
   * recovery, because its inner calls need them; a plain tool needs only its
   * own binding. Declaring it keeps the loop from having to know tool names.
   */
  readonly dispatches?: boolean
  /** Static system-prompt section bundled with this tool. For dynamic
   *  prompt fragments resolved per-turn from services, use a turn projection hook. */
  readonly prompt?: PromptSection
}

/**
 * Erased runtime shape of a `tool({...})` Capability. The author-facing branded
 * type lives in `domain/capability/tool.ts`; runtime code reads Gent-only fields
 * from the `GentToolMetadata` annotation, not this shape.
 */
export interface ToolCapability extends ToolDeclarations {
  readonly _tag: "tool"
  readonly id: ToolId
  readonly readonly: boolean
  readonly input: unknown
  readonly output: unknown
  readonly effect: unknown
  readonly description: string
  readonly metadata: unknown
}

/**
 * Erased runtime shape of a `request({...})` Capability. The author-facing
 * branded type lives in `domain/capability/request.ts`.
 */
export interface RequestCapability {
  readonly _tag: "request"
  readonly id: RpcId
  readonly prompt?: PromptSection
  readonly input: unknown
  readonly output: unknown
  readonly effect: unknown
  readonly slash?: unknown
  readonly description?: string
  /** Answers during a turn: runs without the loop's mutation permit. Must not change loop state. */
  readonly readonly?: boolean
  readonly ref: unknown
}

/**
 * Reference object handed to transport callers so they can route + decode
 * through the runtime's public capability dispatcher.
 */
export interface CapabilityRef<Input = unknown, Output = unknown> {
  readonly extensionId: ExtensionId
  readonly capabilityId: RpcId
  readonly input: Schema.Decoder<Input, never>
  readonly output: Schema.Decoder<Output, never>
}
