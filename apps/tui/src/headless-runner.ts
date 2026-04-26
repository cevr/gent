import { Cause, Deferred, Effect, Exit, Fiber, Schedule, Stream } from "effect"
import type { RunSpec } from "@gent/core/domain/agent.js"
import type { BranchId, SessionId } from "@gent/core/domain/ids.js"
import { GentConnectionError, type GentNamespacedClient } from "@gent/sdk"

const isTransientTransportOpenError = (error: unknown): boolean => {
  const text = String(error)
  return text.includes("RpcClientError") || text.includes("SocketOpenError")
}

export const runHeadless = (
  client: GentNamespacedClient,
  sessionId: SessionId,
  branchId: BranchId,
  promptText: string,
  agentOverride?: string,
  runSpec?: RunSpec,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const done = yield* Deferred.make<void>()
      const streamFiber = yield* client.session.events({ sessionId, branchId }).pipe(
        Stream.tap((envelope) =>
          Effect.gen(function* () {
            const event = envelope.event
            switch (event._tag) {
              case "StreamChunk":
                process.stdout.write(event.chunk)
                break
              case "ToolCallStarted":
                process.stdout.write(`\n[tool: ${event.toolName}]\n`)
                break
              case "ToolCallSucceeded":
                process.stdout.write(`[tool done: ${event.toolName}]\n`)
                break
              case "ToolCallFailed":
                process.stdout.write(`[tool done: ${event.toolName} (error)]\n`)
                break
              case "StreamEnded":
                process.stdout.write("\n")
                break
              case "ErrorOccurred":
                process.stderr.write(`\nError: ${event.error}\n`)
                yield* Deferred.succeed(done, void 0)
                break
              case "TurnCompleted":
                yield* Deferred.succeed(done, void 0)
                break
              case "InteractionPresented":
                process.stdout.write(`\n[interaction: auto-approving]\n`)
                yield* client.interaction
                  .respondInteraction({
                    requestId: event.requestId,
                    sessionId,
                    branchId,
                    approved: true,
                  })
                  .pipe(Effect.catchEager(() => Effect.void))
                break
              case "InteractionResolved":
                break
            }
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      )

      const sendRequestId = crypto.randomUUID()
      yield* Effect.suspend(() =>
        client.message.send({
          sessionId,
          branchId,
          content: promptText,
          requestId: sendRequestId,
          ...(agentOverride !== undefined ? { agentOverride } : {}),
          ...(runSpec !== undefined ? { runSpec } : {}),
        }),
      ).pipe(
        Effect.retry({
          schedule: Schedule.spaced("250 millis"),
          times: 20,
          while: isTransientTransportOpenError,
        }),
        Effect.withSpan("Headless.sendMessage"),
      )

      yield* Effect.raceFirst(
        Deferred.await(done),
        Fiber.await(streamFiber).pipe(
          Effect.flatMap((exit) =>
            Exit.match(exit, {
              onFailure: (cause) =>
                Effect.fail(
                  new GentConnectionError({
                    message: Cause.pretty(cause),
                  }),
                ),
              onSuccess: () =>
                Effect.fail(
                  new GentConnectionError({
                    message: "headless event stream ended before turn completion",
                  }),
                ),
            }),
          ),
        ),
      )
      yield* Fiber.interrupt(streamFiber).pipe(Effect.asVoid)
    }),
  )
