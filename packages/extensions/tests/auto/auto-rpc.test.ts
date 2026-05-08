/**
 * Auto RPC acceptance test — exercises typed requests through the same
 * per-request scope boundary production uses.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { textStep } from "@gent/core-internal/debug/provider"
import { ref } from "@gent/core/extensions/api"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { AutoExtension } from "@gent/extensions/auto"
import { AutoRpc } from "@gent/extensions/auto/protocol"
import { e2ePreset } from "../helpers/test-preset"

const StartAutoRef = ref(AutoRpc.StartAuto)
const CancelAutoRef = ref(AutoRpc.CancelAuto)
const IsActiveRef = ref(AutoRpc.IsActive)
const SnapshotRef = ref(AutoRpc.GetSnapshot)

describe("AutoExtension via RPC", () => {
  it.live("StartAuto, IsActive, GetSnapshot, and CancelAuto round-trip", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          extensionInputs: [AutoExtension],
        })

        yield* client.extension.request({
          sessionId,
          branchId,
          extensionId: StartAutoRef.extensionId,
          capabilityId: StartAutoRef.capabilityId,
          intent: StartAutoRef.intent,
          input: { goal: "Audit extension API", maxIterations: 3 },
        })

        const active = yield* client.extension.request({
          sessionId,
          branchId,
          extensionId: IsActiveRef.extensionId,
          capabilityId: IsActiveRef.capabilityId,
          intent: IsActiveRef.intent,
          input: {},
        })
        expect(active).toBe(true)

        const snapshot = (yield* client.extension.request({
          sessionId,
          branchId,
          extensionId: SnapshotRef.extensionId,
          capabilityId: SnapshotRef.capabilityId,
          intent: SnapshotRef.intent,
          input: {},
        })) as { readonly active: boolean; readonly phase?: string; readonly goal?: string }
        expect(snapshot).toMatchObject({
          active: true,
          phase: "working",
          goal: "Audit extension API",
        })

        yield* client.extension.request({
          sessionId,
          branchId,
          extensionId: CancelAutoRef.extensionId,
          capabilityId: CancelAutoRef.capabilityId,
          intent: CancelAutoRef.intent,
          input: {},
        })

        const afterCancel = yield* client.extension.request({
          sessionId,
          branchId,
          extensionId: IsActiveRef.extensionId,
          capabilityId: IsActiveRef.capabilityId,
          intent: IsActiveRef.intent,
          input: {},
        })
        expect(afterCancel).toBe(false)
      }).pipe(Effect.timeout("8 seconds")),
    ),
  )
})
