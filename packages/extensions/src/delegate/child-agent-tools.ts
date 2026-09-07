import { Effect, Option, Predicate, Record, Schema } from "effect"
import {
  AgentName,
  AgentRunError,
  BranchId,
  ChildAgentRegistryEntry,
  ExtensionContext,
  RequestId,
  RunSpecSchema,
  SessionId,
  defineExtension,
  requireAgent,
  makeRunSpec,
  tool,
} from "@gent/core/extensions/api"

export const ChildAgentHandle = Schema.Struct({
  requestId: RequestId,
  sessionId: SessionId,
  branchId: BranchId,
})

const ChildObservation = Schema.TaggedUnion({
  pending: ChildAgentHandle.fields,
  completed: {
    ...ChildAgentHandle.fields,
    interrupted: Schema.optionalKey(Schema.Boolean),
    streamFailed: Schema.optionalKey(Schema.Boolean),
  },
})

export const StartChildAgent = tool({
  id: "agent-start",
  description:
    "Start one durable child and return its handle. The result never returns here: it arrives later as a message on this branch.",
  promptGuidelines: [
    "Keep the returned requestId. Use agent-child to inspect or cancel that start, and agent-children to list every start on this branch.",
    "Do not poll for completion. When the child finishes, a message on this branch reports its requestId, session, outcome, and output preview.",
    "A new call starts new work. Do not repeat a start to recover an unknown outcome.",
    "For a recovered Unknown agent-start operation, use its toolCallId as the requestId for agent-child inspect or cancel.",
  ],
  params: Schema.Struct({
    agent: AgentName,
    prompt: Schema.NonEmptyString,
    overrides: RunSpecSchema.fields.overrides,
  }),
  output: ChildAgentHandle,
  execute: Effect.fn("StartChildAgent.execute")(function* (params) {
    const ctx = yield* ExtensionContext
    if (Predicate.isUndefined(ctx.toolCallId)) {
      return yield* new AgentRunError({ message: "Child start requires a host-owned tool call" })
    }
    const requestId = RequestId.make(ctx.toolCallId)
    const agent = yield* requireAgent(params.agent)
    const child = yield* ctx.Agent.start({
      agent,
      prompt: params.prompt,
      requestId,
      runSpec: makeRunSpec({ overrides: params.overrides }),
    })
    return { requestId, ...child }
  }),
})

export const ControlChildAgent = tool({
  id: "agent-child",
  description:
    "Inspect or cancel an owned child start. Pending is not proof that work is running; completed is a turn receipt, not task success.",
  promptGuidelines: [
    "Completion arrives as a message on this branch; inspect is for a point-in-time check, not a wait.",
    "After completion, use read_session with the returned sessionId and branchId to read the child output. Omit goal to avoid another model call.",
    "Read the output before treating completion as task success. Interrupted or failed turns can have partial output.",
  ],
  params: Schema.Struct({
    action: Schema.Literals(["inspect", "cancel"]),
    requestId: RequestId,
  }),
  output: ChildObservation,
  execute: Effect.fn("ControlChildAgent.execute")(function* (params) {
    const ctx = yield* ExtensionContext
    if (params.action === "cancel") yield* ctx.Agent.cancel({ requestId: params.requestId })
    const observation = yield* ctx.Agent.inspect({ requestId: params.requestId })
    const handle = {
      requestId: params.requestId,
      sessionId: observation.sessionId,
      branchId: observation.branchId,
    }
    if (Option.isNone(observation.completion)) return ChildObservation.cases.pending.make(handle)
    return ChildObservation.cases.completed.make({
      ...handle,
      ...Record.filter(
        {
          interrupted: observation.completion.value.interrupted,
          streamFailed: observation.completion.value.streamFailed,
        },
        Predicate.isNotUndefined,
      ),
    })
  }),
})

export const ListChildAgents = tool({
  id: "agent-children",
  description:
    "List every child start owned by this branch from the host registry. The registry survives restarts.",
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

/** Durable child admission and control for cells. Registered as a builtin. */
export const ChildAgentExtension = defineExtension({
  id: "@gent/child-agents",
  tools: [StartChildAgent, ControlChildAgent, ListChildAgents],
})
