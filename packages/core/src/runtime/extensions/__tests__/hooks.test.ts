import { describe, test, expect } from "bun:test"
import { Effect, Ref } from "effect"
import type { LoadedExtension } from "../../../domain/extension.js"
import { compileHooks } from "../hooks.js"

const makeExt = (
  id: string,
  kind: "builtin" | "user" | "project",
  hooks: Record<string, unknown>,
): LoadedExtension => ({
  manifest: { id },
  kind,
  sourcePath: `/test/${id}`,
  setup: { hooks: hooks as never },
})

describe("compileHooks", () => {
  describe("interceptors", () => {
    test("runs base when no interceptors registered", async () => {
      const compiled = compileHooks([])
      const result = await Effect.runPromise(
        compiled.runInterceptor("prompt.system", "hello", (input) => Effect.succeed(input)),
      )
      expect(result).toBe("hello")
    })

    test("single interceptor wraps base", async () => {
      const ext = makeExt("a", "builtin", {
        "prompt.system": (
          input: { basePrompt: string },
          next: (i: typeof input) => Effect.Effect<string>,
        ) => next({ ...input, basePrompt: `[wrapped] ${input.basePrompt}` }),
      })

      const compiled = compileHooks([ext])
      const result = await Effect.runPromise(
        compiled.runInterceptor(
          "prompt.system",
          { basePrompt: "hello" },
          (input: { basePrompt: string }) => Effect.succeed(input.basePrompt),
        ),
      )
      expect(result).toBe("[wrapped] hello")
    })

    test("chain order: builtin inner, project outer", async () => {
      const log: string[] = []

      const builtinExt = makeExt("a-builtin", "builtin", {
        "prompt.system": (input: unknown, next: (i: unknown) => Effect.Effect<string>) => {
          log.push("builtin-before")
          return next(input).pipe(
            Effect.map((r) => {
              log.push("builtin-after")
              return r
            }),
          )
        },
      })

      const projectExt = makeExt("b-project", "project", {
        "prompt.system": (input: unknown, next: (i: unknown) => Effect.Effect<string>) => {
          log.push("project-before")
          return next(input).pipe(
            Effect.map((r) => {
              log.push("project-after")
              return r
            }),
          )
        },
      })

      const compiled = compileHooks([builtinExt, projectExt])
      await Effect.runPromise(
        compiled.runInterceptor("prompt.system", "test", () => Effect.succeed("base")),
      )

      // Project is outermost (left fold: builtin wraps base, project wraps that)
      expect(log).toEqual(["project-before", "builtin-before", "builtin-after", "project-after"])
    })

    test("same scope tie-breaks by id alphabetically", async () => {
      const log: string[] = []

      const extB = makeExt("b", "builtin", {
        "prompt.system": (input: unknown, next: (i: unknown) => Effect.Effect<string>) => {
          log.push("b")
          return next(input)
        },
      })

      const extA = makeExt("a", "builtin", {
        "prompt.system": (input: unknown, next: (i: unknown) => Effect.Effect<string>) => {
          log.push("a")
          return next(input)
        },
      })

      const compiled = compileHooks([extB, extA])
      await Effect.runPromise(
        compiled.runInterceptor("prompt.system", "test", () => Effect.succeed("base")),
      )

      // Sorted: [a, b]. Left fold: a wraps base, b wraps a. b is outermost.
      expect(log).toEqual(["b", "a"])
    })
  })

  describe("observers", () => {
    test("no observers = no-op", async () => {
      const compiled = compileHooks([])
      await Effect.runPromise(compiled.notifyObservers("session.start", {}))
    })

    test("fires all observers", async () => {
      const ref = await Effect.runPromise(Ref.make<string[]>([]))

      const ext1 = makeExt("a", "builtin", {
        "session.start": (event: { sessionId: string }) =>
          Ref.update(ref, (arr) => [...arr, `a:${event.sessionId}`]),
      })

      const ext2 = makeExt("b", "user", {
        "session.start": (event: { sessionId: string }) =>
          Ref.update(ref, (arr) => [...arr, `b:${event.sessionId}`]),
      })

      const compiled = compileHooks([ext1, ext2])
      await Effect.runPromise(
        compiled.notifyObservers("session.start", { sessionId: "s1", branchId: "b1" }),
      )

      const result = await Effect.runPromise(Ref.get(ref))
      expect(result).toEqual(["a:s1", "b:s1"])
    })

    test("observer errors are isolated", async () => {
      const ref = await Effect.runPromise(Ref.make<string[]>([]))

      const extBad = makeExt("bad", "builtin", {
        "session.start": () => Effect.die("boom"),
      })

      const extGood = makeExt("good", "user", {
        "session.start": () => Ref.update(ref, (arr) => [...arr, "good"]),
      })

      const compiled = compileHooks([extBad, extGood])
      await Effect.runPromise(compiled.notifyObservers("session.start", {}))

      const result = await Effect.runPromise(Ref.get(ref))
      expect(result).toEqual(["good"])
    })
  })
})
