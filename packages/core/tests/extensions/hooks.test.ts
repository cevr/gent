import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { Agents } from "@gent/core/extensions/all-agents"
import type {
  ContextMessagesInput,
  ExtensionHooks,
  LoadedExtension,
  SystemPromptInput,
  ToolResultInput,
  TurnBeforeInput,
  TurnAfterInput,
  MessageOutputInput,
} from "@gent/core/domain/extension"
import { defineInterceptor } from "@gent/core/domain/extension"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { Message, TextPart } from "@gent/core/domain/message"
import { BranchId, MessageId, SessionId } from "@gent/core/domain/ids"
import { compileHooks } from "@gent/core/runtime/extensions/hooks"

const stubCtx = {
  sessionId: "test-session",
  branchId: "test-branch",
  cwd: "/tmp",
  home: "/tmp",
} as unknown as ExtensionHostContext

const makeExt = (
  id: string,
  kind: "builtin" | "user" | "project",
  hooks: ExtensionHooks,
): LoadedExtension => ({
  manifest: { id },
  kind,
  sourcePath: `/test/${id}`,
  setup: { hooks },
})

describe("compileHooks", () => {
  describe("interceptors", () => {
    it.live("runs base when no interceptors registered", () => {
      const compiled = compileHooks([])
      return compiled
        .runInterceptor(
          "prompt.system",
          { basePrompt: "hello", agent: Agents.cowork },
          (input) => Effect.succeed(input.basePrompt),
          stubCtx,
        )
        .pipe(Effect.tap((result) => Effect.sync(() => expect(result).toBe("hello"))))
    })

    it.live("single interceptor wraps base", () => {
      const ext = makeExt("a", "builtin", {
        interceptors: [
          defineInterceptor(
            "prompt.system",
            (
              input: SystemPromptInput,
              next: (i: SystemPromptInput) => Effect.Effect<string>,
              _ctx,
            ) => next({ ...input, basePrompt: `[wrapped] ${input.basePrompt}` }),
          ),
        ],
      })

      const compiled = compileHooks([ext])
      return compiled
        .runInterceptor(
          "prompt.system",
          { basePrompt: "hello", agent: Agents.cowork },
          (input) => Effect.succeed(input.basePrompt),
          stubCtx,
        )
        .pipe(Effect.tap((result) => Effect.sync(() => expect(result).toBe("[wrapped] hello"))))
    })

    it.live("chain order: builtin inner, project outer", () => {
      const log: string[] = []

      const builtinExt = makeExt("a-builtin", "builtin", {
        interceptors: [
          defineInterceptor(
            "prompt.system",
            (
              input: SystemPromptInput,
              next: (i: SystemPromptInput) => Effect.Effect<string>,
              _ctx,
            ) => {
              log.push("builtin-before")
              return next(input).pipe(
                Effect.map((r) => {
                  log.push("builtin-after")
                  return r
                }),
              )
            },
          ),
        ],
      })

      const projectExt = makeExt("b-project", "project", {
        interceptors: [
          defineInterceptor(
            "prompt.system",
            (
              input: SystemPromptInput,
              next: (i: SystemPromptInput) => Effect.Effect<string>,
              _ctx,
            ) => {
              log.push("project-before")
              return next(input).pipe(
                Effect.map((r) => {
                  log.push("project-after")
                  return r
                }),
              )
            },
          ),
        ],
      })

      const compiled = compileHooks([builtinExt, projectExt])
      return compiled
        .runInterceptor(
          "prompt.system",
          { basePrompt: "test", agent: Agents.cowork },
          () => Effect.succeed("base"),
          stubCtx,
        )
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              // Project is outermost (left fold: builtin wraps base, project wraps that)
              expect(log).toEqual([
                "project-before",
                "builtin-before",
                "builtin-after",
                "project-after",
              ])
            }),
          ),
        )
    })

    it.live("same scope tie-breaks by id alphabetically", () => {
      const log: string[] = []

      const extB = makeExt("b", "builtin", {
        interceptors: [
          defineInterceptor(
            "prompt.system",
            (
              input: SystemPromptInput,
              next: (i: SystemPromptInput) => Effect.Effect<string>,
              _ctx,
            ) => {
              log.push("b")
              return next(input)
            },
          ),
        ],
      })

      const extA = makeExt("a", "builtin", {
        interceptors: [
          defineInterceptor(
            "prompt.system",
            (
              input: SystemPromptInput,
              next: (i: SystemPromptInput) => Effect.Effect<string>,
              _ctx,
            ) => {
              log.push("a")
              return next(input)
            },
          ),
        ],
      })

      const compiled = compileHooks([extB, extA])
      return compiled
        .runInterceptor(
          "prompt.system",
          { basePrompt: "test", agent: Agents.cowork },
          () => Effect.succeed("base"),
          stubCtx,
        )
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              // Sorted: [a, b]. Left fold: a wraps base, b wraps a. b is outermost.
              expect(log).toEqual(["b", "a"])
            }),
          ),
        )
    })
  })

  describe("context.messages", () => {
    const makeMessage = (role: "user" | "assistant", text: string) =>
      new Message({
        id: MessageId.of(`msg-${text}`),
        sessionId: SessionId.of("test-session"),
        branchId: BranchId.of("test-branch"),
        role,
        parts: [new TextPart({ type: "text", text })],
        createdAt: new Date(),
      })

    const baseInput: ContextMessagesInput = {
      messages: [makeMessage("user", "hello"), makeMessage("assistant", "hi")],
      agent: Agents.cowork,
      sessionId: SessionId.of("test-session"),
      branchId: BranchId.of("test-branch"),
    }

    it.live("passes through when no interceptors", () => {
      const compiled = compileHooks([])
      return compiled
        .runInterceptor(
          "context.messages",
          baseInput,
          (input) => Effect.succeed(input.messages),
          stubCtx,
        )
        .pipe(Effect.tap((result) => Effect.sync(() => expect(result).toHaveLength(2))))
    })

    it.live("interceptor injects hidden context message", () => {
      const ext = makeExt("injector", "builtin", {
        interceptors: [
          defineInterceptor(
            "context.messages",
            (
              input: ContextMessagesInput,
              next: (i: ContextMessagesInput) => Effect.Effect<ReadonlyArray<Message>>,
              _ctx,
            ) => {
              const injected = makeMessage("user", "[system context] Remember: be concise")
              return next({ ...input, messages: [...input.messages, injected] })
            },
          ),
        ],
      })

      const compiled = compileHooks([ext])
      return compiled
        .runInterceptor(
          "context.messages",
          baseInput,
          (input) => Effect.succeed(input.messages),
          stubCtx,
        )
        .pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result).toHaveLength(3)
              const texts = result.map((m) =>
                m.parts
                  .filter((p): p is typeof TextPart.Type => p.type === "text")
                  .map((p) => p.text)
                  .join(""),
              )
              expect(texts).toContain("[system context] Remember: be concise")
            }),
          ),
        )
    })

    it.live("interceptor filters messages", () => {
      const ext = makeExt("filter", "project", {
        interceptors: [
          defineInterceptor(
            "context.messages",
            (
              input: ContextMessagesInput,
              next: (i: ContextMessagesInput) => Effect.Effect<ReadonlyArray<Message>>,
              _ctx,
            ) =>
              next({
                ...input,
                messages: input.messages.filter((m) => m.role !== "assistant"),
              }),
          ),
        ],
      })

      const compiled = compileHooks([ext])
      return compiled
        .runInterceptor(
          "context.messages",
          baseInput,
          (input) => Effect.succeed(input.messages),
          stubCtx,
        )
        .pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result).toHaveLength(1)
              expect(result[0]!.role).toBe("user")
            }),
          ),
        )
    })
  })

  describe("turn.before", () => {
    const baseTurnBeforeInput: TurnBeforeInput = {
      sessionId: SessionId.of("test-session"),
      branchId: BranchId.of("test-branch"),
      agentName: "cowork" as never,
      toolCount: 5,
      systemPromptLength: 1200,
    }

    it.live("fires before turn with correct input", () => {
      const captured: TurnBeforeInput[] = []
      const ext = makeExt("pre-turn", "builtin", {
        interceptors: [
          defineInterceptor(
            "turn.before",
            (input: TurnBeforeInput, next: (i: TurnBeforeInput) => Effect.Effect<void>, _ctx) => {
              captured.push(input)
              return next(input)
            },
          ),
        ],
      })

      const compiled = compileHooks([ext])
      return compiled
        .runInterceptor("turn.before", baseTurnBeforeInput, () => Effect.void, stubCtx)
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(captured).toHaveLength(1)
              expect(captured[0]!.toolCount).toBe(5)
              expect(captured[0]!.systemPromptLength).toBe(1200)
              expect(captured[0]!.agentName).toBe("cowork")
            }),
          ),
        )
    })

    it.live("chains before and after hooks in correct order", () => {
      const log: string[] = []

      const ext = makeExt("lifecycle", "builtin", {
        interceptors: [
          defineInterceptor(
            "turn.before",
            (_input: TurnBeforeInput, next: (i: TurnBeforeInput) => Effect.Effect<void>, _ctx) => {
              log.push("before")
              return next(_input)
            },
          ),
          defineInterceptor(
            "turn.after",
            (_input: TurnAfterInput, next: (i: TurnAfterInput) => Effect.Effect<void>, _ctx) => {
              log.push("after")
              return next(_input)
            },
          ),
        ],
      })

      const compiled = compileHooks([ext])
      return compiled
        .runInterceptor("turn.before", baseTurnBeforeInput, () => Effect.void, stubCtx)
        .pipe(
          Effect.andThen(
            compiled.runInterceptor(
              "turn.after",
              {
                sessionId: SessionId.of("test-session"),
                branchId: BranchId.of("test-branch"),
                durationMs: 1500,
                agentName: "cowork" as never,
                interrupted: false,
              },
              () => Effect.void,
              stubCtx,
            ),
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              expect(log).toEqual(["before", "after"])
            }),
          ),
        )
    })
  })

  describe("turn.after", () => {
    const baseTurnInput: TurnAfterInput = {
      sessionId: SessionId.of("test-session"),
      branchId: BranchId.of("test-branch"),
      durationMs: 1500,
      agentName: "cowork" as never,
      interrupted: false,
    }

    it.live("fires after turn with correct input", () => {
      const captured: TurnAfterInput[] = []
      const ext = makeExt("turn-counter", "builtin", {
        interceptors: [
          defineInterceptor(
            "turn.after",
            (input: TurnAfterInput, next: (i: TurnAfterInput) => Effect.Effect<void>, _ctx) => {
              captured.push(input)
              return next(input)
            },
          ),
        ],
      })

      const compiled = compileHooks([ext])
      return compiled
        .runInterceptor("turn.after", baseTurnInput, () => Effect.void, stubCtx)
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(captured).toHaveLength(1)
              expect(captured[0]!.durationMs).toBe(1500)
              expect(captured[0]!.agentName).toBe("cowork")
            }),
          ),
        )
    })
  })

  describe("tool.result", () => {
    const baseToolResultInput: ToolResultInput = {
      toolCallId: "tc-1" as never,
      toolName: "read",
      input: { path: "/tmp/file.txt" },
      result: { content: "hello" },
      agentName: "cowork" as never,
      sessionId: SessionId.of("test-session"),
      branchId: BranchId.of("test-branch"),
    }

    it.live("enriches tool result", () => {
      const ext = makeExt("enricher", "builtin", {
        interceptors: [
          defineInterceptor(
            "tool.result",
            (input: ToolResultInput, next: (i: ToolResultInput) => Effect.Effect<unknown>, _ctx) =>
              next(input).pipe(
                Effect.map((result) => ({
                  ...(result as Record<string, unknown>),
                  enriched: true,
                })),
              ),
          ),
        ],
      })

      const compiled = compileHooks([ext])
      return compiled
        .runInterceptor(
          "tool.result",
          baseToolResultInput,
          (input) => Effect.succeed(input.result),
          stubCtx,
        )
        .pipe(
          Effect.tap((result) =>
            Effect.sync(() => expect(result).toEqual({ content: "hello", enriched: true })),
          ),
        )
    })

    it.live("passes through when no interceptors", () => {
      const compiled = compileHooks([])
      return compiled
        .runInterceptor(
          "tool.result",
          baseToolResultInput,
          (input) => Effect.succeed(input.result),
          stubCtx,
        )
        .pipe(
          Effect.tap((result) => Effect.sync(() => expect(result).toEqual({ content: "hello" }))),
        )
    })
  })

  describe("defect resilience", () => {
    it.live("defecting interceptor falls through to base", () => {
      const ext = makeExt("crashy", "user", {
        interceptors: [
          defineInterceptor("prompt.system", () => {
            throw new Error("interceptor blew up")
          }),
        ],
      })
      const compiled = compileHooks([ext])
      return compiled
        .runInterceptor(
          "prompt.system",
          { basePrompt: "safe", agent: Agents.cowork },
          (input) => Effect.succeed(input.basePrompt),
          stubCtx,
        )
        .pipe(Effect.tap((result) => Effect.sync(() => expect(result).toBe("safe"))))
    })

    it.live("defecting interceptor in chain skips to previous next", () => {
      const good = makeExt("good", "builtin", {
        interceptors: [
          defineInterceptor(
            "prompt.system",
            (
              input: SystemPromptInput,
              next: (i: SystemPromptInput) => Effect.Effect<string>,
              _ctx,
            ) => next(input).pipe(Effect.map((r) => r + " [good]")),
          ),
        ],
      })
      const bad = makeExt("bad", "user", {
        interceptors: [
          defineInterceptor("prompt.system", () => {
            throw new Error("boom")
          }),
        ],
      })
      const compiled = compileHooks([good, bad])
      return compiled
        .runInterceptor(
          "prompt.system",
          { basePrompt: "hello", agent: Agents.cowork },
          (input) => Effect.succeed(input.basePrompt),
          stubCtx,
        )
        .pipe(
          Effect.tap((result) =>
            // bad defected, so falls through to good's chain which appends [good]
            Effect.sync(() => expect(result).toBe("hello [good]")),
          ),
        )
    })
  })

  describe("message.output", () => {
    const baseMessageOutputInput: MessageOutputInput = {
      sessionId: SessionId.of("test-session"),
      branchId: BranchId.of("test-branch"),
      agentName: "cowork" as never,
      parts: [new TextPart({ type: "text", text: "Hello world" })],
    }

    it.live("fires with assembled message parts", () => {
      const captured: MessageOutputInput[] = []
      const ext = makeExt("output-observer", "builtin", {
        interceptors: [
          defineInterceptor(
            "message.output",
            (
              input: MessageOutputInput,
              next: (i: MessageOutputInput) => Effect.Effect<void>,
              _ctx,
            ) => {
              captured.push(input)
              return next(input)
            },
          ),
        ],
      })

      const compiled = compileHooks([ext])
      return compiled
        .runInterceptor("message.output", baseMessageOutputInput, () => Effect.void, stubCtx)
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(captured).toHaveLength(1)
              expect(captured[0]!.parts).toHaveLength(1)
              expect(captured[0]!.agentName).toBe("cowork")
            }),
          ),
        )
    })
  })
})
