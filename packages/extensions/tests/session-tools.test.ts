import { describe, expect, it, test } from "effect-bun-test"
import { Effect, Fiber, Option, Stream } from "effect"
import { AgentsExtension } from "../src/agents.js"
import { builtinAgent } from "./helpers/builtin-agents.js"
import { type SystemPromptInput, messagePartsDisplayText } from "@gent/core/extensions/api"
import {
  collectTestContributions,
  createRpcHarness,
  LanguageModelLayers,
  toolCallStep,
  type MessagePart,
} from "@gent/core/test-utils"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  renderMessageParts,
  renderSessionTree,
  sessionMessageBody,
  sessionMessageText,
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

// ── session-tools.test ──────────────────────────────────────────────────────

/**
 * SessionToolsExtension prompt-slot behavior locks.
 *
 * The extension contributes a `systemPrompt` projection slot that injects
 * a `## Session naming` instruction for interactive prompts and skips it
 * for non-interactive ones. Test pins both branches against the
 * runtime slot compiler.
 */

const getSystemPrompt = Effect.gen(function* () {
  const contributions = yield* collectTestContributions(SessionToolsExtension.setup)
  const systemPrompt = Option.fromUndefinedOr(
    contributions.hooks?.find((slot) => slot.kind === "systemPrompt"),
  )
  if (Option.isNone(systemPrompt)) {
    return yield* Effect.die(new Error("expected session tools systemPrompt hook"))
  }
  return systemPrompt.value.hook.handler
})

describe("SessionToolsExtension", () => {
  it.live("injects naming instruction for interactive prompts", () =>
    Effect.gen(function* () {
      const systemPrompt = yield* getSystemPrompt
      const prompt = yield* systemPrompt({
        basePrompt: "base",
        agent: builtinAgent,
        interactive: true,
      } satisfies SystemPromptInput)
      expect(prompt).toContain("## Session naming")
      expect(prompt.startsWith("base")).toBe(true)
    }),
  )
  it.live("non-interactive prompts pass through unchanged", () =>
    Effect.gen(function* () {
      const systemPrompt = yield* getSystemPrompt
      const prompt = yield* systemPrompt({
        basePrompt: "base",
        agent: builtinAgent,
        interactive: false,
      } satisfies SystemPromptInput)
      expect(prompt).toBe("base")
    }),
  )
})

// ── session-tools/read-session.test ─────────────────────────────────────────

describe("session.send summary", () => {
  it.live("a sent message reads as who got it and what it said, not JSON", () =>
    Effect.gen(function* () {
      const contributions = yield* collectTestContributions(SessionToolsExtension.setup)
      const send = Option.fromUndefinedOr(
        contributions.tools?.find((candidate) => candidate.id === "session.send"),
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

describe("messagePartsDisplayText", () => {
  test("read-session subpath exports renderMessageParts", () => {
    const parts: MessagePart[] = [Prompt.textPart({ text: "hello world" })]
    expect(renderMessageParts(parts)).toBe(messagePartsDisplayText(parts))
  })

  test("text part → text content", () => {
    const parts: MessagePart[] = [Prompt.textPart({ text: "hello world" })]
    expect(messagePartsDisplayText(parts)).toBe("hello world")
  })

  test("tool-call part → '### tool: name' header + truncated input", () => {
    const parts: MessagePart[] = [
      Prompt.toolCallPart({
        id: ToolCallId.make("tc1"),
        name: "read",
        params: { path: "/tmp/test.txt" },
        providerExecuted: false,
      }),
    ]
    const result = messagePartsDisplayText(parts)
    expect(result).toContain("### tool: read")
    expect(result).toContain("/tmp/test.txt")
  })

  test("tool-call part with undefined input renders without throwing", () => {
    const parts: MessagePart[] = [
      Prompt.toolCallPart({
        id: ToolCallId.make("tc1"),
        name: "read",
        params: Option.getOrUndefined(Option.none()),
        providerExecuted: false,
      }),
    ]
    expect(messagePartsDisplayText(parts)).toBe("### tool: read\nundefined")
  })

  test("tool-result part → 'result: {truncated output}'", () => {
    const parts: MessagePart[] = [
      Prompt.toolResultPart({
        id: ToolCallId.make("tc1"),
        name: "read",
        isFailure: false,
        providerExecuted: false,
        result: "file contents here",
      }),
    ]
    const result = messagePartsDisplayText(parts)
    expect(result).toContain("result: file contents here")
  })

  test("mixed parts joined with newline", () => {
    const parts: MessagePart[] = [
      Prompt.textPart({ text: "start" }),
      Prompt.toolCallPart({
        id: ToolCallId.make("tc1"),
        name: "bash",
        params: { command: "ls" },
        providerExecuted: false,
      }),
    ]
    const result = messagePartsDisplayText(parts)
    expect(result).toContain("start")
    expect(result).toContain("### tool: bash")
    expect(result.indexOf("start")).toBeLessThan(result.indexOf("### tool: bash"))
  })
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

// ── session-tools/session-tools-rpc.test ────────────────────────────────────

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
})

describe("session message header", () => {
  const from = { sessionId: SessionId.make("child-1"), relation: "child" }

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
