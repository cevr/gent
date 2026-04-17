/**
 * Interceptor composition regression locks.
 *
 * Locks the contract for `next` semantics:
 *  - calling `next(input)` runs the inner chain, returns its Effect
 *  - skipping `next` short-circuits — inner chain does not run
 *  - calling `next` multiple times is allowed (e.g., retry semantics)
 *  - typed errors raised in inner chain propagate to outer (no swallow)
 *  - defects in one interceptor fall through to the next (caught per-interceptor)
 *
 * Tied to planify Commit 1 — the substrate that later commits (2, 3, 4, 5, 6, 8, 10)
 * lean on for splitting projection/interceptor primitives.
 */
import { describe, it, expect } from "effect-bun-test"
import { Data, Effect } from "effect"
import { Agents } from "@gent/extensions/all-agents"
import { defineInterceptor, type LoadedExtension } from "@gent/core/domain/extension"
import { compileInterceptors } from "@gent/core/runtime/extensions/interceptor-registry"
import {
  interceptor as interceptorContribution,
  type Contribution,
} from "@gent/core/domain/contribution"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"

const stubCtx = {
  sessionId: "test-session",
  branchId: "test-branch",
  cwd: "/tmp",
  home: "/tmp",
} as unknown as ExtensionHostContext

const makeExt = (
  id: string,
  kind: "builtin" | "user" | "project",
  contributions: ReadonlyArray<Contribution>,
): LoadedExtension => ({ manifest: { id }, kind, sourcePath: `/test/${id}`, contributions })

class CustomError extends Data.TaggedError("@gent/core/tests/interceptor-composition/CustomError")<{
  readonly reason: string
}> {}

describe("interceptor composition", () => {
  it.live("short-circuit: skipping next prevents inner chain from running", () => {
    const log: string[] = []
    const inner = makeExt("inner", "builtin", [
      interceptorContribution(
        defineInterceptor("prompt.system", (input, next) => {
          log.push("inner")
          return next(input)
        }),
      ),
    ])
    const outer = makeExt("outer", "project", [
      interceptorContribution(
        defineInterceptor("prompt.system", (_input, _next) => {
          log.push("outer-short-circuit")
          return Effect.succeed("override")
        }),
      ),
    ])

    const compiled = compileInterceptors([inner, outer]).chain
    return compiled
      .runInterceptor(
        "prompt.system",
        { basePrompt: "real", agent: Agents.cowork },
        (input) => {
          log.push("base")
          return Effect.succeed(input.basePrompt)
        },
        stubCtx,
      )
      .pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result).toBe("override")
            expect(log).toEqual(["outer-short-circuit"])
          }),
        ),
      )
  })

  it.live("multiple next() calls re-runs inner chain (retry semantics allowed)", () => {
    let baseCalls = 0
    const retrying = makeExt("retrier", "project", [
      interceptorContribution(
        defineInterceptor("prompt.system", (input, next) =>
          Effect.gen(function* () {
            const first = yield* next(input)
            const second = yield* next(input)
            return `${first}|${second}`
          }),
        ),
      ),
    ])

    const compiled = compileInterceptors([retrying]).chain
    return compiled
      .runInterceptor(
        "prompt.system",
        { basePrompt: "p", agent: Agents.cowork },
        (input) => {
          baseCalls += 1
          return Effect.succeed(`${input.basePrompt}-${String(baseCalls)}`)
        },
        stubCtx,
      )
      .pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result).toBe("p-1|p-2")
            expect(baseCalls).toBe(2)
          }),
        ),
      )
  })

  it.live("typed errors from inner chain propagate to outer", () => {
    const passThrough = makeExt("pass", "project", [
      interceptorContribution(
        defineInterceptor("prompt.system", (input, next) =>
          // outer doesn't catch — error must propagate
          next(input),
        ),
      ),
    ])

    const compiled = compileInterceptors([passThrough]).chain
    return compiled
      .runInterceptor(
        "prompt.system",
        { basePrompt: "p", agent: Agents.cowork },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        () => Effect.fail(new CustomError({ reason: "boom" })) as never,
        stubCtx,
      )
      .pipe(
        Effect.flip,
        Effect.tap((err) => Effect.sync(() => expect((err as CustomError).reason).toBe("boom"))),
      )
  })

  it.live("defect in middle interceptor falls through to outer's previous", () => {
    const log: string[] = []
    const inner = makeExt("inner", "builtin", [
      interceptorContribution(
        defineInterceptor("prompt.system", (input, next) => {
          log.push("inner")
          return next(input)
        }),
      ),
    ])
    const middle = makeExt("middle", "user", [
      interceptorContribution(
        defineInterceptor("prompt.system", () => {
          log.push("middle-defect")
          throw new Error("middle blew up")
        }),
      ),
    ])
    const outer = makeExt("outer", "project", [
      interceptorContribution(
        defineInterceptor("prompt.system", (input, next) => {
          log.push("outer")
          return next(input).pipe(Effect.map((r) => `${r}!`))
        }),
      ),
    ])

    const compiled = compileInterceptors([inner, middle, outer]).chain
    return compiled
      .runInterceptor(
        "prompt.system",
        { basePrompt: "ok", agent: Agents.cowork },
        (input) => {
          log.push("base")
          return Effect.succeed(input.basePrompt)
        },
        stubCtx,
      )
      .pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            // middle defects → composeInterceptors falls through to previous (inner)
            // outer still runs and appends "!"
            expect(result).toBe("ok!")
            expect(log).toContain("outer")
            expect(log).toContain("middle-defect")
            expect(log).toContain("inner")
            expect(log).toContain("base")
          }),
        ),
      )
  })
})
