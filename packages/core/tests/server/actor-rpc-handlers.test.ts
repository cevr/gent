import { describe, expect, test } from "bun:test"
import { Effect, Ref } from "effect"
import { buildActorRpcHandlers } from "@gent/core/server/rpc-handler-groups/actor"
import {
  applySteerCommand,
  interruptPayloadToSteerCommand,
  sendUserMessageCommand,
  type RuntimeCommand,
} from "../../src/runtime/session-runtime"

describe("actor RPC handlers", () => {
  test("sendUserMessage dispatches the tagged runtime command", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const seen = yield* Ref.make<RuntimeCommand | undefined>(undefined)
        const handlers = buildActorRpcHandlers({
          sessionRuntime: {
            dispatch: (command) => Ref.set(seen, command),
            getState: () => Effect.die("unused"),
            getMetrics: () => Effect.die("unused"),
            drainQueuedMessages: () => Effect.die("unused"),
            getQueuedMessages: () => Effect.die("unused"),
            watchState: () => Effect.die("unused"),
          },
        } as never)

        const input = {
          sessionId: "session-1" as never,
          branchId: "branch-1" as never,
          content: "hello",
        }

        yield* handlers["actor.sendUserMessage"](input)
        expect(yield* Ref.get(seen)).toEqual(sendUserMessageCommand(input))
      }),
    )
  })

  test("interrupt dispatches a tagged steer command without optional message state", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const seen = yield* Ref.make<RuntimeCommand | undefined>(undefined)
        const handlers = buildActorRpcHandlers({
          sessionRuntime: {
            dispatch: (command) => Ref.set(seen, command),
            getState: () => Effect.die("unused"),
            getMetrics: () => Effect.die("unused"),
            drainQueuedMessages: () => Effect.die("unused"),
            getQueuedMessages: () => Effect.die("unused"),
            watchState: () => Effect.die("unused"),
          },
        } as never)

        const input = {
          _tag: "Interject" as const,
          sessionId: "session-1" as never,
          branchId: "branch-1" as never,
          message: "urgent",
        }

        yield* handlers["actor.interrupt"](input)
        expect(yield* Ref.get(seen)).toEqual(
          applySteerCommand(interruptPayloadToSteerCommand(input)),
        )
      }),
    )
  })
})
