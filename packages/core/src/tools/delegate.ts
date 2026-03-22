import { Effect, Schema } from "effect"
import { defineTool } from "../domain/tool.js"
import {
  AgentRegistry,
  AgentName,
  SubagentRunnerService,
  type SubagentResult,
  type SubagentError,
} from "../domain/agent.js"
import { TaskService } from "../runtime/task-service.js"

const MAX_PARALLEL_TASKS = 8
const MAX_CONCURRENCY = 4

const DelegateItem = Schema.Struct({
  agent: AgentName,
  task: Schema.String,
})
type DelegateItemType = typeof DelegateItem.Type

export const DelegateParams = Schema.Struct({
  agent: Schema.optional(AgentName),
  task: Schema.optional(Schema.String),
  tasks: Schema.optional(Schema.Array(DelegateItem)),
  chain: Schema.optional(Schema.Array(DelegateItem)),
  description: Schema.optional(Schema.String),
  background: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Run in the background via TaskService. Returns immediately with taskId. Poll with task_get.",
    }),
  ),
})

export const DelegateTool = defineTool({
  name: "delegate",
  action: "delegate",
  concurrency: "serial",
  description:
    "Delegate work to specialized subagents. Modes: single (agent+task), parallel (tasks[]), chain (chain[] with {previous}). Set background: true to run asynchronously.",
  params: DelegateParams,
  execute: Effect.fn("DelegateTool.execute")(function* (params, ctx) {
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

    // Background mode: create durable task and fire-and-forget
    if (params.background === true) {
      const taskService = yield* TaskService

      if (hasSingle) {
        const resolved = yield* resolveAgent(params.agent ?? "")
        if (!resolved.ok) return { error: resolved.error }

        const task = yield* taskService.create({
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          subject: params.description ?? params.task ?? "background task",
          agentType: resolved.agent.name,
          prompt: params.task,
          cwd: process.cwd(),
        })
        const result = yield* taskService.run(task.id)
        return { taskId: result.taskId, status: result.status }
      }

      if (hasTasks) {
        const tasks = params.tasks ?? []
        if (tasks.length > MAX_PARALLEL_TASKS) {
          return { error: `Too many parallel tasks (max ${MAX_PARALLEL_TASKS})` }
        }
        const taskIds: string[] = []
        for (const item of tasks) {
          const resolved = yield* resolveAgent(item.agent)
          if (!resolved.ok) return { error: resolved.error }
          const task = yield* taskService.create({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            subject: item.task.length > 60 ? item.task.slice(0, 60) + "…" : item.task,
            agentType: resolved.agent.name,
            prompt: item.task,
            cwd: process.cwd(),
          })
          yield* taskService.run(task.id)
          taskIds.push(task.id)
        }
        return { taskIds, status: "running", count: taskIds.length }
      }

      return { error: "Background mode only supports single and parallel modes, not chain" }
    }

    // Foreground mode: blocking subagent dispatch
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

      const runTask = (
        task: DelegateItemType,
      ): Effect.Effect<SubagentResult, SubagentError, never> =>
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
