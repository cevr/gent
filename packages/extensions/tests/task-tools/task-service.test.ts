import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Stream } from "effect"
import { TaskService } from "@gent/extensions/task-tools-service"
import { EventStore } from "@gent/core/domain/event"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { layer, narrowR, setup, withTaskWrite } from "./helpers.js"

describe("TaskService.remove", () => {
  it.live("publishes state change on delete", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const eventStore = yield* EventStore
        const taskService = yield* TaskService
        const eventsFiber = yield* Effect.forkChild(
          eventStore.subscribe({ sessionId: SessionId.make("s1") }).pipe(
            Stream.filter(
              (envelope) =>
                envelope.event._tag === "ExtensionStateChanged" &&
                envelope.event.extensionId === "@gent/task-tools",
            ),
            Stream.take(1),
            Stream.runCollect,
          ),
        )
        yield* Effect.yieldNow
        const created = yield* taskService.create({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          subject: "Ephemeral debug task",
        })
        yield* taskService.remove(created.id)
        const envelopes = yield* Fiber.join(eventsFiber)
        const events = Array.from(envelopes, (envelope) => envelope.event._tag)
        expect(events).toContain("ExtensionStateChanged")
      }).pipe(withTaskWrite, Effect.provide(layer)),
    ),
  )

  it.live("removes dependency edges referencing the deleted task", () =>
    narrowR(
      Effect.gen(function* () {
        yield* setup
        const taskService = yield* TaskService
        const blocker = yield* taskService.create({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          subject: "Blocker",
        })
        const blocked = yield* taskService.create({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          subject: "Blocked",
        })

        yield* taskService.addDep(blocked.id, blocker.id)
        expect(yield* taskService.getDeps(blocked.id)).toEqual([blocker.id])

        yield* taskService.remove(blocker.id)
        expect(yield* taskService.getDeps(blocked.id)).toEqual([])
      }).pipe(withTaskWrite, Effect.provide(layer)),
    ),
  )
})
