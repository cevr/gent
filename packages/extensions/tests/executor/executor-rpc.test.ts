/**
 * Executor RPC acceptance test — locks the public request boundary without
 * starting the real sidecar.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { textStep } from "@gent/core-internal/debug/provider"
import { ref, withReadOnly, type TurnProjection } from "@gent/core/extensions/api"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { ExecutorExtension, EXECUTOR_EXTENSION_ID } from "../../src/executor/index.js"
import { ExecutorRead, ExecutorRuntime, ExecutorWrite } from "../../src/executor/controller.js"
import { ExecutorRpc } from "../../src/executor/protocol.js"
import { e2ePreset } from "../helpers/test-preset"

const StartRef = ref(ExecutorRpc.Start)
const StopRef = ref(ExecutorRpc.Stop)
const SnapshotRef = ref(ExecutorRpc.GetSnapshot)

describe("ExecutorExtension via RPC", () => {
  it.live("Start, GetSnapshot, and Stop use the request boundary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connectedCwds: string[] = []
        const fakeRuntime = {
          snapshot: () =>
            Effect.succeed({
              status: "ready" as const,
              baseUrl: "http://127.0.0.1:4788",
              executorPrompt: "Use tools.describe before calls.",
            }),
          connect: (cwd: string) =>
            Effect.sync(() => {
              connectedCwds.push(cwd)
            }),
          disconnect: () => Effect.sync(() => connectedCwds.push("disconnected")),
          turnProjection: () => Effect.succeed({} satisfies TurnProjection),
        }
        const executorLayer = Layer.mergeAll(
          Layer.succeed(ExecutorRuntime, fakeRuntime),
          Layer.succeed(ExecutorWrite, fakeRuntime),
          Layer.succeed(ExecutorRead, withReadOnly({ snapshot: fakeRuntime.snapshot })),
        )
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          extensionInputs: [ExecutorExtension],
          cwd: "/tmp/gent-executor-rpc",
          layerOverrides: {
            ...e2ePreset.layerOverrides,
            [EXECUTOR_EXTENSION_ID]: () => executorLayer,
          },
        })

        yield* client.extension.request({
          sessionId,
          branchId,
          extensionId: StartRef.extensionId,
          capabilityId: StartRef.capabilityId,
          intent: StartRef.intent,
          input: "start",
        })

        const snapshot = (yield* client.extension.request({
          sessionId,
          branchId,
          extensionId: SnapshotRef.extensionId,
          capabilityId: SnapshotRef.capabilityId,
          intent: SnapshotRef.intent,
          input: {},
        })) as {
          readonly status: string
          readonly baseUrl?: string
          readonly executorPrompt?: string
        }
        expect(snapshot).toMatchObject({
          status: "ready",
          baseUrl: "http://127.0.0.1:4788",
          executorPrompt: "Use tools.describe before calls.",
        })

        yield* client.extension.request({
          sessionId,
          branchId,
          extensionId: StopRef.extensionId,
          capabilityId: StopRef.capabilityId,
          intent: StopRef.intent,
          input: "stop",
        })

        expect(connectedCwds).toEqual(["/tmp/gent-executor-rpc", "disconnected"])
      }).pipe(Effect.timeout("8 seconds")),
    ),
  )
})
