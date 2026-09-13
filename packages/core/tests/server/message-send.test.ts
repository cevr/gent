import { describe, expect, it } from "effect-bun-test"
import { Effect, Schema } from "effect"
import { textStep } from "../../src/test-utils/sequence-steps"
import { ToolCallId } from "../../src/domain/ids"
import { ModelId } from "../../src/domain/model"
import { AgentName } from "../../src/domain/agent"
import { ConfigService, UserConfig } from "../../src/runtime/config-service"
import { LanguageModelLayers } from "../../src/test-utils/language-model"
import { createE2ELayer } from "../../src/test-utils/e2e-layer"
import { waitFor } from "../../src/test-utils/fixtures"
import { Gent } from "@gent/sdk"
import { e2ePreset } from "../../../extensions/tests/helpers/test-preset"
import { makeClient, parentToolCallProbeExtension } from "./session-mutations/helpers"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

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
