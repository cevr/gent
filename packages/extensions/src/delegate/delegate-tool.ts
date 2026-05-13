import { Effect, Schema } from "effect"
import {
  tool,
  AgentName,
  ExtensionContext,
  AgentRunResult,
  AgentRunToolCallSchema,
  defineExtension,
  getDurableAgentRunSessionId,
  makeRunSpec,
  type ExtensionContextService,
  type SessionId,
} from "@gent/core/extensions/api"
import { TodoService } from "../todo-service.js"
import type { Todo, TodoId } from "../todo/domain.js"

const MAX_PARALLEL_TODOS = 8
const MAX_CONCURRENCY = 4

interface BackgroundDelegateTarget {
  readonly toolCallId: ExtensionContextService["toolCallId"]
  readonly Agent: Pick<ExtensionContextService["Agent"], "run">
}

type BackgroundDelegateAgent = Parameters<ExtensionContextService["Agent"]["run"]>[0]["agent"]

const isTodoStillActive = (todoId: TodoId) =>
  Effect.gen(function* () {
    const todoService = yield* TodoService
    const todo = yield* todoService.get(todoId)
    return todo !== undefined && todo.status !== "stopped" && todo.status !== "failed"
  }).pipe(Effect.catchEager(() => Effect.succeed(false)))

const runBackgroundDelegateTodo = Effect.fn("DelegateTool.runBackgroundDelegateTodo")(function* (
  todo: Todo,
  agent: BackgroundDelegateAgent,
  target: BackgroundDelegateTarget,
) {
  const todoService = yield* TodoService
  yield* todoService
    .update(todo.id, { status: "in_progress" })
    .pipe(Effect.catchEager(() => Effect.void))

  // Background todos need durable sessions so users can navigate to them
  // via the stored childSessionId after the run completes.
  const result = yield* target.Agent.run({
    agent,
    prompt: todo.prompt ?? todo.subject,
    runSpec: makeRunSpec({ persistence: "durable", parentToolCallId: target.toolCallId }),
  })

  const active = yield* isTodoStillActive(todo.id)
  if (!active) return

  if (result._tag === "success") {
    yield* todoService
      .update(todo.id, {
        status: "completed",
        owner: result.sessionId,
        metadata: {
          ...(typeof todo.metadata === "object" && todo.metadata !== null ? todo.metadata : {}),
          childSessionId: result.sessionId,
        },
      })
      .pipe(Effect.catchEager(() => Effect.void))
    return
  }

  yield* todoService
    .update(todo.id, {
      status: "failed",
      metadata: {
        ...(typeof todo.metadata === "object" && todo.metadata !== null ? todo.metadata : {}),
        error: result.error,
      },
    })
    .pipe(Effect.catchEager(() => Effect.void))
})

const DelegateItem = Schema.Struct({
  agent: AgentName,
  todo: Schema.String,
})
type DelegateItemType = typeof DelegateItem.Type

export const DelegateParams = Schema.Struct({
  agent: Schema.optionalKey(AgentName),
  todo: Schema.optionalKey(Schema.String),
  todos: Schema.optionalKey(Schema.Array(DelegateItem)),
  chain: Schema.optionalKey(Schema.Array(DelegateItem)),
  description: Schema.optionalKey(Schema.String),
  background: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Run in the background via todo. Returns immediately with todoId. Poll with todo_get.",
    }),
  ),
})

export const DelegateResult = Schema.Struct({
  error: Schema.optional(Schema.String),
  todoId: Schema.optional(Schema.String),
  todoIds: Schema.optional(Schema.Array(Schema.String)),
  status: Schema.optional(Schema.Literals(["running"])),
  count: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.String),
  metadata: Schema.optional(
    Schema.Struct({
      mode: Schema.optional(Schema.Literals(["single", "parallel", "chain"])),
      results: Schema.optional(Schema.Array(AgentRunResult)),
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
  description:
    "Delegate work to specialized agents. Modes: single (agent+todo), parallel (todos[]), chain (chain[] with {previous}). Set background: true to run asynchronously.",
  promptSnippet: "Delegate work to specialized subagents",
  promptGuidelines: [
    "Use for work that benefits from specialized focus or parallelism",
    "Do NOT delegate simple reads, searches, or single-file edits — do those directly",
    "Each todo prompt must be self-contained — delegated agents have no conversation history",
    "For parallel exploration: don't share preliminary findings between agents — let each form independent conclusions",
    "Prefer focused tools: review (code review), counsel (second opinion), research (repo understanding)",
  ],
  params: DelegateParams,
  output: DelegateResult,
  execute: Effect.fn("DelegateTool.execute")(function* (params: typeof DelegateParams.Type) {
    const ctx = yield* ExtensionContext
    const hasChain = (params.chain?.length ?? 0) > 0
    const hasTodos = (params.todos?.length ?? 0) > 0
    const hasSingle = params.agent !== undefined && params.todo !== undefined

    const modes = [hasChain, hasTodos, hasSingle].filter(Boolean).length
    if (modes !== 1) {
      return { error: "Specify exactly one mode: agent+todo, todos[], or chain[]" }
    }

    const resolveAgent = (agentName: string) =>
      ctx.Agent.listAgents().pipe(
        Effect.map((agents) => {
          const agent = agents.find((a) => a.name === agentName)
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

    const summarizeTodoSubject = (todo: string) => {
      if (todo.length <= 60) return todo
      return `${todo.slice(0, 60)}…`
    }

    const startBackgroundTodo = (todo: Todo, agent: BackgroundDelegateAgent) =>
      Effect.gen(function* () {
        const target: BackgroundDelegateTarget = {
          toolCallId: ctx.toolCallId,
          Agent: { run: ctx.Agent.run },
        }
        yield* runBackgroundDelegateTodo(todo, agent, target).pipe(
          Effect.catchEager(() => Effect.void),
          Effect.forkChild,
        )
      })

    const backgroundSingle = Effect.fn("DelegateTool.backgroundSingle")(function* () {
      const resolved = yield* resolveAgent(params.agent ?? "")
      if (!resolved.ok) return { error: resolved.error }

      const todoService = yield* TodoService
      const todo = yield* todoService
        .create({
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          subject: params.description ?? params.todo ?? "background todo",
          agentType: resolved.agent.name,
          prompt: params.todo,
          cwd: ctx.cwd,
        })
        .pipe(
          Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined))),
          Effect.catchDefect(() => Effect.void.pipe(Effect.as(undefined))),
        )
      if (todo === undefined)
        return { error: "Background todos unavailable — todo extension is disabled" }

      yield* startBackgroundTodo(todo, resolved.agent)
      return { todoId: todo.id, status: "running" as const }
    })

    const backgroundParallel = Effect.fn("DelegateTool.backgroundParallel")(function* () {
      const todos = params.todos ?? []
      if (todos.length > MAX_PARALLEL_TODOS) {
        return { error: `Too many parallel todos (max ${MAX_PARALLEL_TODOS})` }
      }

      const todoIds: string[] = []
      for (const item of todos) {
        const resolved = yield* resolveAgent(item.agent)
        if (!resolved.ok) return { error: resolved.error }
        const todoService = yield* TodoService
        const todo = yield* todoService
          .create({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            subject: summarizeTodoSubject(item.todo),
            agentType: resolved.agent.name,
            prompt: item.todo,
            cwd: ctx.cwd,
          })
          .pipe(
            Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined))),
            Effect.catchDefect(() => Effect.void.pipe(Effect.as(undefined))),
          )
        if (todo === undefined) {
          return { error: "Background todos unavailable — todo extension is disabled" }
        }
        yield* startBackgroundTodo(todo, resolved.agent)
        todoIds.push(todo.id)
      }
      return { todoIds, status: "running" as const, count: todoIds.length }
    })

    const foregroundChain = Effect.fn("DelegateTool.foregroundChain")(function* () {
      const results: AgentRunResult[] = []
      let previousOutput = ""

      for (const step of params.chain ?? []) {
        const resolved = yield* resolveAgent(step.agent)
        if (!resolved.ok) return { error: resolved.error }

        const todoWithContext = step.todo.replace(/\{previous\}/g, previousOutput)
        const result = yield* ctx.Agent.run({
          agent: resolved.agent,
          prompt: todoWithContext,
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
      const todos = params.todos ?? []
      if (todos.length > MAX_PARALLEL_TODOS) {
        return { error: `Too many parallel todos (max ${MAX_PARALLEL_TODOS})` }
      }

      const runTodo = (todo: DelegateItemType) =>
        resolveAgent(todo.agent).pipe(
          Effect.flatMap((resolved) => {
            if (!resolved.ok) {
              return Effect.succeed(AgentRunResult.cases.error.make({ error: resolved.error }))
            }
            return ctx.Agent.run({
              agent: resolved.agent,
              prompt: todo.todo,
              runSpec: makeRunSpec({ persistence: "ephemeral", parentToolCallId: ctx.toolCallId }),
            })
          }),
        )

      const results = yield* Effect.forEach(todos, runTodo, { concurrency: MAX_CONCURRENCY })
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

      const result = yield* ctx.Agent.run({
        agent: resolved.agent,
        prompt: params.todo ?? "",
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

    // Background mode: create durable todo and fire-and-forget
    if (params.background === true) {
      if (hasSingle) return yield* backgroundSingle()
      if (hasTodos) return yield* backgroundParallel()
      return { error: "Background mode only supports single and parallel modes, not chain" }
    }

    // Foreground mode: blocking subagent dispatch
    if (hasChain) return yield* foregroundChain()
    if (hasTodos) return yield* foregroundParallel()
    return yield* foregroundSingle()
  }),
})

export const DelegateExtension = defineExtension({
  id: "@gent/delegate",
  tools: [DelegateTool],
})
