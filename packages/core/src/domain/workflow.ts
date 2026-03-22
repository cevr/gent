import type { Effect, Schema } from "effect"
import type { AgentName, SubagentRunner } from "./agent"
import type { PromptPresenterService } from "./prompt-presenter"
import type { EventStoreError } from "./event"
import type { BranchId, SessionId } from "./ids"
import { defineTool, type ToolDefinition } from "./tool"
import type { runLoop } from "../runtime/loop"

// Workflow Context — extended tool context for multi-agent orchestration

export interface WorkflowContext {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly toolCallId: string
  readonly agentName?: AgentName
  readonly runner: SubagentRunner
  readonly presenter: PromptPresenterService
  readonly loop: typeof runLoop
  readonly callerAgent: AgentName
  readonly publishPhase: (
    phase: string,
    metadata?: Record<string, unknown>,
  ) => Effect.Effect<void, EventStoreError>
}

// Workflow Definition — tool + subagent orchestration + command + phases

export interface WorkflowDefinition<
  Name extends string = string,
  Phases extends readonly string[] = readonly string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Params extends Schema.Decoder<any, never> = Schema.Decoder<any, never>,
  Result = unknown,
  Error = never,
  Deps = never,
> {
  readonly name: Name
  readonly description: string
  readonly command?: string
  readonly phases: Phases
  readonly params: Params
  readonly execute: (
    params: Schema.Schema.Type<Params>,
    ctx: WorkflowContext,
  ) => Effect.Effect<Result, Error, Deps>
}

/**
 * Define a workflow — returns a ToolDefinition that the tool registry handles.
 *
 * The workflow's execute function receives a WorkflowContext instead of plain ToolContext.
 * The context injection happens at runtime when the workflow tool is executed within
 * an agent loop that provides SubagentRunnerService, PromptPresenter, etc.
 *
 * Workflows always use action: "delegate" and concurrency: "serial".
 */
export const defineWorkflow = <
  Name extends string,
  Phases extends readonly string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Params extends Schema.Decoder<any, never>,
  Result,
  Error,
  Deps,
>(
  definition: WorkflowDefinition<Name, Phases, Params, Result, Error, Deps>,
): ToolDefinition<Name, Params, Result, Error, Deps> & {
  readonly command?: string
  readonly phases: Phases
  readonly _workflow: true
} =>
  ({
    ...defineTool({
      name: definition.name,
      action: "delegate" as const,
      concurrency: "serial" as const,
      description: definition.description,
      params: definition.params,
      execute: definition.execute as ToolDefinition<Name, Params, Result, Error, Deps>["execute"],
    }),
    command: definition.command,
    phases: definition.phases,
    _workflow: true as const,
  }) as ToolDefinition<Name, Params, Result, Error, Deps> & {
    readonly command?: string
    readonly phases: Phases
    readonly _workflow: true
  }

/** Type guard for workflow tools */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const isWorkflow = (tool: ToolDefinition<any, any, any, any, any>): boolean =>
  "_workflow" in tool && (tool as Record<string, unknown>)["_workflow"] === true
