/**
 * Capability factory-shape regression locks (compile-time).
 *
 * Type-level only — every `@ts-expect-error` proves that the three
 * typed capability factories (`tool` / `request` / `action`) reject
 * fields that don't belong to their shape. If TypeScript stops erroring
 * here, the typed-factory fence has regressed and the
 * `audiences[] + intent` flag matrix can leak back into the author surface.
 *
 * Tied to B11.5 of the gent-v2 substrate cleanup plan. Wired into the
 * core `typecheck` lock pass via `tsconfig.locks.json`.
 */

import { describe, test, expect } from "bun:test"
import { Context, Effect, Schema } from "effect"
import {
  action,
  type ReadOnly,
  ReadOnlyBrand,
  type ReadRequestInput,
  request,
  tool,
  type ToolInput,
  type WriteRequestInput,
} from "@gent/core/extensions/api"

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
    // Pin the type via `satisfies ToolInput` so neither tsc nor tsgo
    // falls through to the legacy `ToolDefinition` overload. The
    // excess-property error then lands at the offending field for both
    // compilers (TS2353).
    const _badInput = {
      id: "bad-tool",
      description: "x",
      params: NoInput,
      // @ts-expect-error — `surface` is an action-only field
      surface: "slash",
      execute: () => Effect.succeed("x"),
    } satisfies ToolInput
    void _badInput
    expect(true).toBe(true)
  })

  test("tool({...}) rejects `intent` field (request-only)", () => {
    const _badInput = {
      id: "bad-tool",
      description: "x",
      params: NoInput,
      // @ts-expect-error — `intent` is a request-only field
      intent: "read",
      execute: () => Effect.succeed("x"),
    } satisfies ToolInput
    void _badInput
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
    // Pin to ReadRequestInput so overload resolution doesn't fall
    // through to the write overload. The R-channel constraint then
    // fails at the execute property because WriteCapableService lacks
    // ReadOnlyBrand.
    const _badInput = {
      id: "bad-read",
      intent: "read" as const,
      input: NoInput,
      output: StringOutput,
      execute: () =>
        // @ts-expect-error — WriteCapableService lacks ReadOnlyBrand
        Effect.gen(function* () {
          const svc = yield* WriteCapableService
          yield* svc.write()
          return "x"
        }),
    } satisfies ReadRequestInput<unknown, string, never>
    void _badInput
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
    const _badInput = {
      id: "bad-request",
      intent: "write" as const,
      // @ts-expect-error — `params` belongs to tool(), not request()
      params: NoInput,
      input: NoInput,
      output: StringOutput,
      execute: () => Effect.succeed("x"),
    } satisfies WriteRequestInput<unknown, string, never>
    void _badInput
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
