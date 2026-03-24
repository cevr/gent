import { Effect, Ref, Stream } from "effect"
import type { BranchId, SessionId } from "@gent/core/domain/ids.js"
import type { GentClient, GentRpcError } from "@gent/sdk"

export const runHeadless = (
  client: GentClient,
  sessionId: SessionId,
  branchId: BranchId,
  promptText: string,
): Effect.Effect<void, GentRpcError, never> =>
  Effect.gen(function* () {
    const eventStream = client.streamEvents({ sessionId, branchId })

    yield* client
      .sendMessage({ sessionId, branchId, content: promptText })
      .pipe(Effect.withSpan("Headless.sendMessage"))

    const doneRef = yield* Ref.make(false)

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
              yield* Ref.set(doneRef, true)
              break
            case "HandoffPresented":
              process.stdout.write(`\n[handoff: auto-confirming]\n`)
              yield* client
                .respondHandoff(event.requestId, "confirm")
                .pipe(Effect.catchEager(() => Effect.void))
              break
            case "HandoffConfirmed":
            case "HandoffRejected":
              break
          }
        }),
      ),
      Stream.takeUntilEffect(() => Ref.get(doneRef)),
      Stream.runDrain,
    )
  })
