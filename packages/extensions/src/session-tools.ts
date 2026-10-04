import { Cause, Context, Effect, Layer, Option, Predicate, Ref, Schema } from "effect"
import {
  AGENT_PROMPT_PRIORITY,
  type Branch,
  BranchId,
  DEFAULT_SESSION_NAME,
  defineExtension,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  getToolId,
  headTailChars,
  interjectionMessageId,
  isRuntimeUserMessage,
  isSpawnedSession,
  type Message,
  type MessageId,
  messagePartsDisplayText,
  RequestId,
  SessionId,
  tool,
  type TurnAfterInput,
} from "@gent/core/extensions/api"

// Test seam: only tests read these exports. renderSessionTree is pure with
// unit tests; ReadSessionTool is the capability the cell signature tests render.

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

const renderMessageParts = (parts: ReadonlyArray<Message["parts"][number]>): string =>
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

/** A code fence: three or more backticks or tildes at the start of a trimmed line. */
const FENCE = /^(?:`{3,}|~{3,})/
/** Markdown that opens a line: a heading, a quote, a list bullet, a rule, emphasis. */
const LEADING_MARKERS = /^(?:(?:#{1,6}|[-*+]|[-*_]{3,})(?=\s|$)|\*\*|__|>)\s*/
const TRAILING_EMPHASIS = /\s*(?:\*\*|__)$/

/** A line with its markdown markers taken off both ends. */
const plainWords = (line: string): string => {
  let words = line
  let previous = ""
  while (words !== previous) {
    previous = words
    words = words.replace(LEADING_MARKERS, "").replace(TRAILING_EMPHASIS, "")
  }
  return words.trim()
}

/**
 * The first plain words of `text`: the first line with words on it once its
 * markdown markers are off. A fenced block, as an `@file` reference expands
 * to, is skipped. Only a fence of the opener's character, as long or longer,
 * closes it, so a shorter fence inside is block text. Words after the closing
 * fence count: the TUI writes the user's next words on that line.
 */
export const sessionTitleOf = (text: string): Option.Option<string> => {
  let opener = Option.none<string>()
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    const fence = Option.map(Option.fromNullishOr(FENCE.exec(line)), (found) => found[0])
    let rest = line
    if (Option.isNone(opener)) {
      if (Option.isSome(fence)) {
        opener = fence
        continue
      }
    } else {
      const open = opener.value
      if (Option.isNone(fence)) continue
      if (fence.value[0] !== open[0] || fence.value.length < open.length) continue
      opener = Option.none()
      rest = line.slice(fence.value.length)
    }
    const words = plainWords(rest)
    if (words.length > 0) return Option.some(words)
  }
  return Option.none()
}

/**
 * The sessions this process found no text to name from, so a session whose
 * first message has no text loads its history once per process, not at
 * every turn end.
 */
class Untitled extends Context.Service<Untitled, Ref.Ref<ReadonlySet<SessionId>>>()(
  "@gent/extensions/src/session-tools/Untitled",
) {}

const UntitledResource = defineResource({
  id: "@gent/session-tools/untitled",
  scope: "process",
  layer: Layer.effect(Untitled, Ref.make<ReadonlySet<SessionId>>(new Set())),
})

/**
 * A session that still has the default name takes the first plain words of
 * its first user message (`sessionTitleOf`) at a turn end, as a delegate
 * child takes its task. The
 * rename trims it to the title length. A name given before, by the create or
 * by `rename_session`, is left alone: the rename expects the default name,
 * and the write checks it, so a rename that lands after the read here wins.
 * A first message with no text leaves the default name.
 */
const nameFromFirstMessage = Effect.fn("SessionTools.nameFromFirstMessage")(function* (
  input: Pick<TurnAfterInput, "sessionId" | "branchId">,
) {
  const ctx = yield* ExtensionContext
  const session = Option.fromUndefinedOr(yield* ctx.Session.getSession(input.sessionId))
  if (!Option.exists(session, (found) => found.name === DEFAULT_SESSION_NAME)) return
  const untitled = yield* Untitled
  if ((yield* Ref.get(untitled)).has(input.sessionId)) return
  const detail = yield* ctx.Session.getDetail(input.sessionId)
  const title = Option.fromUndefinedOr(
    detail.branches.find((entry) => entry.branch.id === input.branchId),
  ).pipe(
    Option.flatMap((entry) =>
      Option.fromUndefinedOr(
        entry.messages.find((message) => message.role === "user" && !isRuntimeUserMessage(message)),
      ),
    ),
    Option.flatMap((message) => sessionTitleOf(messagePartsDisplayText(message.parts))),
  )
  if (Option.isNone(title)) {
    yield* Ref.update(untitled, (current) => new Set([...current, input.sessionId]))
    return
  }
  yield* ctx.Session.renameCurrent(title.value, { expectedName: DEFAULT_SESSION_NAME })
})

const RenameSessionParams = Schema.Struct({
  name: Schema.String.annotate({
    description: "The new session name",
  }),
})

const RenameSessionResult = Schema.Struct({
  renamed: Schema.Boolean,
  name: Schema.optional(Schema.String),
})

const RenameSessionTool = tool({
  id: "rename_session",
  // A session takes its first message as its name at a turn end
  // (`nameFromFirstMessage`), so this tool is for a rename the user asks for.
  description: "Rename the current session.",
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

/** How one session stands to another. */
const Relation = Schema.Literals(["parent", "child", "session"])
type Relation = typeof Relation.Type

/** The sender, as the receiving client sees it. */
export const SessionMessageDetails = Schema.Struct({
  from: Schema.Struct({
    sessionId: SessionId,
    /** The branch that sent it. Rows stored before the field have none. */
    branchId: Schema.optional(BranchId),
    name: Schema.optional(Schema.String),
    /** How the sender stands to the receiver. */
    relation: Relation,
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
  relation: Relation,
})

type RelatedSession = Parameters<typeof isSpawnedSession>[0]

/** Parent and child only across a spawn; a handoff continues its predecessor's thread. */
const relationOf = (sender: RelatedSession, receiver: RelatedSession): Relation => {
  if (sender.parentSessionId === receiver.id && isSpawnedSession(sender)) return "parent"
  if (receiver.parentSessionId === sender.id && isSpawnedSession(receiver)) return "child"
  return "session"
}

const inverse = (relation: Relation): Relation => {
  if (relation === "parent") return "child"
  if (relation === "child") return "parent"
  return "session"
}

/** The header the model reads: who wrote it, and what they are to the reader. */
type SessionMessageSender = {
  readonly sessionId: SessionId
  readonly name?: string
  readonly relation: Relation
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
 * the same way, by the one stop that names its message. When the sender's
 * delegate stop reached the child's turn first, that stop took the waiting
 * message with the turn: the send stop then reaches nothing, and the child
 * is named once, under the delegate's stopped children. A turn the user
 * opened in the child is not the sender's, and the stop never names it.
 *
 * Only sends to a child are kept: an interrupt reaches down the spawn tree,
 * as the delegate registry's does for a child's first turn, never up to a
 * parent or across to a sibling.
 *
 * The record lives in memory, keyed by the child session and the message.
 * A send that fails keeps its record: the message may still have landed.
 * The record drops a message when the turn it opened ends, when the sender's
 * interrupt stops it or finds nothing left to stop, and when the sender or
 * the child session no longer exists. A message a step joined into a turn
 * another message opened stays until one of those. Only a stop that reports
 * it reached the message (`Session.stopMessage`) becomes a notice; a stop
 * that fails is logged, and the record stays for the next interrupt. A
 * notice lives until an answered turn of the sender reads it. A restart
 * forgets both: a child turn the restart resumes is not stopped by the
 * sender's next interrupt.
 */

interface SentTurn {
  readonly senderSessionId: SessionId
  readonly senderBranchId: BranchId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly name: Option.Option<string>
  /** The message the send landed; the turn it opens carries the same id. */
  readonly messageId: MessageId
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

/** One message in one child session: the record's key. */
const sameSent =
  (key: { readonly sessionId: SessionId; readonly messageId: MessageId }) =>
  (turn: { readonly sessionId: SessionId; readonly messageId: MessageId }) =>
    turn.sessionId === key.sessionId && turn.messageId === key.messageId

const recordSentTurn = (turn: SentTurn) =>
  Effect.flatMap(SentTurns, (state) =>
    Ref.update(state, (current) => ({
      ...current,
      sent: [...current.sent.filter(Predicate.not(sameSent(turn))), turn],
    })),
  )

/**
 * A turn ended somewhere. When a send opened it, or a step joined a send into
 * it, the record drops that send: a joined send has no turn end of its own.
 */
const onSentTurnEnd = (
  input: Pick<TurnAfterInput, "sessionId" | "messageId" | "joinedMessageIds">,
) =>
  Effect.flatMap(SentTurns, (state) =>
    Ref.update(state, (current) => ({
      ...current,
      sent: current.sent.filter(
        (turn) =>
          turn.sessionId !== input.sessionId ||
          (turn.messageId !== input.messageId && !input.joinedMessageIds.has(turn.messageId)),
      ),
    })),
  )

/**
 * The stop's own answer settles the record: a stop that reached the message
 * (stopped its turn, or took it back before a step read it) is a notice; a
 * stop that found nothing is no news. Either way nothing is left to stop.
 */
const settleStop = (turn: SentTurn, reached: boolean) =>
  Effect.flatMap(SentTurns, (state) =>
    Ref.update(state, (current) => {
      const sent = current.sent.filter(Predicate.not(sameSent(turn)))
      if (!reached || current.stopped.some(sameSent(turn))) return { ...current, sent }
      return { sent, stopped: [...current.stopped, turn] }
    }),
  )

/** A child that does not answer a stop in time holds its sender's interrupt no longer than this. */
const STOP_TIMEOUT = "10 seconds"
/** Stops for one interrupt run side by side, a few at a time. */
const STOP_CONCURRENCY = 8

/**
 * The sender's interrupted turn stops every message its sends landed that
 * the record still holds. Each stop carries a fresh request id, so a later
 * interrupt retries a stop that failed instead of replaying its failure.
 */
const stopSentTurns = Effect.fn("SessionTools.stopSentTurns")(function* () {
  const ctx = yield* ExtensionContext
  const mine = (yield* Ref.get(yield* SentTurns)).sent.filter(sentBy(ctx))
  yield* Effect.forEach(
    mine,
    (turn) =>
      ctx.Session.stopMessage({
        sessionId: turn.sessionId,
        branchId: turn.branchId,
        messageId: turn.messageId,
      }).pipe(
        Effect.timeout(STOP_TIMEOUT),
        Effect.matchCauseEffect({
          onSuccess: (reached) => settleStop(turn, reached),
          onFailure: (cause) =>
            Effect.logWarning("session-send.stop.failed").pipe(
              Effect.annotateLogs({ messageId: turn.messageId, cause: Cause.pretty(cause) }),
            ),
        }),
      ),
    { concurrency: STOP_CONCURRENCY, discard: true },
  )
})

/**
 * A sender turn that was not interrupted drops the notices its answer read,
 * and its own records whose child session no longer exists: nothing can stop
 * those. Only this sender's children are read; the sender exists, since its
 * turn just ended. A session that cannot be read now is kept. A sender deleted
 * with its children keeps its records until the process ends; they name
 * nothing that runs.
 */
const settleSentTurns = Effect.fn("SessionTools.settleSentTurns")(function* (
  readNotices: ReadonlySet<string>,
) {
  const ctx = yield* ExtensionContext
  const state = yield* SentTurns
  const mine = sentBy(ctx)
  const current = yield* Ref.get(state)
  const ownSent = current.sent.filter(mine)
  if (ownSent.length === 0 && !current.stopped.some(mine)) return
  const named = new Set<SessionId>(ownSent.map((turn) => turn.sessionId))
  const gone = new Set<SessionId>()
  yield* Effect.forEach(
    named,
    (sessionId) =>
      ctx.Session.getSession(sessionId).pipe(
        Effect.map((session) => {
          if (Predicate.isUndefined(session)) gone.add(sessionId)
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("session-send.settle.read-failed").pipe(
            Effect.annotateLogs({ sessionId, cause: Cause.pretty(cause) }),
          ),
        ),
      ),
    { concurrency: 4, discard: true },
  )
  const read = (turn: StoppedTurn) => mine(turn) && readNotices.has(turn.messageId)
  yield* Ref.update(state, (latest) => ({
    sent: latest.sent.filter((turn) => !mine(turn) || !gone.has(turn.sessionId)),
    stopped: latest.stopped.filter((turn) => !read(turn)),
  }))
})

/** The sender's own turn end: an interrupt stops what its sends landed; any other end settles. */
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
      content: `# Stopped child turns\n\nThe user interrupted your turn, and that stopped what your session.send messages had started in these children: a turn a message opened was stopped, or a message no step had read yet was taken back. Nothing runs from them, and no answer will come from them. Tell the user which children stopped; send to them again only when the user asks for it.\n\n${[...new Set(lines)].join("\n")}`,
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
      branchId: ctx.branchId,
      ...Option.match(Option.fromUndefinedOr(sender.name), {
        onNone: () => ({}),
        onSome: (name) => ({ name }),
      }),
      relation: inverse(relation),
    }
    const details: SessionMessageDetails = { from }
    const requestId = RequestId.make(`session-send:${ctx.toolCallId}`)
    const messageId = interjectionMessageId(requestId)
    // Recorded before the send: a turn the send opens can end before the send
    // returns. A failed send keeps it: the message may still have landed.
    if (relation === "child") {
      yield* recordSentTurn({
        senderSessionId: ctx.sessionId,
        senderBranchId: ctx.branchId,
        sessionId: receiver.id,
        branchId,
        name: Option.fromUndefinedOr(receiver.name),
        messageId,
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
      Effect.mapError((e) => new SendSessionError({ message: `Cannot deliver: ${e.message}` })),
    )
    return { sessionId: receiver.id, relation }
  }),
})

// ── extension ───────────────────────────────────────────────────────────────

/**
 * `session.send` is how sessions talk; the section is its owner's, shown
 * wherever the tool may run. An agent that denies the tool lacks it, so it
 * sits in the agent's own part of the prompt, after the part a child shares
 * with its parent (core's `AGENT_PROMPT_PRIORITY`).
 */
const SESSIONS_SECTION = {
  id: "sessions",
  priority: AGENT_PROMPT_PRIORITY + 10,
  content: `# Sessions

- Sessions talk with session.send: correct a running child, answer a child's question, or ask the session that spawned you when you are blocked on a decision in a turn whose reply does not return to it (a child's task turn returns its reply as its completion). A message wakes an idle session.`,
}

export const SessionToolsExtension = defineExtension({
  id: SESSION_TOOLS_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", ReadSessionTool, RenameSessionTool, SendSessionTool)
    yield* host.register("resource", SentTurnsResource, UntitledResource)
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
          if (!agent.admitsTool(getToolId(SendSessionTool))) return { notices }
          return { promptSections: [SESSIONS_SECTION], notices }
        }),
      ),
    )
    yield* host.on("turnAfter", (input) =>
      nameFromFirstMessage(input).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("session-naming.failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          ),
        ),
      ),
    )
  }),
})
