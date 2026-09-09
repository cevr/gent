import { describe, expect, it } from "effect-bun-test"
import { Context, Effect, Layer, Schema } from "effect"
import { ExtensionHost, defineExtension, defineResource, request } from "@gent/core/extensions/api"
import { e2ePreset } from "../../../extensions/tests/helpers/test-preset"
import { createRpcHarness } from "../../src/test-utils/rpc-harness"
import { LanguageModelLayers } from "../../src/test-utils/language-model"
import { textStep } from "../../src/debug/provider"
import { ExtensionId } from "../../src/domain/ids"

class BranchCounter extends Context.Service<BranchCounter, { readonly instance: number }>()(
  "@gent/core/tests/runtime/branch-resources.test/BranchCounter",
) {}

describe("branch-scoped resources", () => {
  it.live("builds a branch resource per loop and releases it when the branch closes", () =>
    Effect.gen(function* () {
      const events: Array<string> = []
      let nextInstance = 0

      const extensionId = ExtensionId.make("@gent/tests/branch-resource")
      const readId = "read-branch-instance"

      const BranchResourceExtension = defineExtension({
        id: extensionId,
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            defineResource({
              id: "@gent/tests/branch-resource/counter",
              scope: "branch",
              tag: BranchCounter,
              layer: Layer.effect(
                BranchCounter,
                Effect.acquireRelease(
                  Effect.sync(() => {
                    const instance = ++nextInstance
                    events.push(`acquire:${instance}`)
                    return BranchCounter.of({ instance })
                  }),
                  (service) => Effect.sync(() => events.push(`release:${service.instance}`)),
                ),
              ),
            }),
          )
          yield* host.register(
            "request",
            request({
              id: readId,
              input: Schema.String,
              output: Schema.String,
              execute: () =>
                Effect.gen(function* () {
                  const counter = yield* BranchCounter
                  return `instance:${counter.instance}`
                }),
            }),
          )
        }),
      })

      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
      const { client, sessionId, branchId } = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer,
        extensionInputs: [...e2ePreset.extensionInputs, BranchResourceExtension],
      })

      // The branch resource is live for the running loop, and is the same
      // instance across calls within that branch.
      const first = yield* client.extension.request({
        sessionId,
        branchId,
        extensionId,
        capabilityId: readId,
        input: "read",
      })
      expect(first).toBe("instance:1")
      expect(events).toContain("acquire:1")
      expect(events).not.toContain("release:1")

      const second = yield* client.extension.request({
        sessionId,
        branchId,
        extensionId,
        capabilityId: readId,
        input: "read",
      })
      expect(second).toBe("instance:1")
      expect(nextInstance).toBe(1)
    }).pipe(Effect.scoped),
  )
})
