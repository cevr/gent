import { Cause, Effect, Option, Predicate } from "effect"
import {
  AgentRunResult,
  type AgentRunOverrides,
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

const overrideArray = <A>(values?: ReadonlyArray<A>): Option.Option<ReadonlyArray<A>> =>
  Option.map(Option.fromUndefinedOr(values), (items) => [...items])

// oxlint-disable-next-line effect/noNullish -- This normalization helper preserves the established optional run-spec API.
export const normalizeRunSpec = (runSpec: RunSpec | undefined): RunSpec | undefined => {
  // oxlint-disable-next-line effect/noNullish -- This normalization helper preserves the established optional run-spec API.
  if (Predicate.isUndefined(runSpec)) return undefined
  const overrides = runSpec.overrides
  // oxlint-disable-next-line effect/noNullish -- Run-spec normalization preserves omission of absent override groups.
  let normalizedOverrides: AgentRunOverrides | undefined
  if (Predicate.isUndefined(overrides)) {
    // oxlint-disable-next-line effect/noNullish -- Run-spec normalization preserves omission of absent override groups.
    normalizedOverrides = undefined
  } else {
    const normalized: { -readonly [K in keyof AgentRunOverrides]?: AgentRunOverrides[K] } = {}
    if (Predicate.isNotUndefined(overrides.modelId)) normalized.modelId = overrides.modelId
    const allowedTools = overrideArray(overrides.allowedTools)
    if (Option.isSome(allowedTools)) normalized.allowedTools = allowedTools.value
    const deniedTools = overrideArray(overrides.deniedTools)
    if (Option.isSome(deniedTools)) normalized.deniedTools = deniedTools.value
    if (Predicate.isNotUndefined(overrides.reasoningEffort)) {
      normalized.reasoningEffort = overrides.reasoningEffort
    }
    if (Predicate.isNotUndefined(overrides.systemPromptAddendum)) {
      normalized.systemPromptAddendum = overrides.systemPromptAddendum
    }
    normalizedOverrides = normalized
  }

  const normalized: { -readonly [K in keyof RunSpec]?: RunSpec[K] } = {}
  if (Predicate.isNotUndefined(runSpec.persistence)) normalized.persistence = runSpec.persistence
  if (Predicate.isNotUndefined(normalizedOverrides)) normalized.overrides = normalizedOverrides
  const tags = overrideArray(runSpec.tags)
  if (Option.isSome(tags)) normalized.tags = tags.value
  if (Predicate.isNotUndefined(runSpec.parentToolCallId)) {
    normalized.parentToolCallId = runSpec.parentToolCallId
  }
  return normalized
}
