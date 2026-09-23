import { Effect, Option, Predicate, Schema } from "effect"
import {
  type Branch,
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  headTailChars,
  type Message,
  messagePartsDisplayText,
  RequestId,
  SessionId,
  tool,
} from "@gent/core/extensions/api"

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
})

// Read Session Result

const ReadSessionResult = Schema.Struct({
  sessionId: Schema.String,
  content: Schema.String,
  messageCount: Schema.optional(Schema.Finite),
  branchCount: Schema.optional(Schema.Finite),
})

// Session tree rendering

const MAX_TOOL_ARG_CHARS = 500
const MAX_TREE_CHARS = 120_000

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
    "Read a past session's conversation as markdown. A long transcript keeps its head and tail.",
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

    const markdown = renderSessionTree(tree.branches, targetBranchId)
    return {
      sessionId: params.sessionId,
      content: headTailChars(markdown, MAX_TREE_CHARS).text,
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

// ── session.send ────────────────────────────────────────────────────────────

/**
 * One message from this session to another. Every session has it: a parent
 * corrects a child, a child asks its parent, two siblings hand off a fact.
 * The text lands on the target's active branch as an interjection. A running
 * turn reads it at its next step; an idle branch wakes and answers it.
 */

class SendSessionError extends Schema.TaggedError<SendSessionError>()("SendSessionError", {
  message: Schema.String,
}) {}

const SESSION_MESSAGE_TYPE = "session-message"

/** The sender, as the receiving client sees it. */
export const SessionMessageDetails = Schema.Struct({
  from: Schema.Struct({
    sessionId: SessionId,
    name: Schema.optional(Schema.String),
    /** How the sender stands to the receiver. */
    relation: Schema.Literals(["parent", "child", "session"]),
  }),
})
export type SessionMessageDetails = typeof SessionMessageDetails.Type

const SendSessionParams = Schema.Struct({
  to: Schema.String.annotate({
    description: "A session id, or `parent` for the session that started this one.",
  }),
  message: Schema.String.annotate({ description: "The text the other session reads." }),
})

const SendSessionResult = Schema.Struct({
  sessionId: SessionId,
  /** What the receiver is to the sender. */
  relation: Schema.Literals(["parent", "child", "session"]),
})

const relationOf = (
  sender: { readonly id: SessionId; readonly parentSessionId?: SessionId },
  receiver: { readonly id: SessionId; readonly parentSessionId?: SessionId },
): "parent" | "child" | "session" => {
  if (sender.parentSessionId === receiver.id) return "parent"
  if (receiver.parentSessionId === sender.id) return "child"
  return "session"
}

const inverse = (relation: "parent" | "child" | "session"): "parent" | "child" | "session" => {
  if (relation === "parent") return "child"
  if (relation === "child") return "parent"
  return "session"
}

/** The header the model reads: who wrote it, and what they are to the reader. */
type SessionMessageSender = {
  readonly sessionId: SessionId
  readonly name?: string
  readonly relation: string
}

/** The first header line: who wrote it, and what they are to the reader. */
const senderLine = (from: SessionMessageSender): string => {
  const name = Option.fromUndefinedOr(from.name).pipe(
    Option.map((value) => ` "${value}"`),
    Option.getOrElse(() => ""),
  )
  const who = Option.liftPredicate(from.relation, (relation) => relation !== "session").pipe(
    Option.map((relation) => `your ${relation}`),
    Option.getOrElse(() => "another session"),
  )
  return `Message from ${who}${name} (session ${from.sessionId}):`
}

/** A child's message arrives mid-turn; its completion is a separate message. */
const CHILD_STATUS_LINE =
  "Your child is still running. This is not its completion; that arrives as a separate message."

export const sessionMessageText = (input: {
  readonly from: SessionMessageSender
  readonly message: string
}): string => {
  const status = Option.liftPredicate(input.from.relation, (relation) => relation === "child").pipe(
    Option.map(() => `\n${CHILD_STATUS_LINE}`),
    Option.getOrElse(() => ""),
  )
  return `${senderLine(input.from)}${status}\n\n${input.message}`
}

/**
 * The text of a stored message without its header. Rows written before the
 * child status line existed have none, so the line is removed only when it
 * is there; a row whose header does not match is returned whole.
 */
export const sessionMessageBody = (from: SessionMessageSender, content: string): string => {
  const afterSender = (text: string) =>
    Option.liftPredicate(text, (value) => value.startsWith(senderLine(from))).pipe(
      Option.map((value) => value.slice(senderLine(from).length)),
    )
  const afterStatus = (text: string) =>
    Option.liftPredicate(text, (value) => value.startsWith(`\n${CHILD_STATUS_LINE}`)).pipe(
      Option.map((value) => value.slice(CHILD_STATUS_LINE.length + 1)),
      Option.getOrElse(() => text),
    )
  return afterSender(content).pipe(
    Option.map(afterStatus),
    Option.filter((rest) => rest.startsWith("\n\n")),
    Option.map((rest) => rest.slice(2)),
    Option.getOrElse(() => content),
  )
}

const SendSessionTool = tool({
  id: "session.send",
  description:
    "Send a message to another session: `parent` for the one that started you, or a session id from delegate.list or read_session. A running session reads it at its next step; an idle one wakes to answer. Use it to ask your parent a question, hand a child a correction, or pass a sibling a fact.",
  params: SendSessionParams,
  output: SendSessionResult,
  execute: Effect.fn("SendSessionTool.execute")(function* (params: typeof SendSessionParams.Type) {
    const ctx = yield* ExtensionContext
    const message = params.message.trim()
    if (message.length === 0 || Predicate.isUndefined(ctx.toolCallId)) {
      return yield* new SendSessionError({
        message: "session.send needs a message and a host-owned tool call",
      })
    }
    const sender = yield* ctx.Session.getSession().pipe(
      Effect.mapError(
        (e) => new SendSessionError({ message: `Cannot read this session: ${e.message}` }),
      ),
    )
    if (Predicate.isUndefined(sender)) {
      return yield* new SendSessionError({ message: "This session no longer exists" })
    }
    if (params.to === "parent" && Predicate.isUndefined(sender.parentSessionId)) {
      return yield* new SendSessionError({ message: "This session has no parent" })
    }
    const targetId = Option.fromUndefinedOr(sender.parentSessionId).pipe(
      Option.filter(() => params.to === "parent"),
      Option.getOrElse(() => SessionId.make(params.to)),
    )
    if (targetId === sender.id) {
      return yield* new SendSessionError({
        message: "A session cannot message itself; the text is already in your context",
      })
    }
    const receiver = yield* ctx.Session.getSession(targetId).pipe(
      Effect.mapError(
        (e) => new SendSessionError({ message: `Cannot read the session: ${e.message}` }),
      ),
    )
    if (Predicate.isUndefined(receiver) || Predicate.isUndefined(receiver.activeBranchId)) {
      return yield* new SendSessionError({ message: `No session ${targetId}` })
    }
    const relation = relationOf(sender, receiver)
    const from = {
      sessionId: sender.id,
      ...Option.match(Option.fromUndefinedOr(sender.name), {
        onNone: () => ({}),
        onSome: (name) => ({ name }),
      }),
      relation: inverse(relation),
    }
    const details: SessionMessageDetails = { from }
    yield* ctx.Session.steer({
      _tag: "Interject",
      sessionId: receiver.id,
      branchId: receiver.activeBranchId,
      requestId: RequestId.make(`session-send:${ctx.toolCallId}`),
      message: sessionMessageText({ from, message }),
      metadata: { customType: SESSION_MESSAGE_TYPE, extensionId: "@gent/session-tools", details },
      // The receiver may be idle; a parked message nobody reads is a lost question.
      wake: true,
    }).pipe(
      Effect.mapError((e) => new SendSessionError({ message: `Cannot deliver: ${e.message}` })),
    )
    return { sessionId: receiver.id, relation }
  }),
})

// ── extension ───────────────────────────────────────────────────────────────

export const SessionToolsExtension = defineExtension({
  id: "@gent/session-tools",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", ReadSessionTool, RenameSessionTool, SendSessionTool)
    yield* host.on("systemPrompt", (input) => {
      if (input.interactive === false) {
        return Effect.succeed(input.basePrompt)
      }
      return Effect.succeed(input.basePrompt + NAMING_INSTRUCTION)
    })
  }),
})
