/**
 * `gent ctl`: drive a running gent server from a shell, one session per
 * call, over the RPC the TUI uses.
 *
 * A call finds the server the data directory names (`GENT_DATA_DIR`, else
 * `~/.gent`), the way `gent doctor` does, or the one `--connect` names. It
 * never starts a server. Each command prints one JSON value on stdout; an
 * array of records prints one record per line, so a reader takes the lines it
 * needs. A failure prints one tagged JSON error on stderr and exits with the
 * code the error names (`CTL_EXIT`).
 */
import {
  AgentEvent,
  BranchId,
  type EventEnvelope,
  EventEnvelope as EventEnvelopeSchema,
  ExtensionId,
  type GentClientRpcError,
  type GentNamespacedClient,
  messagePartsText,
  MessageId,
  ModelId,
  type ProjectedMessage,
  SessionId,
  SessionSnapshot,
  userMessageIdForRequest,
} from "@gent/core/protocol"
import type { GentPlatform } from "@gent/core/host"
import { Gent, serverLock, dataPaths } from "@gent/sdk"
import {
  Clock,
  Duration,
  Effect,
  Filter,
  type FileSystem,
  Option,
  Predicate,
  Ref,
  Runtime,
  Schema,
  type Scope,
  Stdio,
  Stream,
} from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { connectFlag, readHome } from "./ops"
import { isConversation, randomId } from "./utils"

// ── exit codes and errors ───────────────────────────────────────────────────

/**
 * The process exit code of each outcome. A flag the parser refuses exits 1
 * with the parser's own message, before any of these.
 */
export const CTL_EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  noServer: 3,
  notFound: 4,
  timedOut: 124,
} as const

/** A call that failed for a reason no other error names: an RPC error, a lost connection. */
class CtlFailed extends Schema.TaggedError<CtlFailed, { readonly brand: unique symbol }>()(
  "CtlFailed",
  { message: Schema.String },
) {
  override readonly [Runtime.errorExitCode] = CTL_EXIT.failed
  override readonly [Runtime.errorReported] = false
}

/** Flags that parse but do not fit together. */
class CtlUsage extends Schema.TaggedError<CtlUsage, { readonly brand: unique symbol }>()(
  "CtlUsage",
  { message: Schema.String },
) {
  override readonly [Runtime.errorExitCode] = CTL_EXIT.usage
  override readonly [Runtime.errorReported] = false
}

/** No live server for the data directory. */
class CtlNoServer extends Schema.TaggedError<CtlNoServer, { readonly brand: unique symbol }>()(
  "CtlNoServer",
  { dataDir: Schema.String, message: Schema.String },
) {
  override readonly [Runtime.errorExitCode] = CTL_EXIT.noServer
  override readonly [Runtime.errorReported] = false
}

/** The session, branch or run the call names does not exist, or is not the caller's. */
class CtlNotFound extends Schema.TaggedError<CtlNotFound, { readonly brand: unique symbol }>()(
  "CtlNotFound",
  { message: Schema.String },
) {
  override readonly [Runtime.errorExitCode] = CTL_EXIT.notFound
  override readonly [Runtime.errorReported] = false
}

/** `wait` saw no match within its timeout. `cursor`: the last event id it read. */
class CtlWaitTimedOut extends Schema.TaggedError<
  CtlWaitTimedOut,
  { readonly brand: unique symbol }
>()("CtlWaitTimedOut", {
  until: Schema.String,
  seconds: Schema.Finite,
  cursor: Schema.OptionFromNullOr(Schema.Finite),
}) {
  override readonly [Runtime.errorExitCode] = CTL_EXIT.timedOut
  override readonly [Runtime.errorReported] = false
}

const CtlError = Schema.Union([CtlFailed, CtlUsage, CtlNoServer, CtlNotFound, CtlWaitTimedOut])
type CtlError = typeof CtlError.Type

const rpcFailure = (error: GentClientRpcError): CtlError => {
  if (error._tag === "NotFoundError") return new CtlNotFound({ message: error.message })
  if ("message" in error && Predicate.isString(error.message)) {
    return new CtlFailed({ message: `${error._tag}: ${error.message}` })
  }
  return new CtlFailed({ message: String(error) })
}

// ── output ──────────────────────────────────────────────────────────────────

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

/**
 * One JSON value as text: an object's array of records prints one record per
 * line, every other field stays on the first line.
 */
const asJsonObject = Schema.decodeUnknownOption(Schema.JsonObject)
const asRecordList = Schema.decodeUnknownOption(Schema.NonEmptyArray(Schema.JsonObject))

const renderJson = (value: Schema.Json): string =>
  Option.match(asJsonObject(value), {
    onNone: () => encodeJsonText(value),
    onSome: (object) => {
      const fields = Object.entries(object).map(([key, field]) => {
        const name = encodeJsonText(key)
        return Option.match(asRecordList(field), {
          onNone: () => `${name}:${encodeJsonText(field)}`,
          onSome: (records) =>
            `${name}:[\n${records.map((record) => encodeJsonText(record)).join(",\n")}\n]`,
        })
      })
      return `{${fields.join(",")}}`
    },
  })

/** Write `value`, encoded by `schema`, as the call's one JSON value on stdout. */
const printResult = <A, I>(schema: Schema.Codec<A, I>, value: A) =>
  Effect.gen(function* () {
    const text = yield* Schema.encodeEffect(Schema.fromJsonString(schema))(value)
    const json = yield* decodeJsonText(text)
    const stdio = yield* Stdio.Stdio
    yield* Stream.make(`${renderJson(json)}\n`).pipe(Stream.run(stdio.stdout()))
  }).pipe(Effect.mapError((error) => new CtlFailed({ message: `output encode: ${error.message}` })))

/** Print a ctl error as one JSON line on stderr, then fail with it for its exit code. */
const reportCtlError = (error: CtlError) =>
  Effect.gen(function* () {
    const text = yield* Schema.encodeEffect(Schema.fromJsonString(CtlError))(error).pipe(
      Effect.orElseSucceed(() => `{"_tag":"CtlFailed","message":${encodeJsonText(String(error))}}`),
    )
    const stdio = yield* Stdio.Stdio
    yield* Stream.make(`${text}\n`).pipe(Stream.run(stdio.stderr()), Effect.ignore)
    return yield* error
  })

// ── compact records ─────────────────────────────────────────────────────────

/** A one-line view of an event. A run of `StreamChunk` events folds into one record. */
const CompactEvent = Schema.Struct({
  id: Schema.Finite,
  tag: Schema.String,
  /** Folded `StreamChunk` events. */
  n: Schema.optionalKey(Schema.Int),
  role: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(Schema.String),
  call: Schema.optionalKey(Schema.String),
  step: Schema.optionalKey(Schema.Int),
  outcome: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  ms: Schema.optionalKey(Schema.Finite),
  flags: Schema.optionalKey(Schema.Array(Schema.String)),
  error: Schema.optionalKey(Schema.String),
  ext: Schema.optionalKey(Schema.String),
  request: Schema.optionalKey(Schema.String),
  approved: Schema.optionalKey(Schema.Boolean),
})
type CompactEvent = typeof CompactEvent.Type

/** `text` on one line, cut to `max` characters with an ellipsis. */
const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim()
  if (line.length <= max) return line
  return `${line.slice(0, max - 1)}…`
}

const TEXT_CLIP = 120

const turnFlags = (event: typeof AgentEvent.cases.TurnCompleted.Type): ReadonlyArray<string> => [
  ...Option.toArray(Option.liftPredicate("interrupted", () => event.interrupted === true)),
  ...Option.toArray(Option.liftPredicate("streamFailed", () => event.streamFailed === true)),
  ...Option.toArray(Option.liftPredicate("unanswered", () => event.unanswered === true)),
]

/** The fields of one event that a check reads; never the whole body. */
const eventFields = (event: AgentEvent): Omit<CompactEvent, "id" | "tag"> =>
  AgentEvent.match(event, {
    SessionStarted: () => ({}),
    MessageReceived: ({ message }) => ({
      role: message.role,
      message: message.id,
      text: clip(messagePartsText(message.parts), TEXT_CLIP),
    }),
    StreamStarted: (e) =>
      Object.fromEntries(
        Option.toArray(Option.map(Option.fromUndefinedOr(e.step), (step) => ["step", step])),
      ),
    StreamChunk: ({ chunk }) => ({ n: 1, text: chunk }),
    ModelRouted: ({ model }) => ({ model }),
    CredentialAssigned: () => ({}),
    StreamEnded: (e) => ({
      ...Option.match(Option.fromUndefinedOr(e.step), {
        onNone: () => ({}),
        onSome: (step) => ({ step }),
      }),
      ...Option.match(Option.fromUndefinedOr(e.outcome), {
        onNone: () => ({}),
        onSome: (outcome) => ({ outcome }),
      }),
      ...Option.match(Option.fromUndefinedOr(e.model), {
        onNone: () => ({}),
        onSome: (model) => ({ model }),
      }),
    }),
    TurnCompleted: (e) => ({
      ...Option.match(Option.fromUndefinedOr(e.messageId), {
        onNone: () => ({}),
        onSome: (message) => ({ message }),
      }),
      ms: e.durationMs,
      flags: turnFlags(e),
    }),
    ModelContextProjected: () => ({}),
    ToolCallStarted: ({ toolName, toolCallId }) => ({ tool: toolName, call: toolCallId }),
    ToolCallSucceeded: (e) => ({
      tool: e.toolName,
      call: e.toolCallId,
      ...Option.match(Option.fromUndefinedOr(e.summary), {
        onNone: () => ({}),
        onSome: (summary) => ({ text: clip(summary, TEXT_CLIP) }),
      }),
    }),
    ToolCallFailed: (e) => ({
      tool: e.toolName,
      call: e.toolCallId,
      ...Option.match(Option.fromUndefinedOr(e.summary), {
        onNone: () => ({}),
        onSome: (summary) => ({ error: clip(summary, TEXT_CLIP) }),
      }),
    }),
    InteractionPresented: ({ requestId, text }) => ({
      request: requestId,
      text: clip(text, TEXT_CLIP),
    }),
    InteractionResolved: ({ requestId, approved }) => ({ request: requestId, approved }),
    ErrorOccurred: (e) => ({
      error: clip(e.error, TEXT_CLIP),
      ...Option.match(Option.fromUndefinedOr(e.notice), {
        onNone: () => ({}),
        onSome: () => ({ flags: ["notice"] }),
      }),
    }),
    ProviderRetrying: ({ attempt, error }) => ({ step: attempt, error: clip(error, TEXT_CLIP) }),
    SessionNameUpdated: ({ name }) => ({ text: name }),
    SessionSettingsUpdated: (e) =>
      Option.match(Option.fromUndefinedOr(e.modelId), {
        onNone: () => ({}),
        onSome: (model) => ({ model }),
      }),
    BranchCreated: () => ({}),
    BranchSwitched: () => ({}),
    ExtensionStateChanged: ({ extensionId }) => ({ ext: extensionId }),
    StreamSynchronized: () => ({}),
  })

const compactEvent = (envelope: EventEnvelope): CompactEvent => ({
  id: envelope.id,
  tag: envelope.event._tag,
  ...eventFields(envelope.event),
})

/**
 * Compact records for `envelopes`, in order. Consecutive `StreamChunk`
 * events fold into one record: its id is the last chunk's, so it is a cursor,
 * `n` counts the chunks, and `text` is their text clipped.
 */
export const compactEvents = (
  envelopes: ReadonlyArray<EventEnvelope>,
): ReadonlyArray<CompactEvent> => {
  const records: Array<CompactEvent> = []
  let chunkText = ""
  for (const envelope of envelopes) {
    const record = compactEvent(envelope)
    const previous = records.at(-1)
    if (record.tag === "StreamChunk" && previous?.tag === "StreamChunk") {
      chunkText += record.text ?? ""
      records[records.length - 1] = {
        ...previous,
        id: record.id,
        n: (previous.n ?? 1) + 1,
        text: clip(chunkText, TEXT_CLIP),
      }
      continue
    }
    if (record.tag !== "StreamChunk") {
      records.push(record)
      continue
    }
    chunkText = record.text ?? ""
    records.push({ ...record, text: clip(chunkText, TEXT_CLIP) })
  }
  return records
}

// ── results ─────────────────────────────────────────────────────────────────

const Target = { sessionId: SessionId, branchId: BranchId }

const CompactMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.String,
  kind: Schema.String,
  text: Schema.String,
  tools: Schema.Int,
})
type CompactMessage = typeof CompactMessage.Type

const QueueCounts = Schema.Struct({ steering: Schema.Int, followUp: Schema.Int })

/** What each ctl command prints on success. */
export const CtlResult = Schema.TaggedUnion({
  /** `send`: the message is admitted; `wait --message <messageId>` waits for its turn. */
  Sent: {
    ...Target,
    requestId: Schema.String,
    messageId: Schema.String,
    created: Schema.Boolean,
  },
  /** A turn's `TurnCompleted`: `from` is its opening message's event id, `cursor` its own. */
  TurnEnded: {
    ...Target,
    messageId: Schema.optionalKey(Schema.String),
    from: Schema.OptionFromNullOr(Schema.Finite),
    cursor: Schema.Finite,
    ok: Schema.Boolean,
    flags: Schema.Array(Schema.String),
    durationMs: Schema.Finite,
    /** The turn's streamed text, clipped; `replyChars` is its full length. */
    reply: Schema.String,
    replyChars: Schema.Int,
  },
  /** `wait --until idle`: the branch runs no turn and holds no queued message. */
  Idle: { ...Target },
  /** `wait --until <EventTag>`: the first such event. */
  Seen: { ...Target, cursor: Schema.Finite, event: CompactEvent },
  /** `events`: compact records after `since`; `cursor` is the last record's id. */
  Events: {
    ...Target,
    cursor: Schema.OptionFromNullOr(Schema.Finite),
    more: Schema.Boolean,
    events: Schema.Array(CompactEvent),
  },
  /** `events --full`: the envelopes as stored. */
  EventsFull: {
    ...Target,
    cursor: Schema.OptionFromNullOr(Schema.Finite),
    more: Schema.Boolean,
    envelopes: Schema.Array(EventEnvelopeSchema),
  },
  /** `snapshot`: the session's state and its last messages, compacted. */
  Snapshot: {
    ...Target,
    name: Schema.optionalKey(Schema.String),
    agent: Schema.String,
    model: Schema.optionalKey(Schema.String),
    runtime: Schema.String,
    queued: QueueCounts,
    turns: Schema.Finite,
    costUsd: Schema.Finite,
    lastEventId: Schema.NullOr(Schema.Finite),
    messageCount: Schema.Int,
    messages: Schema.Array(CompactMessage),
  },
  /** `snapshot --full`: the snapshot as the RPC returns it. */
  SnapshotFull: { snapshot: SessionSnapshot },
  /** `status`: the branch's runtime state and the server that answered. */
  Status: {
    ...Target,
    runtime: Schema.String,
    queued: QueueCounts,
    runningMs: Schema.optionalKey(Schema.Finite),
    server: Schema.String,
  },
  /** `request`: an extension request's reply, as the extension encodes it. */
  /** `reply` is absent when the request answers nothing. */
  Reply: {
    ...Target,
    extensionId: Schema.String,
    requestId: Schema.String,
    reply: Schema.optionalKey(Schema.Json),
  },
})
export type CtlResult = typeof CtlResult.Type

// ── server and session ──────────────────────────────────────────────────────

const CONNECT_TIMEOUT = "5 seconds"

/** A client of the server the call addresses, and the url it answers on. */
interface CtlConnection {
  readonly client: GentNamespacedClient
  readonly server: string
}

/**
 * Attach to the server `connect` names, or the one the data directory's lock
 * names. A call never starts a server: with none, it fails `CtlNoServer`.
 */
const connectCtl = Effect.fn("Ctl.connect")(function* (options: {
  readonly connect: Option.Option<string>
  readonly cwd: string
}) {
  const attach = (url: string) =>
    Effect.gen(function* () {
      const bundle = yield* Gent.client(url, { cwd: options.cwd })
      yield* bundle.runtime.lifecycle.waitForReady
      return { client: bundle.client, server: url } satisfies CtlConnection
    }).pipe(
      Effect.timeoutOrElse({
        duration: CONNECT_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new CtlFailed({ message: `no answer within ${CONNECT_TIMEOUT} from ${url}` }),
          ),
      }),
      Effect.mapError((error) => {
        if (error._tag === "CtlFailed") return error
        return new CtlFailed({ message: error.message })
      }),
    )
  if (Option.isSome(options.connect)) return yield* attach(options.connect.value)
  const home = yield* readHome.pipe(
    Effect.mapError((error) => new CtlFailed({ message: `HOME: ${error.message}` })),
  )
  const { dataDir } = yield* dataPaths(home)
  const status = yield* serverLock
    .status(home)
    .pipe(Effect.mapError((error) => new CtlFailed({ message: error.message })))
  if (status._tag !== "Alive") {
    const reasons = {
      None: "no server for this data directory",
      Unnamed: "a server holds the lock but has not named itself yet; retry",
      Stale: "the server the lock names is gone",
    } as const
    return yield* new CtlNoServer({
      dataDir,
      message: `${reasons[status._tag]}; start one with \`gent\` or \`gent server start\` under the same GENT_DATA_DIR`,
    })
  }
  if (!(yield* serverLock.probe(status.entry))) {
    return yield* new CtlNoServer({
      dataDir,
      message: `PID ${status.entry.pid} holds the lock but does not answer at ${status.entry.rpcUrl}`,
    })
  }
  return yield* attach(status.entry.rpcUrl)
})

/** The session and branch a call names: `--session`, else the newest conversation in `cwd`. */
const resolveTarget = Effect.fn("Ctl.resolveTarget")(function* (
  client: GentNamespacedClient,
  options: {
    readonly session: Option.Option<string>
    readonly branch: Option.Option<string>
    readonly cwd: string
  },
) {
  const session = yield* Option.match(options.session, {
    onSome: (id) =>
      client.session.get({ sessionId: SessionId.make(id) }).pipe(
        Effect.mapError(rpcFailure),
        Effect.flatMap((view) =>
          Effect.fromOption(Option.fromNullishOr(view)).pipe(
            Effect.mapError(() => new CtlNotFound({ message: `no session ${id}` })),
          ),
        ),
      ),
    onNone: () =>
      client.session.list().pipe(
        Effect.mapError(rpcFailure),
        Effect.flatMap((sessions) =>
          Effect.fromOption(
            Option.fromNullishOr(
              sessions
                .filter((candidate) => candidate.cwd === options.cwd)
                .filter(isConversation)
                .toSorted((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0],
            ),
          ).pipe(
            Effect.mapError(
              () =>
                new CtlNotFound({
                  message: `no session in ${options.cwd}; pass --session <id>, or start one with \`gent ctl send --new\``,
                }),
            ),
          ),
        ),
      ),
  })
  const branchId = Option.orElse(
    Option.map(options.branch, (id) => BranchId.make(id)),
    () => Option.fromNullishOr(session.activeBranchId),
  )
  if (Option.isNone(branchId)) {
    return yield* new CtlNotFound({ message: `session ${session.id} has no active branch` })
  }
  return { sessionId: session.id, branchId: branchId.value }
})

type CtlTarget = Effect.Success<ReturnType<typeof resolveTarget>>

// ── events and waits ────────────────────────────────────────────────────────

/** The stored events of the branch after `since`, read up to the live mark. */
const storedEvents = (
  client: GentNamespacedClient,
  target: CtlTarget,
  since: Option.Option<number>,
) =>
  client.session
    .events({
      ...target,
      ...Option.match(since, { onNone: () => ({}), onSome: (after) => ({ after }) }),
    })
    .pipe(
      Stream.takeUntil((envelope) => envelope.event._tag === "StreamSynchronized"),
      Stream.filter((envelope) => envelope.event._tag !== "StreamSynchronized"),
      Stream.runCollect,
      Effect.mapError(rpcFailure),
    )

/**
 * `events`: with `since`, the first `limit` records after it; without, the
 * last `limit` records. `tags` keeps only events of those tags.
 */
const readEvents = Effect.fn("Ctl.events")(function* (
  client: GentNamespacedClient,
  target: CtlTarget,
  options: {
    readonly since: Option.Option<number>
    readonly limit: number
    readonly tags: ReadonlyArray<string>
    readonly full: boolean
  },
) {
  const stored = (yield* storedEvents(client, target, options.since)).filter(
    (envelope) => options.tags.length === 0 || options.tags.includes(envelope.event._tag),
  )
  const window = <A>(items: ReadonlyArray<A>) => {
    if (Option.isSome(options.since))
      return { items: items.slice(0, options.limit), more: items.length > options.limit }
    return { items: items.slice(Math.max(0, items.length - options.limit)), more: false }
  }
  const cursorOf = (items: ReadonlyArray<{ readonly id: number }>) =>
    Option.orElse(
      Option.map(Option.fromUndefinedOr(items.at(-1)), (item) => item.id),
      () => options.since,
    )
  if (options.full) {
    const { items, more } = window(stored)
    return CtlResult.cases.EventsFull.make({
      ...target,
      cursor: cursorOf(items),
      more,
      envelopes: items,
    })
  }
  const { items, more } = window(compactEvents(stored))
  return CtlResult.cases.Events.make({ ...target, cursor: cursorOf(items), more, events: items })
})

/** What `wait` waits for. */
const EVENT_TAGS: ReadonlySet<string> = new Set(Object.keys(AgentEvent.cases))
const WaitUntil = Schema.String.check(
  Schema.makeFilter(
    (value: string) => value === "turn" || value === "idle" || EVENT_TAGS.has(value),
    {
      expected: "turn, idle, or an event tag",
    },
  ),
)

const REPLY_CLIP = 400

/**
 * Read the branch's events until `match` answers. With `after`, the stored
 * events after it count; with `replay`, every stored event counts; otherwise
 * only events that arrive after the call. `cursor` holds the last id read.
 */
const watchEvents = <A>(
  client: GentNamespacedClient,
  target: CtlTarget,
  options: {
    readonly after: Option.Option<number>
    readonly replay: boolean
    readonly cursor: Ref.Ref<Option.Option<number>>
  },
  match: (envelope: EventEnvelope) => Option.Option<A>,
) =>
  Effect.gen(function* () {
    let live = options.replay || Option.isSome(options.after)
    const found = yield* client.session
      .events({
        ...target,
        ...Option.match(options.after, { onNone: () => ({}), onSome: (after) => ({ after }) }),
      })
      .pipe(
        Stream.tap((envelope) => Ref.set(options.cursor, Option.some(envelope.id))),
        Stream.filterMap(
          Filter.fromPredicateOption((envelope: EventEnvelope) => {
            if (envelope.event._tag === "StreamSynchronized") {
              live = true
              return Option.none()
            }
            if (!live) return Option.none()
            return match(envelope)
          }),
        ),
        Stream.runHead,
        Effect.mapError(rpcFailure),
      )
    return yield* Effect.fromOption(found).pipe(
      Effect.mapError(() => new CtlFailed({ message: "the event stream ended before a match" })),
    )
  })

/**
 * The end of a turn: the `TurnCompleted` that names `message`, or with no
 * message the next one. The reply is the text the turn streamed.
 */
const awaitTurn = (
  client: GentNamespacedClient,
  target: CtlTarget,
  options: {
    readonly after: Option.Option<number>
    readonly message: Option.Option<MessageId>
    readonly cursor: Ref.Ref<Option.Option<number>>
  },
) => {
  let from = Option.none<number>()
  let reply = ""
  return watchEvents(
    client,
    target,
    { after: options.after, replay: Option.isSome(options.message), cursor: options.cursor },
    (envelope) => {
      const event = envelope.event
      if (event._tag === "MessageReceived" && event.message.role === "user") {
        if (Option.isNone(options.message) || Option.contains(options.message, event.message.id)) {
          from = Option.some(envelope.id)
          reply = ""
        }
        return Option.none()
      }
      if (event._tag === "StreamChunk") {
        reply += event.chunk
        return Option.none()
      }
      if (event._tag !== "TurnCompleted") return Option.none()
      if (Option.isSome(options.message) && event.messageId !== options.message.value)
        return Option.none()
      const flags = turnFlags(event)
      return Option.some(
        CtlResult.cases.TurnEnded.make({
          ...target,
          ...Option.match(Option.fromUndefinedOr(event.messageId), {
            onNone: () => ({}),
            onSome: (messageId) => ({ messageId }),
          }),
          from,
          cursor: envelope.id,
          ok: flags.length === 0,
          flags,
          durationMs: event.durationMs,
          reply: clip(reply, REPLY_CLIP),
          replyChars: reply.length,
        }),
      )
    },
  )
}

/** The branch runs no turn and holds nothing queued. */
const awaitIdle = (client: GentNamespacedClient, target: CtlTarget) =>
  client.session.watchRuntime(target).pipe(
    Stream.filter(
      (state) =>
        state._tag === "Idle" &&
        state.queue.steering.length === 0 &&
        state.queue.followUp.length === 0,
    ),
    Stream.runHead,
    Effect.mapError(rpcFailure),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new CtlFailed({ message: "the runtime stream ended before idle" })),
        onSome: () => Effect.succeed(CtlResult.cases.Idle.make(target)),
      }),
    ),
  )

/** `wait`: the first match of `until`, or `CtlWaitTimedOut` after `seconds`. */
const waitFor = Effect.fn("Ctl.wait")(function* (
  client: GentNamespacedClient,
  target: CtlTarget,
  options: {
    readonly until: typeof WaitUntil.Type
    readonly after: Option.Option<number>
    readonly message: Option.Option<string>
    readonly seconds: number
  },
) {
  const cursor = yield* Ref.make(Option.none<number>())
  if (Option.isSome(options.message) && options.until !== "turn") {
    return yield* new CtlUsage({ message: "--message applies to --until turn" })
  }
  const waiting: Effect.Effect<CtlResult, CtlError> = (() => {
    if (options.until === "turn")
      return awaitTurn(client, target, {
        after: options.after,
        message: Option.map(options.message, (id) => MessageId.make(id)),
        cursor,
      })
    if (options.until === "idle") return awaitIdle(client, target)
    const tag = options.until
    return watchEvents(
      client,
      target,
      { after: options.after, replay: false, cursor },
      (envelope) =>
        Option.liftPredicate(
          CtlResult.cases.Seen.make({
            ...target,
            cursor: envelope.id,
            event: compactEvent(envelope),
          }),
          () => envelope.event._tag === tag,
        ),
    )
  })()
  return yield* waiting.pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(options.seconds),
      orElse: () =>
        Effect.flatMap(Ref.get(cursor), (last) =>
          Effect.fail(
            new CtlWaitTimedOut({ until: options.until, seconds: options.seconds, cursor: last }),
          ),
        ),
    }),
  )
})

// ── send, snapshot, status ──────────────────────────────────────────────────

/**
 * `send`: admit `content` on the target branch, or on a new session in `cwd`
 * with `fresh`. The request id makes a retry safe: the server runs one send
 * per id. The message id is the one its turn's `TurnCompleted` names.
 */
const sendMessage = Effect.fn("Ctl.send")(function* (
  client: GentNamespacedClient,
  options: {
    readonly content: string
    readonly target: Option.Option<CtlTarget>
    readonly fresh: Option.Option<{ readonly cwd: string; readonly model: Option.Option<string> }>
    readonly requestId: Option.Option<string>
  },
) {
  const created = Option.isSome(options.fresh)
  const target: CtlTarget = yield* Option.match(options.fresh, {
    onSome: (fresh) =>
      client.session
        .create({
          cwd: fresh.cwd,
          ...Option.match(fresh.model, {
            onNone: () => ({}),
            onSome: (model) => ({ modelId: ModelId.make(model) }),
          }),
        })
        .pipe(
          Effect.mapError(rpcFailure),
          Effect.map(({ sessionId, branchId }) => ({ sessionId, branchId })),
        ),
    onNone: () =>
      Effect.fromOption(options.target).pipe(
        Effect.mapError(() => new CtlUsage({ message: "send needs a session or --new" })),
      ),
  })
  const requestId = yield* Option.match(options.requestId, {
    onNone: () => randomId,
    onSome: Effect.succeed,
  })
  yield* client.message
    .send({ ...target, content: options.content, requestId })
    .pipe(Effect.mapError(rpcFailure))
  return CtlResult.cases.Sent.make({
    ...target,
    requestId,
    messageId: userMessageIdForRequest(requestId),
    created,
  })
})

const compactMessage = (message: ProjectedMessage): CompactMessage => ({
  id: message.id,
  role: message.role,
  kind: message._tag,
  text: clip(messagePartsText(message.parts), TEXT_CLIP),
  tools: message.parts.filter((part) => part.type === "tool-call").length,
})

/** `snapshot`: the session's state and its last `limit` messages. */
const readSnapshot = Effect.fn("Ctl.snapshot")(function* (
  client: GentNamespacedClient,
  target: CtlTarget,
  options: { readonly limit: number; readonly full: boolean },
) {
  const snapshot = yield* client.session.getSnapshot(target).pipe(Effect.mapError(rpcFailure))
  if (options.full) return CtlResult.cases.SnapshotFull.make({ snapshot })
  return CtlResult.cases.Snapshot.make({
    ...target,
    ...Option.match(Option.fromUndefinedOr(snapshot.name), {
      onNone: () => ({}),
      onSome: (name) => ({ name }),
    }),
    agent: snapshot.agent,
    ...Option.match(Option.fromUndefinedOr(snapshot.resolvedModelId), {
      onNone: () => ({}),
      onSome: (model) => ({ model }),
    }),
    runtime: snapshot.runtime._tag,
    queued: {
      steering: snapshot.runtime.queue.steering.length,
      followUp: snapshot.runtime.queue.followUp.length,
    },
    turns: snapshot.metrics.turns,
    costUsd: snapshot.metrics.costUsd,
    lastEventId: snapshot.lastEventId,
    messageCount: snapshot.messages.length,
    messages: snapshot.messages
      .slice(Math.max(0, snapshot.messages.length - options.limit))
      .map(compactMessage),
  })
})

/** `status`: the branch's runtime state and the server that answered. */
const readStatus = Effect.fn("Ctl.status")(function* (
  connection: CtlConnection,
  target: CtlTarget,
) {
  const state = yield* connection.client.session
    .watchRuntime(target)
    .pipe(Stream.runHead, Effect.mapError(rpcFailure))
  if (Option.isNone(state))
    return yield* new CtlFailed({ message: "the runtime stream ended at once" })
  const runtime = state.value
  const now = yield* Clock.currentTimeMillis
  const fields = {
    ...target,
    runtime: runtime._tag,
    queued: { steering: runtime.queue.steering.length, followUp: runtime.queue.followUp.length },
    server: connection.server,
  }
  if (runtime._tag === "Idle") return CtlResult.cases.Status.make(fields)
  return CtlResult.cases.Status.make({
    ...fields,
    runningMs: Math.max(0, now - runtime.startedAtMs),
  })
})

/**
 * `request`: one extension request on the target session, as a client
 * extension sends it. The server checks `input` against the request's schema
 * and the session's authority; `reply` is the output the extension encodes.
 */
const sendRequest = Effect.fn("Ctl.request")(function* (
  client: GentNamespacedClient,
  target: CtlTarget,
  options: { readonly extensionId: string; readonly requestId: string; readonly input: string },
) {
  const input = yield* decodeJsonText(options.input).pipe(
    Effect.mapError(() => new CtlUsage({ message: `--input is not JSON: ${options.input}` })),
  )
  const reply = yield* client.extension
    .request({
      ...target,
      extensionId: ExtensionId.make(options.extensionId),
      capabilityId: options.requestId,
      input,
    })
    .pipe(
      Effect.mapError((error) => {
        if (error._tag === "ExtensionProtocolError")
          return new CtlFailed({ message: `${error._tag}: ${error.message}` })
        return rpcFailure(error)
      }),
    )
  const answered = {
    ...target,
    extensionId: options.extensionId,
    requestId: options.requestId,
  }
  return yield* Option.match(Option.fromUndefinedOr(reply), {
    onNone: () => Effect.succeed(CtlResult.cases.Reply.make(answered)),
    onSome: (value) =>
      Schema.decodeUnknownEffect(Schema.Json)(value).pipe(
        Effect.map((json) => CtlResult.cases.Reply.make({ ...answered, reply: json })),
        Effect.mapError(
          (error) => new CtlFailed({ message: `reply is not JSON: ${error.message}` }),
        ),
      ),
  })
})

// ── commands ────────────────────────────────────────────────────────────────

const sessionFlags = {
  connect: connectFlag,
  session: Flag.String("session").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Session id (default: the newest conversation in --cwd)"),
    Flag.optional,
  ),
  branch: Flag.String("branch").pipe(
    Flag.withDescription("Branch id (default: the session's active branch)"),
    Flag.optional,
  ),
  cwd: Flag.String("cwd").pipe(
    Flag.withDescription("Workspace directory the session runs in (default: the current one)"),
    Flag.optional,
  ),
}

interface SessionFlags {
  readonly connect: Option.Option<string>
  readonly session: Option.Option<string>
  readonly branch: Option.Option<string>
  readonly cwd: Option.Option<string>
}

const cwdOf = (flags: Pick<SessionFlags, "cwd">) => Option.getOrElse(flags.cwd, () => process.cwd())

/**
 * Run one ctl call: connect, run `body`, print its result. Every failure is
 * printed as a tagged JSON line on stderr and keeps its exit code.
 */
const runCtl = <R>(
  flags: SessionFlags,
  body: (connection: CtlConnection, cwd: string) => Effect.Effect<CtlResult, CtlError, R>,
): Effect.Effect<
  void,
  CtlError,
  R | Stdio.Stdio | Scope.Scope | FileSystem.FileSystem | GentPlatform
> =>
  Effect.gen(function* () {
    const cwd = cwdOf(flags)
    const connection = yield* connectCtl({ connect: flags.connect, cwd })
    const result = yield* body(connection, cwd)
    yield* printResult(CtlResult, result)
  }).pipe(Effect.catch(reportCtlError))

const targeted = (connection: CtlConnection, flags: SessionFlags, cwd: string) =>
  resolveTarget(connection.client, { session: flags.session, branch: flags.branch, cwd })

const timeoutFlag = Flag.Int("timeout").pipe(
  Flag.withDescription("Seconds to wait before exiting 124"),
  Flag.withDefault(60),
)

const send = Command.make(
  "send",
  {
    ...sessionFlags,
    content: Argument.String("text").pipe(Argument.withDescription("The message to send")),
    fresh: Flag.Boolean("new").pipe(
      Flag.withDescription("Start a new session in --cwd and send there"),
      Flag.withDefault(false),
    ),
    model: Flag.String("model").pipe(
      Flag.withDescription("Model of the new session, as provider/model (--new only)"),
      Flag.optional,
    ),
    requestId: Flag.String("request-id").pipe(
      Flag.withDescription("Send under this id: a retry with the same id sends once"),
      Flag.optional,
    ),
    wait: Flag.Boolean("wait").pipe(
      Flag.withDescription("Wait for the turn this message opens and print its end"),
      Flag.withDefault(false),
    ),
    timeout: timeoutFlag,
  },
  (input) =>
    Effect.scoped(
      runCtl(input, (connection, cwd) =>
        Effect.gen(function* () {
          if (Option.isSome(input.model) && !input.fresh) {
            return yield* new CtlUsage({ message: "--model applies to --new" })
          }
          if (input.fresh && Option.isSome(input.session)) {
            return yield* new CtlUsage({ message: "--new starts a session; drop --session" })
          }
          const fresh = Option.liftPredicate({ cwd, model: input.model }, () => input.fresh)
          const target = yield* Option.match(fresh, {
            onSome: () => Effect.succeed(Option.none<CtlTarget>()),
            onNone: () => Effect.asSome(targeted(connection, input, cwd)),
          })
          const sent = yield* sendMessage(connection.client, {
            content: input.content,
            target,
            fresh,
            requestId: input.requestId,
          })
          if (!input.wait) return sent
          return yield* waitFor(
            connection.client,
            { sessionId: sent.sessionId, branchId: sent.branchId },
            {
              until: "turn",
              after: Option.none(),
              message: Option.some(sent.messageId),
              seconds: input.timeout,
            },
          )
        }),
      ),
    ),
).pipe(
  Command.withDescription("Send a message to a session, as the composer does"),
  Command.withExamples([
    {
      command: 'gent ctl send --new --model anthropic/claude-sonnet-5 "hi"',
      description: "Start a session",
    },
    {
      command: 'gent ctl send -s <id> --wait "debug tools"',
      description: "Send, then wait for its turn",
    },
  ]),
)

const events = Command.make(
  "events",
  {
    ...sessionFlags,
    since: Flag.Int("since").pipe(
      Flag.withDescription("Event id cursor: list the events after it (default: the last --limit)"),
      Flag.optional,
    ),
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("Most records to print"),
      Flag.withDefault(50),
    ),
    tags: Flag.String("tags").pipe(
      Flag.withDescription(
        "Comma-separated event tags to keep, such as ToolCallStarted,TurnCompleted",
      ),
      Flag.optional,
    ),
    full: Flag.Boolean("full").pipe(
      Flag.withDescription("Print whole stored envelopes instead of one-line records"),
      Flag.withDefault(false),
    ),
  },
  (input) =>
    Effect.scoped(
      runCtl(input, (connection, cwd) =>
        Effect.gen(function* () {
          const tags = Option.match(input.tags, {
            onNone: () => [],
            onSome: (text) =>
              text
                .split(",")
                .map((tag) => tag.trim())
                .filter((tag) => tag.length > 0),
          })
          const unknown = tags.filter((tag) => !EVENT_TAGS.has(tag))
          if (unknown.length > 0) {
            return yield* new CtlUsage({ message: `unknown event tags: ${unknown.join(", ")}` })
          }
          const target = yield* targeted(connection, input, cwd)
          return yield* readEvents(connection.client, target, {
            since: input.since,
            limit: input.limit,
            tags,
            full: input.full,
          })
        }),
      ),
    ),
).pipe(
  Command.withDescription("List a session's events, one compact record per line"),
  Command.withExamples([
    {
      command: "gent ctl events --limit 20",
      description: "The last 20 events of the newest session",
    },
    {
      command: "gent ctl events --since 41 --tags ToolCallStarted,TurnCompleted",
      description: "Page forward",
    },
  ]),
)

const wait = Command.make(
  "wait",
  {
    ...sessionFlags,
    until: Flag.String("until").pipe(
      Flag.withDescription(
        "turn (a TurnCompleted), idle (no turn, nothing queued), or an event tag",
      ),
      Flag.withDefault("turn"),
    ),
    after: Flag.Int("after").pipe(
      Flag.withDescription(
        "Event id cursor: stored events after it count too (default: only new ones)",
      ),
      Flag.optional,
    ),
    message: Flag.String("message").pipe(
      Flag.withDescription(
        "The messageId `send` printed: wait for its turn, even one already ended",
      ),
      Flag.optional,
    ),
    timeout: timeoutFlag,
  },
  (input) =>
    Effect.scoped(
      runCtl(input, (connection, cwd) =>
        Effect.gen(function* () {
          const until = yield* Schema.decodeEffect(WaitUntil)(input.until).pipe(
            Effect.mapError(
              () =>
                new CtlUsage({
                  message: `--until takes turn, idle, or an event tag; got ${input.until}`,
                }),
            ),
          )
          const target = yield* targeted(connection, input, cwd)
          return yield* waitFor(connection.client, target, {
            until,
            after: input.after,
            message: input.message,
            seconds: input.timeout,
          })
        }),
      ),
    ),
).pipe(
  Command.withDescription("Wait for a turn's end, an idle branch or an event; exit 124 on timeout"),
  Command.withExamples([
    {
      command: "gent ctl wait --message <messageId>",
      description: "Wait for the turn a send opened",
    },
    {
      command: "gent ctl wait --until InteractionPresented --timeout 20",
      description: "Wait for an ask",
    },
  ]),
)

const snapshot = Command.make(
  "snapshot",
  {
    ...sessionFlags,
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("Last messages to print"),
      Flag.withDefault(10),
    ),
    full: Flag.Boolean("full").pipe(
      Flag.withDescription("Print the whole snapshot the RPC returns"),
      Flag.withDefault(false),
    ),
  },
  (input) =>
    Effect.scoped(
      runCtl(input, (connection, cwd) =>
        Effect.flatMap(targeted(connection, input, cwd), (target) =>
          readSnapshot(connection.client, target, { limit: input.limit, full: input.full }),
        ),
      ),
    ),
).pipe(Command.withDescription("Print a session's state and its last messages"))

const status = Command.make("status", sessionFlags, (input) =>
  Effect.scoped(
    runCtl(input, (connection, cwd) =>
      Effect.flatMap(targeted(connection, input, cwd), (target) => readStatus(connection, target)),
    ),
  ),
).pipe(Command.withDescription("Print a branch's runtime state and the server's url"))

const request = Command.make(
  "request",
  {
    ...sessionFlags,
    extensionId: Flag.String("extension").pipe(
      Flag.withDescription("The extension id, such as @gent/machines"),
    ),
    requestId: Flag.String("id").pipe(
      Flag.withDescription("The request id the extension registers, such as run-status"),
    ),
    input: Flag.String("input").pipe(
      Flag.withDescription("The request input as JSON"),
      Flag.withDefault("{}"),
    ),
  },
  (input) =>
    Effect.scoped(
      runCtl(input, (connection, cwd) =>
        Effect.flatMap(targeted(connection, input, cwd), (target) =>
          sendRequest(connection.client, target, {
            extensionId: input.extensionId,
            requestId: input.requestId,
            input: input.input,
          }),
        ),
      ),
    ),
).pipe(
  Command.withDescription("Send one extension request on a session and print its reply"),
  Command.withExamples([
    {
      command:
        'gent ctl request --extension @gent/machines --id run-status --input \'{"run":"run-0123456789abcdef"}\'',
      description: "A machine run's state and last steps",
    },
  ]),
)

/** `gent ctl`: the control CLI over a running server. */
export const ctl = Command.make("ctl", {}, () =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.make("Usage: gent ctl <send|events|wait|snapshot|status|request> --help\n").pipe(
      Stream.run(stdio.stderr()),
    )
  }),
).pipe(
  Command.withDescription(
    "Drive a running gent server: one JSON value per call; exit 3 no server, 4 not found, 124 wait timed out",
  ),
  Command.withSubcommands([send, events, wait, snapshot, status, request]),
)
