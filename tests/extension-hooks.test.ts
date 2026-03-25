import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { Agents } from "@gent/core/domain/agent"
import type {
  ExtensionHooks,
  LoadedExtension,
  SystemPromptInput,
} from "@gent/core/domain/extension"
import { defineInterceptor } from "@gent/core/domain/extension"
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
})
