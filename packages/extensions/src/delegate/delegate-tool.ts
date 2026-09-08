import { Effect, Predicate, Record, Schema } from "effect"
import {
  tool,
  AgentName,
  AgentRunError,
  ExtensionContext,
  AgentRunToolCallSchema,
  defineExtension,
  ExtensionHost,
  getDurableAgentRunSessionId,
  makeRunSpec,
  RequestId,
  requireCurrentAgent,
  RunSpecSchema,
} from "@gent/core/extensions/api"
import { ChildAgentHandle, ControlChildAgent, ListChildAgents } from "./child-agent-tools.js"

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

const DelegateMetadata = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
  agentName: Schema.optionalKey(AgentName),
  usage: Schema.optionalKey(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cost: Schema.optionalKey(Schema.Finite),
    }),
  ),
  toolCalls: Schema.optionalKey(Schema.Array(AgentRunToolCallSchema)),
})

/**
 * One admission call, two shapes: `running` is the handle of a background
 * child (its result arrives later as a message), `completed` is a foreground
 * child's output. `agent-child` and `agent-children` inspect the running ones.
 */
export const DelegateResult = Schema.TaggedUnion({
  running: ChildAgentHandle.fields,
  completed: { output: Schema.String, metadata: DelegateMetadata },
  error: { error: Schema.String },
})

export const DelegateTool = tool({
  id: "delegate",
  description:
    "Delegate one self-contained task to a child that inherits this agent and model. Foreground returns the child's output. background: true returns a handle now; the result arrives later as a message on this branch.",
  promptSnippet: "Delegate work to child agents",
  promptGuidelines: [
    "Use for independent work that benefits from a fresh context or parallelism",
    "Do NOT delegate simple reads, searches, or single-file edits — do those directly",
    "Each todo prompt must be self-contained — children have no conversation history",
    "Run independent delegations concurrently from one cell with Promise.all; chain dependent ones with sequential awaits and pass earlier output in the next prompt",
    "Background delegations never return output here. Do not poll; a message on this branch reports the result. agent-child inspects or cancels one by requestId; agent-children lists them.",
    "A new call starts new work. Do not repeat a delegation to recover an unknown outcome; inspect it with agent-child using its toolCallId as the requestId.",
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
      return DelegateResult.cases.running.make({ requestId, ...child })
    }

    // Foreground mode: a durable child in this runtime, awaited here. Durable
    // keeps the child on the session profile, so its cell and resources work;
    // the ephemeral root is for tool-less helper runs only.
    const result = yield* ctx.Agent.run({
      agent,
      prompt: params.todo,
      runSpec: makeRunSpec({
        persistence: "durable",
        parentToolCallId: ctx.toolCallId,
        overrides: params.overrides,
      }),
    })

    if (result._tag === "error") {
      return DelegateResult.cases.error.make({
        error: appendSessionRef(result.error, getDurableAgentRunSessionId(result)),
      })
    }

    const sessionId = getDurableAgentRunSessionId(result)
    const parts = [result.text]
    if (Predicate.isNotUndefined(result.savedPath)) {
      parts.push(`\n\nFull output: ${result.savedPath}`)
    }
    if (Predicate.isNotUndefined(sessionId)) {
      parts.push(`\n\nFull session: session://${sessionId}`)
    }
    return DelegateResult.cases.completed.make({
      output: parts.join(""),
      metadata: Record.filter(
        {
          sessionId,
          agentName: result.agentName,
          usage: result.usage,
          toolCalls: result.toolCalls,
        },
        Predicate.isNotUndefined,
      ),
    })
  }),
})

/** Child admission and control for cells: one admission call plus inspect, cancel, and list. */
export const DelegateExtension = defineExtension({
  id: "@gent/delegate",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", DelegateTool, ControlChildAgent, ListChildAgents)
  }),
})
