import { Cause, Effect } from "effect"
import {
  AgentRunResult,
  type AgentName,
  type AgentPersistence,
  type RunSpec,
} from "../../domain/agent.js"
import type { ToolCallId, SessionId, BranchId } from "../../domain/ids.js"

export const handleAgentRunFailure =
  <R2>(
    params: {
      parentSessionId: SessionId
      parentBranchId: BranchId
      toolCallId?: ToolCallId
      sessionId: SessionId
      agentName: AgentName
      persistence: AgentPersistence
      spanName: string
    },
    publishFailed: (params: {
      parentSessionId: SessionId
      parentBranchId: BranchId
      toolCallId?: ToolCallId
      sessionId: SessionId
      agentName: AgentName
    }) => Effect.Effect<void, never, R2>,
  ): (<E, R>(
    effect: Effect.Effect<AgentRunResult, E, R>,
  ) => Effect.Effect<AgentRunResult, E, R | R2>) =>
  <E, R>(effect: Effect.Effect<AgentRunResult, E, R>) =>
    effect.pipe(
      Effect.withSpan(params.spanName, {
        attributes: { agentName: params.agentName },
      }),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
        return Effect.gen(function* () {
          const error = Cause.pretty(cause)
          yield* publishFailed(params)
          return AgentRunResult.cases.error.make({
            error,
            sessionId: params.sessionId,
            agentName: params.agentName,
            persistence: params.persistence,
          })
        })
      }),
    )

const overrideArray = <A>(values: ReadonlyArray<A> | undefined) =>
  values === undefined ? undefined : [...values]

export const normalizeRunSpec = (runSpec: RunSpec | undefined): RunSpec | undefined => {
  if (runSpec === undefined) return undefined
  const overrides = runSpec.overrides
  const normalizedOverrides =
    overrides === undefined
      ? undefined
      : {
          ...(overrides.modelId !== undefined ? { modelId: overrides.modelId } : {}),
          ...(overrides.allowedTools !== undefined
            ? { allowedTools: overrideArray(overrides.allowedTools) }
            : {}),
          ...(overrides.deniedTools !== undefined
            ? { deniedTools: overrideArray(overrides.deniedTools) }
            : {}),
          ...(overrides.reasoningEffort !== undefined
            ? { reasoningEffort: overrides.reasoningEffort }
            : {}),
          ...(overrides.systemPromptAddendum !== undefined
            ? { systemPromptAddendum: overrides.systemPromptAddendum }
            : {}),
        }
  return {
    ...(runSpec.persistence !== undefined ? { persistence: runSpec.persistence } : {}),
    ...(normalizedOverrides !== undefined ? { overrides: normalizedOverrides } : {}),
    ...(runSpec.tags !== undefined ? { tags: overrideArray(runSpec.tags) } : {}),
    ...(runSpec.parentToolCallId !== undefined
      ? { parentToolCallId: runSpec.parentToolCallId }
      : {}),
  }
}
