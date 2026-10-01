/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Effect, FileSystem, Option } from "effect"
import {
  type InteractionPresented,
  type ApprovalResult,
  BranchId,
  type CreateSessionInput,
  SessionId,
} from "@gent/core/protocol"
import { InteractionRequestId } from "@gent/core/extensions/branch-tools"
import { HandoffRenderer, PromptRenderer } from "../src/interaction-renderers"
import { AskUserRenderer } from "../src/extensions/interaction-tools.client"
import { createMockClient, renderFrame, renderScoped } from "./render-harness-boundary"
import { waitForFrame } from "./helpers-boundary"
import { BunFileSystem } from "@effect/platform-bun"
import { EnvProvider } from "../src/workspace"

// ── ask user ────────────────────────────────────────────────────────────────

const interaction = (text: string) =>
  ({
    _tag: "InteractionPresented",
    sessionId: SessionId.make("s"),
    branchId: BranchId.make("b"),
    requestId: InteractionRequestId.make("req-1"),
    text,
  }) satisfies InteractionPresented

describe("AskUserRenderer", () => {
  it.scopedLive("renders structured questions", () =>
    Effect.gen(function* () {
      const results: ApprovalResult[] = []
      const setup = yield* renderScoped(
        () => (
          <AskUserRenderer
            event={
              {
                ...interaction("fallback question"),
                metadata: {
                  type: "ask-user",
                  questions: [
                    {
                      header: "Pick a color",
                      question: "Choose your favorite",
                      options: [{ label: "Red" }, { label: "Blue" }],
                    },
                  ],
                },
              } satisfies InteractionPresented
            }
            resolve={(r) => results.push(r)}
          />
        ),
        { width: 80, height: 24 },
      )
      const frame = yield* waitForFrame(
        setup,
        (f) => f.includes("Pick a color"),
        "ask-user question",
      )
      expect(frame).toContain("Pick a color")
      expect(frame).toContain("Choose your favorite")
      expect(frame).toContain("Red")
      expect(frame).toContain("Blue")
    }),
  )

  // The ask_user params cap a header at 30 characters and a question at four
  // options. An interaction stored before those caps still shows its choices.
  it.scopedLive("a stored question past the new call limits still shows its choices", () =>
    Effect.gen(function* () {
      const results: ApprovalResult[] = []
      const header = "Which of these deployment targets first?"
      const labels = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]
      const setup = yield* renderScoped(
        () => (
          <AskUserRenderer
            event={
              {
                ...interaction("fallback question"),
                metadata: {
                  type: "ask-user",
                  questions: [
                    {
                      header,
                      question: "Pick one",
                      options: labels.map((label) => ({ label, description: `${label} site` })),
                    },
                  ],
                },
              } satisfies ActiveInteraction
            }
            resolve={(r) => results.push(r)}
          />
        ),
        { width: 80, height: 30 },
      )
      const frame = yield* waitForFrame(setup, (f) => f.includes("Echo"), "the stored choices")
      expect(frame).toContain(header)
      expect(frame).not.toContain("fallback question")
      setup.mockInput.pressArrow("up")
      setup.mockInput.pressArrow("up")
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      expect(results).toEqual([{ approved: true, notes: '[["Echo"]]' }])
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("falls back to yes/no without structured metadata", () =>
    Effect.gen(function* () {
      const results: ApprovalResult[] = []
      const setup = yield* renderScoped(
        () => (
          <AskUserRenderer
            event={interaction("Do you want to proceed?")}
            resolve={(r) => results.push(r)}
          />
        ),
        { width: 80, height: 24 },
      )
      const frame = yield* waitForFrame(
        setup,
        (f) => f.includes("Do you want to proceed"),
        "ask-user fallback",
      )
      expect(frame).toContain("Do you want to proceed")
      expect(frame).toContain("Yes")
      expect(frame).toContain("No")
      setup.mockInput.pressArrow("down")
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      expect(results).toEqual([{ approved: false }])
    }),
  )
})

/**
 * The answer the ask tool decodes: `approved`, and for structured questions
 * one array of picks per question, JSON-encoded in `notes`.
 */
describe("AskUserRenderer answers", () => {
  const color = {
    header: "Pick a color",
    question: "Choose your favorite",
    options: [{ label: "Red" }, { label: "Blue" }],
  }

  const ask = (questions: ReadonlyArray<typeof color & { multiple?: boolean }>) =>
    Effect.gen(function* () {
      const results: ApprovalResult[] = []
      const setup = yield* renderScoped(
        () => (
          <AskUserRenderer
            event={
              {
                ...interaction("fallback question"),
                metadata: { type: "ask-user", questions },
              } satisfies InteractionPresented
            }
            resolve={(r) => results.push(r)}
          />
        ),
        { width: 80, height: 24 },
      )
      yield* waitForFrame(setup, (f) => f.includes("Pick a color"), "the question")
      return { setup, results }
    })

  it.scopedLive("enter on a single choice sends that choice", () =>
    Effect.gen(function* () {
      const { setup, results } = yield* ask([color])
      setup.mockInput.pressArrow("down")
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      expect(results).toEqual([{ approved: true, notes: '[["Blue"]]' }])
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("space toggles each choice of a multiple choice and enter sends them", () =>
    Effect.gen(function* () {
      const { setup, results } = yield* ask([{ ...color, multiple: true }])
      setup.mockInput.pressKey(" ")
      setup.mockInput.pressArrow("down")
      setup.mockInput.pressKey(" ")
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      expect(results).toEqual([{ approved: true, notes: '[["Red","Blue"]]' }])
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("a typed answer past the choices is sent as the answer", () =>
    Effect.gen(function* () {
      const { setup, results } = yield* ask([color])
      setup.mockInput.pressArrow("down")
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.mockInput.typeText("Green"))
      yield* waitForFrame(setup, (f) => f.includes("Green"), "the typed answer")
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      expect(results).toEqual([{ approved: true, notes: '[["Green"]]' }])
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("several questions send one array of picks per question", () =>
    Effect.gen(function* () {
      const size = {
        header: "Pick a size",
        question: "Choose a size",
        options: [{ label: "Small" }, { label: "Large" }],
      }
      const { setup, results } = yield* ask([color, size])
      expect(renderFrame(setup)).toContain("(1/2)")
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, (f) => f.includes("Pick a size"), "the second question")
      expect(results).toEqual([])
      setup.mockInput.pressArrow("down")
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      expect(results).toEqual([{ approved: true, notes: '[["Red"],["Large"]]' }])
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("enter on an empty Other row with nothing picked sends nothing", () =>
    Effect.gen(function* () {
      const { setup, results } = yield* ask([color])
      setup.mockInput.pressArrow("down")
      setup.mockInput.pressArrow("down")
      yield* waitForFrame(setup, (f) => f.includes("> Other:"), "the Other row in focus")
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      expect(results).toEqual([])
      // The question stays open: a choice still answers it.
      setup.mockInput.pressArrow("up")
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      expect(results).toEqual([{ approved: true, notes: '[["Blue"]]' }])
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("escape declines the question", () =>
    Effect.gen(function* () {
      const { setup, results } = yield* ask([color])
      setup.mockInput.pressEscape()
      // A lone escape byte is told from an escape sequence after a short wait.
      yield* waitForFrame(setup, () => results.length > 0, "the decline")
      expect(results).toEqual([{ approved: false }])
    }).pipe(Effect.timeout("10 seconds")),
  )
})

// ── handoff ─────────────────────────────────────────────────────────────────

describe("HandoffRenderer", () => {
  it.scopedLive("renders confirmation with summary", () =>
    Effect.gen(function* () {
      const results: ApprovalResult[] = []
      const setup = yield* renderScoped(
        () => (
          <HandoffRenderer
            event={interaction("Todo complete. Ready to hand off to the user.")}
            resolve={(r) => results.push(r)}
          />
        ),
        { width: 80, height: 24 },
      )
      const frame = yield* waitForFrame(setup, (f) => f.includes("Handoff"), "handoff renderer")
      expect(frame).toContain("Handoff")
      expect(frame).toContain("Ready to hand off")
      expect(frame).toContain("Yes")
      expect(frame).toContain("No")
    }),
  )

  it.scopedLive("confirming opens a linked session seeded with the summary", () =>
    Effect.gen(function* () {
      const results: ApprovalResult[] = []
      const created: CreateSessionInput[] = []
      const client = createMockClient({
        session: {
          create: (input: CreateSessionInput) => {
            created.push(input)
            return Effect.succeed({
              sessionId: SessionId.make("handoff-child"),
              branchId: BranchId.make("handoff-branch"),
              name: "Handoff",
            })
          },
        },
      })
      const setup = yield* renderScoped(
        () => (
          <HandoffRenderer
            event={interaction("Carry over: rows and marker.")}
            resolve={(r) => results.push(r)}
          />
        ),
        {
          width: 80,
          height: 24,
          client,
          initialSession: {
            sessionId: SessionId.make("parent-session"),
            branchId: BranchId.make("parent-branch"),
            name: "Parent",
          },
        },
      )
      yield* waitForFrame(setup, (f) => f.includes("Handoff"), "handoff renderer")
      setup.mockInput.pressEnter()
      yield* waitForFrame(setup, () => created.length === 1, "handoff session request")
      expect(results).toEqual([{ approved: true }])
      expect(created[0]).toMatchObject({
        parentSessionId: "parent-session",
        parentBranchId: "parent-branch",
        initialPrompt: "Carry over: rows and marker.",
      })
    }),
  )
})

// ── prompt ──────────────────────────────────────────────────────────────────

describe("PromptRenderer", () => {
  it.scopedLive.layer(BunFileSystem.layer)(
    "Edit returns the content saved by the external editor",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "gent-review-editor-" })
        const editorPath = `${dir}/editor.js`
        yield* fs.writeFileString(
          editorPath,
          'await Bun.write(process.argv.at(-1), "Edited review from the editor\\n");',
        )
        const results: ApprovalResult[] = []
        const setup = yield* renderScoped(() => (
          <EnvProvider
            env={{
              visual: Option.some(`bun ${editorPath}`),
              editor: Option.none(),
              shutdown: () => {},
              resumable: true,
              writeTerminal: () => {},
            }}
          >
            <PromptRenderer
              event={{
                ...interaction("Original review"),
                metadata: { type: "prompt", mode: "review", title: "Edit review" },
              }}
              resolve={(result) => results.push(result)}
            />
          </EnvProvider>
        ))
        setup.mockInput.pressArrow("down")
        setup.mockInput.pressArrow("down")
        setup.mockInput.pressEnter()
        // The editor is a real `bun` process: its start-up is the wait, so the
        // bound is wall-clock seconds, not the in-process frame default.
        yield* waitForFrame(setup, () => results.length > 0, "edited review reply", 10_000)
        expect(results).toEqual([
          { approved: true, notes: "edit", editedContent: "Edited review from the editor\n" },
        ])
      }),
  )

  it.scopedLive("renders review content with yes/no", () =>
    Effect.gen(function* () {
      const results: ApprovalResult[] = []
      const setup = yield* renderScoped(
        () => (
          <PromptRenderer
            event={
              {
                ...interaction("Here is the generated code"),
                metadata: {
                  type: "prompt",
                  mode: "confirm",
                  title: "Code Review",
                },
              } satisfies InteractionPresented
            }
            resolve={(r) => results.push(r)}
          />
        ),
        { width: 80, height: 24 },
      )
      const frame = yield* waitForFrame(setup, (f) => f.includes("Code Review"), "prompt renderer")
      expect(frame).toContain("Code Review")
      expect(frame).toContain("Here is the generated code")
      expect(frame).toContain("Yes")
      expect(frame).toContain("No")
    }),
  )
})
