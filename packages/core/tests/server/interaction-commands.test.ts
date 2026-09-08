import { describe, it, expect } from "effect-bun-test"
import { Cause, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { createHash } from "node:crypto"
import { LoadedArtifactIdentity, type LoadedExtension } from "../../src/domain/extension.js"
import { ExtensionId, InteractionRequestId } from "@gent/core-internal/domain/ids"
import { ExtensionContext, tool } from "@gent/core/extensions/api"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { ApprovalService } from "../../src/runtime/approval-service"
import { createE2ELayer } from "@gent/core-internal/test-utils/e2e-layer"
import { makeTempDirectoryScoped, waitFor } from "@gent/core-internal/test-utils/fixtures"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { InteractionStorage } from "@gent/core-internal/storage/interaction-storage"
import { BunPlatformLive } from "../../src/runtime/gent-platform-bun"
import { Gent } from "@gent/sdk"
import { e2ePreset } from "../../../extensions/tests/helpers/test-preset"
import { CurrentWorkspaceId, WorkspaceId } from "../../src/server/workspace-rpc.js"
import { encodeInteractionDecision } from "../../src/domain/interaction-request.js"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const InteractionProbeExtension: LoadedExtension = {
  manifest: { id: ExtensionId.make("@test/interaction-probe") },
  scope: "builtin",
  sourcePath: "test",
  artifactIdentity: LoadedArtifactIdentity.make("@test/interaction-probe@artifact-1"),
  contributions: {
    tools: [
      tool({
        id: "approval_probe",
        description: "Request approval and report the result",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({
          approved: Schema.Boolean,
          notes: Schema.String,
        }),
        execute: Effect.fn("approval_probe")(function* (params) {
          const ctx = yield* ExtensionContext
          const decision = yield* ctx.Interaction.approve({ text: params.text })
          return {
            approved: decision.approved,
            notes: decision.notes ?? "",
          }
        }),
      }),
    ],
  },
}

const currentTestWorkspaceId = () =>
  WorkspaceId.make(createHash("sha256").update(process.cwd()).digest("hex"))

describe("interaction.respondInteraction", () => {
  it.scopedLive(
    "rehydrates one pending interaction after restart and accepts response before explicit actor wake",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDirectoryScoped("gent-interaction-")
        const dbPath = `${tempDir}/gent.db`
        const finalReply = "approval resumed after restart"
        const firstProvider = yield* LanguageModelLayers.sequence([
          toolCallStep("approval_probe", { text: "approve deploy?" }),
        ])
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* Gent.test(
              createE2ELayer({
                ...e2ePreset,
                providerLayer: firstProvider.layer,
                extensions: [InteractionProbeExtension],
                durableApproval: true,
                storagePath: dbPath,
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
            const presented = interactions[0]
            expect(presented?.event._tag).toBe("InteractionPresented")
            if (presented?.event._tag !== "InteractionPresented") {
              return yield* Effect.die(new Error("interaction was not presented"))
            }

            yield* waitFor(
              client.session.getSnapshot({ sessionId, branchId }),
              (current) => current.runtime._tag === "WaitingForInteraction",
              5_000,
              "waiting interaction runtime state before restart",
            )
            const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
            return {
              sessionId,
              branchId,
              requestId: presented.event.requestId,
              lastEventId: snapshot.lastEventId ?? 0,
            }
          }).pipe(Effect.timeout("8 seconds")),
        )

        const secondProvider = yield* LanguageModelLayers.sequence([textStep(finalReply)])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* Gent.test(
              createE2ELayer({
                ...e2ePreset,
                providerLayer: secondProvider.layer,
                extensions: [InteractionProbeExtension],
                durableApproval: true,
                storagePath: dbPath,
              }),
            )
            const rehydrated = Array.from(
              yield* client.session
                .events({
                  sessionId: first.sessionId,
                  branchId: first.branchId,
                  after: first.lastEventId,
                })
                .pipe(
                  Stream.filter((envelope) => envelope.event._tag === "InteractionPresented"),
                  Stream.take(1),
                  Stream.runCollect,
                ),
            )
            expect(rehydrated.length).toBe(1)
            expect(rehydrated[0]?.event._tag).toBe("InteractionPresented")
            if (rehydrated[0]?.event._tag === "InteractionPresented") {
              expect(rehydrated[0].event.requestId).toBe(first.requestId)
            }
            yield* client.interaction.respondInteraction({
              sessionId: first.sessionId,
              branchId: first.branchId,
              requestId: first.requestId,
              approved: true,
              notes: "after restart",
            })

            const snapshot = yield* waitFor(
              client.session.getSnapshot({
                sessionId: first.sessionId,
                branchId: first.branchId,
              }),
              (current) =>
                current.messages.some(
                  (message) =>
                    message.role === "assistant" &&
                    message.parts.some((part) => part.type === "text" && part.text === finalReply),
                ),
              5_000,
              "assistant reply after restarted interaction response",
            )

            expect(
              snapshot.messages.some(
                (message) =>
                  message.role === "tool" &&
                  message.parts.some(
                    (part) =>
                      part.type === "tool-result" &&
                      encodeJson(part.result).includes("after restart"),
                  ),
              ),
            ).toBe(true)
          }).pipe(Effect.timeout("8 seconds")),
        )
      }),
    12_000,
  )

  it.scopedLive(
    "recovers a stored decision after restart before actor wake",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDirectoryScoped("gent-interaction-")
        const dbPath = `${tempDir}/gent-decision.db`
        const storageLayer = SqliteStorage.LiveWithSql(dbPath).pipe(Layer.provide(BunPlatformLive))
        const finalReply = "approval resumed from stored decision"
        const firstProvider = yield* LanguageModelLayers.sequence([
          toolCallStep("approval_probe", { text: "approve deploy?" }),
        ])
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* Gent.test(
              createE2ELayer({
                ...e2ePreset,
                providerLayer: firstProvider.layer,
                extensions: [InteractionProbeExtension],
                durableApproval: true,
                storagePath: dbPath,
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
            if (presented?._tag !== "InteractionPresented") {
              return yield* Effect.die(new Error("interaction was not presented"))
            }

            yield* waitFor(
              client.session.getSnapshot({ sessionId, branchId }),
              (current) => current.runtime._tag === "WaitingForInteraction",
              5_000,
              "waiting interaction runtime state before stored decision",
            )
            return {
              sessionId,
              branchId,
              requestId: presented.requestId,
            }
          }).pipe(Effect.timeout("8 seconds")),
        )
        yield* Effect.gen(function* () {
          const storage = yield* InteractionStorage
          const decisionJson = yield* encodeInteractionDecision({
            approved: true,
            notes: "stored before wake",
          })
          yield* storage.decide(first.requestId, decisionJson)
        }).pipe(
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          Effect.provide(storageLayer),
          Effect.provideService(CurrentWorkspaceId, currentTestWorkspaceId()),
        )

        const secondProvider = yield* LanguageModelLayers.sequence([textStep(finalReply)])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* Gent.test(
              createE2ELayer({
                ...e2ePreset,
                providerLayer: secondProvider.layer,
                extensions: [InteractionProbeExtension],
                durableApproval: true,
                storagePath: dbPath,
              }),
            )

            const snapshot = yield* waitFor(
              client.session.getSnapshot({
                sessionId: first.sessionId,
                branchId: first.branchId,
              }),
              (current) =>
                current.messages.some(
                  (message) =>
                    message.role === "assistant" &&
                    message.parts.some((part) => part.type === "text" && part.text === finalReply),
                ),
              5_000,
              "assistant reply after stored interaction decision recovery",
            )

            expect(
              snapshot.messages.some(
                (message) =>
                  message.role === "tool" &&
                  message.parts.some(
                    (part) =>
                      part.type === "tool-result" &&
                      encodeJson(part.result).includes("stored before wake"),
                  ),
              ),
            ).toBe(true)
          }).pipe(Effect.timeout("8 seconds")),
        )
      }),
    12_000,
  )

  it.live(
    "rejects stale request ids without consuming the pending interaction",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const finalReply = "approval resumed after stale response"
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
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

          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "WaitingForInteraction",
            5_000,
            "waiting interaction runtime state before stale response",
          )

          const staleExit = yield* Effect.exit(
            client.interaction.respondInteraction({
              sessionId,
              branchId,
              requestId: InteractionRequestId.make("req-stale-rpc-1"),
              approved: false,
              notes: "wrong dialog",
            }),
          )
          expect(staleExit._tag).toBe("Failure")
          if (staleExit._tag === "Failure") {
            expect(Cause.pretty(staleExit.cause)).toContain("InteractionRequestMismatchError")
          }

          const parked = yield* client.session.getSnapshot({ sessionId, branchId })
          expect(parked.runtime._tag).toBe("WaitingForInteraction")

          yield* client.interaction.respondInteraction({
            sessionId,
            branchId,
            requestId: presented.requestId,
            approved: true,
            notes: "real approval",
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
            "assistant reply after correct interaction response",
          )

          expect(
            snapshot.messages.some(
              (message) =>
                message.role === "tool" &&
                message.parts.some(
                  (part) =>
                    part.type === "tool-result" &&
                    encodeJson(part.result).includes("real approval"),
                ),
            ),
          ).toBe(true)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})
