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
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { Message, TextPart } from "@gent/core/domain/message"
import { compileRuntimeSlots } from "../../src/runtime/extensions/runtime-slots"

const stubHostCtx = {
  sessionId: "test-session",
  branchId: "test-branch",
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
    agent: Agents.cowork,
    allTools: [],
    agentName: "cowork",
  },
}

const makeExt = (
  id: string,
  scope: "builtin" | "user" | "project",
  contributions: ExtensionContributions,
): LoadedExtension => ({
  manifest: { id },
  scope,
  sourcePath: `/test/${id}`,
  contributions,
})

class BoomError extends Data.TaggedError("@gent/core/tests/runtime-slots/BoomError")<{
  readonly reason: string
}> {}

describe("runtime slots", () => {
  it.live("normalizeMessageInput is a pass-through without explicit rewrites", () => {
    const slots = compileRuntimeSlots([])
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

  it.live("systemPrompt composes explicit projection rewrites in scope order", () => {
    const extensions = [
      makeExt("builtin", "builtin", {
        projections: [
          {
            id: "prompt-builtin",
            query: () => Effect.succeed("[builtin]"),
            systemPrompt: (suffix, input) => Effect.succeed(`${input.basePrompt}${suffix}`),
          },
        ],
      }),
      makeExt("project", "project", {
        projections: [
          {
            id: "prompt",
            query: () => Effect.succeed("[projection]"),
            systemPrompt: (suffix, input) => Effect.succeed(`${input.basePrompt}${suffix}`),
          },
        ],
      }),
    ]

    const slots = compileRuntimeSlots(extensions)

    return slots
      .resolveSystemPrompt(
        { basePrompt: "base", agent: Agents.cowork } satisfies SystemPromptInput,
        { projection: stubProjectionCtx, host: stubHostCtx },
      )
      .pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("base[builtin][projection]"))),
      )
  })

  it.live("contextMessages applies explicit projection rewrites in sequence", () => {
    const baseMessage = Message.Regular.make({
      id: "m1",
      sessionId: SessionId.make("test-session"),
      branchId: BranchId.make("test-branch"),
      role: "user",
      parts: [new TextPart({ type: "text", text: "hello" })],
      createdAt: new Date(),
    })
    const injectedMessage = Message.Regular.make({
      id: "m2",
      sessionId: SessionId.make("test-session"),
      branchId: BranchId.make("test-branch"),
      role: "system",
      parts: [new TextPart({ type: "text", text: "extra" })],
      createdAt: new Date(),
    })
    const extensions = [
      makeExt("prepend", "builtin", {
        projections: [
          {
            id: "messages-prepend",
            query: () => Effect.succeed(baseMessage),
            contextMessages: (message, input) => Effect.succeed([message, ...input.messages]),
          },
        ],
      }),
      makeExt("append", "project", {
        projections: [
          {
            id: "messages",
            query: () => Effect.succeed(injectedMessage),
            contextMessages: (message, input) => Effect.succeed([...input.messages, message]),
          },
        ],
      }),
    ]

    const slots = compileRuntimeSlots(extensions)

    return slots
      .resolveContextMessages(
        {
          messages: [baseMessage],
          agent: Agents.cowork,
          sessionId: SessionId.make("test-session"),
          branchId: BranchId.make("test-branch"),
        } satisfies ContextMessagesInput,
        { projection: stubProjectionCtx, host: stubHostCtx },
      )
      .pipe(
        Effect.tap((messages) =>
          Effect.sync(() =>
            expect(messages.map((message) => message.id)).toEqual(["m1", "m1", "m2"]),
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

    const slots = compileRuntimeSlots(extensions)

    return slots
      .transformToolResult(
        {
          toolCallId: "tc-1",
          toolName: "echo",
          input: { text: "hello" },
          result: "base",
          sessionId: SessionId.make("test-session"),
          branchId: BranchId.make("test-branch"),
          agentName: "cowork",
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

    const slots = compileRuntimeSlots(extensions)

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        slots.emitTurnAfter(
          {
            sessionId: SessionId.make("test-session"),
            branchId: BranchId.make("test-branch"),
            durationMs: 10,
            agentName: "cowork",
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
    const slots = compileRuntimeSlots([
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
          agentName: "cowork",
          toolCount: 2,
          systemPromptLength: 42,
        } satisfies TurnBeforeInput,
        stubHostCtx,
      )
      .pipe(Effect.tap(() => Effect.sync(() => expect(calls).toEqual(["builtin", "project"]))))
  })

  it.live("messageOutput explicit reactions fire in scope order", () => {
    const calls: string[] = []
    const slots = compileRuntimeSlots([
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
          agentName: "cowork",
          parts: [new TextPart({ type: "text", text: "hello" })],
        } satisfies MessageOutputInput,
        stubHostCtx,
      )
      .pipe(Effect.tap(() => Effect.sync(() => expect(calls).toEqual(["builtin", "project"]))))
  })
})
