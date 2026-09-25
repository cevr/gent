import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, FileSystem, Schema, Stream } from "effect"
import { AskUserTool, HandoffTool, PromptTool } from "../src/interaction-tools.js"
import { BranchId, SessionId, ToolCallId } from "@gent/core/protocol"
import {
  createRpcHarness,
  runToolWithCtx,
  testToolContext,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  textStep,
  toolCallStep,
  RuntimeEnvironment,
} from "@gent/core/test-utils"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import type { ApprovalDecision, ExtensionContextService } from "@gent/core/extensions/api"
import { e2ePreset, shippedPreset } from "./helpers/test-preset"
import { isToolResultFor } from "./helpers/tool-event.js"

// ── ask user ────────────────────────────────────────────────────────────────

const makeCtx = (
  decision: Effect.Effect<{ readonly approved: boolean; readonly notes?: string }>,
) => {
  const interaction = {
    approve: () => decision,
    present: () => Effect.die("not wired"),
  }
  return {
    ctx: testToolContext({
      sessionId: SessionId.make("test-session"),
      branchId: BranchId.make("test-branch"),
      toolCallId: ToolCallId.make("test-call"),
      cwd: "/tmp",
      home: "/nonexistent/gent-test-home",
      Interaction: interaction,
    }),
    interaction,
  } satisfies {
    readonly ctx: ReturnType<typeof testToolContext>
    readonly interaction: typeof interaction
  }
}

describe("AskUser Tool", () => {
  it.live("asks questions and returns answers", () => {
    const { ctx } = makeCtx(Effect.succeed({ approved: true, notes: "Option A" }))

    return runToolWithCtx(
      AskUserTool,
      {
        questions: [
          {
            question: "Which approach?",
            header: "Approach",
            options: [
              { label: "Option A", description: "First option" },
              { label: "Option B", description: "Second option" },
            ],
          },
        ],
      },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.answers.length).toBe(1)
        expect(result.answers[0]).toEqual(["Option A"])
        expect(result.cancelled).toBeUndefined()
      }),
    )
  })

  it.live("decodes structured JSON answers from notes", () => {
    const { ctx } = makeCtx(
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
    const { ctx } = makeCtx(Effect.succeed({ approved: true, notes: "not-json {{{" }))

    return runToolWithCtx(AskUserTool, { questions: [{ question: "Free-form?" }] }, ctx).pipe(
      Effect.map((result) => {
        expect(result.answers).toEqual([["not-json {{{"]])
      }),
    )
  })

  it.live("an approval without notes answers each question with an empty list", () => {
    const { ctx } = makeCtx(Effect.succeed({ approved: true }))

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
        makeCtx(Effect.succeed({ approved: true, notes })).ctx,
      )
    return Effect.gen(function* () {
      // A short list is padded with empty answers.
      expect((yield* run('[["A"]]')).answers).toEqual([["A"], []])
      // A long list is truncated to the question count.
      expect((yield* run('[["A"],["B"],["C"]]')).answers).toEqual([["A"], ["B"]])
    })
  })

  it.live("free-text notes answer the first question and leave the rest empty", () => {
    const { ctx } = makeCtx(Effect.succeed({ approved: true, notes: "free text" }))

    return runToolWithCtx(
      AskUserTool,
      { questions: [{ question: "One?" }, { question: "Two?" }] },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.answers).toEqual([["free text"], []])
      }),
    )
  })

  it.live("cancel returns cancelled flag with empty answers", () => {
    const { ctx } = makeCtx(Effect.succeed({ approved: false }))

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

  it.live("present mode: returns shown status", () =>
    runToolWithCtx(
      PromptTool,
      { mode: "present", content: "Info" },
      testToolContext({
        Interaction: {
          approve: () => Effect.die("interaction.approve not wired"),
          present: () => Effect.void,
        },
      }),
    ).pipe(
      Effect.map((result) => {
        expect(result.mode).toBe("present")
        if (result.mode === "present") expect(result.status).toBe("shown")
      }),
    ),
  )
})

// ── interaction tools rpc ───────────────────────────────────────────────────

/**
 * Interaction-tools RPC acceptance test — exercises the `ask_user` and
 * `prompt` tools through real agent turns (LLM emits the tool call, runtime
 * dispatches it inside the per-request scope and through the ApprovalService
 * Test stub which auto-approves). The existing tool-level tests bypass the
 * scope boundary production uses.
 *
 * Both tools route through `ExtensionContext.Interaction`, which is the
 * highest scope-leak risk surface — Approval is yielded inside the executor
 * and the result must survive across the per-request scope edge.
 *
 * Maps W37 S6 C14 (audit L5-P1-2).
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
          durableApproval: true,
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
            durableApproval: true,
            cwd,
            extraLayers: [RuntimeEnvironment.Live({ cwd, home: cwd })],
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

  it.live(
    "ask_user tool call routes through per-request scope and auto-approves via Test ApprovalService",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("ask_user", {
              questions: [
                {
                  question: "What's your favorite color?",
                  header: "color",
                },
              ],
            }),
            textStep("asked"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })

          const toolEventFiber = yield* client.session
            .events({ sessionId, branchId })
            .pipe(
              Stream.filter(isToolResultFor("ask_user")),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "ask me a question",
          })

          const events = Array.from(yield* Fiber.join(toolEventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain("answers")
          }
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "prompt tool (confirm mode) routes through per-request scope and auto-approves via Test ApprovalService",
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

  it.live(
    "prompt tool (review mode) routes through per-request scope, writes a file, and auto-approves",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("prompt", {
              mode: "review",
              content: "# Plan\n\nMigrate the actor mailbox to bounded queues.",
              title: "Migration plan",
            }),
            textStep("reviewed"),
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
            content: "review the plan",
          })

          const events = Array.from(yield* Fiber.join(toolEventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain('"mode": "review"')
            expect(succeeded.event.output).toContain('"decision": "yes"')
            expect(succeeded.event.output).toContain(".gent/prompts/")
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
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
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
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )
})
