import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { Agents } from "@gent/core/domain/agent"
import type {
  ContextMessagesInput,
  ExtensionHooks,
  LoadedExtension,
  SystemPromptInput,
} from "@gent/core/domain/extension"
import { defineInterceptor } from "@gent/core/domain/extension"
import { Message, TextPart } from "@gent/core/domain/message"
import type { BranchId, MessageId, SessionId } from "@gent/core/domain/ids"
import { compileHooks } from "@gent/core/runtime/extensions/hooks"

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
    test("runs base when no interceptors registered", async () => {
      const compiled = compileHooks([])
      const result = await Effect.runPromise(
        compiled.runInterceptor(
          "prompt.system",
          { basePrompt: "hello", agent: Agents.cowork },
          (input) => Effect.succeed(input.basePrompt),
        ),
      )
      expect(result).toBe("hello")
    })

    test("single interceptor wraps base", async () => {
      const ext = makeExt("a", "builtin", {
        interceptors: [
          defineInterceptor(
            "prompt.system",
            (input: SystemPromptInput, next: (i: SystemPromptInput) => Effect.Effect<string>) =>
              next({ ...input, basePrompt: `[wrapped] ${input.basePrompt}` }),
          ),
        ],
      })

      const compiled = compileHooks([ext])
      const result = await Effect.runPromise(
        compiled.runInterceptor(
          "prompt.system",
          { basePrompt: "hello", agent: Agents.cowork },
          (input) => Effect.succeed(input.basePrompt),
        ),
      )
      expect(result).toBe("[wrapped] hello")
    })

    test("chain order: builtin inner, project outer", async () => {
      const log: string[] = []

      const builtinExt = makeExt("a-builtin", "builtin", {
        interceptors: [
          defineInterceptor(
            "prompt.system",
            (input: SystemPromptInput, next: (i: SystemPromptInput) => Effect.Effect<string>) => {
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
            (input: SystemPromptInput, next: (i: SystemPromptInput) => Effect.Effect<string>) => {
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
      await Effect.runPromise(
        compiled.runInterceptor("prompt.system", { basePrompt: "test", agent: Agents.cowork }, () =>
          Effect.succeed("base"),
        ),
      )

      // Project is outermost (left fold: builtin wraps base, project wraps that)
      expect(log).toEqual(["project-before", "builtin-before", "builtin-after", "project-after"])
    })

    test("same scope tie-breaks by id alphabetically", async () => {
      const log: string[] = []

      const extB = makeExt("b", "builtin", {
        interceptors: [
          defineInterceptor(
            "prompt.system",
            (input: SystemPromptInput, next: (i: SystemPromptInput) => Effect.Effect<string>) => {
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
            (input: SystemPromptInput, next: (i: SystemPromptInput) => Effect.Effect<string>) => {
              log.push("a")
              return next(input)
            },
          ),
        ],
      })

      const compiled = compileHooks([extB, extA])
      await Effect.runPromise(
        compiled.runInterceptor("prompt.system", { basePrompt: "test", agent: Agents.cowork }, () =>
          Effect.succeed("base"),
        ),
      )

      // Sorted: [a, b]. Left fold: a wraps base, b wraps a. b is outermost.
      expect(log).toEqual(["b", "a"])
    })
  })

  describe("context.messages", () => {
    const makeMessage = (role: "user" | "assistant", text: string) =>
      new Message({
        id: `msg-${text}` as MessageId,
        sessionId: "test-session" as SessionId,
        branchId: "test-branch" as BranchId,
        role,
        parts: [new TextPart({ type: "text", text })],
        createdAt: new Date(),
      })

    const baseInput: ContextMessagesInput = {
      messages: [makeMessage("user", "hello"), makeMessage("assistant", "hi")],
      agent: Agents.cowork,
      sessionId: "test-session" as SessionId,
      branchId: "test-branch" as BranchId,
    }

    test("passes through when no interceptors", async () => {
      const compiled = compileHooks([])
      const result = await Effect.runPromise(
        compiled.runInterceptor("context.messages", baseInput, (input) =>
          Effect.succeed(input.messages),
        ),
      )
      expect(result).toHaveLength(2)
    })

    test("interceptor injects hidden context message", async () => {
      const ext = makeExt("injector", "builtin", {
        interceptors: [
          defineInterceptor(
            "context.messages",
            (
              input: ContextMessagesInput,
              next: (i: ContextMessagesInput) => Effect.Effect<ReadonlyArray<Message>>,
            ) => {
              const injected = makeMessage("user", "[system context] Remember: be concise")
              return next({ ...input, messages: [...input.messages, injected] })
            },
          ),
        ],
      })

      const compiled = compileHooks([ext])
      const result = await Effect.runPromise(
        compiled.runInterceptor("context.messages", baseInput, (input) =>
          Effect.succeed(input.messages),
        ),
      )
      expect(result).toHaveLength(3)
      const texts = result.map((m) =>
        m.parts
          .filter((p): p is typeof TextPart.Type => p.type === "text")
          .map((p) => p.text)
          .join(""),
      )
      expect(texts).toContain("[system context] Remember: be concise")
    })

    test("interceptor filters messages", async () => {
      const ext = makeExt("filter", "project", {
        interceptors: [
          defineInterceptor(
            "context.messages",
            (
              input: ContextMessagesInput,
              next: (i: ContextMessagesInput) => Effect.Effect<ReadonlyArray<Message>>,
            ) =>
              next({
                ...input,
                messages: input.messages.filter((m) => m.role !== "assistant"),
              }),
          ),
        ],
      })

      const compiled = compileHooks([ext])
      const result = await Effect.runPromise(
        compiled.runInterceptor("context.messages", baseInput, (input) =>
          Effect.succeed(input.messages),
        ),
      )
      expect(result).toHaveLength(1)
      expect(result[0]!.role).toBe("user")
    })
  })
})
