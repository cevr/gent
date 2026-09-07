import { Effect, Option, Predicate, Record, Schema } from "effect"
import {
  AgentName,
  AgentRunError,
  BranchId,
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
  description: "Start one durable child and return its handle without waiting for completion.",
  promptGuidelines: [
    "Keep the returned requestId. Use agent-child to inspect, wait, or cancel that start.",
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
    "Inspect, wait for, or cancel an owned child start. Pending is not proof that work is running; completed is a turn receipt, not task success.",
  promptGuidelines: [
    "After completion, use read_session with the returned sessionId and branchId to read the child output. Omit goal to avoid another model call.",
    "Read the output before treating completion as task success. Interrupted or failed turns can have partial output.",
  ],
  params: Schema.Struct({
    action: Schema.Literals(["inspect", "wait", "cancel"]),
    requestId: RequestId,
    waitMs: Schema.optionalKey(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(30000),
      ).annotate({ description: "Required for wait: how long to wait for completion" }),
    ),
  }),
  output: ChildObservation,
  execute: Effect.fn("ControlChildAgent.execute")(function* (params) {
    const ctx = yield* ExtensionContext
    if (params.action === "cancel") yield* ctx.Agent.cancel({ requestId: params.requestId })
    let observation
    if (params.action === "wait") {
      const waitMs = Option.fromUndefinedOr(params.waitMs)
      if (Option.isNone(waitMs))
        return yield* new AgentRunError({ message: "agent-child wait requires waitMs" })
      observation = yield* ctx.Agent.wait({
        requestId: params.requestId,
        waitMs: waitMs.value,
      }).pipe(
        Effect.catchTag("TimeoutError", (cause) =>
          Effect.fail(
            new AgentRunError({
              message: "Child wait timed out; the child was not cancelled",
              cause,
            }),
          ),
        ),
      )
    } else {
      observation = yield* ctx.Agent.inspect({ requestId: params.requestId })
    }
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

/** Durable child admission and control for cells. Registered as a builtin. */
export const ChildAgentExtension = defineExtension({
  id: "@gent/child-agents",
  tools: [StartChildAgent, ControlChildAgent],
})
