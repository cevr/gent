/**
 * Core's own test composition: the shared test agent and model driver, and a
 * local compactor. Core tests never load the shipped extensions;
 * `@gent/extensions` depends on core, so its builtins are a cycle here.
 */
import { Effect, Layer, Stream } from "effect"
import type { AgentDefinition } from "../../src/domain/agent"
import { defineExtension, defineResource, ExtensionHost } from "../../src/extensions/api"
import { ModelCompactionError, ModelContextCompactor } from "../../src/runtime/model-context"
import { type E2ELayerConfig, testAgent, testTurnExtension } from "../../src/test-utils/harness"

export { testAgent }

export const testAgents: ReadonlyArray<AgentDefinition> = [testAgent]

/**
 * A compactor that asks the summary model once and names the id range it
 * replaced. The shipped compactor's notice format is its own extension's test.
 */
export const rangeCompactorLayer = Layer.succeed(
  ModelContextCompactor,
  ModelContextCompactor.of({
    compact: (request) =>
      Effect.gen(function* () {
        const failed = (error: { readonly message: string }) =>
          new ModelCompactionError({ modelId: request.modelId, reason: error.message })
        const model = yield* request.summaryModel(1_000).pipe(Effect.mapError(failed))
        const text: Array<string> = []
        yield* Stream.runForEach(model.streamText({ prompt: "summarize" }), (part) =>
          Effect.sync(() => {
            if (part.type === "text-delta") text.push(part.delta)
          }),
        ).pipe(Effect.mapError(failed))
        const first = request.history.at(0)?.id ?? "none"
        const last = request.history.at(-1)?.id ?? "none"
        return {
          notice: `Summary:\n${text.join("")}\n(${first} … ${last})`,
          modelId: request.modelId,
        }
      }),
  }),
)

const testCompactorExtension = defineExtension({
  id: "test-compactor",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register(
      "resource",
      defineResource({
        id: "test-compactor/compactor",
        scope: "process",
        layer: rangeCompactorLayer,
      }),
    )
  }),
})

export const e2ePreset = {
  agents: testAgents,
  extensionInputs: [testTurnExtension, testCompactorExtension],
} satisfies Pick<E2ELayerConfig, "agents" | "extensionInputs">
