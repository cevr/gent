import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Predicate,
  Schedule,
  Stdio,
  Stream,
} from "effect"
import type { AgentName, RunSpec } from "@gent/core-internal/domain/agent.js"
import type { BranchId, SessionId } from "@gent/core-internal/domain/ids.js"
import { GentConnectionError, type GentNamespacedClient } from "@gent/sdk"
import {
  DEFAULT_HEADLESS_TOOL_RENDERERS,
  renderHeadlessToolCall,
  type HeadlessToolRendererRegistry,
  type HeadlessToolCall,
} from "./headless-tool-renderers"
import { randomId } from "./utils/random-id"

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
      const stdio = yield* Stdio.Stdio
      const writeStdout = (text: string) => Stream.make(text).pipe(Stream.run(stdio.stdout()))
      const writeStderr = (text: string) => Stream.make(text).pipe(Stream.run(stdio.stderr()))
      const done = yield* Deferred.make<void>()
      const activeTools = new Map<string, HeadlessToolCall>()
      const renderTool = (toolCall: HeadlessToolCall, parentToolCallId?: string) => {
        const rendered = renderHeadlessToolCall(toolCall, toolRenderers)
        if (Predicate.isUndefined(parentToolCallId)) return writeStdout(`${rendered}\n`)
        // Cell-admitted calls stay visibly nested under their cell.
        const nested = rendered
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n")
        return writeStdout(`${nested}\n`)
      }
      const streamFiber = yield* client.session.events({ sessionId, branchId }).pipe(
        Stream.tap((envelope) =>
          Effect.gen(function* () {
            const event = envelope.event
            switch (event._tag) {
              case "StreamChunk":
                yield* writeStdout(event.chunk)
                break
              case "ToolCallStarted": {
                const toolCall: HeadlessToolCall = {
                  toolName: event.toolName,
                  input: Option.some(event.input),
                  status: "running",
                  summary: Option.none(),
                  output: Option.none(),
                }
                activeTools.set(String(event.toolCallId), toolCall)
                if (Predicate.isUndefined(event.parentToolCallId)) yield* writeStdout("\n")
                yield* renderTool(toolCall, event.parentToolCallId)
                break
              }
              case "ToolCallSucceeded": {
                const priorInput = Option.fromNullishOr(
                  activeTools.get(String(event.toolCallId)),
                ).pipe(Option.flatMap((toolCall) => toolCall.input))
                const toolCall: HeadlessToolCall = {
                  toolName: event.toolName,
                  input: priorInput,
                  status: "completed",
                  summary: Option.fromNullishOr(event.summary),
                  output: Option.fromNullishOr(event.output),
                }
                activeTools.delete(String(event.toolCallId))
                yield* renderTool(toolCall, event.parentToolCallId)
                break
              }
              case "ToolCallFailed": {
                const priorInput = Option.fromNullishOr(
                  activeTools.get(String(event.toolCallId)),
                ).pipe(Option.flatMap((toolCall) => toolCall.input))
                const toolCall: HeadlessToolCall = {
                  toolName: event.toolName,
                  input: priorInput,
                  status: "error",
                  summary: Option.fromNullishOr(event.summary),
                  output: Option.fromNullishOr(event.output),
                }
                activeTools.delete(String(event.toolCallId))
                yield* renderTool(toolCall, event.parentToolCallId)
                break
              }
              case "StreamEnded":
                yield* writeStdout("\n")
                break
              case "ErrorOccurred":
                yield* writeStderr(`\nError: ${event.error}\n`)
                yield* Deferred.succeed(done, void 0)
                break
              case "TurnCompleted":
                yield* Deferred.succeed(done, void 0)
                break
              case "InteractionPresented":
                yield* writeStdout(`\n[interaction: auto-approving]\n`)
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

      const sendRequestId = yield* randomId
      yield* Effect.suspend(() =>
        client.message.send({
          sessionId,
          branchId,
          content: promptText,
          requestId: sendRequestId,
          agentOverride,
          runSpec,
        }),
      ).pipe(
        Effect.retry({
          schedule: Schedule.spaced("250 millis"),
          times: 20,
          while: (error) => {
            const text = String(error)
            return text.includes("RpcClientError") || text.includes("SocketOpenError")
          },
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
