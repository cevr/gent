/**
 * Pipeline composition regression locks.
 *
 * Locks the contract for `next` semantics:
 *  - calling `next(input)` runs the inner chain, returns its Effect
 *  - skipping `next` short-circuits — inner chain does not run
 *  - calling `next` multiple times is allowed (e.g., retry semantics)
 *  - typed errors raised in inner chain propagate to outer (no swallow)
 *  - defects in one pipeline fall through to the next (caught per-pipeline)
 */
import { describe, it, expect } from "effect-bun-test"
import { Data, Effect } from "effect"
import type { LoadedExtension, ToolExecuteInput } from "@gent/core/domain/extension"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { compileRuntimeSlots } from "@gent/core/runtime/extensions/runtime-slots"
import { pipeline } from "@gent/core/domain/contribution"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"

const stubCtx = {
  sessionId: "test-session",
  branchId: "test-branch",
  cwd: "/tmp",
  home: "/tmp",
} as unknown as ExtensionHostContext

const stubToolExecuteInput: ToolExecuteInput = {
  toolCallId: "tc-1",
  toolName: "echo",
  input: { text: "hi" },
  sessionId: SessionId.of("test-session"),
  branchId: BranchId.of("test-branch"),
}

const makeExt = (
  id: string,
  kind: "builtin" | "user" | "project",
  pipelines: ReturnType<typeof pipeline>[],
): LoadedExtension => ({
  manifest: { id },
  kind,
  sourcePath: `/test/${id}`,
  contributions: { pipelines },
})

class CustomError extends Data.TaggedError("@gent/core/tests/pipeline-composition/CustomError")<{
  readonly reason: string
}> {}

describe("pipeline composition", () => {
  it.live("short-circuit: skipping next prevents inner chain from running", () => {
    const log: string[] = []
    const inner = makeExt("inner", "builtin", [
      pipeline("tool.execute", (input, next) => {
        log.push("inner")
        return next(input)
      }),
    ])
    const outer = makeExt("outer", "project", [
      pipeline("tool.execute", (_input, _next) => {
        log.push("outer-short-circuit")
        return Effect.succeed("override")
      }),
    ])

    const compiled = compileRuntimeSlots([inner, outer])
    return compiled
      .executeTool(
        stubToolExecuteInput,
        () => {
          log.push("base")
          return Effect.succeed("real")
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
      pipeline("tool.execute", (input, next) =>
        Effect.gen(function* () {
          const first = yield* next(input)
          const second = yield* next(input)
          return `${first}|${second}`
        }),
      ),
    ])

    const compiled = compileRuntimeSlots([retrying])
    return compiled
      .executeTool(
        stubToolExecuteInput,
        () => {
          baseCalls += 1
          return Effect.succeed(`p-${String(baseCalls)}`)
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
      pipeline(
        "tool.execute",
        // outer doesn't catch — error must propagate
        (input, next) => next(input),
      ),
    ])

    const compiled = compileRuntimeSlots([passThrough])
    return compiled
      .executeTool(
        stubToolExecuteInput,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        () => Effect.fail(new CustomError({ reason: "boom" })) as never,
        stubCtx,
      )
      .pipe(
        Effect.flip,
        Effect.tap((err) => Effect.sync(() => expect((err as CustomError).reason).toBe("boom"))),
      )
  })

  it.live("defect in middle pipeline falls through to outer's previous", () => {
    const log: string[] = []
    const inner = makeExt("inner", "builtin", [
      pipeline("tool.execute", (input, next) => {
        log.push("inner")
        return next(input)
      }),
    ])
    const middle = makeExt("middle", "user", [
      pipeline("tool.execute", () => {
        log.push("middle-defect")
        throw new Error("middle blew up")
      }),
    ])
    const outer = makeExt("outer", "project", [
      pipeline("tool.execute", (input, next) => {
        log.push("outer")
        return next(input).pipe(Effect.map((r) => `${r}!`))
      }),
    ])

    const compiled = compileRuntimeSlots([inner, middle, outer])
    return compiled
      .executeTool(
        stubToolExecuteInput,
        () => {
          log.push("base")
          return Effect.succeed("ok")
        },
        stubCtx,
      )
      .pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            // middle defects → composeChain falls through to previous (inner)
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
