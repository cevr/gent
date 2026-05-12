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
import { Effect, Fiber, Stream } from "effect"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { e2ePreset } from "../helpers/test-preset"

describe("InteractionToolsExtension via model turn", () => {
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

          const toolEventFiber = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter(
              (envelope) =>
                (envelope.event._tag === "ToolCallSucceeded" ||
                  envelope.event._tag === "ToolCallFailed") &&
                (envelope.event as { readonly toolName?: string }).toolName === "ask_user",
            ),
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

          const toolEventFiber = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter(
              (envelope) =>
                (envelope.event._tag === "ToolCallSucceeded" ||
                  envelope.event._tag === "ToolCallFailed") &&
                (envelope.event as { readonly toolName?: string }).toolName === "prompt",
            ),
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

          const toolEventFiber = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter(
              (envelope) =>
                (envelope.event._tag === "ToolCallSucceeded" ||
                  envelope.event._tag === "ToolCallFailed") &&
                (envelope.event as { readonly toolName?: string }).toolName === "prompt",
            ),
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
