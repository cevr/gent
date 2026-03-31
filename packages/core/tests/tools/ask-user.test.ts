import { describe, it, expect } from "effect-bun-test"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { BunServices } from "@effect/platform-bun"
import { AskUserTool, AskUserHandler } from "@gent/core/tools/ask-user"
import type { ToolContext } from "@gent/core/domain/tool"
import { EventStore } from "@gent/core/domain/event"
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
  const deps = Layer.mergeAll(EventStore.Memory, Storage.TestWithSql())
  const handlerLayer = AskUserHandler.Live.pipe(Layer.provideMerge(deps))

  it.scopedLive("respond with cancelled resolves askMany as cancelled", () =>
    Effect.gen(function* () {
      const handler = yield* AskUserHandler
      const eventStore = yield* EventStore

      // Latch: deterministic wait for QuestionsAsked event
      const latch = yield* Deferred.make<string>()
      const subscription = eventStore.subscribe({ sessionId: "test-session" as never }).pipe(
        Stream.tap((env) => {
          if (env.event._tag === "QuestionsAsked") {
            return Deferred.succeed(latch, env.event.requestId)
          }
          return Effect.void
        }),
        Stream.runDrain,
      )
      yield* Effect.forkScoped(subscription)

      // Start askMany in a fiber — it blocks on the deferred
      const askFiber = yield* Effect.forkScoped(handler.askMany([{ question: "Continue?" }], ctx))

      // Wait for event deterministically, then respond
      const requestId = yield* Deferred.await(latch)
      yield* handler.respond(requestId, [], true)

      const decision = yield* Fiber.join(askFiber)
      expect(decision._tag).toBe("cancelled")
    }).pipe(Effect.provide(handlerLayer)),
  )

  it.scopedLive("respond with answers resolves askMany as answered", () =>
    Effect.gen(function* () {
      const handler = yield* AskUserHandler
      const eventStore = yield* EventStore

      const latch = yield* Deferred.make<string>()
      const subscription = eventStore.subscribe({ sessionId: "test-session" as never }).pipe(
        Stream.tap((env) => {
          if (env.event._tag === "QuestionsAsked") {
            return Deferred.succeed(latch, env.event.requestId)
          }
          return Effect.void
        }),
        Stream.runDrain,
      )
      yield* Effect.forkScoped(subscription)

      const askFiber = yield* Effect.forkScoped(handler.askMany([{ question: "Continue?" }], ctx))

      const requestId = yield* Deferred.await(latch)
      yield* handler.respond(requestId, [["Yes"]])

      const decision = yield* Fiber.join(askFiber)
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
