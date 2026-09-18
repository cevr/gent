import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Schema, Stream } from "effect"
import { narrowR } from "../../core/tests/helpers/effect"
import { HandoffTool } from "../src/handoff.js"
import { SessionId } from "@gent/core-internal/domain/ids"
import type { ExtensionContextService } from "@gent/core/extensions/api"
import {
  createRpcHarness,
  runToolWithCtx,
  testToolContext,
} from "@gent/core-internal/test-utils/index"
import {
  LanguageModelLayers,
  textStep,
  toolCallStep,
} from "@gent/core-internal/test-utils/language-model"
import { e2ePreset } from "./helpers/test-preset"
import { isToolResultFor } from "./helpers/tool-event.js"

// ── handoff.test ────────────────────────────────────────────────────────────

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)

const makeCtx = (overrides: { approve?: ExtensionContextService["Interaction"]["approve"] }) =>
  testToolContext({
    Interaction: {
      approve: overrides.approve ?? dieStub("interaction.approve"),
      present: dieStub("interaction.present"),
    },
  })

describe("HandoffTool", () => {
  it.live("returns handoff confirmed when user accepts", () => {
    const ctx = makeCtx({
      approve: () => Effect.succeed({ approved: true }),
    })

    return narrowR(
      runToolWithCtx(
        HandoffTool,
        {
          context: "Current task: implement auth. Key files: src/auth.ts",
          reason: "context window filling up",
        },
        ctx,
      ).pipe(
        Effect.map((result) => {
          expect(result.handoff).toBe(true)
          expect(result.summary).toContain("implement auth")
          expect(result.parentSessionId).toBe(SessionId.make("test-session"))
        }),
      ),
    )
  })

  it.live("returns handoff rejected when user declines", () => {
    const ctx = makeCtx({
      approve: () => Effect.succeed({ approved: false }),
    })

    return narrowR(
      runToolWithCtx(
        HandoffTool,
        {
          context: "Current task: implement auth",
        },
        ctx,
      ).pipe(
        Effect.map((result) => {
          expect(result.handoff).toBe(false)
          expect(result.reason).toBe("User rejected handoff")
        }),
      ),
    )
  })
})

// ── handoff/handoff-rpc.test ────────────────────────────────────────────────

const largeContext = `Current task: migrate the actor mailbox to bounded queues.\n${"Key decision: use Effect.Queue.bounded(...). ".repeat(100)}`

describe("HandoffExtension via model turn", () => {
  it.live(
    "approval preserves the full supplied handoff without a second model run",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("handoff", {
              context: largeContext,
              reason: "context window filling up",
            }),
            textStep("handed-off"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })

          const toolEventFiber = yield* client.session
            .events({ sessionId, branchId })
            .pipe(
              Stream.filter(isToolResultFor("handoff")),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "hand off to a new session",
          })

          const events = Array.from(yield* Fiber.join(toolEventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain('"handoff": true')
            expect(succeeded.event.output).toContain(
              yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(largeContext),
            )
            expect(succeeded.event.output).toContain('"reason": "context window filling up"')
          }
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )
})
