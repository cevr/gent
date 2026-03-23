import { describe, test, expect } from "bun:test"
import { Effect, Ref } from "effect"
import { Agents } from "../../../domain/agent.js"
import { SessionStarted } from "../../../domain/event.js"
import type { BranchId, SessionId } from "../../../domain/ids.js"
import type {
  ExtensionHooks,
  LoadedExtension,
  SystemPromptInput,
} from "../../../domain/extension.js"
import { defineInterceptor, defineObserver } from "../../../domain/extension.js"
import { compileHooks } from "../hooks.js"

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

  describe("observers", () => {
    test("no observers = no-op", async () => {
      const compiled = compileHooks([])
      await Effect.runPromise(
        compiled.notifyObservers(
          "session.start",
          new SessionStarted({
            sessionId: "s1" as SessionId,
            branchId: "b1" as BranchId,
          }),
        ),
      )
    })

    test("fires all observers", async () => {
      const ref = await Effect.runPromise(Ref.make<string[]>([]))

      const ext1 = makeExt("a", "builtin", {
        observers: [
          defineObserver("session.start", (event: { sessionId: string }) =>
            Ref.update(ref, (arr) => [...arr, `a:${event.sessionId}`]),
          ),
        ],
      })

      const ext2 = makeExt("b", "user", {
        observers: [
          defineObserver("session.start", (event: { sessionId: string }) =>
            Ref.update(ref, (arr) => [...arr, `b:${event.sessionId}`]),
          ),
        ],
      })

      const compiled = compileHooks([ext1, ext2])
      await Effect.runPromise(
        compiled.notifyObservers(
          "session.start",
          new SessionStarted({
            sessionId: "s1" as SessionId,
            branchId: "b1" as BranchId,
          }),
        ),
      )

      const result = await Effect.runPromise(Ref.get(ref))
      expect(result).toEqual(["a:s1", "b:s1"])
    })

    test("observer errors are isolated", async () => {
      const ref = await Effect.runPromise(Ref.make<string[]>([]))

      const extBad = makeExt("bad", "builtin", {
        observers: [defineObserver("session.start", () => Effect.die("boom"))],
      })

      const extGood = makeExt("good", "user", {
        observers: [
          defineObserver("session.start", () => Ref.update(ref, (arr) => [...arr, "good"])),
        ],
      })

      const compiled = compileHooks([extBad, extGood])
      await Effect.runPromise(
        compiled.notifyObservers(
          "session.start",
          new SessionStarted({
            sessionId: "s1" as SessionId,
            branchId: "b1" as BranchId,
          }),
        ),
      )

      const result = await Effect.runPromise(Ref.get(ref))
      expect(result).toEqual(["good"])
    })
  })
})
