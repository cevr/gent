import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Schema, Stream } from "effect"
import type * as Prompt from "effect/unstable/ai/Prompt"
import { DEFAULT_AGENT_NAME, ExternalDriverRef } from "@gent/core-internal/domain/agent"
import { ExternalToolRunner, type TurnExecutor } from "@gent/core-internal/domain/driver"
import { defineExtension, ExtensionHost } from "@gent/core/extensions/api"
import { messageSingleText } from "@gent/core-internal/domain/message-part-projection"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform"
import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { textStep } from "@gent/core-internal/debug/provider"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
} from "@gent/core-internal/test-utils/language-model"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"
import { buildCellExecutable } from "../runtime/cell-worker-fixture.js"
import { shippedPreset } from "../../../extensions/tests/helpers/test-preset.js"

const platformLayer = Layer.merge(BunServices.layer, BunGentPlatformLive)
const CellResult = Schema.Struct({
  isFailure: Schema.Boolean,
  result: Schema.Struct({ display: Schema.String }),
})

describe.skipIf(process.platform !== "darwin")("external driver cell dispatch", () => {
  it.scopedLive(
    "an external executor runs code through the branch's persistent cell",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const artifact = yield* buildCellExecutable
        // The executor is the second interpreter's replacement: it asks the host for
        // the `cell` tool instead of evaluating code itself.
        const executor: TurnExecutor = {
          executeTurn: () =>
            Stream.fromEffect(
              Effect.gen(function* () {
                const runner = yield* ExternalToolRunner
                const first = yield* runner.runTool("cell", {
                  code: "const kept = 20; kept + 1",
                })
                const second = yield* runner.runTool("cell", {
                  code: "kept + 2",
                })
                return [first, second]
              }),
            ).pipe(
              Stream.flatMap((results) =>
                Stream.fromIterable([
                  textDeltaPart(
                    results
                      .map((part) => Schema.decodeUnknownSync(CellResult)(part).result.display)
                      .join(","),
                  ),
                  finishPart({ finishReason: "stop" }),
                ]),
              ),
            ),
        }
        const ext = defineExtension({
          id: "@test/external-cell",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("externalDriver", {
              id: "test-cell-runner",
              executor,
              invalidate: Effect.void,
            })
          }),
        })
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("unused")])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          providerLayer,
          extensionInputs: [...shippedPreset.extensionInputs, ext],
          extraLayers: [
            Layer.succeed(
              GentPlatform,
              GentPlatform.of({
                ...platform,
                cellWorkerPath: Effect.succeed(artifact.binaryPath),
              }),
            ),
          ],
        })
        // The runtime driver override points the default agent at the external driver.
        yield* client.driver.set({
          agentName: DEFAULT_AGENT_NAME,
          driver: ExternalDriverRef.make({ id: "test-cell-runner" }),
        })
        yield* client.message.send({
          sessionId,
          branchId,
          content: "run through the cell",
        })
        const messages = yield* waitFor(
          client.message.list({ branchId }),
          (list) =>
            list.some(
              (message) =>
                message.role === "assistant" && messageSingleText(message.parts) === "21,22",
            ),
          6_000,
          "external reply from cell results",
        )
        const cellResults = messages
          .flatMap((message) => message.parts)
          .filter((part): part is Prompt.ToolResultPart => part.type === "tool-result")
          .filter((part) => part.name === "cell")
        expect(cellResults).toHaveLength(2)
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platformLayer)),
    18000,
  )
})
