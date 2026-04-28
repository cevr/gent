import type { Effect, Schema } from "effect"
import type { ToolCallId } from "./ids"
import type { ExtensionHostContext } from "./extension-host-context"
import type { PermissionRule } from "./permission"
import type { PromptSection } from "./prompt"

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

// Tool Definition

// Params must have no context requirement (never) for sync decoding
export interface ToolDefinition<
  Name extends string = string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
  Params extends Schema.Decoder<any, never> = Schema.Decoder<any, never>,
  Result = unknown,
  Error = never,
  Deps = never,
> {
  readonly name: Name
  readonly description: string
  /**
   * Service/resource needs this tool touches while running. Read needs can
   * share; write needs exclude both reads and writes for the same tag.
   * Empty/undefined = fully parallel.
   */
  readonly needs?: ReadonlyArray<ToolNeed>
  /** One-liner for system prompt tool list (distinct from description which goes to LLM tool schema) */
  readonly promptSnippet?: string
  /** Behavioral guidelines injected into system prompt when this tool is active */
  readonly promptGuidelines?: ReadonlyArray<string>
  /** If true, tool requires an interactive session (human at the terminal).
   *  Filtered out in headless mode and subagent contexts. */
  readonly interactive?: boolean
  /** Permission allow/deny rules gating execution. Folded into
   *  `Capability.permissionRules` by the `tool()` smart constructor. */
  readonly permissionRules?: ReadonlyArray<PermissionRule>
  /** Static system-prompt section bundled with this tool. Folded into
   *  `Capability.prompt` by the `tool()` smart constructor. For dynamic
   *  prompt fragments, use a `Projection` with `prompt:`. */
  readonly prompt?: PromptSection
  readonly params: Params
  readonly execute: (
    params: Schema.Schema.Type<Params>,
    ctx: ToolContext,
  ) => Effect.Effect<Result, Error, Deps>
}

export interface ToolContext extends ExtensionHostContext {
  readonly toolCallId: ToolCallId
}

export const makeToolContext = (
  hostCtx: ExtensionHostContext,
  toolCallId: ToolCallId,
): ToolContext => ({
  ...hostCtx,
  toolCallId,
})

// `ToolDefinition` is the internal lowered LLM-tool shape consumed by the
// provider bridge and tool-runner registry. Authoring stays on the typed
// `tool({...})` factory at `domain/capability/tool.ts`.
