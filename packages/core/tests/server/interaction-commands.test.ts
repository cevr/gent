import { describe, it, expect } from "effect-bun-test"
import { Cause, Effect, Fiber, Layer, Schema, Stream } from "effect"
// @effect-diagnostics nodeBuiltinImport:off -- mirrors SDK workspace hashing in a restart fixture.
import { createHash } from "node:crypto"
// @effect-diagnostics nodeBuiltinImport:off -- file-backed restart fixture uses a temp SQLite path.
import * as path from "node:path"
import type { LoadedExtension } from "../../src/domain/extension.js"
import { ExtensionId, InteractionRequestId } from "@gent/core-internal/domain/ids"
import { tool, ToolNeeds, type ToolCapabilityContext } from "@gent/core/extensions/api"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { ApprovalService } from "../../src/runtime/approval-service"
import { createE2ELayer } from "@gent/core-internal/test-utils/e2e-layer"
import { createTempDirFixture, waitFor } from "@gent/core-internal/test-utils/fixtures"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { EventStorage } from "@gent/core-internal/storage/event-storage"
import { InteractionStorage } from "@gent/core-internal/storage/interaction-storage"
import { BunPlatformLive } from "../../src/runtime/gent-platform-bun"
import { Gent } from "@gent/sdk"
import { e2ePreset } from "../../../extensions/tests/helpers/test-preset"
import { CurrentWorkspaceId } from "../../src/server/workspace-rpc.js"
import { encodeInteractionDecision } from "../../src/domain/interaction-request.js"

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
        output: Schema.Struct({
          approved: Schema.Boolean,
          notes: Schema.String,
        }),
        execute: Effect.fn("approval_probe")(function* (params, ctx: ToolCapabilityContext) {
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

const tempDir = createTempDirFixture("gent-interaction-")
const currentTestWorkspaceId = () =>
  createHash("sha256").update(path.resolve(process.cwd())).digest("hex")

describe("interaction.respondInteraction", () => {
  it.live(
    "rehydrates one pending interaction after restart and accepts response before explicit actor wake",
    () =>
      Effect.gen(function* () {
        const dbPath = path.join(tempDir(), "gent.db")
        const storageLayer = SqliteStorage.LiveWithSql(dbPath).pipe(Layer.provide(BunPlatformLive))
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
                extraLayers: [Layer.succeed(CurrentWorkspaceId, currentTestWorkspaceId())],
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
                extraLayers: [Layer.succeed(CurrentWorkspaceId, currentTestWorkspaceId())],
              }),
            )
            const eventStorage = yield* EventStorage
            const rehydrated = yield* eventStorage
              .listEvents({
                sessionId: first.sessionId,
                branchId: first.branchId,
                afterId: first.lastEventId,
              })
              .pipe(Effect.provideService(CurrentWorkspaceId, currentTestWorkspaceId()))
            const presentedAgain = rehydrated.filter(
              (envelope) => envelope.event._tag === "InteractionPresented",
            )
            expect(presentedAgain.length).toBe(1)
            expect(presentedAgain[0]?.event._tag).toBe("InteractionPresented")
            if (presentedAgain[0]?.event._tag === "InteractionPresented") {
              expect(presentedAgain[0].event.requestId).toBe(first.requestId)
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
                      JSON.stringify(part.result).includes("after restart"),
                  ),
              ),
            ).toBe(true)
          }).pipe(Effect.timeout("8 seconds")),
        ).pipe(Effect.provide(storageLayer))
      }),
    12_000,
  )

  it.live(
    "recovers a stored decision after restart before actor wake",
    () =>
      Effect.gen(function* () {
        const dbPath = path.join(tempDir(), "gent-decision.db")
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
                extraLayers: [Layer.succeed(CurrentWorkspaceId, currentTestWorkspaceId())],
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
                extraLayers: [Layer.succeed(CurrentWorkspaceId, currentTestWorkspaceId())],
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
                      JSON.stringify(part.result).includes("stored before wake"),
                  ),
              ),
            ).toBe(true)
          }).pipe(Effect.timeout("8 seconds")),
        ).pipe(Effect.provide(storageLayer))
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
                    JSON.stringify(part.result).includes("real approval"),
                ),
            ),
          ).toBe(true)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})
