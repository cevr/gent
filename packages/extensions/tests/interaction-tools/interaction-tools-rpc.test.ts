/**
 * Interaction-tools RPC acceptance test — exercises the `ask_user` and
 * `prompt` tools through real agent turns (LLM emits the tool call, runtime
 * dispatches it inside the per-request scope and through the ApprovalService
 * Test stub which auto-approves). The existing tool-level tests bypass the
 * scope boundary production uses.
 *
 * Both tools route through `ExtensionContext.Interaction`, which is the
 * highest scope-leak risk surface — Approval is yielded inside the executor
 * and the result must survive across the per-request scope edge.
 *
 * Maps W37 S6 C14 (audit L5-P1-2).
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, FileSystem, Schema, Stream } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { RuntimeEnvironment } from "@gent/core-internal/runtime/runtime-environment"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { e2ePreset, shippedPreset } from "../helpers/test-preset"
import { isToolResultFor } from "../helpers/tool-event.js"

describe("InteractionToolsExtension via model turn", () => {
  it.scopedLive(
    "presents durable information without suspending the cell for an answer",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", {
            code: 'await tools.call("prompt", {mode:"present", title:"Notice", content:"INFORMATION-SHOWN"}); console.log("CELL-CONTINUED")',
          }),
          textStep("done"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          providerLayer,
          durableApproval: true,
        })
        const events = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.takeUntil(({ event }) => event._tag === "TurnCompleted"),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* client.message.send({ sessionId, branchId, content: "Present the notice" })
        const received = Array.from(yield* Fiber.join(events)).map(({ event }) => event)
        expect(received.some((event) => event._tag === "InteractionPresented")).toBe(false)
        expect(
          received.some(
            (event) =>
              event._tag === "ToolCallSucceeded" &&
              event.toolName === "cell" &&
              event.output?.includes("CELL-CONTINUED"),
          ),
        ).toBe(true)
        expect(
          received.some(
            (event) =>
              event._tag === "MessageReceived" &&
              event.message.metadata?.hidden === true &&
              event.message.parts.some(
                (part) => part.type === "text" && part.text.includes("INFORMATION-SHOWN"),
              ),
          ),
        ).toBe(true)
      }).pipe(Effect.timeout("8 seconds")),
    10_000,
  )

  it.scopedLive.layer(BunFileSystem.layer)(
    "review saves edited reply content through RPC, including an empty document",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "gent-review-reply-" })
        for (const editedContent of ["Updated review\n", ""]) {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("prompt", {
              mode: "review",
              content: "Original review",
              title: "Editable review",
            }),
            textStep("review saved"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            durableApproval: true,
            cwd,
            extraLayers: [RuntimeEnvironment.Test({ cwd, home: cwd, platform: "test" })],
          })
          const interaction = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter((envelope) => envelope.event._tag === "InteractionPresented"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          )
          const result = yield* client.session
            .events({ sessionId, branchId })
            .pipe(
              Stream.filter(isToolResultFor("prompt")),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            )
          yield* client.message.send({ sessionId, branchId, content: "Review this document" })
          const presented = Array.from(yield* Fiber.join(interaction))[0]?.event
          if (presented?._tag !== "InteractionPresented")
            return yield* Effect.die("Missing review interaction")
          yield* client.interaction.respondInteraction({
            sessionId,
            branchId,
            requestId: presented.requestId,
            approved: true,
            notes: "edit",
            editedContent,
          })
          const completed = Array.from(yield* Fiber.join(result))[0]?.event
          if (completed?._tag !== "ToolCallSucceeded")
            return yield* Effect.die("Review did not succeed")
          const output = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({
                decision: Schema.Literal("edit"),
                path: Schema.String,
                content: Schema.String,
              }),
            ),
          )(completed.output)
          expect(output.content).toBe(editedContent)
          expect(output.path.startsWith(`${cwd}/`)).toBe(true)
          expect(yield* fs.readFileString(output.path)).toBe(editedContent)
        }
      }).pipe(Effect.timeout("12 seconds")),
  )

  it.live(
    "ask_user tool call routes through per-request scope and auto-approves via Test ApprovalService",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("ask_user", {
              questions: [
                {
                  question: "What's your favorite color?",
                  header: "color",
                },
              ],
            }),
            textStep("asked"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })

          const toolEventFiber = yield* client.session
            .events({ sessionId, branchId })
            .pipe(
              Stream.filter(isToolResultFor("ask_user")),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "ask me a question",
          })

          const events = Array.from(yield* Fiber.join(toolEventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain("answers")
          }
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "prompt tool (confirm mode) routes through per-request scope and auto-approves via Test ApprovalService",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("prompt", {
              mode: "confirm",
              content: "Proceed with the migration?",
              title: "Confirm migration",
            }),
            textStep("confirmed"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })

          const toolEventFiber = yield* client.session
            .events({ sessionId, branchId })
            .pipe(
              Stream.filter(isToolResultFor("prompt")),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "confirm something",
          })

          const events = Array.from(yield* Fiber.join(toolEventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain('"mode": "confirm"')
            expect(succeeded.event.output).toContain('"decision": "yes"')
          }
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "prompt tool (review mode) routes through per-request scope, writes a file, and auto-approves",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("prompt", {
              mode: "review",
              content: "# Plan\n\nMigrate the actor mailbox to bounded queues.",
              title: "Migration plan",
            }),
            textStep("reviewed"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })

          const toolEventFiber = yield* client.session
            .events({ sessionId, branchId })
            .pipe(
              Stream.filter(isToolResultFor("prompt")),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "review the plan",
          })

          const events = Array.from(yield* Fiber.join(toolEventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain('"mode": "review"')
            expect(succeeded.event.output).toContain('"decision": "yes"')
            expect(succeeded.event.output).toContain(".gent/prompts/")
          }
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )
})
