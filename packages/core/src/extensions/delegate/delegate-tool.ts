import { Effect, Schema } from "effect"
import { defineTool } from "../../domain/tool.js"
import {
  AgentName,
  getDurableAgentRunSessionId,
  type AgentRunError,
  type AgentRunResult,
} from "../../domain/agent.js"
import { TaskId } from "../../domain/ids.js"
import type { SessionId } from "../../domain/ids.js"
import type { Task } from "../../domain/task.js"
import { TaskProtocol } from "../task-tools-protocol.js"

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
  concurrency: "serial",
  description:
    "Delegate work to specialized agents. Modes: single (agent+task), parallel (tasks[]), chain (chain[] with {previous}). Set background: true to run asynchronously.",
  promptSnippet: "Delegate work to specialized subagents",
  promptGuidelines: [
    "Use for work that benefits from specialized focus or parallelism",
    "Do NOT delegate simple reads, searches, or single-file edits — do those directly",
    "Each task prompt must be self-contained — delegated agents have no conversation history",
    "For parallel exploration: don't share preliminary findings between agents — let each form independent conclusions",
    "Prefer focused tools: review (code review), counsel (second opinion), research (repo understanding)",
  ],
  params: DelegateParams,
  execute: Effect.fn("DelegateTool.execute")(function* (params, ctx) {
    const hasChain = (params.chain?.length ?? 0) > 0
    const hasTasks = (params.tasks?.length ?? 0) > 0
    const hasSingle = params.agent !== undefined && params.task !== undefined

    const modes = [hasChain, hasTasks, hasSingle].filter(Boolean).length
    if (modes !== 1) {
      return { error: "Specify exactly one mode: agent+task, tasks[], or chain[]" }
    }

    const resolveAgent = (agentName: string) =>
      ctx.agent.get(agentName).pipe(
        Effect.map((agent) => {
          if (agent === undefined) {
            return { ok: false as const, error: `Unknown agent: ${agentName}` }
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

    /** Check if task is still in a non-terminal state before writing completion */
    const isTaskStillActive = (taskId: string) =>
      ctx.extension.ask(TaskProtocol.GetTask({ taskId: TaskId.of(taskId) }), ctx.branchId).pipe(
        Effect.map(
          (t) => t !== null && t !== undefined && t.status !== "stopped" && t.status !== "failed",
        ),
        Effect.catchEager(() => Effect.succeed(false)),
      )

    const spawnBackgroundTask = (task: Task, agent: { name: string }) =>
      Effect.gen(function* () {
        // Set task to in_progress
        yield* ctx.extension
          .ask(TaskProtocol.UpdateTask({ taskId: task.id, status: "in_progress" }), ctx.branchId)
          .pipe(Effect.catchEager(() => Effect.void))

        const resolvedAgent = yield* ctx.agent.get(agent.name)
        if (resolvedAgent === undefined) {
          yield* ctx.extension
            .ask(
              TaskProtocol.UpdateTask({
                taskId: task.id,
                status: "failed",
                metadata: { error: `Unknown agent: ${agent.name}` },
              }),
              ctx.branchId,
            )
            .pipe(Effect.catchEager(() => Effect.void))
          return
        }

        const result = yield* ctx.agent.run({
          agent: resolvedAgent,
          prompt: task.prompt ?? task.subject,
          toolCallId: ctx.toolCallId,
        })

        // Guard: if task was stopped/failed while running, don't overwrite terminal state
        const active = yield* isTaskStillActive(task.id)
        if (!active) return

        if (result._tag === "success") {
          yield* ctx.extension
            .ask(
              TaskProtocol.UpdateTask({
                taskId: task.id,
                status: "completed",
                owner: result.sessionId,
                metadata: {
                  ...(typeof task.metadata === "object" && task.metadata !== null
                    ? task.metadata
                    : {}),
                  childSessionId: result.sessionId,
                },
              }),
              ctx.branchId,
            )
            .pipe(Effect.catchEager(() => Effect.void))
        } else {
          yield* ctx.extension
            .ask(
              TaskProtocol.UpdateTask({
                taskId: task.id,
                status: "failed",
                metadata: {
                  ...(typeof task.metadata === "object" && task.metadata !== null
                    ? task.metadata
                    : {}),
                  error: result.error,
                },
              }),
              ctx.branchId,
            )
            .pipe(Effect.catchEager(() => Effect.void))
        }
      }).pipe(Effect.catchEager(() => Effect.void))

    const backgroundSingle = Effect.fn("DelegateTool.backgroundSingle")(function* () {
      const resolved = yield* resolveAgent(params.agent ?? "")
      if (!resolved.ok) return { error: resolved.error }

      const task = yield* ctx.extension
        .ask(
          TaskProtocol.CreateTask({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            subject: params.description ?? params.task ?? "background task",
            agentType: resolved.agent.name,
            prompt: params.task,
            cwd: ctx.cwd,
          }),
          ctx.branchId,
        )
        .pipe(Effect.catchDefect(() => Effect.void as Effect.Effect<Task | undefined>))
      if (task === undefined)
        return { error: "Background tasks unavailable — task-tools extension is disabled" }

      yield* Effect.forkChild(spawnBackgroundTask(task, resolved.agent))
      return { taskId: task.id, status: "running" }
    })

    const backgroundParallel = Effect.fn("DelegateTool.backgroundParallel")(function* () {
      const tasks = params.tasks ?? []
      if (tasks.length > MAX_PARALLEL_TASKS) {
        return { error: `Too many parallel tasks (max ${MAX_PARALLEL_TASKS})` }
      }

      const taskIds: string[] = []
      for (const item of tasks) {
        const resolved = yield* resolveAgent(item.agent)
        if (!resolved.ok) return { error: resolved.error }
        const task = yield* ctx.extension
          .ask(
            TaskProtocol.CreateTask({
              sessionId: ctx.sessionId,
              branchId: ctx.branchId,
              subject: summarizeTaskSubject(item.task),
              agentType: resolved.agent.name,
              prompt: item.task,
              cwd: ctx.cwd,
            }),
            ctx.branchId,
          )
          .pipe(Effect.catchDefect(() => Effect.void as Effect.Effect<Task | undefined>))
        if (task === undefined) {
          return { error: "Background tasks unavailable — task-tools extension is disabled" }
        }
        yield* Effect.forkChild(spawnBackgroundTask(task, resolved.agent))
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
        const result = yield* ctx.agent.run({
          agent: resolved.agent,
          prompt: taskWithContext,
          toolCallId: ctx.toolCallId,
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
            return ctx.agent.run({
              agent: resolved.agent,
              prompt: task.task,
              toolCallId: ctx.toolCallId,
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

      const result = yield* ctx.agent.run({
        agent: resolved.agent,
        prompt: params.task ?? "",
        toolCallId: ctx.toolCallId,
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
