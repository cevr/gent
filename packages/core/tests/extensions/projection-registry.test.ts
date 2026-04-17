/**
 * ProjectionRegistry regression locks.
 *
 * Locks the projection contract:
 *  - `evaluateTurn(ctx)` runs only `prompt`/`policy`-bearing projections;
 *    emits promptSections + policyFragments. `turn` is type-required.
 *  - `query` runs once per projection per evaluator pass
 *  - failing query / prompt / policy projector is isolated and skipped
 *  - scope precedence: builtin < user < project (later contributions appear
 *    later in result lists)
 */
import { describe, it, expect } from "effect-bun-test"
import { Context, Effect, Layer, Ref } from "effect"
import { Agents } from "@gent/extensions/all-agents"
import type { ExtensionTurnContext, LoadedExtension } from "@gent/core/domain/extension"
import {
  type AnyProjectionContribution,
  type ProjectionContribution,
  type ProjectionTurnContext,
  ProjectionError,
} from "@gent/core/domain/projection"
import { resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { compileProjections } from "@gent/core/runtime/extensions/projection-registry"
import { projection as projectionContribution } from "@gent/core/domain/contribution"

const ext = (
  id: string,
  kind: "builtin" | "user" | "project",
  projections: ReadonlyArray<AnyProjectionContribution>,
): LoadedExtension => ({
  manifest: { id },
  kind,
  sourcePath: `/test/${id}`,
  contributions: [...projections.map(projectionContribution)],
})

const turnCtx: ExtensionTurnContext = {
  sessionId: "s" as ExtensionTurnContext["sessionId"],
  branchId: "b" as ExtensionTurnContext["branchId"],
  agent: Agents.cowork,
  allTools: [],
  interactive: true,
  cwd: "/tmp",
  home: "/tmp",
} as unknown as ExtensionTurnContext

const turnEvalCtx: ProjectionTurnContext = {
  sessionId: turnCtx.sessionId,
  branchId: turnCtx.branchId,
  cwd: "/tmp",
  home: "/tmp",
  turn: turnCtx,
}

describe("projection registry", () => {
  it.live("evaluateTurn runs prompt/policy projections only", () =>
    Effect.gen(function* () {
      const turnOnly: ProjectionContribution<{ greeting: string }> = {
        id: "greeter",
        query: () => Effect.succeed({ greeting: "hi" }),
        prompt: (v) => [{ id: "g", content: v.greeting, priority: 50 }],
        policy: (v) => ({ include: [v.greeting] }),
      }
      const compiled = compileProjections([ext("a", "builtin", [turnOnly])])
      const result = yield* compiled.evaluateTurn(turnEvalCtx)
      expect(result.promptSections).toHaveLength(1)
      expect(result.promptSections[0]?.content).toBe("hi")
      expect(result.policyFragments).toEqual([{ include: ["hi"] }])
    }),
  )

  it.live("query runs exactly once per evaluator pass", () =>
    Effect.gen(function* () {
      const counter = yield* Ref.make(0)
      const projection: ProjectionContribution<number> = {
        id: "counter",
        query: () => Ref.updateAndGet(counter, (n) => n + 1),
        prompt: (n) => [{ id: "p", content: String(n), priority: 50 }],
        policy: (n) => ({ include: [String(n)] }),
      }
      const compiled = compileProjections([ext("a", "builtin", [projection])])
      yield* compiled.evaluateTurn(turnEvalCtx)
      expect(yield* Ref.get(counter)).toBe(1)
    }),
  )

  it.live("failing query is logged + skipped — other projections continue", () =>
    Effect.gen(function* () {
      const goodFn = (): Effect.Effect<{ value: string }, ProjectionError> =>
        Effect.succeed({ value: "good" })
      const badFn = (): Effect.Effect<never, ProjectionError> =>
        Effect.fail(new ProjectionError({ projectionId: "bad", reason: "boom" }))

      const compiled = compileProjections([
        ext("a", "builtin", [
          { id: "bad", query: badFn, prompt: () => [{ id: "x", content: "x", priority: 1 }] },
          {
            id: "good",
            query: goodFn,
            prompt: (v) => [{ id: "g", content: v.value, priority: 50 }],
          },
        ]),
      ])
      const result = yield* compiled.evaluateTurn(turnEvalCtx)
      expect(result.promptSections).toHaveLength(1)
      expect(result.promptSections[0]?.content).toBe("good")
    }),
  )

  it.live("scope precedence: builtin first, user next, project last in eval order", () =>
    Effect.gen(function* () {
      const make = (id: string): AnyProjectionContribution => ({
        id,
        query: () => Effect.succeed(id),
        prompt: (v) => [{ id, content: String(v), priority: 50 }],
      })
      const compiled = compileProjections([
        ext("c-proj", "project", [make("project-section")]),
        ext("a-built", "builtin", [make("builtin-section")]),
        ext("b-user", "user", [make("user-section")]),
      ])
      const result = yield* compiled.evaluateTurn(turnEvalCtx)
      expect(result.promptSections.map((s) => s.content)).toEqual([
        "builtin-section",
        "user-section",
        "project-section",
      ])
    }),
  )

  it.live("query() targeted lookup returns the raw value", () =>
    Effect.gen(function* () {
      const projection: ProjectionContribution<string> = {
        id: "raw",
        query: () => Effect.succeed("hello"),
      }
      const compiled = compileProjections([ext("a", "builtin", [projection])])
      const value = yield* compiled.query("a", "raw", turnEvalCtx)
      expect(value).toBe("hello")
    }),
  )

  it.live("query() returns undefined for unknown projection id", () =>
    Effect.gen(function* () {
      const compiled = compileProjections([])
      const value = yield* compiled.query("a", "missing", turnEvalCtx)
      expect(value).toBeUndefined()
    }),
  )

  it.live("compiled projections appear in ResolvedExtensions.projections", () =>
    Effect.gen(function* () {
      const projection: ProjectionContribution<number> = {
        id: "p",
        query: () => Effect.succeed(42),
      }
      const resolved = resolveExtensions([ext("a", "builtin", [projection])])
      expect(resolved.projections.entries).toHaveLength(1)
      expect(resolved.projections.entries[0]?.projection.id).toBe("p")
      const value = yield* resolved.projections.query("a", "p", turnEvalCtx)
      expect(value).toBe(42)
    }),
  )

  it.live("query() returns highest-precedence registration when ids collide across scopes", () =>
    Effect.gen(function* () {
      const builtinP: ProjectionContribution<string> = {
        id: "p",
        query: () => Effect.succeed("builtin-value"),
      }
      const projectP: ProjectionContribution<string> = {
        id: "p",
        query: () => Effect.succeed("project-value"),
      }
      const compiled = compileProjections([
        ext("shared", "builtin", [builtinP]),
        ext("shared", "project", [projectP]),
      ])
      const value = yield* compiled.query("shared", "p", turnEvalCtx)
      expect(value).toBe("project-value")
    }),
  )

  it.live("ProjectionContext exposes cwd, home, sessionCwd to query Effect", () =>
    Effect.gen(function* () {
      const captured: { cwd?: string; home?: string; sessionCwd?: string } = {}
      const projection: ProjectionContribution<string> = {
        id: "ctx-reader",
        query: (ctx) =>
          Effect.sync(() => {
            captured.cwd = ctx.cwd
            captured.home = ctx.home
            captured.sessionCwd = ctx.sessionCwd
            return "read"
          }),
        prompt: () => [{ id: "p", content: "x", priority: 1 }],
      }
      const compiled = compileProjections([ext("a", "builtin", [projection])])
      yield* compiled.evaluateTurn({
        sessionId: turnCtx.sessionId,
        branchId: turnCtx.branchId,
        cwd: "/proj",
        home: "/users/me",
        sessionCwd: "/proj/feature",
        turn: turnCtx,
      })
      expect(captured.cwd).toBe("/proj")
      expect(captured.home).toBe("/users/me")
      expect(captured.sessionCwd).toBe("/proj/feature")
    }),
  )

  it.live("projection with service requirement runs when layer is composed", () =>
    Effect.gen(function* () {
      class Greeter extends Context.Service<
        Greeter,
        { readonly say: () => Effect.Effect<string> }
      >()("test/Greeter") {}

      const projection: ProjectionContribution<string, Greeter> = {
        id: "greeter",
        query: () =>
          Effect.gen(function* () {
            const g = yield* Greeter
            return yield* g.say()
          }),
        prompt: (v) => [{ id: "g", content: v, priority: 50 }],
      }
      const compiled = compileProjections([ext("a", "builtin", [projection])])
      const result = yield* compiled
        .evaluateTurn(turnEvalCtx)
        .pipe(
          Effect.provide(Layer.succeed(Greeter, { say: () => Effect.succeed("hi from service") })),
        )
      expect(result.promptSections[0]?.content).toBe("hi from service")
    }),
  )
})
