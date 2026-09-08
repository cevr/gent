/**
 * `/btw` side questions. Each ask runs an ephemeral child of the current
 * agent on a copy of this branch's history, with tools off and low
 * reasoning. Nothing from the side conversation lands on the branch; the
 * client replays earlier side turns inside the next prompt.
 *
 * The ask request returns at once. The run itself lives in a process-scoped
 * resource so it never holds the branch's request permit; the client reads
 * streamed text and the final answer through `btw.progress` on state pulses.
 */
import { Cause, Context, Effect, Exit, Layer, Option, Ref, Schema, Scope } from "effect"
import {
  CapabilityError,
  defineExtension,
  defineRequests,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  makeRunSpec,
  request,
  requireCurrentAgent,
} from "@gent/core/extensions/api"
import {
  BTW_EXTENSION_ID,
  MAXIMUM_SIDE_QUESTION_CHARS,
  SideQuestionInput,
  SideQuestionOutput,
  SideQuestionProgress,
  type SideQuestionRun,
  type SideTurn,
} from "./btw-protocol.js"

export {
  BTW_EXTENSION_ID,
  SideQuestionInput,
  SideQuestionOutput,
  SideQuestionProgress,
  SideQuestionRun,
  SideTurn,
} from "./btw-protocol.js"

export class SideQuestionError extends Schema.TaggedError<SideQuestionError>()(
  "SideQuestionError",
  { message: Schema.String },
) {}

// ── Background runs ──

export interface SideQuestionRunsService {
  readonly get: (branchId: string) => Effect.Effect<Option.Option<SideQuestionRun>>
  readonly set: (branchId: string, run: SideQuestionRun) => Effect.Effect<void>
  readonly update: (
    branchId: string,
    change: (run: SideQuestionRun) => SideQuestionRun,
  ) => Effect.Effect<void>
  /** Runs the effect on the resource's own scope so the request can return. */
  readonly fork: (effect: Effect.Effect<void>) => Effect.Effect<void>
}

/** One run per branch. The process resource owns the fibers and closes them on shutdown. */
export class SideQuestionRuns extends Context.Service<SideQuestionRuns, SideQuestionRunsService>()(
  "@gent/extensions/src/btw/SideQuestionRuns",
) {}

export const SideQuestionRunsLive: Layer.Layer<SideQuestionRuns> = Layer.effect(
  SideQuestionRuns,
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void).pipe(Effect.asVoid))
    const runs = yield* Ref.make<ReadonlyMap<string, SideQuestionRun>>(new Map())
    return SideQuestionRuns.of({
      get: (branchId) =>
        Ref.get(runs).pipe(Effect.map((all) => Option.fromNullishOr(all.get(branchId)))),
      set: (branchId, run) =>
        Ref.update(runs, (all) => {
          const next = new Map(all)
          next.set(branchId, run)
          return next
        }),
      update: (branchId, change) =>
        Ref.update(runs, (all) => {
          const current = Option.fromNullishOr(all.get(branchId))
          if (Option.isNone(current)) return all
          const next = new Map(all)
          next.set(branchId, change(current.value))
          return next
        }),
      fork: (effect) => Effect.forkIn(effect, scope).pipe(Effect.asVoid),
    })
  }),
)

const SideQuestionRunsResource = defineResource({
  id: "@gent/btw/runs",
  scope: "process",
  tag: SideQuestionRuns,
  layer: SideQuestionRunsLive,
})

// ── Prompt ──

export const SIDE_QUESTION_INSTRUCTION =
  "Answer this side question using only the conversation context above. Do not use tools and do not run code. The user may send follow-up side questions; none of this side conversation is added to the main session."

const replayTurns = (previous: ReadonlyArray<SideTurn>) =>
  previous
    .map((turn) => `<side_question>\n${turn.question}\n</side_question>\n\n${turn.answer}`)
    .join("\n\n")

/** The child sees the branch history, then one user message carrying the side exchange. */
export const sideQuestionPrompt = (input: SideQuestionInput): string => {
  const current = `<side_question>\n${input.question}\n</side_question>`
  if (input.previous.length === 0) {
    return `<side_question>\n${SIDE_QUESTION_INSTRUCTION}\n\n${input.question}\n</side_question>`
  }
  return `${SIDE_QUESTION_INSTRUCTION}\n\nEarlier side questions and answers in this exchange:\n\n${replayTurns(input.previous)}\n\n${current}`
}

// ── Requests ──

const askError = (reason: string) =>
  new CapabilityError({ extensionId: BTW_EXTENSION_ID, capabilityId: "btw.ask", reason })

export const BtwRpc = defineRequests(BTW_EXTENSION_ID, {
  Ask: request({
    id: "btw.ask",
    description:
      "Start a side question over the branch history without touching the branch; read the answer through btw.progress",
    input: SideQuestionInput,
    output: SideQuestionOutput,
    execute: Effect.fn("BtwRpc.Ask")(
      function* (input: SideQuestionInput) {
        const question = input.question.trim()
        if (question.length === 0) {
          return yield* new SideQuestionError({ message: "Side question is empty" })
        }
        if ([...question].length > MAXIMUM_SIDE_QUESTION_CHARS) {
          return yield* new SideQuestionError({
            message: `Side question exceeds ${MAXIMUM_SIDE_QUESTION_CHARS} characters`,
          })
        }
        const ctx = yield* ExtensionContext
        const agent = yield* requireCurrentAgent
        const runs = yield* SideQuestionRuns
        const branchId = String(ctx.branchId)
        const current = yield* runs.get(branchId)
        if (Option.isSome(current) && !current.value.done) {
          return yield* new SideQuestionError({ message: "A side question is already in flight" })
        }
        yield* runs.set(branchId, { question, text: "", done: false })
        // The pulse tells the client to read progress; failures there never touch the run.
        const pulse = ctx.State.changed({}).pipe(Effect.ignore)
        yield* pulse
        const finish = (change: (run: SideQuestionRun) => SideQuestionRun) =>
          runs.update(branchId, change).pipe(Effect.andThen(pulse))
        // Services are captured here: the run continues after this request's scope closes.
        const work = ctx.Agent.run({
          agent,
          prompt: sideQuestionPrompt({ question, previous: input.previous }),
          runSpec: makeRunSpec({
            persistence: "ephemeral",
            history: "inherit",
            visibility: "private",
            overrides: {
              allowedTools: [],
              deniedTools: ["cell"],
              reasoningEffort: "none",
              systemPromptAddendum: SIDE_QUESTION_INSTRUCTION,
            },
          }),
          observe: (event) => {
            if (event._tag !== "StreamChunk") return Effect.void
            return runs
              .update(branchId, (run) => ({ ...run, text: run.text + event.chunk }))
              .pipe(Effect.andThen(pulse))
          },
        }).pipe(
          Effect.flatMap((result) =>
            finish((run) => {
              if (result._tag === "error") return { ...run, done: true, error: result.error }
              return { ...run, done: true, answer: result.text }
            }),
          ),
          Effect.catchCause((cause) =>
            finish((run) => ({ ...run, done: true, error: Cause.pretty(cause) })),
          ),
        )
        yield* runs.fork(work)
        return { started: true }
      },
      (effect) => Effect.mapError(effect, (cause) => askError(cause.message)),
    ),
  }),
  Progress: request({
    id: "btw.progress",
    description: "The side question most recently started on this branch, with streamed text",
    input: Schema.Struct({}),
    output: SideQuestionProgress,
    execute: Effect.fn("BtwRpc.Progress")(function* () {
      const ctx = yield* ExtensionContext
      const runs = yield* SideQuestionRuns
      return Option.match(yield* runs.get(String(ctx.branchId)), {
        onNone: (): SideQuestionProgress => ({}),
        onSome: (run): SideQuestionProgress => ({ run }),
      })
    }),
  }),
})

export const BtwExtension = defineExtension({
  id: BTW_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("resource", SideQuestionRunsResource)
    yield* host.register("request", BtwRpc.Ask, BtwRpc.Progress)
  }),
})
