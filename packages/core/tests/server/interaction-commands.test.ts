import { describe, it, expect } from "effect-bun-test"
import { Effect, Fiber, Schema, Stream } from "effect"
import type { LoadedExtension } from "../../src/domain/extension.js"
import { ExtensionId } from "@gent/core/domain/ids"
import { tool, ToolNeeds } from "@gent/core/extensions/api"
import { textStep, toolCallStep } from "@gent/core/debug/provider"
import { Provider } from "@gent/core/providers/provider"
import { ApprovalService } from "../../src/runtime/approval-service"
import { createE2ELayer } from "@gent/core/test-utils/e2e-layer"
import { waitFor } from "@gent/core/test-utils/fixtures"
import { Gent } from "@gent/sdk"
import { e2ePreset } from "../extensions/helpers/test-preset"

const InteractionProbeExtension: LoadedExtension = {
  manifest: { id: ExtensionId.make("@test/interaction-probe") },
  scope: "builtin",
  sourcePath: "test",
  contributions: {
    tools: [
      tool({
        id: "approval_probe",
        description: "Request approval and report the result",
        needs: [ToolNeeds.write("interaction")],
        params: Schema.Struct({ text: Schema.String }),
        execute: Effect.fn("approval_probe")(function* (params, ctx) {
          const decision = yield* ctx.interaction.approve({ text: params.text })
          return {
            approved: decision.approved,
            notes: decision.notes ?? "",
          }
        }),
      }),
    ],
  },
}

describe("interaction.respondInteraction", () => {
  it.live(
    "resumes a parked tool turn through the public RPC contract",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const finalReply = "approval resumed"
          const { layer: providerLayer } = yield* Provider.Sequence([
            toolCallStep("approval_probe", { text: "approve deploy?" }),
            textStep(finalReply),
          ])
          const { client } = yield* Gent.test(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [InteractionProbeExtension],
              approvalLayer: ApprovalService.Live,
            }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
          const interactionFiber = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter((envelope) => envelope.event._tag === "InteractionPresented"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "run approval probe",
          })

          const interactions = Array.from(yield* Fiber.join(interactionFiber))
          const presented = interactions[0]?.event
          expect(presented?._tag).toBe("InteractionPresented")
          if (presented?._tag !== "InteractionPresented") return
          expect(presented.text).toBe("approve deploy?")

          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "WaitingForInteraction",
            5_000,
            "waiting interaction runtime state",
          )

          yield* client.interaction.respondInteraction({
            sessionId,
            branchId,
            requestId: presented.requestId,
            approved: true,
            notes: "ship it",
          })

          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.parts.some((part) => part.type === "text" && part.text === finalReply),
              ),
            5_000,
            "assistant reply after interaction response",
          )

          expect(
            snapshot.messages.some(
              (message) =>
                message.role === "tool" &&
                message.parts.some(
                  (part) =>
                    part.type === "tool-result" &&
                    JSON.stringify(part.output.value).includes("ship it"),
                ),
            ),
          ).toBe(true)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})
