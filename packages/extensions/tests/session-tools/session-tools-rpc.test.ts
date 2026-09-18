import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Stream } from "effect"
import type { EventEnvelope } from "@gent/core-internal/domain/event"
import { LanguageModelLayers, toolCallStep } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/index"
import { AgentsExtension, SessionToolsExtension } from "../../src/index.js"
import { e2ePreset } from "../helpers/test-preset"
import { isToolEventFor } from "../helpers/tool-event.js"

const toolEventsFor = <E>(stream: Stream.Stream<EventEnvelope, E>, toolName: string) =>
  stream.pipe(
    Stream.filter(isToolEventFor(toolName)),
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
})
