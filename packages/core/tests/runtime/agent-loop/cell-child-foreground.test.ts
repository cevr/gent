import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Predicate, Stream } from "effect"
import { AgentDefinition, DEFAULT_AGENT_NAME } from "../../../src/domain/agent"
import { ExtensionHost, defineExtension } from "@gent/core/extensions/api"
import { DelegateExtension } from "../../../../extensions/src/delegate/delegate-tool.js"
import { LoadedArtifactIdentity } from "../../../src/domain/extension"
import { messageSingleText } from "../../../src/domain/message-part-projection"
import { CellTool } from "../../../src/runtime/code-cell/cell-tool"
import { GentPlatform } from "../../../src/runtime/gent-platform"
import { BunGentPlatformLive } from "../../../src/runtime/gent-platform-bun"
import { createRpcHarness } from "../../../src/test-utils/rpc-harness"
import { LanguageModelLayers } from "../../../src/test-utils/language-model"
import { textStep, toolCallStep } from "../../../src/debug/provider"
import { buildCellExecutable } from "../cell-worker-fixture.js"
import { waitFor } from "../../../src/test-utils/fixtures"

const platformLayer = Layer.merge(BunServices.layer, BunGentPlatformLive)

describe.skipIf(process.platform !== "darwin")("foreground child cell", () => {
  it.scopedLive(
    "a child delegated from a cell runs its own cell instead of refusing as a nested outer cell",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const artifact = yield* buildCellExecutable
        // The shared model queue serves the parent turn, then the child's
        // turn admitted from inside the parent's cell operation.
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", {
            code: "const r = await tools.call('delegate', { todo: 'compute' }); r._tag === 'completed' && r.output.includes('child says 2') && r.metadata.toolCalls.length === 1 && r.metadata.toolCalls[0].toolName === 'cell' && r.metadata.toolCalls[0].isError === false",
          }),
          toolCallStep("cell", { code: "1 + 1" }),
          textStep("child says 2"),
          textStep("done"),
        ])
        const fixture = defineExtension({
          id: "cell-child-foreground-fixture",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("agent", new AgentDefinition({ name: DEFAULT_AGENT_NAME }))
            yield* host.register("tool", CellTool)
          }),
        })
        const { client, sessionId, branchId } = yield* createRpcHarness({
          providerLayer,
          agents: [],
          extensionInputs: [
            {
              ...fixture,
              artifactIdentity: LoadedArtifactIdentity.make("cell-child-foreground-source"),
            },
            {
              ...DelegateExtension,
              artifactIdentity: LoadedArtifactIdentity.make("delegate-source"),
            },
          ],
          subagentRunner: "live",
          extraLayers: [
            Layer.succeed(
              GentPlatform,
              GentPlatform.of({
                ...platform,
                siblingBinaryPath: () => Effect.succeed(artifact.binaryPath),
              }),
            ),
          ],
        })
        const content = "delegate from a cell"
        yield* client.message.send({ sessionId, branchId, content })
        const messages = yield* waitFor(client.message.list({ branchId }), (items) =>
          items.some((item) => item.role === "user" && messageSingleText(item.parts) === content),
        )
        const user = messages.find(
          (item) => item.role === "user" && messageSingleText(item.parts) === content,
        )
        if (Predicate.isUndefined(user)) return yield* Effect.die("Missing parent message")
        yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter(
            (envelope) =>
              envelope.event._tag === "TurnCompleted" && envelope.event.messageId === user.id,
          ),
          Stream.take(1),
          Stream.runDrain,
        )
        const completed = yield* client.message.list({ branchId })
        const results = completed
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool-result" && part.name === "cell")
        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({ isFailure: false, result: { display: "true" } })
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platformLayer)),
    20000,
  )
})
