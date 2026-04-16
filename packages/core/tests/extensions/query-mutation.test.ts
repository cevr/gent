/**
 * Query/Mutation registry regression locks.
 *
 * Locks the typed-RPC contract:
 *  - `compileQueries` / `compileMutations` register entries from sorted
 *    extensions
 *  - dispatch by `(extensionId, id)` finds the highest-precedence
 *    registration (project > user > builtin)
 *  - input is decoded via Schema before reaching the handler — bad input
 *    fails as `QueryError`/`MutationError` with reason "input decode failed"
 *  - output is validated via Schema (encode-as-validation) — bad output
 *    fails as `QueryError`/`MutationError` with reason "output validation
 *    failed"
 *  - missing `(extensionId, id)` returns `QueryNotFoundError` /
 *    `MutationNotFoundError`
 *  - handler defects are coerced into typed errors (no defects escape)
 *
 * Tied to planify Commit 4. If query/mutation routing stops respecting scope
 * precedence or stops validating at the boundary, the typed-RPC substrate
 * has regressed.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Schema } from "effect"
import type { LoadedExtension } from "@gent/core/domain/extension"
import {
  type QueryContribution,
  type QueryContext,
  QueryError,
  QueryNotFoundError,
} from "@gent/core/domain/query"
import {
  type MutationContribution,
  type MutationContext,
  MutationError,
  MutationNotFoundError,
} from "@gent/core/domain/mutation"
import { compileQueries } from "@gent/core/runtime/extensions/query-registry"
import { compileMutations } from "@gent/core/runtime/extensions/mutation-registry"

const ctx: QueryContext & MutationContext = {
  sessionId: "s" as QueryContext["sessionId"],
  branchId: "b" as QueryContext["branchId"],
  cwd: "/tmp",
  home: "/tmp",
}

const extWithQueries = (
  id: string,
  kind: "builtin" | "user" | "project",
  queries: ReadonlyArray<QueryContribution<unknown, unknown, never>>,
): LoadedExtension => ({
  manifest: { id },
  kind,
  sourcePath: `/test/${id}`,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  setup: { queries: queries as ReadonlyArray<QueryContribution<never, never, never>> },
})

const extWithMutations = (
  id: string,
  kind: "builtin" | "user" | "project",
  mutations: ReadonlyArray<MutationContribution<unknown, unknown, never>>,
): LoadedExtension => ({
  manifest: { id },
  kind,
  sourcePath: `/test/${id}`,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  setup: { mutations: mutations as ReadonlyArray<MutationContribution<never, never, never>> },
})

describe("query-mutation registries", () => {
  it.live("query: dispatches by (extensionId, queryId) and returns decoded output", () =>
    Effect.gen(function* () {
      const echo: QueryContribution<{ value: string }, { value: string }, never> = {
        id: "echo",
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        handler: (input) => Effect.succeed({ value: input.value }),
      }
      const compiled = compileQueries([extWithQueries("@test/q", "builtin", [echo])])
      const result = yield* compiled.run("@test/q", "echo", { value: "hi" }, ctx)
      expect(result).toEqual({ value: "hi" })
    }),
  )

  it.live("query: returns QueryNotFoundError when (extensionId, queryId) is unknown", () =>
    Effect.gen(function* () {
      const compiled = compileQueries([])
      const result = yield* compiled.run("@x", "missing", {}, ctx).pipe(Effect.flip)
      expect(result).toBeInstanceOf(QueryNotFoundError)
    }),
  )

  it.live("query: respects scope precedence — project wins over user wins over builtin", () =>
    Effect.gen(function* () {
      const make = (label: string): QueryContribution<{ x: number }, { tag: string }, never> => ({
        id: "pick",
        input: Schema.Struct({ x: Schema.Number }),
        output: Schema.Struct({ tag: Schema.String }),
        handler: () => Effect.succeed({ tag: label }),
      })
      // Same extensionId across scopes; project should win.
      const compiled = compileQueries([
        extWithQueries("@scope", "builtin", [make("builtin")]),
        extWithQueries("@scope", "user", [make("user")]),
        extWithQueries("@scope", "project", [make("project")]),
      ])
      const result = yield* compiled.run("@scope", "pick", { x: 1 }, ctx)
      expect(result).toEqual({ tag: "project" })
    }),
  )

  it.live("query: rejects bad input with QueryError reason='input decode failed'", () =>
    Effect.gen(function* () {
      const ping: QueryContribution<{ count: number }, { ok: boolean }, never> = {
        id: "ping",
        input: Schema.Struct({ count: Schema.Number }),
        output: Schema.Struct({ ok: Schema.Boolean }),
        handler: () => Effect.succeed({ ok: true }),
      }
      const compiled = compileQueries([extWithQueries("@v", "builtin", [ping])])
      const error = yield* compiled
        .run("@v", "ping", { count: "not-a-number" }, ctx)
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(QueryError)
      expect((error as QueryError).reason).toContain("input decode failed")
    }),
  )

  it.live("query: rejects bad output with QueryError reason='output validation failed'", () =>
    Effect.gen(function* () {
      const lying: QueryContribution<{}, { ok: boolean }, never> = {
        id: "lying",
        input: Schema.Struct({}),
        output: Schema.Struct({ ok: Schema.Boolean }),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        handler: () => Effect.succeed({ ok: "yes" } as unknown as { ok: boolean }),
      }
      const compiled = compileQueries([extWithQueries("@v", "builtin", [lying])])
      const error = yield* compiled.run("@v", "lying", {}, ctx).pipe(Effect.flip)
      expect(error).toBeInstanceOf(QueryError)
      expect((error as QueryError).reason).toContain("output validation failed")
    }),
  )

  it.live("query: coerces handler defects into QueryError", () =>
    Effect.gen(function* () {
      const boom: QueryContribution<{}, { ok: boolean }, never> = {
        id: "boom",
        input: Schema.Struct({}),
        output: Schema.Struct({ ok: Schema.Boolean }),
        handler: () => Effect.die("kaboom"),
      }
      const compiled = compileQueries([extWithQueries("@v", "builtin", [boom])])
      const error = yield* compiled.run("@v", "boom", {}, ctx).pipe(Effect.flip)
      expect(error).toBeInstanceOf(QueryError)
      expect((error as QueryError).reason).toContain("handler defect")
    }),
  )

  it.live("mutation: dispatches by (extensionId, mutationId) and returns decoded output", () =>
    Effect.gen(function* () {
      const create: MutationContribution<{ name: string }, { id: string }, never> = {
        id: "create",
        input: Schema.Struct({ name: Schema.String }),
        output: Schema.Struct({ id: Schema.String }),
        handler: (input) => Effect.succeed({ id: `id-${input.name}` }),
      }
      const compiled = compileMutations([extWithMutations("@test/m", "builtin", [create])])
      const result = yield* compiled.run("@test/m", "create", { name: "abc" }, ctx)
      expect(result).toEqual({ id: "id-abc" })
    }),
  )

  it.live("mutation: returns MutationNotFoundError when (extensionId, mutationId) is unknown", () =>
    Effect.gen(function* () {
      const compiled = compileMutations([])
      const result = yield* compiled.run("@x", "missing", {}, ctx).pipe(Effect.flip)
      expect(result).toBeInstanceOf(MutationNotFoundError)
    }),
  )

  it.live("mutation: respects scope precedence — project wins over user wins over builtin", () =>
    Effect.gen(function* () {
      const make = (label: string): MutationContribution<{}, { tag: string }, never> => ({
        id: "pick",
        input: Schema.Struct({}),
        output: Schema.Struct({ tag: Schema.String }),
        handler: () => Effect.succeed({ tag: label }),
      })
      const compiled = compileMutations([
        extWithMutations("@scope", "builtin", [make("builtin")]),
        extWithMutations("@scope", "user", [make("user")]),
        extWithMutations("@scope", "project", [make("project")]),
      ])
      const result = yield* compiled.run("@scope", "pick", {}, ctx)
      expect(result).toEqual({ tag: "project" })
    }),
  )

  it.live("mutation: rejects bad input with MutationError reason='input decode failed'", () =>
    Effect.gen(function* () {
      const upd: MutationContribution<{ id: string }, { ok: boolean }, never> = {
        id: "upd",
        input: Schema.Struct({ id: Schema.String }),
        output: Schema.Struct({ ok: Schema.Boolean }),
        handler: () => Effect.succeed({ ok: true }),
      }
      const compiled = compileMutations([extWithMutations("@v", "builtin", [upd])])
      const error = yield* compiled.run("@v", "upd", { id: 123 }, ctx).pipe(Effect.flip)
      expect(error).toBeInstanceOf(MutationError)
      expect((error as MutationError).reason).toContain("input decode failed")
    }),
  )

  it.live("mutation: rejects bad output with MutationError reason='output validation failed'", () =>
    Effect.gen(function* () {
      const lying: MutationContribution<{}, { ok: boolean }, never> = {
        id: "lying",
        input: Schema.Struct({}),
        output: Schema.Struct({ ok: Schema.Boolean }),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        handler: () => Effect.succeed({ ok: "yes" } as unknown as { ok: boolean }),
      }
      const compiled = compileMutations([extWithMutations("@v", "builtin", [lying])])
      const error = yield* compiled.run("@v", "lying", {}, ctx).pipe(Effect.flip)
      expect(error).toBeInstanceOf(MutationError)
      expect((error as MutationError).reason).toContain("output validation failed")
    }),
  )

  it.live("mutation: coerces handler defects into MutationError", () =>
    Effect.gen(function* () {
      const boom: MutationContribution<{}, { ok: boolean }, never> = {
        id: "boom",
        input: Schema.Struct({}),
        output: Schema.Struct({ ok: Schema.Boolean }),
        handler: () => Effect.die("kaboom"),
      }
      const compiled = compileMutations([extWithMutations("@v", "builtin", [boom])])
      const error = yield* compiled.run("@v", "boom", {}, ctx).pipe(Effect.flip)
      expect(error).toBeInstanceOf(MutationError)
      expect((error as MutationError).reason).toContain("handler defect")
    }),
  )
})
