import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { AskUserTool, AskUserHandler } from "@gent/core/tools/ask-user"
import type { ToolContext } from "@gent/core/domain/tool"
import { EventStore } from "@gent/core/domain/event"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { Storage } from "@gent/core/storage/sqlite-storage"

const ctx: ToolContext = {
  sessionId: "test-session",
  branchId: "test-branch",
  toolCallId: "test-call",
}

const PlatformLayer = Layer.merge(
  BunServices.layer,
  RuntimePlatform.Test({
    cwd: process.cwd(),
    home: "/tmp/test-home",
    platform: "test",
  }),
)

describe("AskUser Handler (integration)", () => {
  const deps = Layer.mergeAll(
    EventStore.Memory,
    Storage.TestWithSql(),
    ExtensionStateRuntime.Test(),
  )
  const handlerLayer = AskUserHandler.Live.pipe(
    Layer.provideMerge(Layer.merge(deps, Layer.provide(EventPublisherLive, deps))),
  )

  it.live("askMany throws InteractionPendingError and persists request", () =>
    Effect.gen(function* () {
      const handler = yield* AskUserHandler

      const error = yield* Effect.flip(handler.askMany([{ question: "Continue?" }], ctx))
      expect(error._tag).toBe("InteractionPendingError")
      expect(error.requestId).toBeTruthy()
      expect(error.interactionType).toBe("ask-user")
    }).pipe(Effect.provide(handlerLayer)),
  )

  it.live("storeResolution + askMany returns stored cancelled decision", () =>
    Effect.gen(function* () {
      const handler = yield* AskUserHandler

      // First call fails
      const error = yield* Effect.flip(handler.askMany([{ question: "Continue?" }], ctx))
      expect(error._tag).toBe("InteractionPendingError")

      // Store the cancelled resolution
      handler.storeResolution(ctx.sessionId as never, ctx.branchId as never, { _tag: "cancelled" })

      // Second call returns stored decision
      const decision = yield* handler.askMany([{ question: "Continue?" }], ctx)
      expect(decision._tag).toBe("cancelled")
    }).pipe(Effect.provide(handlerLayer)),
  )

  it.live("storeResolution + askMany returns stored answered decision", () =>
    Effect.gen(function* () {
      const handler = yield* AskUserHandler

      // First call fails
      yield* Effect.flip(handler.askMany([{ question: "Continue?" }], ctx))

      // Store answered resolution
      handler.storeResolution(ctx.sessionId as never, ctx.branchId as never, {
        _tag: "answered",
        answers: [["Yes"]],
      })

      // Second call returns stored decision
      const decision = yield* handler.askMany([{ question: "Continue?" }], ctx)
      expect(decision._tag).toBe("answered")
      if (decision._tag === "answered") {
        expect(decision.answers).toEqual([["Yes"]])
      }
    }).pipe(Effect.provide(handlerLayer)),
  )
})

describe("AskUser Tool", () => {
  it.live("asks questions and returns answers", () => {
    const layer = Layer.merge(
      AskUserHandler.Test([["Option A"], ["Option B", "Option C"]]),
      PlatformLayer,
    )

    return AskUserTool.execute(
      {
        questions: [
          {
            question: "Which approach?",
            header: "Approach",
            options: [
              { label: "Option A", description: "First option" },
              { label: "Option B", description: "Second option" },
            ],
          },
          {
            question: "Which features?",
            header: "Features",
            options: [
              { label: "Option B", description: "Feature B" },
              { label: "Option C", description: "Feature C" },
            ],
            multiple: true,
          },
        ],
      },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.answers.length).toBe(2)
        expect(result.answers[0]).toEqual(["Option A"])
        expect(result.answers[1]).toEqual(["Option B", "Option C"])
        expect(result.cancelled).toBeUndefined()
      }),
      Effect.provide(layer),
    )
  })

  it.live("cancel returns cancelled flag with empty answers", () => {
    const layer = Layer.merge(AskUserHandler.TestCancelled(), PlatformLayer)

    return AskUserTool.execute(
      {
        questions: [
          {
            question: "Which approach?",
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
      },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.cancelled).toBe(true)
        expect(result.answers).toEqual([])
      }),
      Effect.provide(layer),
    )
  })
})
