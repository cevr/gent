import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import { InteractionCommands } from "@gent/core/server/interaction-commands"
import {
  SessionRuntime,
  respondInteractionCommand,
  type RuntimeCommand,
} from "@gent/core/runtime/session-runtime"
import { ApprovalService } from "@gent/core/runtime/approval-service"

describe("InteractionCommands", () => {
  it.effect("respond stores resolution, dispatches runtime wake-up, then resolves storage", () =>
    Effect.gen(function* () {
      const callLog: string[] = []
      const deps = Layer.mergeAll(
        Layer.succeed(ApprovalService, {
          present: () => Effect.die("unused"),
          storeResolution: () => {
            callLog.push("approval.storeResolution")
          },
          respond: () =>
            Effect.sync(() => {
              callLog.push("approval.respond")
            }),
          rehydrate: () => Effect.void,
        }),
        Layer.succeed(SessionRuntime, {
          dispatch: (command: RuntimeCommand) =>
            Effect.sync(() => {
              callLog.push("sessionRuntime.dispatch")
              expect(command).toEqual(
                respondInteractionCommand({
                  sessionId: "session-1" as never,
                  branchId: "branch-1" as never,
                  requestId: "req-1",
                }),
              )
            }),
          runPrompt: () => Effect.die("unused"),
          drainQueuedMessages: () => Effect.die("unused"),
          getQueuedMessages: () => Effect.die("unused"),
          getState: () => Effect.die("unused"),
          getMetrics: () => Effect.die("unused"),
          watchState: () => Effect.die("unused"),
        }),
        Layer.succeed(EventPublisher, {
          publish: () =>
            Effect.sync(() => {
              callLog.push("eventPublisher.publish")
            }),
          terminateSession: () => Effect.void,
        }),
      )
      const layer = Layer.provide(InteractionCommands.Live, deps)

      yield* Effect.gen(function* () {
        const commands = yield* InteractionCommands

        yield* commands.respond({
          requestId: "req-1",
          sessionId: "session-1" as never,
          branchId: "branch-1" as never,
          approved: true,
          notes: "ship it",
        })
      }).pipe(Effect.provide(layer))

      expect(callLog).toEqual([
        "approval.storeResolution",
        "sessionRuntime.dispatch",
        "approval.respond",
        "eventPublisher.publish",
      ])
    }),
  )
})
