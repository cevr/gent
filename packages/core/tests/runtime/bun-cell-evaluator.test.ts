import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Fiber, Ref } from "effect"
import {
  makeBunCellEvaluator,
  CellHost,
  CellWorkerEnvironment,
} from "@gent/core-internal/runtime/code-cell/bun-evaluator-boundary"
import {
  maximumCellDisplayLength,
  maximumCellSourceLength,
} from "@gent/core-internal/runtime/code-cell/cell-protocol"

/** Cells share the test process realm, so each test clears its bindings at scope exit. */
const makeKernel = (host: typeof CellHost.Service) =>
  Effect.gen(function* () {
    const kernel = yield* makeBunCellEvaluator.pipe(
      Effect.provideService(CellHost, host),
      Effect.provideService(CellWorkerEnvironment, { workingDirectory: process.cwd() }),
    )
    yield* Effect.addFinalizer(() => kernel.reset)
    return kernel
  })

describe("Bun cell evaluation", () => {
  it.scopedLive("accepts a host reply while a cell awaits it", () =>
    Effect.gen(function* () {
      const called = yield* Deferred.make<boolean>()
      const reply = yield* Deferred.make<number>()
      const kernel = yield* makeKernel({
        call: () => Deferred.succeed(called, true).pipe(Effect.andThen(Deferred.await(reply))),
      })
      const cell = yield* kernel
        .evaluate("(await tools.call('read', {})) + 1")
        .pipe(Effect.forkScoped)
      yield* Deferred.await(called)
      yield* Deferred.succeed(reply, 41)
      expect((yield* Fiber.join(cell)).display).toBe("42")
    }).pipe(Effect.timeout("2 seconds")),
  )

  it.scopedLive("searches and describes the shipped catalog locally without a host call", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const kernel = yield* makeKernel({
        call: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(0)),
      })
      yield* kernel.setCatalog([
        {
          name: "read",
          description: "Read a file",
          guidelines: ["Prefer read over bash"],
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
        { name: "write", description: "Write a file", guidelines: [], parameters: {} },
      ])
      const search = yield* kernel.evaluate(
        "const page = tools.search('file', 1); `${page.total}:${page.nextOffset}:${page.tools.map((t) => t.name).join(',')}`",
      )
      expect(search.display).toBe("2:2:write")
      const described = yield* kernel.evaluate(
        "const spec = tools.describe('read'); `${spec.parameters.properties.path.type}:${spec.guidelines[0]}`",
      )
      expect(described.display).toBe("string:Prefer read over bash")
      const missing = yield* kernel.evaluate("tools.describe('bash')").pipe(Effect.flip)
      expect(missing.message).toContain("Tool bash is not selected for this turn")
      // Catalog reads are worker-local and never become host operations.
      expect(yield* Ref.get(calls)).toBe(0)
      // A reset clears the namespace, not the catalog.
      yield* kernel.reset
      expect((yield* kernel.evaluate("tools.search('').total")).display).toBe("2")
    }),
  )

  it.scopedLive("rejects non-data host arguments before dispatch", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const kernel = yield* makeKernel({
        call: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(0)),
      })
      const error = yield* kernel
        .evaluate("await tools.call('read', { callback: () => 1 })")
        .pipe(Effect.flip)
      expect(error.phase).toBe("execute")
      expect(yield* Ref.get(calls)).toBe(0)
    }),
  )

  it.scopedLive("keeps working values across cells and clears them on reset", () =>
    Effect.gen(function* () {
      const kernel = yield* makeKernel({ call: () => Effect.succeed(7) })
      yield* kernel.evaluate("const values: number[] = [1, 2, 3]")
      const result = yield* kernel.evaluate("values.push(await tools.call('count', {})); values")
      expect(result.display).toBe("[ 1, 2, 3, 7 ]")
      expect(result.bindings).toEqual(["values"])
      yield* kernel.reset
      expect((yield* kernel.evaluate("typeof values")).display).toBe("undefined")
    }),
  )

  it.scopedLive("runs cells in the worker realm with Bun, require, and dynamic import", () =>
    Effect.gen(function* () {
      const kernel = yield* makeKernel({ call: () => Effect.succeed(0) })
      const result = yield* kernel.evaluate(
        "const fsm = await import('node:fs/promises'); [typeof Bun.file, typeof fetch, typeof fsm.readdir, typeof require('node:path').join, process.cwd().length > 0]",
      )
      expect(result.display).toBe("[ 'function', 'function', 'function', 'function', true ]")
      expect(result.bindings).toEqual(["fsm"])
      yield* kernel.reset
      expect((yield* kernel.evaluate("typeof fsm")).display).toBe("undefined")
      expect(Object.hasOwn(globalThis, "fsm")).toBe(false)
    }),
  )

  it.scopedLive("an undefined result shows only what the cell logged", () =>
    Effect.gen(function* () {
      const kernel = yield* makeKernel({ call: () => Effect.succeed(0) })
      expect((yield* kernel.evaluate("console.log('only this')")).display).toBe("only this")
      expect((yield* kernel.evaluate("undefined")).display).toBe("")
      expect((yield* kernel.evaluate("null")).display).toBe("null")
      expect((yield* kernel.evaluate("'undefined'")).display).toBe("undefined")
    }).pipe(Effect.timeout("2 seconds")),
  )

  it.scopedLive("limits captured output and rejects oversized source before execution", () =>
    Effect.gen(function* () {
      const kernel = yield* makeKernel({ call: () => Effect.succeed(0) })
      const result = yield* kernel.evaluate(
        "console.log('x'.repeat(100000)); console.log('the end'); 'done'",
      )
      // Head and tail survive; the middle is replaced with an omission marker.
      expect(result.display.length).toBeLessThan(maximumCellDisplayLength + 64)
      expect(result.display.startsWith("x".repeat(1024))).toBe(true)
      expect(result.display).toContain("characters omitted")
      expect(result.display).toContain("the end")
      expect(result.truncated).toBe(true)
      const error = yield* kernel
        .evaluate(" ".repeat(maximumCellSourceLength + 1))
        .pipe(Effect.flip)
      expect(error.phase).toBe("source")
    }),
  )

  it.scopedLive("reports a cell failure without replaying or clearing earlier work", () =>
    Effect.gen(function* () {
      const kernel = yield* makeKernel({ call: () => Effect.succeed(0) })
      yield* kernel.evaluate("let count = 0")
      const error = yield* kernel
        .evaluate("count++; console.log('before failure'); throw new Error('failed')")
        .pipe(Effect.flip)
      expect(error.phase).toBe("execute")
      expect(error.output).toBe("before failure")
      expect((yield* kernel.evaluate("count")).display).toBe("1")
      const invalid = yield* kernel.evaluate("const = ;").pipe(Effect.flip)
      expect(invalid.phase).toBe("compile")
      expect((yield* kernel.evaluate("count")).display).toBe("1")
    }),
  )
})
