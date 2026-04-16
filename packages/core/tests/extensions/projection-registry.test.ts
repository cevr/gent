/**
 * ProjectionRegistry regression locks.
 *
 * Locks the projection contract:
 *  - `query` runs once per projection per `evaluateAll`
 *  - `prompt(value)` populates promptSections
 *  - `policy(value, ctx)` populates policyFragments
 *  - `ui.project(value)` (with optional schema validation) emits an
 *    ExtensionUiSnapshot
 *  - failing query / prompt / policy / ui projector is isolated and skipped
 *  - scope precedence: builtin < user < project (later contributions appear
 *    later in result lists)
 *
 * Tied to planify Commit 2. If projections stop being read-only-derive
 * primitives or stop respecting scope, the substrate has regressed.
 */
import { describe, it, expect } from "effect-bun-test"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { Agents } from "@gent/extensions/all-agents"
import type { ExtensionTurnContext, LoadedExtension } from "@gent/core/domain/extension"
import {
  type AnyProjectionContribution,
  type ProjectionContribution,
  ProjectionError,
} from "@gent/core/domain/projection"
import { resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { compileProjections } from "@gent/core/runtime/extensions/projection-registry"

const ext = (
  id: string,
  kind: "builtin" | "user" | "project",
  projections: ReadonlyArray<AnyProjectionContribution>,
): LoadedExtension => ({
  manifest: { id },
  kind,
  sourcePath: `/test/${id}`,
  setup: { projections },
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

describe("projection registry", () => {
  it.live("evaluateAll runs each query and projects prompt + policy + ui", () =>
    Effect.gen(function* () {
      const projection: ProjectionContribution<{ greeting: string }> = {
        id: "greeter",
        query: () => Effect.succeed({ greeting: "hi" }),
        prompt: (v) => [{ id: "g", content: v.greeting, priority: 50 }],
        policy: (v) => ({ include: [v.greeting] }),
        ui: { project: (v) => ({ rendered: v.greeting }) },
      }
      const compiled = compileProjections([ext("a", "builtin", [projection])])
      const result = yield* compiled.evaluateAll({ turn: turnCtx })
      expect(result.promptSections).toHaveLength(1)
      expect(result.promptSections[0]?.content).toBe("hi")
      expect(result.policyFragments).toEqual([{ include: ["hi"] }])
      expect(result.uiSnapshots).toHaveLength(1)
      expect(result.uiSnapshots[0]?.extensionId).toBe("a")
      expect(result.uiSnapshots[0]?.model).toEqual({ rendered: "hi" })
    }),
  )

  it.live("query runs exactly once per evaluateAll (memoized via single execution)", () =>
    Effect.gen(function* () {
      const counter = yield* Ref.make(0)
      const projection: ProjectionContribution<number> = {
        id: "counter",
        query: () => Ref.updateAndGet(counter, (n) => n + 1),
        prompt: (n) => [{ id: "p", content: String(n), priority: 50 }],
        policy: (n) => ({ include: [String(n)] }),
        ui: { project: (n) => ({ value: n }) },
      }
      const compiled = compileProjections([ext("a", "builtin", [projection])])
      yield* compiled.evaluateAll({ turn: turnCtx })
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
      const result = yield* compiled.evaluateAll({ turn: turnCtx })
      expect(result.promptSections).toHaveLength(1)
      expect(result.promptSections[0]?.content).toBe("good")
    }),
  )

  it.live("ui.schema validation rejects malformed model — snapshot omitted", () =>
    Effect.gen(function* () {
      const Schema_ = Schema.Struct({ count: Schema.Number })
      const projection: ProjectionContribution<{ count: string }> = {
        id: "typed",
        query: () => Effect.succeed({ count: "not-a-number" }),
        ui: { schema: Schema_, project: (v) => v },
      }
      const compiled = compileProjections([ext("a", "builtin", [projection])])
      const result = yield* compiled.evaluateAll({ turn: turnCtx })
      expect(result.uiSnapshots).toHaveLength(0)
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
      const result = yield* compiled.evaluateAll({ turn: turnCtx })
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
      const value = yield* compiled.query("a", "raw", { turn: turnCtx })
      expect(value).toBe("hello")
    }),
  )

  it.live("query() returns undefined for unknown projection id", () =>
    Effect.gen(function* () {
      const compiled = compileProjections([])
      const value = yield* compiled.query("a", "missing", { turn: turnCtx })
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
      const value = yield* resolved.projections.query("a", "p", { turn: turnCtx })
      expect(value).toBe(42)
    }),
  )

  // Layer satisfaction — projection R requirements come from extension layer at runtime.
  // This test demonstrates the contract holds when the layer is provided.
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
        .evaluateAll({ turn: turnCtx })
        .pipe(
          Effect.provide(Layer.succeed(Greeter, { say: () => Effect.succeed("hi from service") })),
        )
      expect(result.promptSections[0]?.content).toBe("hi from service")
    }),
  )
})
