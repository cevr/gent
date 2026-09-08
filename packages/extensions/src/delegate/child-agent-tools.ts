import { Effect, Option, Predicate, Record, Schema } from "effect"
import {
  BranchId,
  ChildAgentRegistryEntry,
  ExtensionContext,
  RequestId,
  SessionId,
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

export const ControlChildAgent = tool({
  id: "agent-child",
  description:
    "Inspect or cancel a child started with delegate background: true. Pending is not proof that work is running; completed is a turn receipt, not task success.",
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
