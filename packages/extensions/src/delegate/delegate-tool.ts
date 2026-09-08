import { Effect, Predicate, Schema } from "effect"
import {
  tool,
  AgentName,
  AgentRunError,
  BranchId,
  ExtensionContext,
  AgentRunToolCallSchema,
  defineExtension,
  getDurableAgentRunSessionId,
  makeRunSpec,
  RequestId,
  requireCurrentAgent,
  RunSpecSchema,
  SessionId,
} from "@gent/core/extensions/api"

/** One self-contained task for a child that inherits this agent. Cells compose parallel and chained delegations. */
export const DelegateParams = Schema.Struct({
  todo: Schema.String,
  description: Schema.optionalKey(Schema.String),
  background: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Start a durable child and return its handle now. The result arrives later as a message on this branch.",
    }),
  ),
  overrides: RunSpecSchema.fields.overrides,
})

export const DelegateResult = Schema.Struct({
  error: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["running"])),
  requestId: Schema.optional(RequestId),
  sessionId: Schema.optional(SessionId),
  branchId: Schema.optional(BranchId),
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
    "Delegate one self-contained task to a child that inherits this agent and model. Set background: true to get a handle now and the result as a later message.",
  promptSnippet: "Delegate work to child agents",
  promptGuidelines: [
    "Use for independent work that benefits from a fresh context or parallelism",
    "Do NOT delegate simple reads, searches, or single-file edits — do those directly",
    "Each todo prompt must be self-contained — children have no conversation history",
    "Run independent delegations concurrently from one cell with Promise.all; chain dependent ones with sequential awaits and pass earlier output in the next prompt",
    "Background delegations never return output here. Do not poll; a message on this branch reports the result. agent-children lists them.",
    "For parallel exploration: don't share preliminary findings between children — let each form independent conclusions",
    "Use overrides.modelId for a second opinion from a different model; overrides.systemPromptAddendum focuses a child on one role",
  ],
  params: DelegateParams,
  output: DelegateResult,
  execute: Effect.fn("DelegateTool.execute")(function* (params: typeof DelegateParams.Type) {
    const ctx = yield* ExtensionContext
    const agent = yield* requireCurrentAgent

    const appendSessionRef = (error: string, sessionId?: string) => {
      if (Predicate.isUndefined(sessionId)) return error
      return `${error}\n\nFull session: session://${sessionId}`
    }

    // Background mode: durable child admission; the host delivers completion as a message.
    if (params.background === true) {
      if (Predicate.isUndefined(ctx.toolCallId)) {
        return yield* new AgentRunError({
          message: "Background delegation requires a host-owned tool call",
        })
      }
      const requestId = RequestId.make(ctx.toolCallId)
      const child = yield* ctx.Agent.start({
        agent,
        prompt: params.todo,
        requestId,
        runSpec: makeRunSpec({ persistence: "durable", overrides: params.overrides }),
      })
      return { requestId, ...child, status: "running" } satisfies typeof DelegateResult.Type
    }

    // Foreground mode: blocking subagent dispatch
    const result = yield* ctx.Agent.run({
      agent,
      prompt: params.todo,
      runSpec: makeRunSpec({
        persistence: "ephemeral",
        parentToolCallId: ctx.toolCallId,
        overrides: params.overrides,
      }),
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
