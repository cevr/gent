/**
 * Executor tools — execute + resume.
 *
 * execute: run TypeScript in Executor's sandboxed runtime.
 * resume: continue a paused execution (waiting_for_interaction).
 *
 * Both read the executor runtime snapshot to get the baseUrl, then delegate to
 * ExecutorMcpBridge. isError results become Effect.fail.
 */

import { Effect, Option, Schema } from "effect"
import { tool } from "@gent/core/extensions/api"
import { ExecutorRead } from "./controller.js"
import { type ExecutorMcpToolResult, ResumeAction, ExecutorMcpError } from "./domain.js"
import { ExecutorMcpBridge } from "./mcp-bridge.js"

// ── Helpers ──

const requireReadyBaseUrl = (phase: "execute" | "resume") =>
  Effect.gen(function* () {
    const executor = yield* Effect.serviceOption(ExecutorRead)
    if (Option.isNone(executor)) {
      return yield* new ExecutorMcpError({ phase, message: "Executor not ready" })
    }
    const snapshot = yield* executor.value.snapshot.pipe(Effect.option)
    if (Option.isNone(snapshot) || snapshot.value.status !== "ready") {
      return yield* new ExecutorMcpError({ phase, message: "Executor not ready" })
    }
    const baseUrl = Option.fromNullishOr(snapshot.value.baseUrl)
    if (Option.isNone(baseUrl) || baseUrl.value.length === 0) {
      return yield* new ExecutorMcpError({ phase, message: "Executor not ready" })
    }
    return baseUrl.value
  })

const failIfError = (result: ExecutorMcpToolResult, phase: "execute" | "resume") => {
  if (result.isError) {
    return Effect.fail(new ExecutorMcpError({ phase, message: result.text }))
  }
  return Effect.succeed(result)
}

const ExecuteResult = Schema.Struct({
  text: Schema.String,
  structuredContent: Schema.optional(Schema.Unknown),
  executionId: Schema.optional(Schema.String),
})

const ResumeResult = Schema.Struct({
  text: Schema.String,
  structuredContent: Schema.optional(Schema.Unknown),
})

const ResumeParams = Schema.Struct({
  executionId: Schema.String.annotate({
    description: "The executionId from execute's result.",
  }),
  action: ResumeAction.annotate({
    description: "How to respond to the pending interaction.",
  }),
  content: Schema.optionalKey(
    Schema.String.annotate({
      description: "Optional JSON string with additional content for the interaction.",
    }),
  ),
})

const ResumeContent = Schema.Record(Schema.String, Schema.Unknown)

// ── Execute Tool ──

export const ExecuteTool = tool({
  id: "execute",
  description: "Execute TypeScript in a sandboxed runtime with access to configured API tools.",
  promptSnippet: "Execute TypeScript in Executor's sandboxed runtime with configured API tools.",
  promptGuidelines: [
    "Use tools.search({ query }) inside execute to discover available API tools.",
    "Use tools.describe.tool({ path }) to get TypeScript shapes before calling.",
  ],
  params: Schema.Struct({
    code: Schema.String.annotate({
      description: "TypeScript code to execute in the Executor runtime.",
    }),
  }),
  output: ExecuteResult,
  execute: Effect.fn("ExecuteTool.execute")(function* (params) {
    const baseUrl = yield* requireReadyBaseUrl("execute")
    const bridge = yield* ExecutorMcpBridge
    const result = yield* bridge.execute(baseUrl, params.code)
    const checked = yield* failIfError(result, "execute")
    return {
      text: checked.text,
      structuredContent: checked.structuredContent,
      executionId: checked.executionId,
    }
  }),
})

// ── Resume Tool ──

export const ResumeTool = tool({
  id: "resume",
  description: "Resume a paused Executor execution. Use the exact executionId returned by execute.",
  promptGuidelines: [
    "Use the exact executionId returned by execute.",
    "action: 'accept' to approve, 'decline' to reject, 'cancel' to abort.",
  ],
  params: ResumeParams,
  output: ResumeResult,
  execute: Effect.fn("ResumeTool.execute")(function* (params: typeof ResumeParams.Type) {
    const baseUrl = yield* requireReadyBaseUrl("resume")
    const bridge = yield* ExecutorMcpBridge
    const contentStr = Option.fromNullishOr(params.content).pipe(
      Option.filter((content) => content.length > 0),
    )
    let parsed: Option.Option<typeof ResumeContent.Type> = Option.none()
    if (Option.isSome(contentStr)) {
      parsed = Option.some(
        yield* Schema.decodeEffect(Schema.fromJsonString(ResumeContent))(contentStr.value).pipe(
          Effect.mapError(
            () =>
              new ExecutorMcpError({
                phase: "resume",
                message: "Invalid JSON in content parameter",
              }),
          ),
        ),
      )
    }
    const result = yield* bridge.resume(
      baseUrl,
      params.executionId,
      params.action,
      Option.getOrUndefined(parsed),
    )
    const checked = yield* failIfError(result, "resume")
    return {
      text: checked.text,
      structuredContent: checked.structuredContent,
    }
  }),
})
