import { Context, Effect, Layer, Option, Predicate } from "effect"
import type * as Prompt from "effect/unstable/ai/Prompt"
import type { BranchId, SessionId } from "../../domain/ids.js"
import type { ResourceGenerationId } from "../../domain/resource-generation.js"
import type { ResolvedToolCapability } from "./tool-runner.js"

export const processLocalReplayBindingKey = (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly assistantMessageId: string
  readonly toolCallId: string
}): string =>
  `${params.sessionId}:${params.branchId}:${params.assistantMessageId}:${params.toolCallId}`

export const processLocalReplayResultKey = (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly toolResultMessageId: string
}): string => `${params.sessionId}:${params.branchId}:${params.toolResultMessageId}`

export const sameProcessLocalGeneration = (
  left: Option.Option<ResourceGenerationId>,
  right: Option.Option<ResourceGenerationId>,
): boolean => {
  if (Option.isNone(left)) return Option.isNone(right)
  if (Option.isNone(right)) return false
  return left.value === right.value
}

export interface ProcessLocalReplayBinding {
  readonly entry: ResolvedToolCapability
  readonly generationId: Option.Option<ResourceGenerationId>
}

export interface ProcessLocalToolReplayService {
  readonly getBinding: (key: string) => Effect.Effect<Option.Option<ProcessLocalReplayBinding>>
  readonly setBinding: (key: string, binding: ProcessLocalReplayBinding) => Effect.Effect<void>
  readonly removeBinding: (key: string) => Effect.Effect<void>
  readonly clearBindingsWithPrefix: (prefix: string) => Effect.Effect<void>
  readonly clearBindingsForGeneration: (generationId: ResourceGenerationId) => Effect.Effect<void>
  readonly getResults: (key: string) => Effect.Effect<ReadonlyMap<string, Prompt.ToolResultPart>>
  readonly setResults: (
    key: string,
    results: ReadonlyMap<string, Prompt.ToolResultPart>,
  ) => Effect.Effect<void>
  readonly removeResults: (key: string) => Effect.Effect<void>
  readonly clearResultsWithPrefix: (prefix: string) => Effect.Effect<void>
}

export class ProcessLocalToolReplay extends Context.Service<
  ProcessLocalToolReplay,
  ProcessLocalToolReplayService
>()("@gent/core/src/runtime/agent/process-local-tool-replay/ProcessLocalToolReplay") {
  static Live: Layer.Layer<ProcessLocalToolReplay> = Layer.effect(
    ProcessLocalToolReplay,
    Effect.gen(function* () {
      const bindings = new Map<string, ProcessLocalReplayBinding>()
      const results = new Map<string, Map<string, Prompt.ToolResultPart>>()

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          bindings.clear()
          results.clear()
        }),
      )

      return ProcessLocalToolReplay.of({
        getBinding: (key) => Effect.sync(() => Option.fromUndefinedOr(bindings.get(key))),
        setBinding: (key, binding) =>
          Effect.sync(() => {
            bindings.set(key, binding)
          }),
        removeBinding: (key) =>
          Effect.sync(() => {
            bindings.delete(key)
          }),
        clearBindingsWithPrefix: (prefix) =>
          Effect.sync(() => {
            for (const key of bindings.keys()) {
              if (key.startsWith(prefix)) bindings.delete(key)
            }
          }),
        clearBindingsForGeneration: (generationId) =>
          Effect.sync(() => {
            for (const [key, binding] of bindings) {
              if (
                Option.isSome(binding.generationId) &&
                binding.generationId.value === generationId
              ) {
                bindings.delete(key)
              }
            }
          }),
        getResults: (key) =>
          Effect.sync(() => {
            const value = results.get(key)
            if (Predicate.isUndefined(value)) return new Map<string, Prompt.ToolResultPart>()
            return new Map(value)
          }),
        setResults: (key, value) =>
          Effect.sync(() => {
            results.set(key, new Map(value))
          }),
        removeResults: (key) =>
          Effect.sync(() => {
            results.delete(key)
          }),
        clearResultsWithPrefix: (prefix) =>
          Effect.sync(() => {
            for (const key of results.keys()) {
              if (key.startsWith(prefix)) results.delete(key)
            }
          }),
      })
    }),
  )
}
