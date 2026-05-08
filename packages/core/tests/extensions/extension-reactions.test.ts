import { describe, it, expect } from "effect-bun-test"
import * as Prompt from "effect/unstable/ai/Prompt"
import { Cause, Context, Data, Effect, Exit, Ref } from "effect"
import { getBuiltinAgent } from "../../../extensions/src/all-agents.js"
import type {
  ContextMessagesInput,
  ExtensionContributions,
  LoadedExtension,
  MessageInputInput,
  MessageOutputInput,
  PermissionCheckInput,
  SystemPromptInput,
  ToolExecuteInput,
  TurnBeforeInput,
  TurnAfterInput,
} from "../../src/domain/extension.js"
import type { ExtensionHostContext } from "@gent/core-internal/domain/extension-host-context"
import { testExtensionHostContext } from "@gent/core-internal/test-utils"
import {
  BranchId,
  ExtensionId,
  MessageId,
  SessionId,
  ToolCallId,
} from "@gent/core-internal/domain/ids"
import { dateFromMillis, Message } from "@gent/core-internal/domain/message"
import { compileExtensionReactions } from "../../src/runtime/extensions/extension-reactions"
import { AgentName } from "@gent/core-internal/domain/agent"

const stubHostCtx = testExtensionHostContext()

const stubProjectionCtx = {
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  cwd: "/tmp",
  home: "/tmp",
  turn: {
    sessionId: SessionId.make("test-session"),
    branchId: BranchId.make("test-branch"),
    agent: getBuiltinAgent("cowork")!,
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

class BoomError extends Data.TaggedError(
  "@gent/core/tests/extensions/extension-reactions.test/BoomError",
)<{
  readonly reason: string
}> {}

class ReactionCounter extends Context.Service<
  ReactionCounter,
  {
    readonly increment: Effect.Effect<void>
    readonly get: Effect.Effect<number>
  }
>()("@gent/core/tests/extensions/extension-reactions.test/ReactionCounter") {}

const FIXTURE_DATE = dateFromMillis(0)

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

  it.live("messageInput composes explicit rewrites in scope order", () => {
    const slots = compileExtensionReactions([
      makeExt("builtin", "builtin", {
        reactions: {
          messageInput: (input) => Effect.succeed(`${input.content} builtin`),
        },
      }),
      makeExt("project", "project", {
        reactions: {
          messageInput: (input) => Effect.succeed(`${input.content} project`),
        },
      }),
    ])

    return slots
      .normalizeMessageInput(
        {
          content: "hello",
          sessionId: SessionId.make("test-session"),
          branchId: BranchId.make("test-branch"),
        } satisfies MessageInputInput,
        stubHostCtx,
      )
      .pipe(Effect.tap((result) => Effect.sync(() => expect(result).toBe("hello builtin project"))))
  })

  it.live("messageInput isolates failing rewrites", () => {
    const slots = compileExtensionReactions([
      makeExt("builtin", "builtin", {
        reactions: {
          messageInput: (input) => Effect.succeed(`${input.content} builtin`),
        },
      }),
      makeExt("project", "project", {
        reactions: {
          messageInput: () => Effect.fail(new BoomError({ reason: "bad input" })),
        },
      }),
    ])

    return slots
      .normalizeMessageInput(
        {
          content: "hello",
          sessionId: SessionId.make("test-session"),
          branchId: BranchId.make("test-branch"),
        } satisfies MessageInputInput,
        stubHostCtx,
      )
      .pipe(Effect.tap((result) => Effect.sync(() => expect(result).toBe("hello builtin"))))
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
        { basePrompt: "base", agent: getBuiltinAgent("cowork")! } satisfies SystemPromptInput,
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
        { basePrompt: "base", agent: getBuiltinAgent("cowork")! } satisfies SystemPromptInput,
        { projection: stubProjectionCtx, host: stubHostCtx },
      )
      .pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("base[builtin-reaction]"))),
      )
  })

  it.live("systemPrompt receives a physically read-only host context", () =>
    Effect.gen(function* () {
      const sawProcessAuthority = yield* Ref.make(false)
      const slots = compileExtensionReactions([
        makeExt("readonly", "project", {
          reactions: {
            systemPrompt: (_input, ctx) =>
              Effect.gen(function* () {
                yield* Ref.set(sawProcessAuthority, "runProcess" in ctx.host)
                return "readonly"
              }),
          },
        }),
      ])

      const result = yield* slots.resolveSystemPrompt(
        {
          basePrompt: "base",
          agent: getBuiltinAgent("cowork")!,
        },
        {
          projection: stubProjectionCtx,
          host: stubHostCtx,
        },
      )

      expect(result).toBe("readonly")
      expect(yield* Ref.get(sawProcessAuthority)).toBe(false)
    }),
  )

  it.live("contextMessages is a pass-through without explicit rewrites", () => {
    const baseMessage = Message.Regular.make({
      id: MessageId.make("m1"),
      sessionId: SessionId.make("test-session"),
      branchId: BranchId.make("test-branch"),
      role: "user",
      parts: [Prompt.textPart({ text: "hello" })],
      createdAt: FIXTURE_DATE,
    })
    const slots = compileExtensionReactions([])

    return slots
      .resolveContextMessages(
        {
          messages: [baseMessage],
          agent: getBuiltinAgent("cowork")!,
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

  it.live("contextMessages composes explicit rewrites and isolates failures", () => {
    const baseMessage = Message.Regular.make({
      id: MessageId.make("m1"),
      sessionId: SessionId.make("test-session"),
      branchId: BranchId.make("test-branch"),
      role: "user",
      parts: [Prompt.textPart({ text: "hello" })],
      createdAt: FIXTURE_DATE,
    })
    const appendedMessage = Message.Regular.make({
      id: MessageId.make("m2"),
      sessionId: SessionId.make("test-session"),
      branchId: BranchId.make("test-branch"),
      role: "user",
      parts: [Prompt.textPart({ text: "extra" })],
      createdAt: FIXTURE_DATE,
    })
    const slots = compileExtensionReactions([
      makeExt("builtin", "builtin", {
        reactions: {
          contextMessages: (input) => Effect.succeed([...input.messages, appendedMessage]),
        },
      }),
      makeExt("project", "project", {
        reactions: {
          contextMessages: () => Effect.fail(new BoomError({ reason: "bad context" })),
        },
      }),
    ])

    return slots
      .resolveContextMessages(
        {
          messages: [baseMessage],
          agent: getBuiltinAgent("cowork")!,
          sessionId: SessionId.make("test-session"),
          branchId: BranchId.make("test-branch"),
        } satisfies ContextMessagesInput,
        { projection: stubProjectionCtx, host: stubHostCtx },
      )
      .pipe(
        Effect.tap((messages) =>
          Effect.sync(() =>
            expect(messages.map((message) => message.id)).toEqual([
              MessageId.make("m1"),
              MessageId.make("m2"),
            ]),
          ),
        ),
      )
  })

  it.live("permissionCheck composes from base decision", () => {
    const slots = compileExtensionReactions([
      makeExt("builtin", "builtin", {
        reactions: {
          permissionCheck: (input) =>
            Effect.succeed(input.toolName === "blocked" ? "denied" : input.current),
        },
      }),
      makeExt("project", "project", {
        reactions: {
          permissionCheck: () => Effect.fail(new BoomError({ reason: "bad permission" })),
        },
      }),
    ])

    return slots
      .checkPermission(
        {
          toolName: "blocked",
          input: {},
        } satisfies PermissionCheckInput,
        () => Effect.succeed("allowed"),
        stubHostCtx,
      )
      .pipe(Effect.tap((result) => Effect.sync(() => expect(result).toBe("denied"))))
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

  it.live("toolExecute wraps base execution in scope order", () => {
    const slots = compileExtensionReactions([
      makeExt("builtin", "builtin", {
        reactions: {
          toolExecute: (input) => Effect.succeed(`${String(input.current)}-builtin`),
        },
      }),
      makeExt("project", "project", {
        reactions: {
          toolExecute: (input) => Effect.succeed(`${String(input.current)}-project`),
        },
      }),
    ])

    return slots
      .executeTool(
        {
          toolCallId: ToolCallId.make("tc-1"),
          toolName: "echo",
          input: { text: "hello" },
          sessionId: SessionId.make("test-session"),
          branchId: BranchId.make("test-branch"),
        } satisfies ToolExecuteInput,
        () => Effect.succeed("base"),
        stubHostCtx,
      )
      .pipe(Effect.tap((result) => Effect.sync(() => expect(result).toBe("base-builtin-project"))))
  })

  it.live("toolExecute isolates wrapper failures", () => {
    const slots = compileExtensionReactions([
      makeExt("builtin", "builtin", {
        reactions: {
          toolExecute: (input) => Effect.succeed(`${String(input.current)}-builtin`),
        },
      }),
      makeExt("project", "project", {
        reactions: {
          toolExecute: () => Effect.fail(new BoomError({ reason: "bad execute" })),
        },
      }),
    ])

    return slots
      .executeTool(
        {
          toolCallId: ToolCallId.make("tc-1"),
          toolName: "echo",
          input: { text: "hello" },
          sessionId: SessionId.make("test-session"),
          branchId: BranchId.make("test-branch"),
        } satisfies ToolExecuteInput,
        () => Effect.succeed("base"),
        stubHostCtx,
      )
      .pipe(Effect.tap((result) => Effect.sync(() => expect(result).toBe("base-builtin"))))
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
      if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(false)
      expect(calls).toEqual(["continue", "isolate", "halt"])
    })
  })

  it.live("turnAfter handler parameter receives a physically read-only host context", () =>
    Effect.gen(function* () {
      const sawProcessAuthority = yield* Ref.make(false)
      const slots = compileExtensionReactions([
        makeExt("readonly-lifecycle", "project", {
          reactions: {
            turnAfter: {
              failureMode: "halt",
              handler: (_input, ctx) => Ref.set(sawProcessAuthority, "runProcess" in ctx.host),
            },
          },
        }),
      ])

      yield* slots.emitTurnAfter(
        {
          sessionId: SessionId.make("test-session"),
          branchId: BranchId.make("test-branch"),
          durationMs: 10,
          agentName: AgentName.make("cowork"),
          interrupted: false,
        } satisfies TurnAfterInput,
        stubHostCtx,
      )

      expect(yield* Ref.get(sawProcessAuthority)).toBe(false)
    }),
  )

  it.live("turnAfter reactions run inside lifecycle capability context", () =>
    Effect.gen(function* () {
      const ref = yield* Ref.make(0)
      const counter = {
        increment: Ref.update(ref, (n) => n + 1),
        get: Ref.get(ref),
      }
      const slots = compileExtensionReactions([
        makeExt("resource-backed", "builtin", {
          reactions: {
            turnAfter: {
              failureMode: "halt",
              handler: () =>
                Effect.gen(function* () {
                  const service = yield* ReactionCounter
                  yield* service.increment
                }),
            },
          },
        }),
      ])
      const hostCtx = {
        ...stubHostCtx,
        capabilityContext: Context.make(ReactionCounter, counter),
      } satisfies ExtensionHostContext

      yield* slots.emitTurnAfter(
        {
          sessionId: SessionId.make("test-session"),
          branchId: BranchId.make("test-branch"),
          durationMs: 10,
          agentName: AgentName.make("cowork"),
          interrupted: false,
        } satisfies TurnAfterInput,
        hostCtx,
      )

      const count = yield* counter.get
      expect(count).toBe(1)
    }),
  )

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
          parts: [Prompt.textPart({ text: "hello" })],
        } satisfies MessageOutputInput,
        stubHostCtx,
      )
      .pipe(Effect.tap(() => Effect.sync(() => expect(calls).toEqual(["builtin", "project"]))))
  })
})
