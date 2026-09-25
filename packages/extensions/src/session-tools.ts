import { Cause, Context, Effect, Layer, Option, Predicate, Ref, Schema } from "effect"
import {
  type Branch,
  type BranchId,
  defineExtension,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  headTailChars,
  interjectionMessageId,
  isSpawnedSession,
  type Message,
  type MessageId,
  messagePartsDisplayText,
  RequestId,
  SessionId,
  tool,
  type TurnAfterInput,
} from "@gent/core/extensions/api"

// Test seam: only tests read these exports. renderMessageParts and
// renderSessionTree are pure with unit tests; ReadSessionTool is the capability
// the cell signature tests render.

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
      description:
        "Branch to mark as the target; the transcript shows every branch (defaults to the first branch)",
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

    const named = params.branchId
    if (
      Predicate.isNotUndefined(named) &&
      !tree.branches.some((entry) => String(entry.branch.id) === named)
    ) {
      return yield* new ReadSessionError({
        message: `Session ${params.sessionId} has no branch ${named}`,
      })
    }
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
 * The text lands as an interjection on the target's active branch; a child's
 * message to its parent lands on the branch that owns the child. A running
 * turn reads it at its next step; an idle branch wakes and answers it.
 */

class SendSessionError extends Schema.TaggedError<SendSessionError>()("SendSessionError", {
  message: Schema.String,
}) {}

export const SESSION_TOOLS_EXTENSION_ID = ExtensionId.make("@gent/session-tools")

/** `metadata.customType` on the interjection `session.send` lands on the receiver. */
export const SESSION_MESSAGE_TYPE = "session-message"

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

type RelatedSession = Parameters<typeof isSpawnedSession>[0]

/** Parent and child only across a spawn; a handoff continues its predecessor's thread. */
const relationOf = (
  sender: RelatedSession,
  receiver: RelatedSession,
): "parent" | "child" | "session" => {
  if (sender.parentSessionId === receiver.id && isSpawnedSession(sender)) return "parent"
  if (receiver.parentSessionId === sender.id && isSpawnedSession(receiver)) return "child"
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

/**
 * A child's message is never its completion. It can arrive mid-turn or after
 * the completion (a later wake turn), so the line holds in both cases.
 */
const CHILD_STATUS_LINE =
  "A child's completion arrives as its own child-completion message; this message is not one."

/** Stored rows written before the line above carry this one. */
const STORED_CHILD_STATUS_LINES = [
  CHILD_STATUS_LINE,
  "Your child is still running. This is not its completion; that arrives as a separate message.",
]

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
    Option.fromUndefinedOr(
      STORED_CHILD_STATUS_LINES.find((line) => text.startsWith(`\n${line}`)),
    ).pipe(
      Option.map((line) => text.slice(line.length + 1)),
      Option.getOrElse(() => text),
    )
  return afterSender(content).pipe(
    Option.map(afterStatus),
    Option.filter((rest) => rest.startsWith("\n\n")),
    Option.map((rest) => rest.slice(2)),
    Option.getOrElse(() => content),
  )
}

// ── session.send: the child turns a send opens ──────────────────────────────

/**
 * A message to a child wakes it when it is idle, so the sender opened that
 * turn, and the sender stops it when its own turn is interrupted: the user
 * who stops a parent means its work, and a correction the parent sent is
 * part of it. A message that still waits in the child's queue is taken back
 * the same way, by the one stop that names its message. A turn the user
 * opened in the child is not the sender's, and the stop never names it.
 *
 * Only sends to a child are kept: an interrupt reaches down the spawn tree,
 * as the delegate registry's does for a child's first turn, never up to a
 * parent or across to a sibling.
 *
 * The record lives in memory. It drops a turn when the child's turn ends,
 * and at the sender's next turn that is not interrupted it drops every turn
 * whose child no longer runs (the message joined a running turn, or was taken
 * back). A notice lives until an answered turn of the sender reads it. A
 * restart forgets both: a child turn the restart resumes is not stopped by
 * the sender's next interrupt.
 */

interface SentTurn {
  readonly senderSessionId: SessionId
  readonly senderBranchId: BranchId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly name: Option.Option<string>
  /** The message the send landed; the turn it opens carries the same id. */
  readonly messageId: MessageId
  /** The sender's interrupt stopped it; its end, if it ends interrupted, is a notice. */
  readonly stopping: boolean
}

/** A child turn the sender's interrupt stopped, until a sender turn reads it. */
interface StoppedTurn {
  readonly senderSessionId: SessionId
  readonly senderBranchId: BranchId
  readonly sessionId: SessionId
  readonly name: Option.Option<string>
  readonly messageId: MessageId
}

interface SentTurnsState {
  readonly sent: ReadonlyArray<SentTurn>
  readonly stopped: ReadonlyArray<StoppedTurn>
}

class SentTurns extends Context.Service<SentTurns, Ref.Ref<SentTurnsState>>()(
  "@gent/extensions/src/session-tools/SentTurns",
) {}

const SentTurnsResource = defineResource({
  id: "@gent/session-tools/sent-turns",
  scope: "process",
  layer: Layer.effect(SentTurns, Ref.make<SentTurnsState>({ sent: [], stopped: [] })),
})

const sentBy =
  (sender: { readonly sessionId: SessionId; readonly branchId: BranchId }) =>
  (turn: { readonly senderSessionId: SessionId; readonly senderBranchId: BranchId }) =>
    turn.senderSessionId === sender.sessionId && turn.senderBranchId === sender.branchId

const recordSentTurn = (turn: SentTurn) =>
  Effect.flatMap(SentTurns, (state) =>
    Ref.update(state, (current) => ({
      ...current,
      sent: [...current.sent.filter((sent) => sent.messageId !== turn.messageId), turn],
    })),
  )

const forgetSentTurn = (messageId: MessageId) =>
  Effect.flatMap(SentTurns, (state) =>
    Ref.update(state, (current) => ({
      ...current,
      sent: current.sent.filter((sent) => sent.messageId !== messageId),
    })),
  )

/**
 * A turn ended somewhere. When it is one a send opened, the record drops it,
 * and a turn the sender's interrupt stopped that ended interrupted becomes a
 * notice: the stop took effect. A turn that ended on its own before the stop
 * reached it is no news.
 */
const onSentTurnEnd = (input: Pick<TurnAfterInput, "sessionId" | "messageId" | "interrupted">) =>
  Effect.flatMap(SentTurns, (state) =>
    Ref.update(state, (current) => {
      const ended = current.sent.find(
        (sent) => sent.sessionId === input.sessionId && sent.messageId === input.messageId,
      )
      if (Predicate.isUndefined(ended)) return current
      const sent = current.sent.filter((turn) => turn !== ended)
      if (!ended.stopping || !input.interrupted) return { ...current, sent }
      return { sent, stopped: [...current.stopped, ended] }
    }),
  )

/** The sender's interrupted turn stops every turn its sends opened that still runs or waits. */
const stopSentTurns = Effect.fn("SessionTools.stopSentTurns")(function* () {
  const ctx = yield* ExtensionContext
  const state = yield* SentTurns
  const mine = sentBy(ctx)
  const stopping = yield* Ref.modify(state, (current) => {
    const marked = current.sent.filter((sent) => mine(sent) && !sent.stopping)
    if (marked.length === 0) return [marked, current]
    const sent = current.sent.map((turn) => {
      if (!marked.includes(turn)) return turn
      return { ...turn, stopping: true }
    })
    return [marked, { ...current, sent }]
  })
  yield* Effect.forEach(
    stopping,
    (turn) =>
      ctx.Session.stop({
        sessionId: turn.sessionId,
        branchId: turn.branchId,
        messageId: turn.messageId,
        requestId: RequestId.make(`session-send-stop:${turn.messageId}`),
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("session-send.stop.failed").pipe(
            Effect.annotateLogs({ messageId: turn.messageId, cause: Cause.pretty(cause) }),
          ),
        ),
      ),
    { discard: true },
  )
})

/**
 * A sender turn that was not interrupted drops what its answer read and every
 * sent turn whose child no longer runs: a message that joined a running
 * turn, or one a stop took back, never ends a turn of its own. A turn whose
 * child still runs stays; its end drops it.
 */
const settleSentTurns = Effect.fn("SessionTools.settleSentTurns")(function* (
  readNotices: ReadonlySet<string>,
) {
  const ctx = yield* ExtensionContext
  const state = yield* SentTurns
  const mine = sentBy(ctx)
  const current = yield* Ref.get(state)
  const read = (turn: StoppedTurn) => mine(turn) && readNotices.has(turn.messageId)
  const waiting = current.sent.filter(mine)
  if (waiting.length === 0 && !current.stopped.some(read)) return
  let settled = new Set<MessageId>()
  if (waiting.length > 0) {
    const live = new Set(
      (yield* ctx.Session.listActiveLoops)
        .filter((loop) => Option.exists(loop.status, (status) => status !== "Idle"))
        .map((loop) => `${loop.sessionId}:${loop.branchId}`),
    )
    settled = new Set(
      waiting
        .filter((turn) => !live.has(`${turn.sessionId}:${turn.branchId}`))
        .map((turn) => turn.messageId),
    )
  }
  yield* Ref.update(state, (latest) => ({
    sent: latest.sent.filter((turn) => !(mine(turn) && settled.has(turn.messageId))),
    stopped: latest.stopped.filter((turn) => !read(turn)),
  }))
})

/** The sender's own turn end: an interrupt stops what its sends opened; any other end settles. */
const afterSenderTurn = (input: Pick<TurnAfterInput, "interrupted" | "readNotices">) => {
  if (input.interrupted) return stopSentTurns()
  return settleSentTurns(input.readNotices)
}

/** The child turns the sender's interrupt stopped, as one notice for its next turn. */
const stoppedTurnNotices = Effect.fn("SessionTools.stoppedTurnNotices")(function* () {
  const ctx = yield* ExtensionContext
  const stopped = (yield* Ref.get(yield* SentTurns)).stopped.filter(sentBy(ctx))
  if (stopped.length === 0) return []
  const lines = stopped.map((turn) => {
    const name = Option.match(turn.name, {
      onNone: () => "",
      onSome: (value) => ` "${value}"`,
    })
    return `- session ${turn.sessionId}${name}`
  })
  return [
    {
      id: "session-send-stopped",
      keys: stopped.map((turn) => turn.messageId),
      content: `# Stopped child turns\n\nThe user interrupted your turn, and that stopped the turns your session.send messages had started in these children. Those turns are not running, and no answer will come from them. Tell the user which children stopped; send to them again only when the user asks for it.\n\n${[...new Set(lines)].join("\n")}`,
    },
  ]
})

const SendSessionTool = tool({
  id: "session.send",
  description:
    "Send a message to another session: `parent` for the one that started you, or a session id from delegate.list. A running session reads it at its next step; an idle one wakes to answer. Use it to ask your parent a question, hand a child a correction, or pass a sibling a fact.",
  params: SendSessionParams,
  output: SendSessionResult,
  summary: (input, output) => `to ${output.relation} · ${input.message.trim()}`,
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
    const activeBranchId = receiver.activeBranchId
    // A child reports to the branch that owns it, not to whichever branch
    // the person has open on the parent now, whether it names "parent" or
    // the parent's id.
    const branchId = Option.fromUndefinedOr(sender.parentBranchId).pipe(
      Option.filter(() => targetId === sender.parentSessionId),
      Option.getOrElse(() => activeBranchId),
    )
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
    const requestId = RequestId.make(`session-send:${ctx.toolCallId}`)
    const messageId = interjectionMessageId(requestId)
    // Recorded before the send: a turn the send opens can end before the send returns.
    if (relation === "child") {
      yield* recordSentTurn({
        senderSessionId: ctx.sessionId,
        senderBranchId: ctx.branchId,
        sessionId: receiver.id,
        branchId,
        name: Option.fromUndefinedOr(receiver.name),
        messageId,
        stopping: false,
      })
    }
    yield* ctx.Session.send({
      delivery: "steer",
      sessionId: receiver.id,
      branchId,
      requestId,
      content: sessionMessageText({ from, message }),
      metadata: {
        customType: SESSION_MESSAGE_TYPE,
        extensionId: SESSION_TOOLS_EXTENSION_ID,
        details,
      },
      // The receiver may be idle; a parked message nobody reads is a lost question.
      wake: true,
    }).pipe(
      Effect.tapError(() => forgetSentTurn(messageId)),
      Effect.mapError((e) => new SendSessionError({ message: `Cannot deliver: ${e.message}` })),
    )
    return { sessionId: receiver.id, relation }
  }),
})

// ── extension ───────────────────────────────────────────────────────────────

/** `session.send` is how sessions talk; the section is its owner's, shown wherever the tool may run. */
const SESSIONS_SECTION = {
  id: "sessions",
  priority: 14,
  content: `# Sessions

- Sessions talk with session.send: correct a running child, answer a child's question, or ask the session that spawned you when you are blocked on a decision in a turn whose reply does not return to it (a child's task turn returns its reply as its completion). A message wakes an idle session.`,
}

export const SessionToolsExtension = defineExtension({
  id: SESSION_TOOLS_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", ReadSessionTool, RenameSessionTool, SendSessionTool)
    yield* host.register("resource", SentTurnsResource)
    // Every turn end is read twice: as the end of a turn a send opened, and
    // as the sender's own turn, which stops what its sends opened when it was
    // interrupted and settles the record when it was not.
    yield* host.on("turnAfter", (input) =>
      onSentTurnEnd(input).pipe(
        Effect.andThen(afterSenderTurn(input)),
        Effect.catchCause((cause) =>
          Effect.logWarning("session-send.turn-after.failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          ),
        ),
      ),
    )
    yield* host.on("turnProjection", ({ agent }) =>
      stoppedTurnNotices().pipe(
        Effect.map((notices) => {
          if (agent.deniedTools?.includes(SendSessionTool.id) === true) return { notices }
          return { promptSections: [SESSIONS_SECTION], notices }
        }),
      ),
    )
    yield* host.on("systemPrompt", (input) => {
      if (input.interactive === false) {
        return Effect.succeed(input.basePrompt)
      }
      return Effect.succeed(input.basePrompt + NAMING_INSTRUCTION)
    })
  }),
})
