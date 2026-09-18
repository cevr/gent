import { describe, expect, it } from "effect-bun-test"
import { Effect, Option, Schema } from "effect"
import { textStep } from "../../src/test-utils/sequence-steps"
import { ToolCallId } from "../../src/domain/ids"
import { AgentName, ModelId, type ReasoningEffort } from "../../src/domain/agent"
import { ConfigService, UserConfig } from "../../src/runtime/config"
import { LanguageModelLayers } from "../../src/test-utils/language-model"
import { createE2ELayer } from "../../src/test-utils/e2e-layer"
import { waitFor } from "../../src/test-utils/fixtures"
import { Gent } from "@gent/sdk"
import { e2ePreset } from "../../../extensions/tests/helpers/test-preset"
import { makeClient, parentToolCallProbeExtension } from "./session-mutations/helpers"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const absentModel = Option.getOrUndefined(Option.none<ModelId>())
const absentReasoning = Option.getOrUndefined(Option.none<ReasoningEffort>())

describe("message.send", () => {
  it.live(
    "persists the user message and assistant reply through the public snapshot contract",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const userText = "hello from acceptance"
          const assistantText = "acceptance reply"
          const { client } = yield* makeClient(assistantText)
          const created = yield* client.session.create({ cwd: process.cwd() })

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: userText,
          })

          const snapshot = yield* waitFor(
            client.session.getSnapshot({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (current) =>
              current.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.parts.some((part) => part.type === "text" && part.text === assistantText),
              ),
            5_000,
            "assistant reply in session snapshot",
          )

          expect(
            snapshot.messages.some(
              (message) =>
                message.role === "user" &&
                message.parts.some((part) => part.type === "text" && part.text === userText),
            ),
          ).toBe(true)
          expect(
            snapshot.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.parts.some((part) => part.type === "text" && part.text === assistantText),
            ),
          ).toBe(true)
        }).pipe(Effect.timeout("4 seconds")),
      ),
  )

  it.live("applies runSpec overrides through the public message contract", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const assistantText = "runSpec acceptance reply"
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          {
            ...textStep(assistantText),
            assertRequest: (request) => {
              expect(request.model).toBe("custom/model")
              expect(request.reasoning).toBe("high")
            },
          },
        ])
        const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
        const created = yield* client.session.create({ cwd: process.cwd() })

        yield* client.message.send({
          sessionId: created.sessionId,
          branchId: created.branchId,
          content: "use run spec",
          runSpec: {
            overrides: {
              modelId: ModelId.make("custom/model"),
              reasoningEffort: "high",
              systemPromptAddendum: "Extra public contract instructions",
            },
          },
        })

        const snapshot = yield* waitFor(
          client.session.getSnapshot({
            sessionId: created.sessionId,
            branchId: created.branchId,
          }),
          (current) =>
            current.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.parts.some((part) => part.type === "text" && part.text === assistantText),
            ),
          5_000,
          "assistant reply from runSpec turn",
        )

        expect(
          snapshot.messages.some(
            (message) =>
              message.role === "assistant" &&
              message.parts.some((part) => part.type === "text" && part.text === assistantText),
          ),
        ).toBe(true)
        yield* controls.assertDone
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("config agent overrides set the model and effort, and a runSpec still wins", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          {
            ...textStep("configured reply"),
            assertRequest: (request) => {
              expect(request.model).toBe("openai/gpt-5.6-sol")
              expect(request.reasoning).toBe("low")
            },
          },
          {
            ...textStep("run spec reply"),
            assertRequest: (request) => {
              expect(request.model).toBe("custom/model")
              expect(request.reasoning).toBe("low")
            },
          },
        ])
        const configServiceLayer = ConfigService.Test(
          new UserConfig({
            agents: {
              [AgentName.make("main")]: {
                modelId: ModelId.make("openai/gpt-5.6-sol"),
                reasoningEffort: "low",
              },
            },
          }),
        )
        const { client } = yield* Gent.test(
          createE2ELayer({ ...e2ePreset, providerLayer, configServiceLayer }),
        )
        const created = yield* client.session.create({ cwd: process.cwd() })
        const replied = (text: string) =>
          waitFor(
            client.session.getSnapshot({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (current) =>
              current.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.parts.some((part) => part.type === "text" && part.text === text),
              ),
            5_000,
            `assistant reply: ${text}`,
          )

        yield* client.message.send({
          sessionId: created.sessionId,
          branchId: created.branchId,
          content: "use the configured model",
        })
        yield* replied("configured reply")

        yield* client.message.send({
          sessionId: created.sessionId,
          branchId: created.branchId,
          content: "use the run spec model",
          runSpec: { overrides: { modelId: ModelId.make("custom/model") } },
        })
        yield* replied("run spec reply")
        yield* controls.assertDone
      }).pipe(Effect.timeout("6 seconds")),
    ),
  )

  it.live("session settings win over config agent overrides until they are cleared", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          {
            ...textStep("session model reply"),
            assertRequest: (request) => {
              expect(request.model).toBe("custom/session-model")
              expect(request.reasoning).toBe("max")
            },
          },
          {
            ...textStep("configured reply"),
            assertRequest: (request) => {
              expect(request.model).toBe("openai/gpt-5.6-sol")
              expect(request.reasoning).toBe("low")
            },
          },
        ])
        const configServiceLayer = ConfigService.Test(
          new UserConfig({
            agents: {
              [AgentName.make("main")]: {
                modelId: ModelId.make("openai/gpt-5.6-sol"),
                reasoningEffort: "low",
              },
            },
          }),
        )
        const { client } = yield* Gent.test(
          createE2ELayer({ ...e2ePreset, providerLayer, configServiceLayer }),
        )
        const created = yield* client.session.create({ cwd: process.cwd() })
        const replied = (text: string) =>
          waitFor(
            client.session.getSnapshot({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (current) =>
              current.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.parts.some((part) => part.type === "text" && part.text === text),
              ),
            5_000,
            `assistant reply: ${text}`,
          )
        // Before any setting or turn, the snapshot already resolves the config default.
        const fresh = yield* client.session.getSnapshot({
          sessionId: created.sessionId,
          branchId: created.branchId,
        })
        expect(fresh.resolvedModelId).toBe(ModelId.make("openai/gpt-5.6-sol"))
        expect(fresh.resolvedReasoningLevel).toBe("low")

        const sessionModel = ModelId.make("custom/session-model")
        const stored = yield* client.session.updateSettings({
          sessionId: created.sessionId,
          modelId: sessionModel,
          reasoningLevel: "max",
        })
        expect(stored).toEqual({ modelId: sessionModel, reasoningLevel: "max" })
        const withSettings = yield* client.session.getSnapshot({
          sessionId: created.sessionId,
          branchId: created.branchId,
        })
        expect(withSettings.modelId).toBe(sessionModel)
        expect(withSettings.reasoningLevel).toBe("max")
        expect(withSettings.resolvedModelId).toBe(sessionModel)
        expect(withSettings.resolvedReasoningLevel).toBe("max")

        yield* client.message.send({
          sessionId: created.sessionId,
          branchId: created.branchId,
          content: "use the session model",
        })
        yield* replied("session model reply")

        yield* client.session.updateSettings({
          sessionId: created.sessionId,
          modelId: absentModel,
          reasoningLevel: absentReasoning,
        })
        // Cleared settings resolve back to the config default before the next turn.
        const cleared = yield* client.session.getSnapshot({
          sessionId: created.sessionId,
          branchId: created.branchId,
        })
        expect(cleared.resolvedModelId).toBe(ModelId.make("openai/gpt-5.6-sol"))
        expect(cleared.resolvedReasoningLevel).toBe("low")
        yield* client.message.send({
          sessionId: created.sessionId,
          branchId: created.branchId,
          content: "back to the configured model",
        })
        yield* replied("configured reply")
        yield* controls.assertDone
      }).pipe(Effect.timeout("6 seconds")),
    ),
  )

  it.live(
    "a model change leaves a durable notice the next turn reads; an effort change does not",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
            {
              ...textStep("after the switch"),
              assertOptions: (options) => {
                expect(encodeJson(options.prompt)).toContain(
                  "[model changed: the turns above were generated by the default model; the session continues with custom/next-model]",
                )
              },
            },
          ])
          const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
          const created = yield* client.session.create({ cwd: process.cwd() })
          const notices = () =>
            client.session
              .getSnapshot({ sessionId: created.sessionId, branchId: created.branchId })
              .pipe(
                Effect.map((snapshot) =>
                  snapshot.messages.filter(
                    (message) => message.metadata?.customType === "model-change",
                  ),
                ),
              )
          yield* client.session.updateSettings({
            sessionId: created.sessionId,
            modelId: absentModel,
            reasoningLevel: "low",
          })
          expect(yield* notices()).toHaveLength(0)
          yield* client.session.updateSettings({
            sessionId: created.sessionId,
            modelId: ModelId.make("custom/next-model"),
            reasoningLevel: "low",
          })
          const [notice] = yield* notices()
          expect(notice?.role).toBe("user")
          yield* client.session.updateSettings({
            sessionId: created.sessionId,
            modelId: ModelId.make("custom/next-model"),
            reasoningLevel: "max",
          })
          expect(yield* notices()).toHaveLength(1)
          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "hello",
          })
          yield* waitFor(
            client.session.getSnapshot({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (current) =>
              current.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.parts.some(
                    (part) => part.type === "text" && part.text === "after the switch",
                  ),
              ),
            5_000,
            "assistant reply after the switch",
          )
          yield* controls.assertDone
        }).pipe(Effect.timeout("6 seconds")),
      ),
  )

  it.live("threads runSpec parentToolCallId through the public message contract", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const assistantText = "parent tool call acceptance reply"
        const parentToolCallId = ToolCallId.make("tc-parent-acceptance")
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          {
            ...textStep(assistantText),
            assertOptions: (options) => {
              expect(encodeJson(options.prompt)).toContain(`parentToolCallId:${parentToolCallId}`)
            },
          },
        ])
        const { client } = yield* Gent.test(
          createE2ELayer({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [],
            extensions: [parentToolCallProbeExtension],
          }),
        )
        const created = yield* client.session.create({ cwd: process.cwd() })

        yield* client.message.send({
          sessionId: created.sessionId,
          branchId: created.branchId,
          content: "thread parent tool call id",
          runSpec: { parentToolCallId },
        })

        yield* waitFor(
          client.session.getSnapshot({
            sessionId: created.sessionId,
            branchId: created.branchId,
          }),
          (current) =>
            current.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.parts.some((part) => part.type === "text" && part.text === assistantText),
            ),
          5_000,
          "assistant reply from parentToolCallId turn",
        )

        yield* controls.assertDone
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("rejects a deleted session before provider dispatch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          textStep("should not run"),
        ])
        const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
        const created = yield* client.session.create({ cwd: process.cwd() })

        yield* client.session.delete({ sessionId: created.sessionId })

        const exit = yield* Effect.exit(
          client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "deleted session",
          }),
        )

        expect(exit._tag).toBe("Failure")
        expect(yield* controls.callCount).toBe(0)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
})
