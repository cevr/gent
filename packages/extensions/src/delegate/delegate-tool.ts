import { Effect, Schema } from "effect"
import {
  tool,
  ToolNeeds,
  AgentName,
  AgentRunResultSchema,
  AgentRunToolCallSchema,
  getDurableAgentRunSessionId,
  makeRunSpec,
  type AgentRunError,
  type AgentRunResult,
  type SessionId,
  type Task,
  type TaskId,
} from "@gent/core/extensions/api"
import { TaskService } from "../task-tools-service.js"

const MAX_PARALLEL_TASKS = 8
const MAX_CONCURRENCY = 4

const DelegateItem = Schema.Struct({
  agent: AgentName,
  task: Schema.String,
})
type DelegateItemType = typeof DelegateItem.Type

export const DelegateParams = Schema.Struct({
  agent: Schema.optionalKey(AgentName),
  task: Schema.optionalKey(Schema.String),
  tasks: Schema.optionalKey(Schema.Array(DelegateItem)),
  chain: Schema.optionalKey(Schema.Array(DelegateItem)),
  description: Schema.optionalKey(Schema.String),
  background: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Run in the background via task-tools. Returns immediately with taskId. Poll with task_get.",
    }),
  ),
})

export const DelegateResult = Schema.Struct({
  error: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
  taskIds: Schema.optional(Schema.Array(Schema.String)),
  status: Schema.optional(Schema.Literals(["running"])),
  count: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.String),
  metadata: Schema.optional(
    Schema.Struct({
      mode: Schema.optional(Schema.Literals(["single", "parallel", "chain"])),
      results: Schema.optional(Schema.Array(AgentRunResultSchema)),
      sessionId: Schema.optional(Schema.String),
      agentName: Schema.optional(AgentName),
      usage: Schema.optional(
        Schema.Struct({
          input: Schema.Number,
          output: Schema.Number,
          cost: Schema.optional(Schema.Number),
        }),
      ),
      toolCalls: Schema.optional(Schema.Array(AgentRunToolCallSchema)),
    }),
  ),
})

export const DelegateTool = tool({
  id: "delegate",
  needs: [ToolNeeds.write("agent")],
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
  output: DelegateResult,
  execute: Effect.fn("DelegateTool.execute")(function* (params, ctx) {
    const hasChain = (params.chain?.length ?? 0) > 0
    const hasTasks = (params.tasks?.length ?? 0) > 0
    const hasSingle = params.agent !== undefined && params.task !== undefined

    const modes = [hasChain, hasTasks, hasSingle].filter(Boolean).length
    if (modes !== 1) {
      return { error: "Specify exactly one mode: agent+task, tasks[], or chain[]" }
    }

    const resolveAgent = (agentName: string) =>
      ctx.agent.get(AgentName.make(agentName)).pipe(
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
    const isTaskStillActive = (taskId: TaskId) =>
      Effect.gen(function* () {
        const taskService = yield* TaskService
        const task = yield* taskService.get(taskId)
        return task !== undefined && task.status !== "stopped" && task.status !== "failed"
      }).pipe(Effect.catchEager(() => Effect.succeed(false)))

    const spawnBackgroundTask = (task: Task, agent: { name: AgentName }) =>
      Effect.gen(function* () {
        const taskService = yield* TaskService
        // Set task to in_progress
        yield* taskService
          .update(task.id, { status: "in_progress" })
          .pipe(Effect.catchEager(() => Effect.void))

        const resolvedAgent = yield* ctx.agent.get(agent.name)
        if (resolvedAgent === undefined) {
          yield* taskService
            .update(task.id, {
              status: "failed",
              metadata: { error: `Unknown agent: ${agent.name}` },
            })
            .pipe(Effect.catchEager(() => Effect.void))
          return
        }

        // Background tasks need durable sessions so users can navigate to them
        // via the stored childSessionId after the run completes.
        const result = yield* ctx.agent.run({
          agent: resolvedAgent,
          prompt: task.prompt ?? task.subject,
          runSpec: makeRunSpec({ persistence: "durable", parentToolCallId: ctx.toolCallId }),
        })

        // Guard: if task was stopped/failed while running, don't overwrite terminal state
        const active = yield* isTaskStillActive(task.id)
        if (!active) return

        if (result._tag === "success") {
          yield* taskService
            .update(task.id, {
              status: "completed",
              owner: result.sessionId,
              metadata: {
                ...(typeof task.metadata === "object" && task.metadata !== null
                  ? task.metadata
                  : {}),
                childSessionId: result.sessionId,
              },
            })
            .pipe(Effect.catchEager(() => Effect.void))
        } else {
          yield* taskService
            .update(task.id, {
              status: "failed",
              metadata: {
                ...(typeof task.metadata === "object" && task.metadata !== null
                  ? task.metadata
                  : {}),
                error: result.error,
              },
            })
            .pipe(Effect.catchEager(() => Effect.void))
        }
      }).pipe(Effect.catchEager(() => Effect.void))

    const backgroundSingle = Effect.fn("DelegateTool.backgroundSingle")(function* () {
      const resolved = yield* resolveAgent(params.agent ?? "")
      if (!resolved.ok) return { error: resolved.error }

      const taskService = yield* TaskService
      const task = yield* taskService
        .create({
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          subject: params.description ?? params.task ?? "background task",
          agentType: resolved.agent.name,
          prompt: params.task,
          cwd: ctx.cwd,
        })
        .pipe(
          Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined))),
          Effect.catchDefect(() => Effect.void.pipe(Effect.as(undefined))),
        )
      if (task === undefined)
        return { error: "Background tasks unavailable — task-tools extension is disabled" }

      yield* Effect.forkChild(spawnBackgroundTask(task, resolved.agent))
      return { taskId: task.id, status: "running" as const }
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
        const taskService = yield* TaskService
        const task = yield* taskService
          .create({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            subject: summarizeTaskSubject(item.task),
            agentType: resolved.agent.name,
            prompt: item.task,
            cwd: ctx.cwd,
          })
          .pipe(
            Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined))),
            Effect.catchDefect(() => Effect.void.pipe(Effect.as(undefined))),
          )
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
          runSpec: makeRunSpec({ persistence: "ephemeral", parentToolCallId: ctx.toolCallId }),
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
              runSpec: makeRunSpec({ persistence: "ephemeral", parentToolCallId: ctx.toolCallId }),
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
        runSpec: makeRunSpec({ persistence: "ephemeral", parentToolCallId: ctx.toolCallId }),
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
