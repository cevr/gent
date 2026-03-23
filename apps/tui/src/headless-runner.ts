import { Effect, Ref, Stream } from "effect"
import type { BranchId, SessionId } from "@gent/core/domain/ids.js"
import type { HandoffPresented } from "@gent/core/domain/event.js"
import type { AppServiceError } from "@gent/core/server/errors.js"
import type { GentClient } from "@gent/sdk"
import type { SessionCommandsService } from "@gent/core/server/session-commands.js"
import type { SessionEventsService } from "@gent/core/server/session-events.js"

export const runHeadless = (
  commands: SessionCommandsService,
  events: SessionEventsService,
  client: GentClient,
  sessionId: SessionId,
  branchId: BranchId,
  promptText: string,
): Effect.Effect<void, AppServiceError, never> =>
  Effect.gen(function* () {
    const eventStream = events.subscribeEvents({ sessionId, branchId })

    yield* commands
      .sendMessage({ sessionId, branchId, content: promptText })
      .pipe(Effect.withSpan("Headless.sendMessage"))

    const doneRef = yield* Ref.make(false)
    const handoffPendingRef = yield* Ref.make(false)

    yield* eventStream.pipe(
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
            case "ToolCallCompleted":
              process.stdout.write(
                `[tool done: ${event.toolName}${event.isError ? " (error)" : ""}]\n`,
              )
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
              yield* Ref.set(doneRef, true)
              break
            case "TurnCompleted":
              break
            case "HandoffPresented": {
              yield* Ref.set(handoffPendingRef, true)
              const hp = event as typeof HandoffPresented.Type
              process.stdout.write(`\n[handoff: auto-confirming]\n`)
              yield* client
                .respondHandoff(hp.requestId, "confirm")
                .pipe(Effect.catchEager(() => Effect.void))
              break
            }
            case "HandoffConfirmed":
              yield* Ref.set(handoffPendingRef, false)
              yield* Ref.set(doneRef, true)
              break
            case "HandoffRejected":
              yield* Ref.set(handoffPendingRef, false)
              break
          }

          if (event._tag === "TurnCompleted") {
            yield* Effect.sleep("50 millis")
            const pending = yield* Ref.get(handoffPendingRef)
            if (!pending) yield* Ref.set(doneRef, true)
          }
        }),
      ),
      Stream.takeUntilEffect(() => Ref.get(doneRef)),
      Stream.runDrain,
    )
  })
