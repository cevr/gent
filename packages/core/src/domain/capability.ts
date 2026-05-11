/** Shared extension callable primitives. Tool and request leaves are
 * independent; this file holds only errors, host contexts, and typed request
 * references used across those leaves.
 *
 * @module
 */

import { type Effect, Schema } from "effect"
import type { AgentName } from "./agent.js"
import type { ExtensionHostFacts } from "./extension.js"
import type { PermissionRule } from "./permission.js"
import type { PromptSection } from "./prompt.js"
import {
  ExtensionId,
  type RpcId,
  type ToolId,
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
 * Minimal facts passed to capabilities. Host authority is not threaded through
 * this object; extension code imports constrained Effect services instead.
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
 * Erased runtime shape of a `tool({...})` Capability. The author-facing branded
 * type lives in `domain/capability/tool.ts`; runtime code reads Gent-only fields
 * from the `GentToolMetadata` annotation, not this shape.
 */
export interface ToolCapability {
  readonly _tag: "tool"
  readonly id: ToolId
  readonly readonly: boolean
  readonly promptSnippet?: string
  readonly prompt?: PromptSection
  readonly permissionRules?: ReadonlyArray<PermissionRule>
  readonly input: unknown
  readonly output: unknown
  readonly native: unknown
  readonly effect: unknown
  readonly description: string
  readonly promptGuidelines?: ReadonlyArray<string>
  readonly interactive?: boolean
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
  readonly permissionRules?: ReadonlyArray<PermissionRule>
  readonly input: unknown
  readonly output: unknown
  readonly effect: unknown
  readonly public: true
  readonly slash?: unknown
  readonly description?: string
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
