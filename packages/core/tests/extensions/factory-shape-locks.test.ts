/**
 * Capability factory-shape regression locks (compile-time).
 *
 * Type-level only — every `@ts-expect-error` proves that the three
 * typed capability factories (`tool` / `request` / `action`) reject
 * fields that don't belong to their shape. If TypeScript stops erroring
 * here, the typed-factory fence has regressed and the
 * `audiences[] + intent` flag matrix can leak back into the author surface.
 *
 * Tied to B11.5 of the gent-v2 substrate cleanup plan. Wired into
 * `typecheck:locks` via `tsconfig.locks.json`.
 */

import { describe, test, expect } from "bun:test"
import { Context, Effect, Schema } from "effect"
import { action, type ReadOnly, ReadOnlyBrand, request, tool } from "@gent/core/extensions/api"

// A representative WRITE-capable service tag (no `ReadOnly` brand).
class WriteCapableService extends Context.Service<
  WriteCapableService,
  { readonly write: () => Effect.Effect<void> }
>()("@gent/core/tests/factory-shape-locks/WriteCapableService") {}

// A representative READ-only service tag with the brand.
interface ReadOnlyShape {
  readonly read: () => Effect.Effect<string>
}
class ReadOnlyService extends Context.Service<ReadOnlyService, ReadOnly<ReadOnlyShape>>()(
  "@gent/core/tests/factory-shape-locks/ReadOnlyService",
) {
  declare readonly [ReadOnlyBrand]: true
}

// Keep symbol live (declare-only property otherwise tree-shakes the import).
void ReadOnlyBrand

const NoInput = Schema.Struct({})
const StringOutput = Schema.String

describe("Capability factory-shape locks (compile-time)", () => {
  test("tool({...}) — happy path compiles", () => {
    const ok = tool({
      id: "ok-tool",
      description: "ok",
      params: Schema.Struct({ x: Schema.String }),
      execute: (params) => Effect.succeed(`ok: ${params.x}`),
    })
    void ok
    expect(true).toBe(true)
  })

  test("tool({...}) rejects `surface` field (action-only)", () => {
    // Overload resolution fails: new `ToolInput` doesn't accept
    // `surface` (action-only field), and legacy `ToolDefinition`
    // requires `name` not `id`. So neither matches.
    tool({
      // @ts-expect-error
      id: "bad-tool",
      description: "x",
      params: NoInput,
      surface: "slash",
      execute: () => Effect.succeed("x"),
    })
    expect(true).toBe(true)
  })

  test("tool({...}) rejects `intent` field (request-only)", () => {
    // Overload resolution fails: new `ToolInput` doesn't accept
    // `intent` (request-only field).
    tool({
      // @ts-expect-error
      id: "bad-tool",
      description: "x",
      params: NoInput,
      intent: "read",
      execute: () => Effect.succeed("x"),
    })
    expect(true).toBe(true)
  })

  test("request({ intent: 'read' }) — happy path compiles with ReadOnly Tag", () => {
    const ok = request({
      id: "ok-read",
      intent: "read",
      input: NoInput,
      output: StringOutput,
      execute: () =>
        Effect.gen(function* () {
          const svc = yield* ReadOnlyService
          return yield* svc.read()
        }),
    })
    void ok
    expect(true).toBe(true)
  })

  test("request({ intent: 'read' }) rejects write-capable Tag in R", () => {
    // Write-capable Tag fails the `R extends ReadOnlyTag` constraint on
    // the read overload; overload resolution falls through to the write
    // overload which expects `intent: "write"`, hence the literal mismatch.
    request({
      id: "bad-read",
      // @ts-expect-error
      intent: "read",
      input: NoInput,
      output: StringOutput,
      execute: () =>
        Effect.gen(function* () {
          const svc = yield* WriteCapableService
          yield* svc.write()
          return "x"
        }),
    })
    expect(true).toBe(true)
  })

  test("request({ intent: 'write' }) — write-capable Tag in R is allowed", () => {
    const ok = request({
      id: "ok-write",
      intent: "write",
      input: NoInput,
      output: StringOutput,
      execute: () =>
        Effect.gen(function* () {
          const svc = yield* WriteCapableService
          yield* svc.write()
          return "x"
        }),
    })
    void ok
    expect(true).toBe(true)
  })

  test("request({...}) rejects `params` field (tool-only)", () => {
    request({
      id: "bad-request",
      intent: "write",
      // @ts-expect-error — `params` belongs to tool(), not request()
      params: NoInput,
      input: NoInput,
      output: StringOutput,
      execute: () => Effect.succeed("x"),
    })
    expect(true).toBe(true)
  })

  test("action({...}) — happy path compiles", () => {
    const ok = action({
      id: "ok-action",
      name: "Ok Action",
      description: "ok",
      surface: "slash",
      input: NoInput,
      output: StringOutput,
      execute: () => Effect.succeed("done"),
    })
    void ok
    expect(true).toBe(true)
  })

  test("action({...}) rejects `params` field (tool-only)", () => {
    action({
      id: "bad-action",
      name: "x",
      description: "x",
      surface: "slash",
      // @ts-expect-error — `params` belongs to tool(), not action()
      params: NoInput,
      input: NoInput,
      output: StringOutput,
      execute: () => Effect.succeed("x"),
    })
    expect(true).toBe(true)
  })

  test("action({...}) rejects `intent` field (request-only)", () => {
    action({
      id: "bad-action",
      name: "x",
      description: "x",
      surface: "slash",
      // @ts-expect-error — `intent` belongs to request(), not action()
      intent: "write",
      input: NoInput,
      output: StringOutput,
      execute: () => Effect.succeed("x"),
    })
    expect(true).toBe(true)
  })

  test("action({...}) rejects unknown `surface` value", () => {
    action({
      id: "bad-action",
      name: "x",
      description: "x",
      // @ts-expect-error — surface is `"slash" | "palette" | "both"` only
      surface: "modal",
      input: NoInput,
      output: StringOutput,
      execute: () => Effect.succeed("x"),
    })
    expect(true).toBe(true)
  })
})
