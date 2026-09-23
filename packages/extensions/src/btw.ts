import {
  Context,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Record,
  Ref,
  Schema,
  Stream,
} from "effect"
import {
  BranchId,
  defineExtension,
  defineRequests,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  type Message,
  request,
  SessionId,
} from "@gent/core/extensions/api"

// ── protocol ────────────────────────────────────────────────────────────────

export const BTW_EXTENSION_ID = ExtensionId.make("@gent/btw")

const MAXIMUM_QUESTION_CHARS = 8000
const FORK_NAME_CHARS = 60

/** One exchange on the fork; `answer` is the streamed text while the fork is replying. */
const ForkTurn = Schema.Struct({
  question: Schema.String,
  answer: Schema.String,
})
type ForkTurn = typeof ForkTurn.Type

/** The fork most recently opened from this branch, as the pane shows it. */
export const ForkView = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  name: Schema.String,
  turns: Schema.Array(ForkTurn),
  /** The fork's loop holds a turn; a follow-up waits for it. */
  replying: Schema.Boolean,
  error: Schema.optional(Schema.String),
})
export type ForkView = typeof ForkView.Type

export const ForkProgress = Schema.Struct({
  fork: Schema.optional(ForkView),
})
export type ForkProgress = typeof ForkProgress.Type

const ForkInput = Schema.Struct({
  /** The first question; empty forks now and asks nothing. */
  question: Schema.String,
})
type ForkInput = typeof ForkInput.Type

const ForkOutput = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
})
type ForkOutput = typeof ForkOutput.Type

const AskInput = Schema.Struct({
  question: Schema.String,
})
type AskInput = typeof AskInput.Type

// ── extension ───────────────────────────────────────────────────────────────

/**
 * `/btw` forks the branch. The fork is a child session seeded with this
 * branch's context window, run by the session's own agent and model with its
 * tools; a parallel session, not a side channel. Nothing the fork does lands on this
 * branch. The pane reads it through `btw.progress`; opening it as the shell's
 * session is the client's `switchSession`, because the fork already is one.
 *
 * The fork itself is durable. What this process keeps is the pane's view of
 * it: which fork the branch opened last, and the reply streaming now.
 */

class ForkError extends Schema.TaggedError<ForkError>()("ForkError", {
  message: Schema.String,
}) {}

// ── Open forks ──

interface OpenFork {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly name: string
  /** Messages the fork copied in; the pane shows what came after. */
  readonly inherited: number
  readonly partial: string
  readonly replying: boolean
  readonly error: Option.Option<string>
  /** Follows the fork's stream; ends with the fork it follows. */
  readonly follower: Option.Option<Fiber.Fiber<void>>
}

interface OpenForksService {
  readonly get: (branchId: string) => Effect.Effect<Option.Option<OpenFork>>
  /** Replaces the branch's open fork; the one it replaces stops being followed. */
  readonly set: (branchId: string, fork: OpenFork) => Effect.Effect<void>
  readonly update: (branchId: string, change: (fork: OpenFork) => OpenFork) => Effect.Effect<void>
  /** Runs the effect on the resource's own scope so the request can return. */
  readonly spawn: (effect: Effect.Effect<void>) => Effect.Effect<Fiber.Fiber<void>>
}

/** One open fork per branch. The process resource owns the follower fibers and closes them on shutdown. */
class OpenForks extends Context.Service<OpenForks, OpenForksService>()(
  "@gent/extensions/src/btw/OpenForks",
) {}

const OpenForksLive: Layer.Layer<OpenForks> = Layer.effect(
  OpenForks,
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const forks = yield* Ref.make<ReadonlyMap<string, OpenFork>>(new Map())
    return OpenForks.of({
      get: (branchId) =>
        Ref.get(forks).pipe(Effect.map((all) => Option.fromNullishOr(all.get(branchId)))),
      set: (branchId, fork) =>
        Ref.modify(
          forks,
          (all): readonly [Option.Option<OpenFork>, ReadonlyMap<string, OpenFork>] => {
            const next = new Map(all)
            next.set(branchId, fork)
            return [Option.fromNullishOr(all.get(branchId)), next]
          },
        ).pipe(
          Effect.flatMap((previous) =>
            Option.match(
              Option.flatMap(previous, (fork) => fork.follower),
              {
                onNone: () => Effect.void,
                onSome: Fiber.interrupt,
              },
            ),
          ),
        ),
      update: (branchId, change) =>
        Ref.update(forks, (all) => {
          const current = Option.fromNullishOr(all.get(branchId))
          if (Option.isNone(current)) return all
          const next = new Map(all)
          next.set(branchId, change(current.value))
          return next
        }),
      spawn: (effect) => Effect.forkIn(effect, scope),
    })
  }),
)

const OpenForksResource = defineResource({
  id: "@gent/btw/forks",
  scope: "process",
  layer: OpenForksLive,
})

// ── View ──

const textOf = (message: Message): string =>
  message.parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text]
      return []
    })
    .join("")

/** A user turn the pane asked, not a message the runtime wrote for the model. */
const isAskedTurn = (message: Message): boolean =>
  message.role === "user" && Predicate.isUndefined(message.metadata?.customType)

/** Pairs each asked question with the assistant text that followed it. */
const forkTurns = (messages: ReadonlyArray<Message>, partial: string): ReadonlyArray<ForkTurn> => {
  const turns: Array<ForkTurn> = []
  for (const message of messages) {
    if (isAskedTurn(message)) {
      turns.push({ question: textOf(message), answer: "" })
      continue
    }
    const last = turns.at(-1)
    if (message.role !== "assistant" || Predicate.isUndefined(last)) continue
    turns[turns.length - 1] = { ...last, answer: last.answer + textOf(message) }
  }
  const last = turns.at(-1)
  if (partial.length > 0 && Predicate.isNotUndefined(last) && last.answer.length === 0) {
    turns[turns.length - 1] = { ...last, answer: partial }
  }
  return turns
}

const forkName = (question: string): string => {
  const chars = [...question.trim()]
  if (chars.length === 0) return "btw"
  if (chars.length <= FORK_NAME_CHARS) return `btw: ${chars.join("")}`
  return `btw: ${chars.slice(0, FORK_NAME_CHARS).join("")}…`
}

const checkQuestion = (raw: string) =>
  Effect.gen(function* () {
    const question = raw.trim()
    if ([...question].length > MAXIMUM_QUESTION_CHARS) {
      return yield* new ForkError({
        message: `Question exceeds ${MAXIMUM_QUESTION_CHARS} characters`,
      })
    }
    return question
  })

// ── Requests ──

/**
 * Follows the fork's live stream into the pane's view. The reply text is
 * kept only until its message is durable; the view reads finished turns
 * from the fork's history.
 */
const followFork = (parentBranchId: string, fork: { sessionId: SessionId; branchId: BranchId }) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const forks = yield* OpenForks
    const pulse = ctx.State.changed().pipe(Effect.ignore)
    // A newer fork on the same branch has its own follower; this one never writes over it.
    const apply = (change: (current: OpenFork) => OpenFork) =>
      forks
        .update(parentBranchId, (current) => {
          if (current.sessionId !== fork.sessionId) return current
          return change(current)
        })
        .pipe(Effect.andThen(pulse))
    yield* ctx.Session.events(fork).pipe(
      Stream.runForEach((event) => {
        switch (event._tag) {
          case "StreamStarted":
            return apply((current) => ({ ...current, replying: true, error: Option.none() }))
          case "StreamChunk":
            return apply((current) => ({ ...current, partial: current.partial + event.chunk }))
          case "TurnCompleted":
            return apply((current) => ({ ...current, partial: "", replying: false }))
          case "ErrorOccurred":
            return apply((current) => ({
              ...current,
              partial: "",
              replying: false,
              error: Option.some(event.error),
            }))
          default:
            return Effect.void
        }
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("btw.follow.failed").pipe(
          Effect.annotateLogs({ sessionId: fork.sessionId, error: String(cause) }),
        ),
      ),
    )
  })

/** Admits the question on the fork's loop and marks the fork replying until its receipt arrives. */
const sendToFork = (parentBranchId: string, fork: OpenFork, question: string) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const forks = yield* OpenForks
    yield* forks.update(parentBranchId, (current) => {
      if (current.sessionId !== fork.sessionId) return current
      return { ...current, replying: true, error: Option.none() }
    })
    yield* ctx.Session.send({
      delivery: "turn",
      sessionId: fork.sessionId,
      branchId: fork.branchId,
      content: question,
      completion: "admission",
    }).pipe(
      Effect.mapError(
        (error) => new ForkError({ message: `Cannot ask the fork: ${error.message}` }),
      ),
    )
  })

export const BtwRpc = defineRequests(BTW_EXTENSION_ID, {
  Fork: request({
    id: "btw.fork",
    description:
      "Fork this branch into a parallel child session seeded with its context; an empty question forks without asking",
    input: ForkInput,
    output: ForkOutput,
    execute: Effect.fn("BtwRpc.Fork")(function* (input: ForkInput) {
      const question = yield* checkQuestion(input.question)
      const ctx = yield* ExtensionContext
      const forks = yield* OpenForks
      const parentBranchId = String(ctx.branchId)
      const session = yield* ctx.Session.getSession().pipe(
        Effect.mapError(
          (error) => new ForkError({ message: `Cannot read this session: ${error.message}` }),
        ),
      )
      // The fork is this session running beside itself: the same agent and
      // admission, and the model and reasoning its `/model` choice set.
      const created = yield* ctx.Session.create({
        name: forkName(question),
        parentSessionId: ctx.sessionId,
        parentBranchId: ctx.branchId,
        historyBranchId: ctx.branchId,
        ...Record.filter(
          {
            admission: session?.admission,
            modelId: session?.modelId,
            reasoningLevel: session?.reasoningLevel,
          },
          Predicate.isNotUndefined,
        ),
      }).pipe(
        Effect.mapError((error) => new ForkError({ message: `Cannot fork: ${error.message}` })),
      )
      const detail = yield* ctx.Session.getDetail(created.sessionId).pipe(
        Effect.mapError(
          (error) => new ForkError({ message: `Cannot read the fork: ${error.message}` }),
        ),
      )
      const inherited = detail.branches
        .filter((entry) => entry.branch.id === created.branchId)
        .reduce((count, entry) => count + entry.messages.length, 0)
      const fork: OpenFork = {
        sessionId: created.sessionId,
        branchId: created.branchId,
        name: forkName(question),
        inherited,
        partial: "",
        replying: false,
        error: Option.none(),
        follower: Option.none(),
      }
      yield* forks.set(parentBranchId, fork)
      // The follower outlives this request; it carries the context it needs.
      const follower = yield* forks.spawn(
        followFork(parentBranchId, created).pipe(
          Effect.provideService(ExtensionContext, ctx),
          Effect.provideService(OpenForks, forks),
        ),
      )
      yield* forks.update(parentBranchId, (current) => {
        if (current.sessionId !== fork.sessionId) return current
        return { ...current, follower: Option.some(follower) }
      })
      if (question.length > 0) yield* sendToFork(parentBranchId, fork, question)
      yield* ctx.State.changed().pipe(Effect.ignore)
      return { sessionId: created.sessionId, branchId: created.branchId }
    }),
  }),
  Ask: request({
    id: "btw.ask",
    description:
      "Ask the fork opened from this branch a follow-up; it waits for a reply in progress",
    input: AskInput,
    output: Schema.Struct({ asked: Schema.Boolean }),
    execute: Effect.fn("BtwRpc.Ask")(function* (input: AskInput) {
      const question = yield* checkQuestion(input.question)
      if (question.length === 0) return yield* new ForkError({ message: "Question is empty" })
      const ctx = yield* ExtensionContext
      const forks = yield* OpenForks
      const fork = yield* forks.get(String(ctx.branchId))
      if (Option.isNone(fork)) return yield* new ForkError({ message: "No fork is open here" })
      if (fork.value.replying) {
        return yield* new ForkError({ message: "The fork is still replying" })
      }
      yield* sendToFork(String(ctx.branchId), fork.value, question)
      return { asked: true }
    }),
  }),
  Progress: request({
    id: "btw.progress",
    description:
      "The fork opened from this branch: its turns after the fork point and the reply streaming now",
    input: Schema.Struct({}),
    output: ForkProgress,
    execute: Effect.fn("BtwRpc.Progress")(function* () {
      const ctx = yield* ExtensionContext
      const forks = yield* OpenForks
      const fork = yield* forks.get(String(ctx.branchId))
      if (Option.isNone(fork)) return {}
      const detail = yield* ctx.Session.getDetail(fork.value.sessionId).pipe(
        Effect.mapError(
          (error) => new ForkError({ message: `Cannot read the fork: ${error.message}` }),
        ),
      )
      const messages = detail.branches
        .filter((entry) => entry.branch.id === fork.value.branchId)
        .flatMap((entry) => entry.messages)
        .slice(fork.value.inherited)
      const view: ForkView = {
        sessionId: fork.value.sessionId,
        branchId: fork.value.branchId,
        name: fork.value.name,
        turns: forkTurns(messages, fork.value.partial),
        replying: fork.value.replying,
        ...Option.match(fork.value.error, {
          onNone: () => ({}),
          onSome: (error) => ({ error }),
        }),
      }
      return { fork: view }
    }),
  }),
})

export const BtwExtension = defineExtension({
  id: BTW_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("resource", OpenForksResource)
    yield* host.register("request", BtwRpc.Fork, BtwRpc.Ask, BtwRpc.Progress)
  }),
})
