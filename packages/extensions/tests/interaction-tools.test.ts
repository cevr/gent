import { describe, expect, it, test } from "effect-bun-test"
import { Deferred, Effect, Fiber, FileSystem, Option, Schema, Stream } from "effect"
import type * as Prompt from "effect/ai/Prompt"
import {
  addOpenQuestions,
  AskUserAnswers,
  AskUserAsyncTool,
  AskUserMetadata,
  AskUserTool,
  HandoffTool,
  INTERACTION_TOOLS_EXTENSION_ID,
  OpenQuestion,
  OpenQuestions,
  PromptTool,
  QUESTION_ANSWER_TYPE,
  QuestionAnswerDetails,
  questionAnswerText,
  QuestionRow,
} from "../src/interaction-tools.js"
import { BranchId, SessionId, SteerCommand, ToolCallId } from "@gent/core/protocol"
import {
  createRpcHarness,
  runToolWithCtx,
  testToolContext,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  finishPart,
  multiToolCallStep,
  textDeltaPart,
  textStep,
  toolCallPart,
  toolCallStep,
  turnRequestText,
  waitFor,
  ApprovalService,
  type ApprovalDecision,
} from "@gent/core/test-utils"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import {
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  type ExtensionContextService,
  LoadedArtifactIdentity,
  RequestId,
  tool,
} from "@gent/core/extensions/api"
import { e2ePreset, shippedPreset } from "./helpers/test-preset"
import { isToolResultFor } from "./helpers/tool-event.js"

// ── ask user ────────────────────────────────────────────────────────────────

const makeCtx = (
  decision: Effect.Effect<{ readonly approved: boolean; readonly notes?: string }>,
) =>
  testToolContext({
    sessionId: SessionId.make("test-session"),
    branchId: BranchId.make("test-branch"),
    toolCallId: ToolCallId.make("test-call"),
    home: "/nonexistent/gent-test-home",
    Interaction: { approve: () => decision, present: () => Effect.die("not wired") },
  })

describe("ask-user wire", () => {
  // The metadata JSON as an interaction stored it before the call limits: a
  // long header and five options.
  test("a question stored before the call limits decodes for the client", () => {
    const options = ["A", "B", "C", "D", "E"]
      .map((label) => `{"label":"${label}","description":"${label}"}`)
      .join(",")
    const stored = `{"type":"ask-user","questions":[{"question":"Pick one","header":"Which of these deployment targets first?","markdown":"**context**","options":[${options}],"multiple":false}]}`
    const decoded = Schema.decodeSync(Schema.fromJsonString(AskUserMetadata))(stored)
    expect(decoded.questions[0]?.options?.map((option) => option.label)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
    ])
    expect(decoded.questions[0]?.header).toBe("Which of these deployment targets first?")
  })
})

describe("AskUser Tool", () => {
  it.live("decodes structured JSON answers from notes", () => {
    const ctx = makeCtx(
      Effect.succeed({ approved: true, notes: '[["Option A","Option B"],["Option C"]]' }),
    )

    return runToolWithCtx(
      AskUserTool,
      {
        questions: [
          { question: "Pick first set", options: [{ label: "Option A" }, { label: "Option B" }] },
          { question: "Pick second", options: [{ label: "Option C" }] },
        ],
      },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.answers).toEqual([["Option A", "Option B"], ["Option C"]])
        expect(result.cancelled).toBeUndefined()
      }),
    )
  })

  it.live("falls back to wrapping raw notes when JSON is malformed", () => {
    const ctx = makeCtx(Effect.succeed({ approved: true, notes: "not-json {{{" }))

    return runToolWithCtx(AskUserTool, { questions: [{ question: "Free-form?" }] }, ctx).pipe(
      Effect.map((result) => {
        expect(result.answers).toEqual([["not-json {{{"]])
      }),
    )
  })

  it.live("an approval without notes answers each question with an empty list", () => {
    const ctx = makeCtx(Effect.succeed({ approved: true }))

    return runToolWithCtx(
      AskUserTool,
      { questions: [{ question: "One?" }, { question: "Two?" }, { question: "Three?" }] },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.answers).toEqual([[], [], []])
      }),
    )
  })

  it.live("a decoded answer list is normalized to one list per question", () => {
    const run = (notes: string) =>
      runToolWithCtx(
        AskUserTool,
        { questions: [{ question: "One?" }, { question: "Two?" }] },
        makeCtx(Effect.succeed({ approved: true, notes })),
      )
    return Effect.gen(function* () {
      // A short list is padded with empty answers.
      expect((yield* run('[["A"]]')).answers).toEqual([["A"], []])
      // A long list is truncated to the question count.
      expect((yield* run('[["A"],["B"],["C"]]')).answers).toEqual([["A"], ["B"]])
    })
  })

  it.live("free-text notes answer the first question and leave the rest empty", () => {
    const ctx = makeCtx(Effect.succeed({ approved: true, notes: "free text" }))

    return runToolWithCtx(
      AskUserTool,
      { questions: [{ question: "One?" }, { question: "Two?" }] },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.answers).toEqual([["free text"], []])
        expect(result.cancelled).toBeUndefined()
      }),
    )
  })

  it.live("cancel returns cancelled flag with empty answers", () => {
    const ctx = makeCtx(Effect.succeed({ approved: false }))

    return runToolWithCtx(
      AskUserTool,
      {
        questions: [
          {
            question: "Which approach?",
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
      },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.cancelled).toBe(true)
        expect(result.answers).toEqual([])
      }),
    )
  })
})

// ── prompt tool ─────────────────────────────────────────────────────────────

const interactionDeciding = (
  decision: ApprovalDecision,
): ExtensionContextService["Interaction"] => ({
  approve: () => Effect.succeed(decision),
  present: () => Effect.die("interaction.present not wired"),
})

describe("Prompt Tool", () => {
  it.scopedLive(
    "review mode: writes the content under .gent/prompts and returns the decision",
    () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDirectoryScoped("prompt-review")
        const ctx = testToolContext({ cwd, Interaction: interactionDeciding({ approved: true }) })
        const result = yield* runToolWithCtx(
          PromptTool,
          { mode: "review", content: "## Plan\n- Step 1", title: "Release Plan" },
          ctx,
        )
        expect(result.mode).toBe("review")
        if (result.mode !== "review") return
        expect(result.decision).toBe("yes")
        expect(result.path.startsWith(`${cwd}/.gent/prompts/release-plan-`)).toBe(true)
        const fs = yield* FileSystem.FileSystem
        expect(yield* fs.readFileString(result.path)).toBe("# Release Plan\n\n## Plan\n- Step 1")
      }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive("review mode: a title with no ASCII letters names the file prompt", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDirectoryScoped("prompt-review-title")
      const ctx = testToolContext({ cwd, Interaction: interactionDeciding({ approved: true }) })
      const result = yield* runToolWithCtx(
        PromptTool,
        { mode: "review", content: "draft", title: "計画" },
        ctx,
      )
      if (result.mode !== "review") return yield* Effect.die("expected a review result")
      expect(result.path.startsWith(`${cwd}/.gent/prompts/prompt-`)).toBe(true)
    }).pipe(Effect.provide(BunServices.layer)),
  )
  it.scopedLive("review mode: an edit decision stores the edited content", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDirectoryScoped("prompt-edit")
      const ctx = testToolContext({
        cwd,
        Interaction: interactionDeciding({
          approved: true,
          notes: "edit",
          editedContent: "revised",
        }),
      })
      const result = yield* runToolWithCtx(PromptTool, { mode: "review", content: "draft" }, ctx)
      expect(result.mode).toBe("review")
      if (result.mode !== "review") return
      expect(result.decision).toBe("edit")
      expect(result.content).toBe("revised")
      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.readFileString(result.path)).toBe("revised")
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.live("confirm mode: a rejected approval is a no", () =>
    runToolWithCtx(
      PromptTool,
      { mode: "confirm", content: "Proceed?" },
      testToolContext({ Interaction: interactionDeciding({ approved: false }) }),
    ).pipe(
      Effect.map((result) => {
        expect(result.mode).toBe("confirm")
        if (result.mode === "confirm") expect(result.decision).toBe("no")
      }),
    ),
  )
})

// ── interaction tools rpc ───────────────────────────────────────────────────

/**
 * The `ask_user` and `prompt` tools through real agent turns: the model calls
 * the tool, the runtime runs it in the per-request scope, and the answer
 * comes back over `respondInteraction` (with `ApprovalService.Live`) or from
 * the auto-approving test approval. The answer must survive the scope edge.
 */

describe("InteractionToolsExtension via model turn", () => {
  it.scopedLive(
    "presents durable information without suspending the cell for an answer",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", {
            code: 'await tools.prompt({mode:"present", title:"Notice", content:"INFORMATION-SHOWN"}); console.log("CELL-CONTINUED")',
          }),
          textStep("done"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          providerLayer,
          approvalLayer: ApprovalService.Live,
        })
        const events = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.takeUntil(({ event }) => event._tag === "TurnCompleted"),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* client.message.send({ sessionId, branchId, content: "Present the notice" })
        const received = Array.from(yield* Fiber.join(events)).map(({ event }) => event)
        expect(received.some((event) => event._tag === "InteractionPresented")).toBe(false)
        expect(
          received.some(
            (event) =>
              event._tag === "ToolCallSucceeded" &&
              event.toolName === "cell" &&
              event.output?.includes("CELL-CONTINUED"),
          ),
        ).toBe(true)
        expect(
          received.some(
            (event) =>
              event._tag === "MessageReceived" &&
              event.message.metadata?.hidden === true &&
              event.message.parts.some(
                (part) => part.type === "text" && part.text.includes("INFORMATION-SHOWN"),
              ),
          ),
        ).toBe(true)
      }).pipe(Effect.timeout("8 seconds")),
    10_000,
  )

  it.scopedLive.layer(BunFileSystem.layer)(
    "review saves edited reply content through RPC, including an empty document",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "gent-review-reply-" })
        for (const editedContent of ["Updated review\n", ""]) {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("prompt", {
              mode: "review",
              content: "Original review",
              title: "Editable review",
            }),
            textStep("review saved"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            approvalLayer: ApprovalService.Live,
            cwd,
            home: cwd,
          })
          const interaction = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter((envelope) => envelope.event._tag === "InteractionPresented"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          )
          const result = yield* client.session
            .events({ sessionId, branchId })
            .pipe(
              Stream.filter(isToolResultFor("prompt")),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            )
          yield* client.message.send({ sessionId, branchId, content: "Review this document" })
          const presented = Array.from(yield* Fiber.join(interaction))[0]?.event
          if (presented?._tag !== "InteractionPresented")
            return yield* Effect.die("Missing review interaction")
          yield* client.interaction.respondInteraction({
            sessionId,
            branchId,
            requestId: presented.requestId,
            approved: true,
            notes: "edit",
            editedContent,
          })
          const completed = Array.from(yield* Fiber.join(result))[0]?.event
          if (completed?._tag !== "ToolCallSucceeded")
            return yield* Effect.die("Review did not succeed")
          const output = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({
                decision: Schema.Literal("edit"),
                path: Schema.String,
                content: Schema.String,
              }),
            ),
          )(completed.output)
          expect(output.content).toBe(editedContent)
          expect(output.path.startsWith(`${cwd}/`)).toBe(true)
          expect(yield* fs.readFileString(output.path)).toBe(editedContent)
        }
      }).pipe(Effect.timeout("12 seconds")),
  )

  // The notes are what the TUI's ask-user view sends: one array of picks per
  // question, encoded with the extension's own codec.
  it.scopedLive("the picks a user sends reach the model as one list per question", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("ask_user", {
          questions: [
            {
              question: "Which colors?",
              options: [{ label: "Red" }, { label: "Blue" }],
              multiple: true,
            },
            { question: "Which size?", options: [{ label: "Small" }, { label: "Large" }] },
          ],
        }),
        textStep("asked"),
      ])
      const { client, sessionId, branchId } = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer,
        approvalLayer: ApprovalService.Live,
      })
      const interaction = yield* client.session.events({ sessionId, branchId }).pipe(
        Stream.filter((envelope) => envelope.event._tag === "InteractionPresented"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      )
      const result = yield* client.session
        .events({ sessionId, branchId })
        .pipe(
          Stream.filter(isToolResultFor("ask_user")),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        )
      yield* client.message.send({ sessionId, branchId, content: "ask me" })
      const presented = Array.from(yield* Fiber.join(interaction))[0]?.event
      if (presented?._tag !== "InteractionPresented")
        return yield* Effect.die("Missing ask_user interaction")
      const notes = yield* Schema.encodeEffect(AskUserAnswers)([["Red", "Blue"], ["Large"]])
      yield* client.interaction.respondInteraction({
        sessionId,
        branchId,
        requestId: presented.requestId,
        approved: true,
        notes,
      })
      const completed = Array.from(yield* Fiber.join(result))[0]?.event
      if (completed?._tag !== "ToolCallSucceeded")
        return yield* Effect.die("ask_user did not succeed")
      const output = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({ answers: Schema.Array(Schema.Array(Schema.String)) }),
        ),
      )(completed.output)
      expect(output.answers).toEqual([["Red", "Blue"], ["Large"]])
    }).pipe(Effect.timeout("12 seconds")),
  )

  it.live(
    "a confirm prompt in a model turn answers yes when the approval says yes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("prompt", {
              mode: "confirm",
              content: "Proceed with the migration?",
              title: "Confirm migration",
            }),
            textStep("confirmed"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })

          const toolEventFiber = yield* client.session
            .events({ sessionId, branchId })
            .pipe(
              Stream.filter(isToolResultFor("prompt")),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "confirm something",
          })

          const events = Array.from(yield* Fiber.join(toolEventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain('"mode": "confirm"')
            expect(succeeded.event.output).toContain('"decision": "yes"')
          }
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )
})

// ── handoff ──────────────────────────────────────────────────────────────────

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)

const handoffCtx = (overrides: { approve?: ExtensionContextService["Interaction"]["approve"] }) =>
  testToolContext({
    Interaction: {
      approve: overrides.approve ?? dieStub("interaction.approve"),
      present: dieStub("interaction.present"),
    },
  })

describe("HandoffTool", () => {
  it.live("returns handoff confirmed when user accepts", () => {
    const ctx = handoffCtx({
      approve: () => Effect.succeed({ approved: true }),
    })

    return runToolWithCtx(
      HandoffTool,
      {
        context: "Current task: implement auth. Key files: src/auth.ts",
        reason: "context window filling up",
      },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.handoff).toBe(true)
        expect(result.summary).toContain("implement auth")
        expect(result.parentSessionId).toBe(SessionId.make("test-session"))
      }),
    )
  })

  it.live("returns handoff rejected when user declines", () => {
    const ctx = handoffCtx({
      approve: () => Effect.succeed({ approved: false }),
    })

    return runToolWithCtx(
      HandoffTool,
      {
        context: "Current task: implement auth",
      },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.handoff).toBe(false)
        expect(result.reason).toBe("User rejected handoff")
      }),
    )
  })
})

const largeContext = `Current task: migrate the actor mailbox to bounded queues.\n${"Key decision: use Effect.Queue.bounded(...). ".repeat(100)}`

describe("Handoff tool via model turn", () => {
  it.live(
    "approval preserves the full supplied handoff without a second model run",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
            toolCallStep("handoff", {
              context: largeContext,
              reason: "context window filling up",
            }),
            textStep("handed-off"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })

          const toolEventFiber = yield* client.session
            .events({ sessionId, branchId })
            .pipe(
              Stream.filter(isToolResultFor("handoff")),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "hand off to a new session",
          })

          const events = Array.from(yield* Fiber.join(toolEventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain('"handoff": true')
            expect(succeeded.event.output).toContain(
              yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(largeContext),
            )
            expect(succeeded.event.output).toContain('"reason": "context window filling up"')
          }
          // The turn's two steps are the only model calls: once the branch
          // settles with nothing queued, no call followed the approval.
          yield* waitFor(
            Effect.all([
              client.session.getSnapshot({ sessionId, branchId }),
              client.queue.get({ sessionId, branchId }),
            ]),
            ([snapshot, queue]) =>
              snapshot.runtime._tag === "Idle" &&
              queue.followUp.length === 0 &&
              snapshot.messages.some((message) =>
                message.parts.some((part) => part.type === "text" && part.text === "handed-off"),
              ),
            5_000,
            "the handoff turn settles",
          )
          expect(yield* controls.callCount).toBe(2)
          yield* controls.assertDone
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )
})

// ── background questions ─────────────────────────────────────────────────────

const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const askedRow = (id: string, question: string, askedAt = 1_000): OpenQuestion => ({
  id,
  question,
  assume: `assume ${question}`,
  askedAt,
})

describe("background question store", () => {
  test("a replay of the same call replaces its row instead of adding one", () => {
    const open = addOpenQuestions([], [askedRow("call-1:0", "Which cache?")])
    expect(addOpenQuestions(open, [askedRow("call-1:0", "Which cache?", 2_000)])).toEqual([
      askedRow("call-1:0", "Which cache?", 2_000),
    ])
  })

  test("the same question text asked again replaces the open row", () => {
    const open = addOpenQuestions([], [askedRow("call-1:0", "Which cache?")])
    expect(addOpenQuestions(open, [askedRow("call-2:0", "Which cache?")])).toEqual([
      askedRow("call-2:0", "Which cache?"),
    ])
  })

  test("a ninth open question drops the oldest", () => {
    const eight = Array.from({ length: 8 }, (_, index) => askedRow(`call-${index}:0`, `Q${index}`))
    const next = addOpenQuestions(eight, [askedRow("call-8:0", "Q8")])
    expect(next.map((row) => row.id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `call-${index + 1}:0`),
    )
  })

  test("a recorded answer stays through a replay and does not count toward the cap", () => {
    const answered = {
      ...askedRow("call-0:0", "Which cache?"),
      answered: { answer: "Redis", batch: "question-answer:b" },
    }
    const eight = Array.from({ length: 8 }, (_, index) =>
      askedRow(`call-${index + 1}:0`, `Q${index + 1}`),
    )
    const next = addOpenQuestions(
      [answered, ...eight],
      [askedRow("call-0:0", "Which cache?", 2_000), askedRow("call-9:0", "Which cache?")],
    )
    expect(next).toEqual([answered, ...eight.slice(1), askedRow("call-9:0", "Which cache?")])
  })

  test("the answer text holds the question, the assumption and the answer, and no id", () => {
    const id = `cell:${"a".repeat(64)}:0`
    const text = questionAnswerText([
      {
        row: { ...askedRow(id, "Which cache backend?"), assume: "in-memory LRU" },
        answer: "Redis",
      },
    ])
    expect(text).not.toContain(id)
    expect(text).toBe(
      [
        "Answer to your background question (asked 1970-01-01T00:00:01.000Z):",
        "Q: Which cache backend?",
        "You assumed: in-memory LRU",
        "A: Redis",
      ].join("\n"),
    )
  })
})

/** A tool that holds its step open until the test releases it. */
const holdFixture = (release: Deferred.Deferred<void>) => ({
  ...defineExtension({
    id: "hold-fixture",
    setup: Effect.gen(function* () {
      yield* (yield* ExtensionHost).register(
        "tool",
        tool({
          id: "hold",
          description: "Wait until the test releases the step",
          params: Schema.Struct({}),
          output: Schema.String,
          execute: () => Deferred.await(release).pipe(Effect.as("released")),
        }),
      )
    }),
  }),
  artifactIdentity: LoadedArtifactIdentity.make("hold-fixture-source"),
})

/**
 * A tool that asks the user first (the turn parks on it), then, on the run
 * that resumes it, signals `resumed` and holds until the test releases it.
 */
const askThenHoldFixture = (
  resumed: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
) => ({
  ...defineExtension({
    id: "ask-then-hold-fixture",
    setup: Effect.gen(function* () {
      yield* (yield* ExtensionHost).register(
        "tool",
        tool({
          id: "ask_then_hold",
          interactive: true,
          description: "Ask to go on, then wait until the test releases the step",
          params: Schema.Struct({}),
          output: Schema.String,
          execute: () =>
            Effect.gen(function* () {
              const ctx = yield* ExtensionContext
              yield* ctx.Interaction.approve({ text: "Go on?" })
              yield* Deferred.succeed(resumed, void 0)
              yield* Deferred.await(release)
              return "released"
            }),
        }),
      )
    }),
  }),
  artifactIdentity: LoadedArtifactIdentity.make("ask-then-hold-fixture-source"),
})

/** The input of `questions.open` (empty) and `questions.answer`. */
interface QuestionsInput {
  readonly answers?: ReadonlyArray<{ readonly id: string; readonly answer: string }>
  readonly dismiss?: ReadonlyArray<string>
}

const questionsHarness = (
  providerLayer: Parameters<typeof createRpcHarness>[0]["providerLayer"],
  fixtures: ReadonlyArray<(typeof e2ePreset.extensionInputs)[number]> = [],
  /** `approvalLayer: ApprovalService.Live` parks a blocking ask until the test answers it. */
  options: Pick<Parameters<typeof createRpcHarness>[0], "approvalLayer"> = {},
) =>
  Effect.gen(function* () {
    const home = yield* makeTempDirectoryScoped("questions-")
    const cwd = yield* makeTempDirectoryScoped("gent-test-cwd-")
    const harness = yield* createRpcHarness({
      ...e2ePreset,
      extensionInputs: [...e2ePreset.extensionInputs, ...fixtures],
      providerLayer,
      cwd,
      home,
      ...options,
    })
    const target = { sessionId: harness.sessionId, branchId: harness.branchId }
    const request = (capabilityId: string, input: QuestionsInput) =>
      harness.client.extension.request({
        ...target,
        extensionId: INTERACTION_TOOLS_EXTENSION_ID,
        capabilityId,
        input,
      })
    return {
      ...harness,
      target,
      home,
      open: request("questions.open", {}).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(OpenQuestions)),
        Effect.map((value) => value.questions),
      ),
      answer: (input: QuestionsInput) => request("questions.answer", input),
      snapshot: harness.client.session.getSnapshot(target),
    }
  })

const answerMessages = <M extends { readonly metadata?: { readonly customType?: string } }>(
  messages: ReadonlyArray<M>,
): ReadonlyArray<M> =>
  messages.filter((message) => message.metadata?.customType === QUESTION_ANSWER_TYPE)

const decodeTextPart = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
)

const lastAssistantText = (
  messages: ReadonlyArray<{
    readonly role: string
    readonly parts: ReadonlyArray<{ readonly type: string }>
  }>,
): string => {
  const last = messages.findLast((message) => message.role === "assistant")
  return (last?.parts ?? [])
    .flatMap((part) =>
      Option.match(decodeTextPart(part), { onNone: () => [], onSome: (text) => [text.text] }),
    )
    .join("")
}

const cacheQuestion = {
  questions: [
    {
      header: "cache",
      question: "Which cache backend do you want in production?",
      options: [{ label: "in-memory LRU" }, { label: "Redis" }],
      assume: "in-memory LRU",
    },
  ],
}

/** The request's messages without the turn notices that ride after them. */
const conversationOf = (prompt: Prompt.Prompt) => {
  if (turnRequestText(prompt).notices.length === 0) return prompt.content
  return prompt.content.slice(0, -1)
}

const twoQuestions = {
  questions: [
    ...cacheQuestion.questions,
    { header: "db", question: "Which database should the tests use?", assume: "SQLite" },
  ],
}

const decodeAnswerDetails = Schema.decodeUnknownOption(QuestionAnswerDetails)

/** Every answer the model read for question `id`, across the answer messages. */
const answersTo = (
  messages: ReadonlyArray<{
    readonly metadata?: { readonly customType?: string; readonly details?: unknown }
  }>,
  id: string,
) =>
  answerMessages(messages).flatMap((message) =>
    Option.match(decodeAnswerDetails(message.metadata?.details), {
      onNone: () => [],
      onSome: (details) =>
        details.answers.filter((entry) => entry.id === id).map((entry) => entry.answer),
    }),
  )

const encodeRows = Schema.encodeSync(Schema.fromJsonString(Schema.Array(QuestionRow)))

describe("ask_user_async", () => {
  it.live(
    "the call returns at once and the turn ends with no answer; the question stays open",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
            toolCallStep("ask_user_async", cacheQuestion, { toolCallId: ToolCallId.make("ask-1") }),
            textStep("Using an in-memory LRU for now."),
          ])
          const harness = yield* questionsHarness(providerLayer)
          yield* harness.client.message.send({ ...harness.target, content: "add a cache" })
          const done = yield* waitFor(
            harness.snapshot,
            (current) =>
              current.runtime._tag === "Idle" &&
              lastAssistantText(current.messages) === "Using an in-memory LRU for now.",
            5_000,
            "the turn answered without waiting",
          )
          expect(done.runtime._tag).toBe("Idle")
          yield* controls.assertDone
          const open = yield* harness.open
          expect(open).toMatchObject([
            {
              id: "ask-1:0",
              header: "cache",
              question: "Which cache backend do you want in production?",
              assume: "in-memory LRU",
            },
          ])
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "an answer during the turn joins its next step as the last user message, after an unchanged prefix",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>()
          const prompts: Array<Prompt.Prompt> = []
          const record = (options: { readonly prompt: Prompt.Prompt }) => {
            prompts.push(options.prompt)
          }
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
            {
              ...multiToolCallStep(
                {
                  toolName: "ask_user_async",
                  input: cacheQuestion,
                  toolCallId: ToolCallId.make("ask-2"),
                },
                { toolName: "hold", input: {}, toolCallId: ToolCallId.make("hold-2") },
              ),
              assertOptions: record,
            },
            { ...textStep("Switching the cache to Redis."), assertOptions: record },
          ])
          const harness = yield* questionsHarness(providerLayer, [holdFixture(release)])
          const turns = yield* harness.client.session.events(harness.target).pipe(
            Stream.filter(({ event }) => event._tag === "TurnCompleted"),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          )
          yield* harness.client.message.send({ ...harness.target, content: "add a cache" })
          yield* waitFor(harness.open, (open) => open.length === 1, 5_000, "the question is open")
          // The step still runs: the hold call has not returned.
          yield* harness.answer({
            answers: [{ id: "ask-2:0", answer: "Redis, we run it in prod" }],
          })
          // The waiting answer carries its message's metadata, so a client
          // can show it as an answer rather than as its text.
          const waiting = (yield* harness.snapshot).runtime.queue.steering
          expect(waiting.map((entry) => entry.metadata?.customType)).toEqual([QUESTION_ANSWER_TYPE])
          expect(answersTo(waiting, "ask-2:0")).toEqual(["Redis, we run it in prod"])
          yield* Deferred.succeed(release, void 0)
          yield* Fiber.join(turns)
          yield* controls.assertDone

          const [first, second] = Option.getOrThrow(
            Option.all([Option.fromUndefinedOr(prompts[0]), Option.fromUndefinedOr(prompts[1])]),
          )
          const before = jsonText(conversationOf(first))
          const after = jsonText(conversationOf(second))
          // Byte prefix: the second request only appends to the first.
          expect(after.startsWith(before.slice(0, -1))).toBe(true)
          const last = conversationOf(second).at(-1)
          expect(last?.role).toBe("user")
          expect(jsonText(last)).toContain("A: Redis, we run it in prod")

          const snapshot = yield* harness.snapshot
          // One turn: the answer joined it and opened none of its own.
          expect(answerMessages(snapshot.messages)).toHaveLength(1)
          expect(lastAssistantText(snapshot.messages)).toBe("Switching the cache to Redis.")
          expect(yield* harness.open).toEqual([])
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  // A turn parked on a blocking ask resumes at a step boundary: the stored
  // tool results are there and no stream is open, so an answer that came
  // while it waited joins before the next model request, not after it.
  it.live(
    "a turn parked on ask_user resumes with the background answer in its first request",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const prompts: Array<Prompt.Prompt> = []
          const record = (options: { readonly prompt: Prompt.Prompt }) => {
            prompts.push(options.prompt)
          }
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("ask_user_async", cacheQuestion, { toolCallId: ToolCallId.make("ask-p") }),
            toolCallStep(
              "ask_user",
              {
                questions: [{ question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }],
              },
              { toolCallId: ToolCallId.make("park-p") },
            ),
            { ...textStep("Done with Redis."), assertOptions: record },
            { ...textStep("Done with Redis, again."), assertOptions: record },
          ])
          const harness = yield* questionsHarness(providerLayer, [], {
            approvalLayer: ApprovalService.Live,
          })
          const presented = yield* harness.client.session.events(harness.target).pipe(
            Stream.map((envelope) => envelope.event),
            Stream.filter((event) => event._tag === "InteractionPresented"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          )
          yield* harness.client.message.send({ ...harness.target, content: "add a cache" })
          const [ask] = Array.from(yield* Fiber.join(presented))
          if (ask?._tag !== "InteractionPresented") return yield* Effect.die("no ask presented")
          yield* harness.answer({ answers: [{ id: "ask-p:0", answer: "Redis" }] })
          yield* harness.client.interaction.respondInteraction({
            ...harness.target,
            requestId: ask.requestId,
            approved: true,
            notes: '[["Yes"]]',
          })
          yield* waitFor(
            harness.snapshot,
            (current) => current.runtime._tag === "Idle" && prompts.length > 0,
            5_000,
            "the resumed turn ended",
          )
          const first = Option.getOrThrow(Option.fromUndefinedOr(prompts[0]))
          const last = conversationOf(first).at(-1)
          expect(last?.role).toBe("user")
          expect(jsonText(last)).toContain("A: Redis")
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  // An interrupt while the resumed tool still runs ends the turn with no model
  // request: the answer that waited must not join it, or no model reads it.
  it.live(
    "an interrupt while a resumed tool runs leaves the background answer for a turn of its own",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const resumed = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const prompts: Array<Prompt.Prompt> = []
          const record = (options: { readonly prompt: Prompt.Prompt }) => {
            prompts.push(options.prompt)
          }
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("ask_user_async", cacheQuestion, { toolCallId: ToolCallId.make("ask-i") }),
            toolCallStep("ask_then_hold", {}, { toolCallId: ToolCallId.make("hold-i") }),
            { ...textStep("Switching the cache to Redis."), assertOptions: record },
          ])
          const harness = yield* questionsHarness(
            providerLayer,
            [askThenHoldFixture(resumed, release)],
            { approvalLayer: ApprovalService.Live },
          )
          const presented = yield* harness.client.session.events(harness.target).pipe(
            Stream.map((envelope) => envelope.event),
            Stream.filter((event) => event._tag === "InteractionPresented"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          )
          yield* harness.client.message.send({ ...harness.target, content: "add a cache" })
          const [ask] = Array.from(yield* Fiber.join(presented))
          if (ask?._tag !== "InteractionPresented") return yield* Effect.die("no ask presented")
          yield* harness.answer({ answers: [{ id: "ask-i:0", answer: "Redis" }] })
          yield* harness.client.interaction.respondInteraction({
            ...harness.target,
            requestId: ask.requestId,
            approved: true,
          })
          yield* Deferred.await(resumed)
          yield* harness.client.steer.command({
            command: SteerCommand.make({
              _tag: "Cancel",
              ...harness.target,
              requestId: RequestId.make("cancel-resumed-hold"),
            }),
          })
          yield* Deferred.succeed(release, void 0)
          const woken = yield* waitFor(
            harness.snapshot,
            (current) =>
              current.runtime._tag === "Idle" &&
              lastAssistantText(current.messages) === "Switching the cache to Redis.",
            5_000,
            "the answer opened a turn of its own",
          )
          const first = Option.getOrThrow(Option.fromUndefinedOr(prompts[0]))
          const last = conversationOf(first).at(-1)
          expect(last?.role).toBe("user")
          expect(jsonText(last)).toContain("A: Redis")
          expect(answerMessages(woken.messages)).toHaveLength(1)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "an answer on an idle branch starts a turn, and a repeated answer sends nothing more",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
            toolCallStep("ask_user_async", cacheQuestion, { toolCallId: ToolCallId.make("ask-3") }),
            textStep("Using an in-memory LRU for now."),
            textStep("Switching the cache to Redis."),
          ])
          const harness = yield* questionsHarness(providerLayer)
          yield* harness.client.message.send({ ...harness.target, content: "add a cache" })
          yield* waitFor(
            harness.snapshot,
            (current) =>
              current.runtime._tag === "Idle" &&
              lastAssistantText(current.messages) === "Using an in-memory LRU for now.",
            5_000,
            "the first turn answered",
          )
          const answer = { answers: [{ id: "ask-3:0", answer: "Redis" }] }
          yield* harness.answer(answer)
          yield* harness.answer(answer)
          const woken = yield* waitFor(
            harness.snapshot,
            (current) =>
              current.runtime._tag === "Idle" &&
              lastAssistantText(current.messages) === "Switching the cache to Redis.",
            5_000,
            "the answer started a turn",
          )
          expect(answerMessages(woken.messages)).toHaveLength(1)
          yield* controls.assertDone
          expect(yield* harness.open).toEqual([])
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "a dismiss closes the question and sends no message",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
            toolCallStep("ask_user_async", cacheQuestion, { toolCallId: ToolCallId.make("ask-4") }),
            textStep("Using an in-memory LRU for now."),
          ])
          const harness = yield* questionsHarness(providerLayer)
          yield* harness.client.message.send({ ...harness.target, content: "add a cache" })
          yield* waitFor(harness.open, (open) => open.length === 1, 5_000, "the question is open")
          yield* waitFor(
            harness.snapshot,
            (current) => current.runtime._tag === "Idle" && current.messages.length >= 3,
            5_000,
            "the turn ended",
          )
          yield* harness.answer({ answers: [], dismiss: ["ask-4:0"] })
          expect(yield* harness.open).toEqual([])
          const snapshot = yield* harness.snapshot
          expect(answerMessages(snapshot.messages)).toHaveLength(0)
          yield* controls.assertDone
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  // First answer wins per question: a submit whose write failed, then a
  // retry that answers fewer questions, must not reach the model twice.
  it.live(
    "a failed answer write and a narrower retry give each question one answer",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("ask_user_async", twoQuestions, { toolCallId: ToolCallId.make("ask-f") }),
            textStep("Using the defaults for now."),
            textStep("Switching the cache."),
            textStep("Switching the cache, again."),
          ])
          const harness = yield* questionsHarness(providerLayer)
          yield* harness.client.message.send({ ...harness.target, content: "add a cache" })
          yield* waitFor(
            harness.snapshot,
            (current) =>
              current.runtime._tag === "Idle" &&
              lastAssistantText(current.messages) === "Using the defaults for now.",
            5_000,
            "the first turn answered",
          )
          const fs = yield* FileSystem.FileSystem
          const directory = `${harness.home}/.gent/questions`
          yield* fs.chmod(directory, 0o555)
          const failed = yield* harness
            .answer({
              answers: [
                { id: "ask-f:0", answer: "Redis" },
                { id: "ask-f:1", answer: "Postgres" },
              ],
            })
            .pipe(Effect.exit)
          yield* fs.chmod(directory, 0o755)
          expect(failed._tag).toBe("Failure")
          yield* harness.answer({ answers: [{ id: "ask-f:0", answer: "SQLite file" }] })
          yield* waitFor(
            harness.snapshot,
            (current) =>
              current.runtime._tag === "Idle" && answerMessages(current.messages).length > 0,
            5_000,
            "the answer turn ended",
          )
          const snapshot = yield* harness.snapshot
          expect(answersTo(snapshot.messages, "ask-f:0")).toHaveLength(1)
          expect(answersTo(snapshot.messages, "ask-f:1")).toEqual([])
          expect((yield* harness.open).map((row) => row.id)).toEqual(["ask-f:1"])
        }).pipe(Effect.timeout("8 seconds"), Effect.provide(BunFileSystem.layer)),
      ),
    10_000,
  )

  // The state a failed removal leaves: an answer recorded, and maybe sent,
  // whose row is still in the file. The recorded answer is the one that goes,
  // and a batch sent again under its request id reaches the model once.
  it.live(
    "a recorded answer wins over a later one, and its batch reaches the model once",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("ask_user_async", twoQuestions, { toolCallId: ToolCallId.make("ask-o") }),
            textStep("Using the defaults for now."),
            textStep("Switching the cache."),
            textStep("Switching the cache, again."),
          ])
          const harness = yield* questionsHarness(providerLayer)
          yield* harness.client.message.send({ ...harness.target, content: "add a cache" })
          yield* waitFor(
            harness.snapshot,
            (current) =>
              current.runtime._tag === "Idle" &&
              lastAssistantText(current.messages) === "Using the defaults for now.",
            5_000,
            "the first turn answered",
          )
          const fs = yield* FileSystem.FileSystem
          const file = `${harness.home}/.gent/questions/${harness.branchId}.json`
          const opened = yield* harness.open
          const [cache, db] = Option.getOrThrow(
            Option.all([Option.fromUndefinedOr(opened[0]), Option.fromUndefinedOr(opened[1])]),
          )
          const planted = encodeRows([
            { ...cache, answered: { answer: "Redis", batch: "question-answer:planted" } },
            db,
          ])
          yield* fs.writeFileString(file, planted)
          expect((yield* harness.open).map((row) => row.id)).toEqual(["ask-o:1"])
          yield* harness.answer({ answers: [{ id: "ask-o:0", answer: "SQLite file" }] })
          yield* waitFor(
            harness.snapshot,
            (current) =>
              current.runtime._tag === "Idle" && answerMessages(current.messages).length > 0,
            5_000,
            "the answer turn ended",
          )
          // The removal failed after the send: the batch is in the file again.
          yield* fs.writeFileString(file, planted)
          yield* harness.answer({ answers: [] })
          const snapshot = yield* harness.snapshot
          expect(answersTo(snapshot.messages, "ask-o:0")).toEqual(["Redis"])
          expect((yield* harness.open).map((row) => row.id)).toEqual(["ask-o:1"])
        }).pipe(Effect.timeout("8 seconds"), Effect.provide(BunFileSystem.layer)),
      ),
    10_000,
  )

  it.live(
    "a session delete removes its open questions",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("ask_user_async", cacheQuestion, { toolCallId: ToolCallId.make("ask-d") }),
            textStep("Using an in-memory LRU for now."),
          ])
          const harness = yield* questionsHarness(providerLayer)
          yield* harness.client.message.send({ ...harness.target, content: "add a cache" })
          yield* waitFor(harness.open, (open) => open.length === 1, 5_000, "the question is open")
          const fs = yield* FileSystem.FileSystem
          const file = `${harness.home}/.gent/questions/${harness.branchId}.json`
          expect(yield* fs.exists(file)).toBe(true)
          yield* harness.client.session.delete({ sessionId: harness.sessionId })
          yield* waitFor(fs.exists(file), (exists) => !exists, 5_000, "the file removed")
        }).pipe(Effect.timeout("8 seconds"), Effect.provide(BunFileSystem.layer)),
      ),
    10_000,
  )

  it.live("a run of the same call twice keeps one open row", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("questions-replay-")
      const ctx = testToolContext({ home, toolCallId: ToolCallId.make("call-r") })
      const run = runToolWithCtx(AskUserAsyncTool, cacheQuestion, ctx)
      const first = yield* run
      yield* run
      const fs = yield* FileSystem.FileSystem
      const stored = yield* fs
        .readFileString(`${home}/.gent/questions/test-branch.json`)
        .pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(OpenQuestion))),
          ),
        )
      expect(first.asked).toEqual([{ id: "call-r:0", assume: "in-memory LRU" }])
      expect(stored.map((row) => row.id)).toEqual(["call-r:0"])
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.live(
    "a spawned child's task turn is not offered the tool; its parent's turn is",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const childTask = "CHILD-TASK: reply with pong"
          const offered = new Map<"parent" | "child", ReadonlyArray<string>>()
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const names = options.tools.map((entry) => entry.name)
            // The child reads its task as its own first message; the parent
            // carries it only inside its start call.
            const firstUser = options.prompt.content.find((message) => message.role === "user")
            const isChild = Option.exists(Option.fromUndefinedOr(firstUser), (message) =>
              jsonText(message).includes(childTask),
            )
            const called = options.prompt.content.some((message) => message.role === "tool")
            if (isChild) {
              offered.set("child", names)
              return Effect.succeed(
                Stream.fromIterable([textDeltaPart("pong"), finishPart({ finishReason: "stop" })]),
              )
            }
            if (!offered.has("parent")) offered.set("parent", names)
            if (called) {
              return Effect.succeed(
                Stream.fromIterable([
                  textDeltaPart("started"),
                  finishPart({ finishReason: "stop" }),
                ]),
              )
            }
            return Effect.succeed(
              Stream.fromIterable([
                toolCallPart(
                  "delegate.start",
                  { todo: childTask },
                  { toolCallId: ToolCallId.make("start-1") },
                ),
                finishPart({ finishReason: "tool-calls" }),
              ]),
            )
          })
          const harness = yield* questionsHarness(providerLayer)
          yield* harness.client.message.send({ ...harness.target, content: "delegate it" })
          yield* waitFor(
            Effect.sync(() => offered.has("child")),
            (seen) => seen,
            5_000,
            "the child's task turn asked the model",
          )
          expect(offered.get("parent")).toContain("ask_user_async")
          expect(offered.get("child")).not.toContain("ask_user_async")
          expect(offered.get("child")).not.toContain("ask_user")
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )
})
