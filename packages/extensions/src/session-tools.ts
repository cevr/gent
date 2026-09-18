import { Effect, Option, Schema } from "effect"
import {
  type Branch,
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  headTailChars,
  makeRunSpec,
  type Message,
  messagePartsDisplayText,
  requireCurrentAgent,
  SessionId,
  tool,
} from "@gent/core/extensions/api"
import { runChild } from "./delegate.js"

// ── read-session ────────────────────────────────────────────────────────────

// Read Session Error

class ReadSessionError extends Schema.TaggedError<ReadSessionError>()("ReadSessionError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Read Session Params

const ReadSessionParams = Schema.Struct({
  sessionId: Schema.String.annotate({
    description: "Session ID to read",
  }),
  branchId: Schema.optionalKey(
    Schema.String.annotate({
      description: "Target branch ID (defaults to first branch)",
    }),
  ),
  goal: Schema.optionalKey(
    Schema.String.annotate({
      description: "What to extract — AI sub-agent filters for relevance",
    }),
  ),
})

// Read Session Result

const ReadSessionResult = Schema.Struct({
  sessionId: Schema.String,
  content: Schema.String,
  extracted: Schema.Boolean,
  error: Schema.optional(Schema.String),
  goal: Schema.optional(Schema.String),
  messageCount: Schema.optional(Schema.Finite),
  branchCount: Schema.optional(Schema.Finite),
})

// Session tree rendering

const MAX_TOOL_ARG_CHARS = 500
const MAX_TREE_CHARS = 120_000
const EXTRACT_ADDENDUM =
  "Extract only the information relevant to the stated goal from the given transcript. Cite files and decisions. Do not run tools."

export const renderMessageParts = (parts: ReadonlyArray<Message["parts"][number]>): string =>
  messagePartsDisplayText(parts, { maxToolChars: MAX_TOOL_ARG_CHARS })

export function renderSessionTree(
  branches: ReadonlyArray<{ branch: Branch; messages: ReadonlyArray<Message> }>,
  targetBranchId: Option.Option<string>,
): string {
  const lines: string[] = []

  for (const { branch, messages } of branches) {
    const isTarget = Option.contains(targetBranchId, branch.id)
    let marker = ""
    if (isTarget) marker = " [TARGET BRANCH]"

    const branchName = Option.getOrElse(Option.fromNullishOr(branch.name), () => branch.id)
    if (Option.isSome(Option.fromNullishOr(branch.parentBranchId))) {
      lines.push(`\n--- branch point: ${branchName}${marker} ---`)
    } else {
      lines.push(`# Branch: ${branchName}${marker}`)
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

export const ReadSessionTool = tool({
  id: "read_session",
  description:
    "Read a past session's conversation. Optionally extract relevant information using an AI sub-agent.",
  params: ReadSessionParams,
  output: ReadSessionResult,
  execute: Effect.fn("ReadSessionTool.execute")(function* (params: typeof ReadSessionParams.Type) {
    const ctx = yield* ExtensionContext
    const session = ctx.Session
    const tree = yield* session
      .getDetail(SessionId.make(params.sessionId))
      .pipe(
        Effect.mapError(
          (e) =>
            new ReadSessionError({ message: `Failed to load session: ${e.message}`, cause: e }),
        ),
      )

    const targetBranchId = Option.fromNullishOr(params.branchId).pipe(
      Option.orElse(() =>
        Option.fromNullishOr(tree.branches[0]).pipe(Option.map((entry) => entry.branch.id)),
      ),
    )

    // Render session tree as markdown
    let markdown = renderSessionTree(tree.branches, targetBranchId)

    // Truncate for AI extraction
    const truncated = headTailChars(markdown, MAX_TREE_CHARS)
    const truncatedOption = Option.fromNullishOr(truncated)
    if (Option.isSome(truncatedOption)) {
      markdown = truncatedOption.value.text
    }

    // If goal provided, use AI extraction
    const goal = Option.fromNullishOr(params.goal)
    if (Option.isSome(goal)) {
      const prompt = `Here is a coding agent session transcript:\n\n${markdown}\n\n---\n\nExtract the information relevant to this goal: ${goal.value}`
      const agent = yield* requireCurrentAgent
      const result = yield* runChild({
        agent,
        prompt,
        runSpec: makeRunSpec({
          visibility: "private",
          parentToolCallId: ctx.toolCallId,
          overrides: { systemPromptAddendum: EXTRACT_ADDENDUM, allowedTools: [] },
        }),
      })

      if (result._tag === "Error") {
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
        goal: goal.value,
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

// ── rename-session ──────────────────────────────────────────────────────────

const NAMING_INSTRUCTION = `
## Session naming
Call rename_session with a specific 3-5 word lowercase title once you understand what the user needs. If the conversation topic shifts significantly, rename again.`

const RenameSessionParams = Schema.Struct({
  name: Schema.String.annotate({
    description: "Short session title, 3-5 lowercase words describing the current task",
  }),
})

const RenameSessionResult = Schema.Struct({
  renamed: Schema.Boolean,
  name: Schema.optional(Schema.String),
})

const RenameSessionTool = tool({
  id: "rename_session",
  description:
    "Rename the current session. Call once you understand the task, and again if the topic shifts significantly.",
  params: RenameSessionParams,
  output: RenameSessionResult,
  execute: Effect.fn("RenameSessionTool.execute")(function* (
    params: typeof RenameSessionParams.Type,
  ) {
    const ctx = yield* ExtensionContext
    return yield* ctx.Session.renameCurrent(params.name)
  }),
})

// ── extension ───────────────────────────────────────────────────────────────

export const SessionToolsExtension = defineExtension({
  id: "@gent/session-tools",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", ReadSessionTool, RenameSessionTool)
    yield* host.on("systemPrompt", (input) => {
      if (input.interactive === false) {
        return Effect.succeed(input.basePrompt)
      }
      return Effect.succeed(input.basePrompt + NAMING_INSTRUCTION)
    })
  }),
})
