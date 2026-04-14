import { Deferred, Effect, Stream } from "effect"
import type { AgentExecutionOverrides } from "@gent/core/domain/agent.js"
import type { BranchId, SessionId } from "@gent/core/domain/ids.js"
import type { GentNamespacedClient } from "@gent/sdk"

export const runHeadless = (
  client: GentNamespacedClient,
  sessionId: SessionId,
  branchId: BranchId,
  promptText: string,
  agentOverride?: string,
  executionOverrides?: AgentExecutionOverrides,
) =>
  Effect.gen(function* () {
    const eventStream = client.session.events({ sessionId, branchId })
    const done = yield* Deferred.make<void>()

    yield* client.message
      .send({
        sessionId,
        branchId,
        content: promptText,
        ...(agentOverride !== undefined ? { agentOverride } : {}),
        ...(executionOverrides !== undefined ? { executionOverrides } : {}),
      })
      .pipe(Effect.withSpan("Headless.sendMessage"))

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
      Stream.interruptWhen(Deferred.await(done)),
      Stream.runDrain,
    )
  })
