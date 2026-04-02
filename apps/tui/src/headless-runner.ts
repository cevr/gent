import { Effect, Ref, Stream } from "effect"
import type { BranchId, SessionId } from "@gent/core/domain/ids.js"
import type { GentNamespacedClient, GentRpcError } from "@gent/sdk"

export const runHeadless = (
  client: GentNamespacedClient,
  sessionId: SessionId,
  branchId: BranchId,
  promptText: string,
  agentOverride?: string,
): Effect.Effect<void, GentRpcError, never> =>
  Effect.gen(function* () {
    const eventStream = client.session.events({ sessionId, branchId })

    yield* client.message
      .send({ sessionId, branchId, content: promptText, agentOverride })
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
              yield* client.interaction
                .respondHandoff({
                  requestId: event.requestId,
                  sessionId,
                  branchId,
                  decision: "confirm",
                })
                .pipe(Effect.catchEager(() => Effect.void))
              break
            case "QuestionsAsked":
              process.stderr.write(`\n[ask_user: auto-cancelling in headless mode]\n`)
              yield* client.interaction
                .respondQuestions({
                  requestId: event.requestId,
                  sessionId,
                  branchId,
                  answers: [],
                  cancelled: true,
                })
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
