import { Effect, Schema } from "effect"
import { defineTool } from "@gent/core/domain/tool.js"
import {
  AgentRegistry,
  AgentName,
  SubagentRunnerService,
  type SubagentResult,
  type SubagentError,
} from "@gent/core/domain/agent.js"

const MAX_PARALLEL_TASKS = 8
const MAX_CONCURRENCY = 4

const TaskItem = Schema.Struct({
  agent: AgentName,
  task: Schema.String,
})
type TaskItemType = typeof TaskItem.Type

export const TaskParams = Schema.Struct({
  agent: Schema.optional(AgentName),
  task: Schema.optional(Schema.String),
  tasks: Schema.optional(Schema.Array(TaskItem)),
  chain: Schema.optional(Schema.Array(TaskItem)),
  description: Schema.optional(Schema.String),
})

export const TaskTool = defineTool({
  name: "task",
  concurrency: "serial",
  description:
    "Delegate work to specialized subagents. Modes: single (agent+task), parallel (tasks[]), chain (chain[] with {previous}).",
  params: TaskParams,
  execute: Effect.fn("TaskTool.execute")(function* (params, ctx) {
    const runner = yield* SubagentRunnerService
    const registry = yield* AgentRegistry

    const caller = ctx.agentName !== undefined ? yield* registry.get(ctx.agentName) : undefined

    const hasChain = (params.chain?.length ?? 0) > 0
    const hasTasks = (params.tasks?.length ?? 0) > 0
    const hasSingle = params.agent !== undefined && params.task !== undefined

    const modes = [hasChain, hasTasks, hasSingle].filter(Boolean).length
    if (modes !== 1) {
      return { error: "Specify exactly one mode: agent+task, tasks[], or chain[]" }
    }

    const ensureAllowed = (agentName: string) => {
      if (caller === undefined || caller.canDelegateToAgents === undefined) return true
      return Schema.is(AgentName)(agentName) && caller.canDelegateToAgents.includes(agentName)
    }

    const resolveAgent = (agentName: string) =>
      registry.get(agentName).pipe(
        Effect.map((agent) => {
          if (agent === undefined) {
            return { ok: false as const, error: `Unknown agent: ${agentName}` }
          }
          if (agent.kind !== "subagent") {
            return { ok: false as const, error: `Not a subagent: ${agentName}` }
          }
          if (!ensureAllowed(agent.name)) {
            return { ok: false as const, error: `Not allowed to delegate to: ${agentName}` }
          }
          return { ok: true as const, agent }
        }),
      )

    if (hasChain) {
      const results: SubagentResult[] = []
      let previousOutput = ""

      for (const step of params.chain ?? []) {
        const resolved = yield* resolveAgent(step.agent)
        if (!resolved.ok) return { error: resolved.error }

        const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput)
        const result = yield* runner.run({
          agent: resolved.agent,
          prompt: taskWithContext,
          parentSessionId: ctx.sessionId,
          parentBranchId: ctx.branchId,
          toolCallId: ctx.toolCallId,
          cwd: process.cwd(),
        })

        results.push(result)
        if (result._tag === "error") {
          const ref =
            result.sessionId !== undefined ? `\n\nFull session: session://${result.sessionId}` : ""
          return { error: `${result.error}${ref}`, metadata: { mode: "chain", results } }
        }
        previousOutput = result.text
      }

      const chainSessionRefs = results
        .filter((r): r is Extract<SubagentResult, { _tag: "success" }> => r._tag === "success")
        .map((r) => `session://${r.sessionId}`)
        .join(", ")
      return {
        output: `${previousOutput}${chainSessionRefs.length > 0 ? `\n\nFull sessions: ${chainSessionRefs}` : ""}`,
        metadata: { mode: "chain", results },
      }
    }

    if (hasTasks) {
      const tasks = params.tasks ?? []
      if (tasks.length > MAX_PARALLEL_TASKS) {
        return { error: `Too many parallel tasks (max ${MAX_PARALLEL_TASKS})` }
      }

      const runTask = (task: TaskItemType): Effect.Effect<SubagentResult, SubagentError, never> =>
        resolveAgent(task.agent).pipe(
          Effect.flatMap((resolved) => {
            if (!resolved.ok) {
              return Effect.succeed<SubagentResult>({
                _tag: "error",
                error: resolved.error,
              })
            }
            return runner.run({
              agent: resolved.agent,
              prompt: task.task,
              parentSessionId: ctx.sessionId,
              parentBranchId: ctx.branchId,
              toolCallId: ctx.toolCallId,
              cwd: process.cwd(),
            })
          }),
        )

      const results = yield* Effect.forEach(tasks, runTask, { concurrency: MAX_CONCURRENCY })

      const successes = results.filter(
        (r): r is Extract<SubagentResult, { _tag: "success" }> => r._tag === "success",
      )
      const parallelSessionRefs = successes.map((r) => `session://${r.sessionId}`).join(", ")
      return {
        output: `Parallel: ${successes.length}/${results.length} succeeded${parallelSessionRefs.length > 0 ? `\n\nFull sessions: ${parallelSessionRefs}` : ""}`,
        metadata: { mode: "parallel", results },
      }
    }

    const resolved = yield* resolveAgent(params.agent ?? "")
    if (!resolved.ok) return { error: resolved.error }

    const result = yield* runner.run({
      agent: resolved.agent,
      prompt: params.task ?? "",
      parentSessionId: ctx.sessionId,
      parentBranchId: ctx.branchId,
      toolCallId: ctx.toolCallId,
      cwd: process.cwd(),
    })

    if (result._tag === "error") {
      const ref =
        result.sessionId !== undefined ? `\n\nFull session: session://${result.sessionId}` : ""
      return { error: `${result.error}${ref}` }
    }

    return {
      output: `${result.text}\n\nFull session: session://${result.sessionId}`,
      metadata: {
        mode: "single",
        sessionId: result.sessionId,
        agentName: result.agentName,
        usage: result.usage,
        toolCalls: result.toolCalls,
      },
    }
  }),
})
