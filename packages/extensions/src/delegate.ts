import { Effect, Option, Predicate, Record, Schema } from "effect"
import {
  AgentName,
  AgentRunError,
  AgentRunToolCallSchema,
  BranchId,
  ChildAgentRegistryEntry,
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  makeRunSpec,
  RequestId,
  requireCurrentAgent,
  RunSpecSchema,
  SessionId,
  tool,
} from "@gent/core/extensions/api"

// ── child agent tools ───────────────────────────────────────────────────────

export const ChildAgentHandle = Schema.Struct({
  requestId: RequestId,
  sessionId: SessionId,
  branchId: BranchId,
})

const ChildObservation = Schema.TaggedUnion({
  Pending: ChildAgentHandle.fields,
  Completed: {
    ...ChildAgentHandle.fields,
    interrupted: Schema.optionalKey(Schema.Boolean),
    streamFailed: Schema.optionalKey(Schema.Boolean),
    /** The child spent its continuations and never answered. */
    unanswered: Schema.optionalKey(Schema.Boolean),
  },
})

export const ControlChildAgent = tool({
  id: "agent-child",
  description:
    "Inspect, message, or cancel a child started with delegate background: true. Pending is not proof that work is running; completed is a turn receipt, not task success.",
  promptGuidelines: [
    "Completion arrives as a message on this branch; inspect is for a point-in-time check, not a wait.",
    "After completion, use read_session with the returned sessionId and branchId to read the child output. Omit goal to avoid another model call.",
    "Read the output before treating completion as task success. Interrupted or failed turns can have partial output.",
    "send puts a message into the child's running turn: a correction, a new fact, a narrower scope. The child reads it at its next step. A finished child takes no messages; delegate a new task instead.",
  ],
  params: Schema.Struct({
    action: Schema.Literals(["inspect", "send", "cancel"]),
    requestId: RequestId,
    message: Schema.optionalKey(
      Schema.String.annotate({ description: "The text the child reads. Required for send." }),
    ),
  }),
  output: ChildObservation,
  execute: Effect.fn("ControlChildAgent.execute")(function* (params) {
    const ctx = yield* ExtensionContext
    if (params.action === "cancel") yield* ctx.Agent.cancel({ requestId: params.requestId })
    if (params.action === "send") {
      const message = params.message ?? ""
      if (message.trim().length === 0 || Predicate.isUndefined(ctx.toolCallId)) {
        return yield* new AgentRunError({
          message: "send needs a message and a host-owned tool call",
        })
      }
      yield* ctx.Agent.send({
        requestId: params.requestId,
        message,
        sendId: RequestId.make(`agent-send:${ctx.toolCallId}`),
      })
    }
    const observation = yield* ctx.Agent.inspect({ requestId: params.requestId })
    const handle = {
      requestId: params.requestId,
      sessionId: observation.sessionId,
      branchId: observation.branchId,
    }
    if (Option.isNone(observation.completion)) return ChildObservation.cases.Pending.make(handle)
    return ChildObservation.cases.Completed.make({
      ...handle,
      ...Record.filter(
        {
          interrupted: observation.completion.value.interrupted,
          streamFailed: observation.completion.value.streamFailed,
          unanswered: observation.completion.value.unanswered,
        },
        Predicate.isNotUndefined,
      ),
    })
  }),
})

const ListChildAgents = tool({
  id: "agent-children",
  description:
    "List every background delegation owned by this branch from the host registry. The registry survives restarts.",
  promptGuidelines: [
    "Use this after a restart or compaction to recover child handles you no longer hold.",
  ],
  params: Schema.Struct({
    completed: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "Keep only finished (true) or unfinished (false) children",
      }),
    ),
  }),
  output: Schema.Array(ChildAgentRegistryEntry),
  execute: Effect.fn("ListChildAgents.execute")(function* (params) {
    const ctx = yield* ExtensionContext
    const children = yield* ctx.Agent.list()
    const wanted = Option.fromUndefinedOr(params.completed)
    if (Option.isNone(wanted)) return children
    return children.filter((child) => child.completed === wanted.value)
  }),
})

// ── delegate tool and extension ─────────────────────────────────────────────

/**
 * A child never delegates. Fan-out is the caller's decision, and a project
 * prompt that addresses "the orchestrator" reaches children too, so without
 * this a worker reads that prompt and spawns its own workers.
 */
const CHILD_DENIED_TOOLS: ReadonlyArray<string> = ["delegate", "agent-child", "agent-children"]

const childOverrides = (overrides: (typeof DelegateParams.Type)["overrides"]) => ({
  ...overrides,
  deniedTools: [...CHILD_DENIED_TOOLS, ...(overrides?.deniedTools ?? [])],
})

/** One self-contained task for a child that inherits this agent. Cells compose parallel and chained delegations. */
const DelegateParams = Schema.Struct({
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
const DelegateResult = Schema.TaggedUnion({
  Running: ChildAgentHandle.fields,
  Completed: { output: Schema.String, metadata: DelegateMetadata },
  Error: { error: Schema.String },
})

export const DelegateTool = tool({
  id: "delegate",
  description:
    "Delegate one self-contained task to a child that inherits this agent and model but cannot delegate further. Foreground returns the child's output. background: true returns a handle now; the result arrives later as a message on this branch and starts a turn by itself, so end your turn to wait and do not set an alarm or a monitor for it.",
  promptSnippet: "Delegate work to child agents",
  promptGuidelines: [
    "Use for independent work that benefits from a fresh context or parallelism",
    "Do NOT delegate simple reads, searches, or single-file edits — do those directly",
    "Each todo prompt must be self-contained — children have no conversation history",
    "Run independent delegations concurrently from one cell with Promise.all; chain dependent ones with sequential awaits and pass earlier output in the next prompt",
    "Background delegations never return output here. Do not poll; a message on this branch reports the result. agent-child inspects, messages, or cancels one by requestId; agent-children lists them.",
    "A new call starts new work. Do not repeat a delegation to recover an unknown outcome; inspect it with agent-child using its toolCallId as the requestId.",
    "For parallel exploration: don't share preliminary findings between children — let each form independent conclusions",
    "Use overrides.modelId for a second opinion from a different model; overrides.systemPromptAddendum focuses a child on one role",
  ],
  params: DelegateParams,
  output: DelegateResult,
  execute: Effect.fn("DelegateTool.execute")(function* (params: typeof DelegateParams.Type) {
    const ctx = yield* ExtensionContext
    const agent = yield* requireCurrentAgent

    // Both outcomes point the parent at the child's session when there is one.
    const withSessionRef = (text: string, sessionId?: string) => {
      if (Predicate.isUndefined(sessionId)) return text
      return `${text}\n\nFull session: session://${sessionId}`
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
        runSpec: makeRunSpec({ overrides: childOverrides(params.overrides) }),
      })
      return DelegateResult.cases.Running.make({ requestId, ...child })
    }

    // Foreground mode: a child session in this runtime, awaited here.
    const result = yield* ctx.Agent.run({
      agent,
      prompt: params.todo,
      runSpec: makeRunSpec({
        parentToolCallId: ctx.toolCallId,
        overrides: childOverrides(params.overrides),
      }),
    })

    if (result._tag === "Error") {
      return DelegateResult.cases.Error.make({
        error: withSessionRef(result.error, result.sessionId),
      })
    }

    const sessionId = result.sessionId
    return DelegateResult.cases.Completed.make({
      output: withSessionRef(result.text, sessionId),
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

/** Child admission and control for cells: one admission call plus inspect, send, cancel, and list. */
export const DelegateExtension = defineExtension({
  id: "@gent/delegate",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", DelegateTool, ControlChildAgent, ListChildAgents)
  }),
})
