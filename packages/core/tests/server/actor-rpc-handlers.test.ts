import { describe, expect, it } from "effect-bun-test"
import { Effect, Ref } from "effect"
import { buildActorRpcHandlers } from "../../src/server/rpc-handler-groups/actor"
import {
  applySteerCommand,
  interruptPayloadToSteerCommand,
  sendUserMessageCommand,
  type RuntimeCommand,
} from "../../src/runtime/session-runtime"
import { BranchId, SessionId } from "@gent/core/domain/ids"
describe("actor RPC handlers", () => {
  it.live("sendUserMessage dispatches the tagged runtime command", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const seen = yield* Ref.make<RuntimeCommand | undefined>(undefined)
        const handlers = buildActorRpcHandlers({
          sessionRuntime: {
            dispatch: (command: RuntimeCommand) => Ref.set(seen, command),
            getState: () => Effect.die("unused"),
            getMetrics: () => Effect.die("unused"),
            drainQueuedMessages: () => Effect.die("unused"),
            getQueuedMessages: () => Effect.die("unused"),
            watchState: () => Effect.die("unused"),
          },
        } as never)
        const input = {
          sessionId: SessionId.make("session-1") as never,
          branchId: BranchId.make("branch-1") as never,
          content: "hello",
        }
        yield* handlers["actor.sendUserMessage"](input)
        expect(yield* Ref.get(seen)).toEqual(sendUserMessageCommand(input))
      })
    }),
  )
  it.live("interrupt dispatches a tagged steer command without optional message state", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const seen = yield* Ref.make<RuntimeCommand | undefined>(undefined)
        const handlers = buildActorRpcHandlers({
          sessionRuntime: {
            dispatch: (command: RuntimeCommand) => Ref.set(seen, command),
            getState: () => Effect.die("unused"),
            getMetrics: () => Effect.die("unused"),
            drainQueuedMessages: () => Effect.die("unused"),
            getQueuedMessages: () => Effect.die("unused"),
            watchState: () => Effect.die("unused"),
          },
        } as never)
        const input = {
          _tag: "Interject" as const,
          sessionId: SessionId.make("session-1") as never,
          branchId: BranchId.make("branch-1") as never,
          message: "urgent",
        }
        yield* handlers["actor.interrupt"](input)
        expect(yield* Ref.get(seen)).toEqual(
          applySteerCommand(interruptPayloadToSteerCommand(input)),
        )
      })
    }),
  )
})
