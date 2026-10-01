import { describe, expect, it, test } from "effect-bun-test"
import { Effect, Fiber, Option, Stream } from "effect"
import { AgentsExtension } from "../src/agents.js"
import { DEFAULT_SESSION_NAME, getToolId } from "@gent/core/extensions/api"
import {
  collectTestContributions,
  createRpcHarness,
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
  toolCallPart,
  textStep,
  toolCallStep,
  waitFor,
} from "@gent/core/test-utils"
import * as Prompt from "effect/ai/Prompt"
import {
  renderSessionTree,
  type SessionMessageDetails,
  sessionMessageBody,
  sessionMessageText,
  sessionTitleOf,
  SessionToolsExtension,
} from "../src/session-tools.js"
import { toolResultSummary } from "@gent/core/extensions/branch-tools"
import {
  Branch,
  dateFromMillis,
  Message,
  BranchId,
  MessageId,
  SessionId,
  ToolCallId,
  type EventEnvelope,
} from "@gent/core/protocol"
import { e2ePreset } from "./helpers/test-preset"
import { isToolEventFor } from "./helpers/tool-event.js"

// ── session naming ──────────────────────────────────────────────────────────

/** Forks a reader that ends after `count` turns of the branch have ended. */
const turnEnds = <E>(stream: Stream.Stream<EventEnvelope, E>, count: number) =>
  stream.pipe(
    Stream.filter((envelope) => envelope.event._tag === "TurnCompleted"),
    Stream.take(count),
    Stream.runDrain,
    Effect.forkScoped,
  )

describe("session naming", () => {
  it.live(
    "a root session takes its name from the first line of its first message",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("done")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [AgentsExtension, SessionToolsExtension],
          })
          yield* client.message.send({
            sessionId,
            branchId,
            content: "  Fix the login redirect\nIt loops after sign-in.",
          })
          const named = yield* waitFor(
            client.session.get({ sessionId }),
            (session) => session?.name !== DEFAULT_SESSION_NAME,
            3_000,
            "the session's name",
          )
          expect(named?.name).toBe("Fix the login redirect")
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
  it.live(
    "a name the model gives in the first turn wins over the first message",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("rename_session", { name: "auth redirect work" }),
            textStep("done"),
            textStep("again"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [AgentsExtension, SessionToolsExtension],
          })
          const events = client.session.events({ sessionId, branchId })
          const first = yield* turnEnds(events, 1)
          // The loop runs a turn's `turnAfter` hooks before it takes the next
          // turn, so once the second turn ends the first one's hooks have run.
          const second = yield* turnEnds(events, 2)
          yield* client.message.send({ sessionId, branchId, content: "Fix the login redirect" })
          yield* Fiber.join(first)
          yield* client.message.send({ sessionId, branchId, content: "And the logout one" })
          yield* Fiber.join(second)
          expect((yield* client.session.get({ sessionId }))?.name).toBe("auth redirect work")
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  // A handoff's first message is the model's markdown, and an `@file`
  // reference arrives as a fenced block: the title is the first plain words.
  test("the title skips fenced file text and leading markdown markers", () => {
    const fileRef = "```src/foo.ts\nconst a = 1\n```"
    const cases: ReadonlyArray<readonly [string, Option.Option<string>]> = [
      ["## Current task\nShip the fix.", Option.some("Current task")],
      ["- **Ship the fix**", Option.some("Ship the fix")],
      ["> `retry` loops forever", Option.some("`retry` loops forever")],
      [`${fileRef} fix this`, Option.some("fix this")],
      [`${fileRef}\nfix this`, Option.some("fix this")],
      ["---\n\nFix the login redirect", Option.some("Fix the login redirect")],
      ["  Fix the login redirect\nIt loops.", Option.some("Fix the login redirect")],
      [fileRef, Option.none()],
    ]
    for (const [text, title] of cases) expect([text, sessionTitleOf(text)]).toEqual([text, title])
  })
})

// ── read session ────────────────────────────────────────────────────────────

describe("session.send summary", () => {
  it.live("a sent message reads as who got it and what it said, not JSON", () =>
    Effect.gen(function* () {
      const contributions = yield* collectTestContributions(SessionToolsExtension.setup)
      const send = Option.fromUndefinedOr(
        contributions.tools?.find((candidate) => getToolId(candidate) === "session.send"),
      )
      expect(Option.isSome(send)).toBe(true)
      expect(
        toolResultSummary(
          send,
          { to: "parent", message: "  CI is green  " },
          { isFailure: false, result: { sessionId: "parent-1", relation: "parent" } },
        ),
      ).toBe("to parent · CI is green")
    }),
  )
})

describe("renderSessionTree", () => {
  const now = dateFromMillis(0)
  const sid = SessionId.make("s1")
  const bid1 = BranchId.make("b1")
  const bid2 = BranchId.make("b2")

  const makeBranch = (id: BranchId, opts?: { parentBranchId?: BranchId; name?: string }) =>
    new Branch({
      id,
      sessionId: sid,
      parentBranchId: opts?.parentBranchId,
      name: opts?.name,
      createdAt: now,
    })

  let messageIndex = 0
  const makeMessage = (branchId: BranchId, role: "user" | "assistant", text: string) =>
    Message.cases.regular.make({
      id: MessageId.make(`msg-${messageIndex++}`),
      sessionId: sid,
      branchId,
      role,
      parts: [Prompt.textPart({ text })],
      createdAt: now,
    })

  test("single branch → '# Branch: name' header + messages", () => {
    const branch = makeBranch(bid1, { name: "main" })
    const msg = makeMessage(bid1, "user", "hello")
    const result = renderSessionTree([{ branch, messages: [msg] }], Option.none())
    expect(result).toContain("# Branch: main")
    expect(result).toContain("## user")
    expect(result).toContain("hello")
  })

  test("target branch → '[TARGET BRANCH]' marker", () => {
    const branch = makeBranch(bid1, { name: "main" })
    const msg = makeMessage(bid1, "user", "hello")
    const result = renderSessionTree([{ branch, messages: [msg] }], Option.some(bid1))
    expect(result).toContain("[TARGET BRANCH]")
  })

  test("child branch → '--- branch point ---' separator", () => {
    const parent = makeBranch(bid1, { name: "main" })
    const child = makeBranch(bid2, { parentBranchId: bid1, name: "fix" })
    const result = renderSessionTree(
      [
        { branch: parent, messages: [makeMessage(bid1, "user", "start")] },
        { branch: child, messages: [makeMessage(bid2, "assistant", "fixed")] },
      ],
      Option.none(),
    )
    expect(result).toContain("# Branch: main")
    expect(result).toContain("--- branch point: fix ---")
  })
})

// ── session tools rpc ───────────────────────────────────────────────────────

const toolEventsFor = <E>(stream: Stream.Stream<EventEnvelope, E>, toolName: string) =>
  stream.pipe(
    Stream.filter(isToolEventFor(toolName)),
    Stream.take(2),
    Stream.runCollect,
    Effect.forkScoped,
  )

describe("Session tools via model turn", () => {
  it.live(
    "read_session uses the request-scoped session host facet",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("read_session", { sessionId: "missing-session-tools-rpc" }),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [AgentsExtension, SessionToolsExtension],
          })
          const eventFiber = yield* toolEventsFor(
            client.session.events({ sessionId, branchId }),
            "read_session",
          )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "Read this session",
          })

          const events = Array.from(yield* Fiber.join(eventFiber))
          const failed = events.find((event) => event.event._tag === "ToolCallFailed")
          expect(failed?.event._tag).toBe("ToolCallFailed")
          if (failed?.event._tag === "ToolCallFailed") {
            expect(failed.event.output).toContain("Failed to load session")
          }
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
  it.live(
    "read_session refuses a branch the session does not have",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let target = ""
          let calls = 0
          const providerLayer = LanguageModelLayers.testStream(() => {
            calls += 1
            if (calls > 1) {
              return Effect.succeed(
                Stream.fromIterable([textDeltaPart("done"), finishPart({ finishReason: "stop" })]),
              )
            }
            return Effect.succeed(
              Stream.fromIterable([
                toolCallPart(
                  "read_session",
                  { sessionId: target, branchId: "no-such-branch" },
                  { toolCallId: ToolCallId.make("read-unknown-branch") },
                ),
                finishPart({ finishReason: "tool-calls" }),
              ]),
            )
          })
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [AgentsExtension, SessionToolsExtension],
          })
          target = sessionId
          const eventFiber = yield* toolEventsFor(
            client.session.events({ sessionId, branchId }),
            "read_session",
          )
          yield* client.message.send({ sessionId, branchId, content: "Read this session" })
          const events = Array.from(yield* Fiber.join(eventFiber))
          const failed = events.find((event) => event.event._tag === "ToolCallFailed")
          expect(failed?.event._tag).toBe("ToolCallFailed")
          if (failed?.event._tag === "ToolCallFailed") {
            expect(failed.event.output).toContain("has no branch no-such-branch")
          }
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
  it.live(
    "a handoff session messages its predecessor as a session, not as its child",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let calls = 0
          const providerLayer = LanguageModelLayers.testStream(() => {
            calls += 1
            if (calls > 1) {
              return Effect.succeed(
                Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
              )
            }
            return Effect.succeed(
              Stream.fromIterable([
                toolCallPart(
                  "session.send",
                  { to: "parent", message: "picked up where you left off" },
                  { toolCallId: ToolCallId.make("handoff-send") },
                ),
                finishPart({ finishReason: "tool-calls" }),
              ]),
            )
          })
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [AgentsExtension, SessionToolsExtension],
          })
          const handoff = yield* client.session.create({
            cwd: process.cwd(),
            parentSessionId: sessionId,
            parentBranchId: branchId,
            continueThread: true,
          })
          const eventFiber = yield* toolEventsFor(
            client.session.events({ sessionId: handoff.sessionId, branchId: handoff.branchId }),
            "session.send",
          )
          yield* client.message.send({
            sessionId: handoff.sessionId,
            branchId: handoff.branchId,
            content: "Tell the last session",
          })
          const events = Array.from(yield* Fiber.join(eventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded?.event._tag).toBe("ToolCallSucceeded")
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain('"relation": "session"')
          }
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})

describe("session message header", () => {
  const from = {
    sessionId: SessionId.make("child-1"),
    relation: "child",
  } satisfies SessionMessageDetails["from"]

  test("a child's message says it is not the completion, before and after it", () => {
    const text = sessionMessageText({ from, message: "CI is green" })
    expect(text).toContain("child-completion message; this message is not one")
    expect(text).not.toContain("still running")
    expect(sessionMessageBody(from, text)).toBe("CI is green")
  })

  test("a stored row with the earlier status line still shows only its body", () => {
    const stored =
      "Message from your child (session child-1):\nYour child is still running. This is not its completion; that arrives as a separate message.\n\nCI is green"
    expect(sessionMessageBody(from, stored)).toBe("CI is green")
  })
})
