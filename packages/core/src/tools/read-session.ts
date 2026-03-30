import { Effect, Schema } from "effect"
import { defineTool } from "../domain/tool.js"
import { SubagentRunnerService } from "../domain/agent.js"
import { requireAgent } from "../runtime/extensions/registry.js"
import { headTailChars } from "../domain/output-buffer.js"
import type { Message, MessagePart, Branch } from "../domain/message.js"
import type { SessionId } from "../domain/ids.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"
import { Storage } from "../storage/sqlite-storage.js"

// Read Session Error

export class ReadSessionError extends Schema.TaggedErrorClass<ReadSessionError>()(
  "ReadSessionError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

// Read Session Params

export const ReadSessionParams = Schema.Struct({
  sessionId: Schema.String.annotate({
    description: "Session ID to read",
  }),
  branchId: Schema.optional(
    Schema.String.annotate({
      description: "Target branch ID (defaults to first branch)",
    }),
  ),
  goal: Schema.optional(
    Schema.String.annotate({
      description: "What to extract — AI sub-agent filters for relevance",
    }),
  ),
})

// Session tree rendering

const MAX_TOOL_ARG_CHARS = 500
const MAX_TREE_CHARS = 120_000

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s
}

export function renderMessageParts(parts: ReadonlyArray<MessagePart>): string {
  const chunks: string[] = []
  for (const part of parts) {
    switch (part.type) {
      case "text":
        chunks.push(part.text)
        break
      case "tool-call":
        chunks.push(
          `### tool: ${part.toolName}\n${truncate(JSON.stringify(part.input), MAX_TOOL_ARG_CHARS)}`,
        )
        break
      case "tool-result": {
        let output = ""
        if (part.output !== undefined) {
          if (typeof part.output.value === "string") output = part.output.value
          else output = JSON.stringify(part.output.value)
        }
        chunks.push(`result: ${truncate(output, MAX_TOOL_ARG_CHARS)}`)
        break
      }
      // Skip reasoning, image
    }
  }
  return chunks.join("\n")
}

export function renderSessionTree(
  branches: ReadonlyArray<{ branch: Branch; messages: ReadonlyArray<Message> }>,
  targetBranchId: string | undefined,
): string {
  const lines: string[] = []

  for (const { branch, messages } of branches) {
    const isTarget = branch.id === targetBranchId
    const marker = isTarget ? " [TARGET BRANCH]" : ""

    if (branch.parentBranchId !== undefined) {
      lines.push(`\n--- branch point: ${branch.name ?? branch.id}${marker} ---`)
    } else {
      lines.push(`# Branch: ${branch.name ?? branch.id}${marker}`)
    }

    for (const msg of messages) {
      const ts = msg.createdAt.toISOString()
      lines.push(`\n## ${msg.role} (${ts})`)
      const content = renderMessageParts(msg.parts)
      if (content.length > 0) {
        lines.push(content)
      }
    }
  }

  return lines.join("\n")
}

// Read Session Tool

export const ReadSessionTool = defineTool({
  name: "read_session",
  action: "state",
  concurrency: "parallel",
  idempotent: true,
  description:
    "Read a past session's conversation. Optionally extract relevant information using an AI sub-agent.",
  params: ReadSessionParams,
  execute: Effect.fn("ReadSessionTool.execute")(function* (params, ctx) {
    const storage = yield* Storage

    const tree = yield* storage.getSessionDetail(params.sessionId as SessionId).pipe(
      Effect.mapError(
        (e) =>
          new ReadSessionError({
            message: `Failed to load session: ${e.message}`,
            cause: e,
          }),
      ),
    )

    const targetBranchId = params.branchId ?? tree.branches[0]?.branch.id

    // Render session tree as markdown
    let markdown = renderSessionTree(tree.branches, targetBranchId)

    // Truncate for AI extraction
    const truncated = headTailChars(markdown, MAX_TREE_CHARS)
    if (truncated !== undefined) {
      markdown = truncated.text
    }

    // If goal provided, use AI extraction
    if (params.goal !== undefined) {
      const runner = yield* SubagentRunnerService
      const platform = yield* RuntimePlatform

      const prompt = `Here is a coding agent session transcript:\n\n${markdown}\n\n---\n\nExtract the information relevant to this goal: ${params.goal}`

      const result = yield* runner.run({
        agent: yield* requireAgent("summarizer"),
        prompt,
        parentSessionId: ctx.sessionId,
        parentBranchId: ctx.branchId,
        toolCallId: ctx.toolCallId,
        cwd: platform.cwd,
      })

      if (result._tag === "error") {
        return {
          sessionId: params.sessionId,
          content: markdown,
          extracted: false,
          error: result.error,
        }
      }

      return {
        sessionId: params.sessionId,
        content: result.text,
        extracted: true,
        goal: params.goal,
      }
    }

    return {
      sessionId: params.sessionId,
      content: markdown,
      extracted: false,
      messageCount: tree.branches.reduce((sum, b) => sum + b.messages.length, 0),
      branchCount: tree.branches.length,
    }
  }),
})
