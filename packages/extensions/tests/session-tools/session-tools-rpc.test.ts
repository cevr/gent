import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Stream } from "effect"
import type { EventEnvelope } from "@gent/core-internal/domain/event"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { AgentsExtension, SessionToolsExtension } from "../../src/index.js"
import { e2ePreset } from "../helpers/test-preset"

const toolEventsFor = <E>(stream: Stream.Stream<EventEnvelope, E>, toolName: string) =>
  stream.pipe(
    Stream.filter(
      (envelope) =>
        (envelope.event._tag === "ToolCallStarted" ||
          envelope.event._tag === "ToolCallSucceeded" ||
          envelope.event._tag === "ToolCallFailed") &&
        (envelope.event as { readonly toolName?: string }).toolName === toolName,
    ),
    Stream.take(2),
    Stream.runCollect,
    Effect.forkScoped,
  )

describe("Session tools via model turn", () => {
  it.live(
    "read_session uses the request-scoped session host facet",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("read_session", { sessionId: "missing-session-tools-rpc" }),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [AgentsExtension, SessionToolsExtension],
          })
          const eventFiber = yield* toolEventsFor(
            client.session.events({ sessionId, branchId }),
            "read_session",
          )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "Read this session",
          })

          const events = Array.from(yield* Fiber.join(eventFiber))
          const failed = events.find((event) => event.event._tag === "ToolCallFailed")
          expect(failed?.event._tag).toBe("ToolCallFailed")
          if (failed?.event._tag === "ToolCallFailed") {
            expect(failed.event.output).toContain("Failed to load session")
          }
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "search_sessions uses the request-scoped session host facet",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("indexed reply"),
            toolCallStep("search_sessions", { query: "needle-session-tools-rpc", limit: 5 }),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [AgentsExtension, SessionToolsExtension],
          })

          yield* client.message.send({
            sessionId,
            branchId,
            content: "needle-session-tools-rpc",
          })

          const eventFiber = yield* toolEventsFor(
            client.session.events({ sessionId, branchId }),
            "search_sessions",
          )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "Search sessions for the marker",
          })

          const events = Array.from(yield* Fiber.join(eventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded?.event._tag).toBe("ToolCallSucceeded")
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain("needle-session-tools-rpc")
          }
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})
