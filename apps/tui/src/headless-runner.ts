import { Cause, Deferred, Effect, Exit, Fiber, Random, Schedule, Stream } from "effect"
import type { AgentName, RunSpec } from "@gent/core-internal/domain/agent.js"
import type { BranchId, SessionId } from "@gent/core-internal/domain/ids.js"
import { GentConnectionError, type GentNamespacedClient } from "@gent/sdk"
import {
  DEFAULT_HEADLESS_TOOL_RENDERERS,
  renderHeadlessToolCall,
  type HeadlessToolRendererRegistry,
  type HeadlessToolCall,
} from "./headless-tool-renderers"

const isTransientTransportOpenError = (error: unknown): boolean => {
  const text = String(error)
  return text.includes("RpcClientError") || text.includes("SocketOpenError")
}

export const runHeadless = (
  client: GentNamespacedClient,
  sessionId: SessionId,
  branchId: BranchId,
  promptText: string,
  agentOverride?: AgentName,
  runSpec?: RunSpec,
  toolRenderers: HeadlessToolRendererRegistry = DEFAULT_HEADLESS_TOOL_RENDERERS,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const done = yield* Deferred.make<void>()
      const activeTools = new Map<string, HeadlessToolCall>()
      const renderTool = (toolCall: HeadlessToolCall): void => {
        process.stdout.write(`${renderHeadlessToolCall(toolCall, toolRenderers)}\n`)
      }
      const streamFiber = yield* client.session.events({ sessionId, branchId }).pipe(
        Stream.tap((envelope) =>
          Effect.gen(function* () {
            const event = envelope.event
            switch (event._tag) {
              case "StreamChunk":
                process.stdout.write(event.chunk)
                break
              case "ToolCallStarted": {
                const toolCall: HeadlessToolCall = {
                  toolName: event.toolName,
                  input: event.input,
                  status: "running",
                  summary: undefined,
                  output: undefined,
                }
                activeTools.set(String(event.toolCallId), toolCall)
                process.stdout.write("\n")
                renderTool(toolCall)
                break
              }
              case "ToolCallSucceeded": {
                const toolCall: HeadlessToolCall = {
                  toolName: event.toolName,
                  input: activeTools.get(String(event.toolCallId))?.input,
                  status: "completed",
                  summary: event.summary,
                  output: event.output,
                }
                activeTools.delete(String(event.toolCallId))
                renderTool(toolCall)
                break
              }
              case "ToolCallFailed": {
                const toolCall: HeadlessToolCall = {
                  toolName: event.toolName,
                  input: activeTools.get(String(event.toolCallId))?.input,
                  status: "error",
                  summary: event.summary,
                  output: event.output,
                }
                activeTools.delete(String(event.toolCallId))
                renderTool(toolCall)
                break
              }
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

      const sendRequestId = yield* Random.nextUUIDv4
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
