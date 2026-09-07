import { Data, Effect, Option, Predicate, Schema } from "effect"
import {
  tool,
  AgentName,
  ExtensionContext,
  AgentRunToolCallSchema,
  defineExtension,
  getDurableAgentRunSessionId,
  makeRunSpec,
  type ExtensionContextService,
} from "@gent/core/extensions/api"
import { TodoService } from "../todo-service.js"
import type { Todo, TodoId } from "../todo/domain.js"

interface BackgroundDelegateTarget {
  readonly toolCallId: ExtensionContextService["toolCallId"]
  readonly Agent: Pick<ExtensionContextService["Agent"], "run">
}

type BackgroundDelegateAgent = Parameters<ExtensionContextService["Agent"]["run"]>[0]["agent"]

type AgentResolution = Data.TaggedEnum<{
  Found: { readonly agent: BackgroundDelegateAgent }
  Missing: { readonly error: string }
}>

const AgentResolution = Data.taggedEnum<AgentResolution>()

const isTodoStillActive = (todoId: TodoId) =>
  Effect.gen(function* () {
    const todoService = yield* TodoService
    const todo = yield* todoService.get(todoId)
    return Option.isSome(todo) && todo.value.status !== "stopped" && todo.value.status !== "failed"
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

  let metadata = {}
  if (Predicate.isObjectOrArray(todo.metadata)) metadata = todo.metadata

  if (result._tag === "success") {
    yield* todoService
      .update(todo.id, {
        status: "completed",
        owner: result.sessionId,
        metadata: {
          ...metadata,
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
        ...metadata,
        error: result.error,
      },
    })
    .pipe(Effect.catchEager(() => Effect.void))
})

/** One agent, one self-contained task. Cells compose parallel and chained delegations. */
export const DelegateParams = Schema.Struct({
  agent: AgentName,
  todo: Schema.String,
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
  status: Schema.optional(Schema.Literals(["running"])),
  output: Schema.optional(Schema.String),
  metadata: Schema.optional(
    Schema.Struct({
      sessionId: Schema.optional(Schema.String),
      agentName: Schema.optional(AgentName),
      usage: Schema.optional(
        Schema.Struct({
          input: Schema.Finite,
          output: Schema.Finite,
          cost: Schema.optional(Schema.Finite),
        }),
      ),
      toolCalls: Schema.optional(Schema.Array(AgentRunToolCallSchema)),
    }),
  ),
})

export const DelegateTool = tool({
  id: "delegate",
  description:
    "Delegate one self-contained task to a specialized agent. Set background: true to run asynchronously.",
  promptSnippet: "Delegate work to specialized subagents",
  promptGuidelines: [
    "Use for work that benefits from specialized focus or parallelism",
    "Do NOT delegate simple reads, searches, or single-file edits — do those directly",
    "Each todo prompt must be self-contained — delegated agents have no conversation history",
    "Run independent delegations concurrently from one cell with Promise.all; chain dependent ones with sequential awaits and pass earlier output in the next prompt",
    "For parallel exploration: don't share preliminary findings between agents — let each form independent conclusions",
    "Prefer focused tools: review (code review), counsel (second opinion), research (repo understanding)",
  ],
  params: DelegateParams,
  output: DelegateResult,
  execute: Effect.fn("DelegateTool.execute")(function* (params: typeof DelegateParams.Type) {
    const ctx = yield* ExtensionContext

    const agents = yield* ctx.Agent.listAgents
    const resolved = Option.match(
      Option.fromNullishOr(agents.find((candidate) => candidate.name === params.agent)),
      {
        onNone: () => AgentResolution.Missing({ error: `Unknown agent: ${params.agent}` }),
        onSome: (agent) => AgentResolution.Found({ agent }),
      },
    )
    if (resolved._tag === "Missing") return { error: resolved.error }

    const appendSessionRef = (error: string, sessionId?: string) => {
      if (Predicate.isUndefined(sessionId)) return error
      return `${error}\n\nFull session: session://${sessionId}`
    }

    // Background mode: create durable todo and fire-and-forget
    if (params.background === true) {
      const todoService = yield* TodoService
      const todo = yield* todoService
        .create({
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          subject: params.description ?? params.todo,
          agentType: resolved.agent.name,
          prompt: params.todo,
          cwd: ctx.cwd,
        })
        .pipe(
          Effect.asSome,
          Effect.catchEager(() => Effect.succeed(Option.none<Todo>())),
          Effect.catchDefect(() => Effect.succeed(Option.none<Todo>())),
        )
      if (Option.isNone(todo))
        return { error: "Background todos unavailable — todo extension is disabled" }

      const target: BackgroundDelegateTarget = {
        toolCallId: ctx.toolCallId,
        Agent: { run: ctx.Agent.run },
      }
      yield* runBackgroundDelegateTodo(todo.value, resolved.agent, target).pipe(
        Effect.catchEager(() => Effect.void),
        Effect.forkChild,
      )
      return { todoId: todo.value.id, status: "running" } satisfies typeof DelegateResult.Type
    }

    // Foreground mode: blocking subagent dispatch
    const result = yield* ctx.Agent.run({
      agent: resolved.agent,
      prompt: params.todo,
      runSpec: makeRunSpec({ persistence: "ephemeral", parentToolCallId: ctx.toolCallId }),
    })

    if (result._tag === "error") {
      return { error: appendSessionRef(result.error, getDurableAgentRunSessionId(result)) }
    }

    const sessionId = getDurableAgentRunSessionId(result)
    const parts = [result.text]
    if (Predicate.isNotUndefined(result.savedPath)) {
      parts.push(`\n\nFull output: ${result.savedPath}`)
    }
    if (Predicate.isNotUndefined(sessionId)) {
      parts.push(`\n\nFull session: session://${sessionId}`)
    }
    return {
      output: parts.join(""),
      metadata: {
        sessionId,
        agentName: result.agentName,
        usage: result.usage,
        toolCalls: result.toolCalls,
      },
    } satisfies typeof DelegateResult.Type
  }),
})

export const DelegateExtension = defineExtension({
  id: "@gent/delegate",
  tools: [DelegateTool],
})
