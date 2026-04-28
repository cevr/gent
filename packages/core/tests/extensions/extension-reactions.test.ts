import { describe, it, expect } from "effect-bun-test"
import { Cause, Data, Effect, Exit } from "effect"
import { Agents } from "@gent/extensions/all-agents"
import type {
  ContextMessagesInput,
  ExtensionContributions,
  LoadedExtension,
  MessageOutputInput,
  SystemPromptInput,
  TurnBeforeInput,
  TurnAfterInput,
} from "../../src/domain/extension.js"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { BranchId, ExtensionId, MessageId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import { Message, TextPart } from "@gent/core/domain/message"
import { compileExtensionReactions } from "../../src/runtime/extensions/extension-reactions"
import { AgentName } from "@gent/core/domain/agent"

const stubHostCtx = {
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  cwd: "/tmp",
  home: "/tmp",
} as unknown as ExtensionHostContext

const stubProjectionCtx = {
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  cwd: "/tmp",
  home: "/tmp",
  turn: {
    sessionId: SessionId.make("test-session"),
    branchId: BranchId.make("test-branch"),
    agent: Agents["cowork"]!,
    allTools: [],
    agentName: AgentName.make("cowork"),
  },
}

const makeExt = (
  id: string,
  scope: "builtin" | "user" | "project",
  contributions: ExtensionContributions,
): LoadedExtension => ({
  manifest: { id: ExtensionId.make(id) },
  scope,
  sourcePath: `/test/${id}`,
  contributions,
})

class BoomError extends Data.TaggedError("@gent/core/tests/extension-reactions/BoomError")<{
  readonly reason: string
}> {}

describe("runtime slots", () => {
  it.live("normalizeMessageInput is a pass-through without explicit rewrites", () => {
    const slots = compileExtensionReactions([])
    return slots
      .normalizeMessageInput(
        {
          content: "hello",
          sessionId: SessionId.make("test-session"),
          branchId: BranchId.make("test-branch"),
        },
        stubHostCtx,
      )
      .pipe(Effect.tap((result) => Effect.sync(() => expect(result).toBe("hello"))))
  })

  it.live("systemPrompt composes explicit reaction rewrites in scope order", () => {
    const extensions = [
      makeExt("builtin", "builtin", {
        reactions: {
          systemPrompt: (input) => Effect.succeed(`${input.basePrompt}[builtin]`),
        },
      }),
      makeExt("project", "project", {
        reactions: {
          systemPrompt: (input) => Effect.succeed(`${input.basePrompt}[project]`),
        },
      }),
    ]

    const slots = compileExtensionReactions(extensions)

    return slots
      .resolveSystemPrompt(
        { basePrompt: "base", agent: Agents["cowork"]! } satisfies SystemPromptInput,
        { projection: stubProjectionCtx, host: stubHostCtx },
      )
      .pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("base[builtin][project]"))),
      )
  })

  it.live("systemPrompt isolates failing reaction rewrites", () => {
    const extensions = [
      makeExt("builtin", "builtin", {
        reactions: {
          systemPrompt: (input) => Effect.succeed(`${input.basePrompt}[builtin-reaction]`),
        },
      }),
      makeExt("project", "project", {
        reactions: {
          systemPrompt: () => Effect.fail(new BoomError({ reason: "bad prompt" })),
        },
      }),
    ]

    const slots = compileExtensionReactions(extensions)

    return slots
      .resolveSystemPrompt(
        { basePrompt: "base", agent: Agents["cowork"]! } satisfies SystemPromptInput,
        { projection: stubProjectionCtx, host: stubHostCtx },
      )
      .pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("base[builtin-reaction]"))),
      )
  })

  it.live("contextMessages is a pass-through without explicit rewrites", () => {
    const baseMessage = Message.Regular.make({
      id: MessageId.make("m1"),
      sessionId: SessionId.make("test-session"),
      branchId: BranchId.make("test-branch"),
      role: "user",
      parts: [new TextPart({ type: "text", text: "hello" })],
      createdAt: new Date(),
    })
    const slots = compileExtensionReactions([])

    return slots
      .resolveContextMessages(
        {
          messages: [baseMessage],
          agent: Agents["cowork"]!,
          sessionId: SessionId.make("test-session"),
          branchId: BranchId.make("test-branch"),
        } satisfies ContextMessagesInput,
        { projection: stubProjectionCtx, host: stubHostCtx },
      )
      .pipe(
        Effect.tap((messages) =>
          Effect.sync(() =>
            expect(messages.map((message) => message.id)).toEqual([MessageId.make("m1")]),
          ),
        ),
      )
  })

  it.live("toolResult applies explicit resource enrichments in scope order", () => {
    const extensions = [
      makeExt("builtin", "builtin", {
        reactions: {
          toolResult: (input) => Effect.succeed(`${String(input.result)}-builtin`),
        },
      }),
      makeExt("explicit", "project", {
        reactions: {
          toolResult: (input) => Effect.succeed(`${String(input.result)}-explicit`),
        },
      }),
    ]

    const slots = compileExtensionReactions(extensions)

    return slots
      .transformToolResult(
        {
          toolCallId: ToolCallId.make("tc-1"),
          toolName: "echo",
          input: { text: "hello" },
          result: "base",
          sessionId: SessionId.make("test-session"),
          branchId: BranchId.make("test-branch"),
          agentName: AgentName.make("cowork"),
        },
        stubHostCtx,
      )
      .pipe(Effect.tap((result) => Effect.sync(() => expect(result).toBe("base-builtin-explicit"))))
  })

  it.live("turnAfter explicit reactions keep continue/isolate/halt semantics", () => {
    const calls: string[] = []
    const extensions = [
      makeExt("continue", "builtin", {
        reactions: {
          turnAfter: {
            failureMode: "continue",
            handler: () => {
              calls.push("continue")
              return Effect.fail(new BoomError({ reason: "continue" }))
            },
          },
        },
      }),
      makeExt("isolate", "user", {
        reactions: {
          turnAfter: {
            failureMode: "isolate",
            handler: () => {
              calls.push("isolate")
              return Effect.fail(new BoomError({ reason: "isolate" }))
            },
          },
        },
      }),
      makeExt("halt", "project", {
        reactions: {
          turnAfter: {
            failureMode: "halt",
            handler: () => {
              calls.push("halt")
              return Effect.fail(new BoomError({ reason: "halt" }))
            },
          },
        },
      }),
    ]

    const slots = compileExtensionReactions(extensions)

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        slots.emitTurnAfter(
          {
            sessionId: SessionId.make("test-session"),
            branchId: BranchId.make("test-branch"),
            durationMs: 10,
            agentName: AgentName.make("cowork"),
            interrupted: false,
          } satisfies TurnAfterInput,
          stubHostCtx,
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true)
      }
      expect(calls).toEqual(["continue", "isolate", "halt"])
    })
  })

  it.live("turnBefore explicit reactions fire in scope order", () => {
    const calls: string[] = []
    const slots = compileExtensionReactions([
      makeExt("builtin", "builtin", {
        reactions: {
          turnBefore: {
            failureMode: "continue",
            handler: () =>
              Effect.sync(() => {
                calls.push("builtin")
              }),
          },
        },
      }),
      makeExt("project", "project", {
        reactions: {
          turnBefore: {
            failureMode: "continue",
            handler: () =>
              Effect.sync(() => {
                calls.push("project")
              }),
          },
        },
      }),
    ])

    return slots
      .emitTurnBefore(
        {
          sessionId: SessionId.make("test-session"),
          branchId: BranchId.make("test-branch"),
          agentName: AgentName.make("cowork"),
          toolCount: 2,
          systemPromptLength: 42,
        } satisfies TurnBeforeInput,
        stubHostCtx,
      )
      .pipe(Effect.tap(() => Effect.sync(() => expect(calls).toEqual(["builtin", "project"]))))
  })

  it.live("messageOutput explicit reactions fire in scope order", () => {
    const calls: string[] = []
    const slots = compileExtensionReactions([
      makeExt("builtin", "builtin", {
        reactions: {
          messageOutput: {
            failureMode: "continue",
            handler: () =>
              Effect.sync(() => {
                calls.push("builtin")
              }),
          },
        },
      }),
      makeExt("project", "project", {
        reactions: {
          messageOutput: {
            failureMode: "continue",
            handler: () =>
              Effect.sync(() => {
                calls.push("project")
              }),
          },
        },
      }),
    ])

    return slots
      .emitMessageOutput(
        {
          sessionId: SessionId.make("test-session"),
          branchId: BranchId.make("test-branch"),
          agentName: AgentName.make("cowork"),
          parts: [new TextPart({ type: "text", text: "hello" })],
        } satisfies MessageOutputInput,
        stubHostCtx,
      )
      .pipe(Effect.tap(() => Effect.sync(() => expect(calls).toEqual(["builtin", "project"]))))
  })
})
