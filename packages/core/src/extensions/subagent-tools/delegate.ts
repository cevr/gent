import { Effect, Schema } from "effect"
import { defineTool } from "../../domain/tool.js"
import {
  AgentName,
  AgentRunnerService,
  getDurableAgentRunSessionId,
  type AgentRunError,
  type AgentRunResult,
} from "../../domain/agent.js"
import type { SessionId } from "../../domain/ids.js"
import type { Task } from "../../domain/task.js"
import { ExtensionStateRuntime } from "../../runtime/extensions/state-runtime.js"
import { TaskProtocol } from "../task-tools-protocol.js"
import { ExtensionRegistry } from "../../runtime/extensions/registry.js"
import { RuntimePlatform } from "../../runtime/runtime-platform.js"

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
        "Run in the background via task-tools. Returns immediately with taskId. Poll with task_get.",
    }),
  ),
})

export const DelegateTool = defineTool({
  name: "delegate",
  action: "delegate",
  concurrency: "serial",
  description:
    "Delegate work to specialized agents. Modes: single (agent+task), parallel (tasks[]), chain (chain[] with {previous}). Set background: true to run asynchronously.",
  promptSnippet: "Delegate work to specialized subagents",
  promptGuidelines: [
    "Use for work that benefits from specialized focus or parallelism",
    "Do NOT delegate simple reads, searches, or single-file edits — do those directly",
    "Each task prompt must be self-contained — delegated agents have no conversation history",
  ],
  params: DelegateParams,
  execute: Effect.fn("DelegateTool.execute")(function* (params, ctx) {
    const runner = yield* AgentRunnerService
    const registry = yield* ExtensionRegistry
    const platform = yield* RuntimePlatform

    const caller = ctx.agentName !== undefined ? yield* registry.getAgent(ctx.agentName) : undefined

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
      registry.getAgent(agentName).pipe(
        Effect.map((agent) => {
          if (agent === undefined) {
            return { ok: false as const, error: `Unknown agent: ${agentName}` }
          }
          if (!ensureAllowed(agent.name)) {
            return { ok: false as const, error: `Not allowed to delegate to: ${agentName}` }
          }
          return { ok: true as const, agent }
        }),
      )

    const appendSessionRef = (error: string, sessionId?: string) => {
      if (sessionId === undefined) return error
      return `${error}\n\nFull session: session://${sessionId}`
    }

    const summarizeTaskSubject = (task: string) => {
      if (task.length <= 60) return task
      return `${task.slice(0, 60)}…`
    }

    const backgroundSingle = Effect.fn("DelegateTool.backgroundSingle")(function* () {
      const extensionRuntime = yield* ExtensionStateRuntime
      const resolved = yield* resolveAgent(params.agent ?? "")
      if (!resolved.ok) return { error: resolved.error }

      const task = yield* extensionRuntime
        .ask(
          ctx.sessionId,
          TaskProtocol.CreateTask({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            subject: params.description ?? params.task ?? "background task",
            agentType: resolved.agent.name,
            prompt: params.task,
            cwd: platform.cwd,
          }),
          ctx.branchId,
        )
        .pipe(Effect.catchDefect(() => Effect.void as Effect.Effect<Task | undefined>))
      if (task === undefined)
        return { error: "Background tasks unavailable — task-tools extension is disabled" }
      const result = yield* extensionRuntime.ask(
        ctx.sessionId,
        TaskProtocol.RunTask({ taskId: task.id }),
        ctx.branchId,
      )
      return { taskId: result.taskId, status: result.status }
    })

    const backgroundParallel = Effect.fn("DelegateTool.backgroundParallel")(function* () {
      const extensionRuntime = yield* ExtensionStateRuntime
      const tasks = params.tasks ?? []
      if (tasks.length > MAX_PARALLEL_TASKS) {
        return { error: `Too many parallel tasks (max ${MAX_PARALLEL_TASKS})` }
      }

      const taskIds: string[] = []
      for (const item of tasks) {
        const resolved = yield* resolveAgent(item.agent)
        if (!resolved.ok) return { error: resolved.error }
        const task = yield* extensionRuntime
          .ask(
            ctx.sessionId,
            TaskProtocol.CreateTask({
              sessionId: ctx.sessionId,
              branchId: ctx.branchId,
              subject: summarizeTaskSubject(item.task),
              agentType: resolved.agent.name,
              prompt: item.task,
              cwd: platform.cwd,
            }),
            ctx.branchId,
          )
          .pipe(Effect.catchDefect(() => Effect.void as Effect.Effect<Task | undefined>))
        if (task === undefined) {
          return { error: "Background tasks unavailable — task-tools extension is disabled" }
        }
        yield* extensionRuntime.ask(
          ctx.sessionId,
          TaskProtocol.RunTask({ taskId: task.id }),
          ctx.branchId,
        )
        taskIds.push(task.id)
      }
      return { taskIds, status: "running" as const, count: taskIds.length }
    })

    const foregroundChain = Effect.fn("DelegateTool.foregroundChain")(function* () {
      const results: AgentRunResult[] = []
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
          cwd: platform.cwd,
        })

        results.push(result)
        if (result._tag === "error") {
          return {
            error: appendSessionRef(result.error, getDurableAgentRunSessionId(result)),
            metadata: { mode: "chain" as const, results },
          }
        }
        previousOutput = result.text
      }

      const chainSessionRefs = results
        .filter((r): r is Extract<AgentRunResult, { _tag: "success" }> => r._tag === "success")
        .map((r) => getDurableAgentRunSessionId(r))
        .filter((sessionId): sessionId is SessionId => sessionId !== undefined)
        .map((sessionId) => `session://${sessionId}`)
        .join(", ")
      const output =
        chainSessionRefs.length > 0
          ? `${previousOutput}\n\nFull sessions: ${chainSessionRefs}`
          : previousOutput
      return {
        output,
        metadata: { mode: "chain" as const, results },
      }
    })

    const foregroundParallel = Effect.fn("DelegateTool.foregroundParallel")(function* () {
      const tasks = params.tasks ?? []
      if (tasks.length > MAX_PARALLEL_TASKS) {
        return { error: `Too many parallel tasks (max ${MAX_PARALLEL_TASKS})` }
      }

      const runTask = (
        task: DelegateItemType,
      ): Effect.Effect<AgentRunResult, AgentRunError, never> =>
        resolveAgent(task.agent).pipe(
          Effect.flatMap((resolved) => {
            if (!resolved.ok) {
              return Effect.succeed<AgentRunResult>({
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
              cwd: platform.cwd,
            })
          }),
        )

      const results = yield* Effect.forEach(tasks, runTask, { concurrency: MAX_CONCURRENCY })
      const successes = results.filter(
        (r): r is Extract<AgentRunResult, { _tag: "success" }> => r._tag === "success",
      )
      const parallelSessionRefs = successes
        .map((r) => getDurableAgentRunSessionId(r))
        .filter((sessionId): sessionId is SessionId => sessionId !== undefined)
        .map((sessionId) => `session://${sessionId}`)
        .join(", ")
      const output =
        parallelSessionRefs.length > 0
          ? `Parallel: ${successes.length}/${results.length} succeeded\n\nFull sessions: ${parallelSessionRefs}`
          : `Parallel: ${successes.length}/${results.length} succeeded`
      return {
        output,
        metadata: { mode: "parallel" as const, results },
      }
    })

    const foregroundSingle = Effect.fn("DelegateTool.foregroundSingle")(function* () {
      const resolved = yield* resolveAgent(params.agent ?? "")
      if (!resolved.ok) return { error: resolved.error }

      const result = yield* runner.run({
        agent: resolved.agent,
        prompt: params.task ?? "",
        parentSessionId: ctx.sessionId,
        parentBranchId: ctx.branchId,
        toolCallId: ctx.toolCallId,
        cwd: platform.cwd,
      })

      if (result._tag === "error") {
        return { error: appendSessionRef(result.error, getDurableAgentRunSessionId(result)) }
      }

      const sessionId = getDurableAgentRunSessionId(result)
      const parts = [result.text]
      if (result.savedPath !== undefined) parts.push(`\n\nFull output: ${result.savedPath}`)
      if (sessionId !== undefined) parts.push(`\n\nFull session: session://${sessionId}`)
      return {
        output: parts.join(""),
        metadata: {
          mode: "single" as const,
          sessionId,
          agentName: result.agentName,
          usage: result.usage,
          toolCalls: result.toolCalls,
        },
      }
    })

    // Background mode: create durable task and fire-and-forget
    if (params.background === true) {
      if (hasSingle) return yield* backgroundSingle()
      if (hasTasks) return yield* backgroundParallel()
      return { error: "Background mode only supports single and parallel modes, not chain" }
    }

    // Foreground mode: blocking subagent dispatch
    if (hasChain) return yield* foregroundChain()
    if (hasTasks) return yield* foregroundParallel()
    return yield* foregroundSingle()
  }),
})
