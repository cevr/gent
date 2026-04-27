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
import { Context, Effect, Layer, Ref, type Schema } from "effect"
import { Agents } from "@gent/extensions/all-agents"
import { type Behavior, ServiceKey } from "@gent/core/domain/actor"
import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class"
import type { ExtensionTurnContext, LoadedExtension } from "../../src/domain/extension.js"
import { ExtensionId } from "@gent/core/domain/ids"
import {
  type AnyProjectionContribution,
  type ProjectionContribution,
  type ProjectionTurnContext,
  ProjectionError,
} from "@gent/core/domain/projection"
import { type ReadOnly, ReadOnlyBrand, withReadOnly } from "@gent/core/domain/read-only"
import { ActorEngine } from "../../src/runtime/extensions/actor-engine.js"
import { compileProjections } from "../../src/runtime/extensions/projection-registry"

const ext = (
  id: string,
  scope: "builtin" | "user" | "project",
  projections: ReadonlyArray<AnyProjectionContribution>,
): LoadedExtension => ({
  manifest: { id: ExtensionId.make(id) },
  scope,
  sourcePath: `/test/${id}`,
  contributions: { projections },
})

const turnCtx: ExtensionTurnContext = {
  sessionId: "s" as ExtensionTurnContext["sessionId"],
  branchId: "b" as ExtensionTurnContext["branchId"],
  agent: Agents["cowork"],
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

// `evaluateTurn` now requires `ActorEngine | Receptionist` so it can sample
// each registered actor's `behavior.view(state)` alongside projections.
// These tests only exercise the projection path; supplying `ActorEngine.Live`
// (which composes `Receptionist.Live` via `provideMerge`) keeps actor route
// collection a no-op when no extensions register actors.
const evalCtxLayer = ActorEngine.Live

describe("projection registry", () => {
  it.live("evaluateTurn queries once and runs only prompt/policy projectors", () =>
    Effect.gen(function* () {
      const counter = yield* Ref.make(0)
      const turnOnly: ProjectionContribution<{ greeting: string }> = {
        id: "greeter",
        query: () =>
          Ref.updateAndGet(counter, (n) => n + 1).pipe(Effect.map(() => ({ greeting: "hi" }))),
        prompt: (v) => [{ id: "g", content: v.greeting, priority: 50 }],
        policy: (v) => ({ include: [v.greeting] }),
      }
      const compiled = compileProjections([ext("a", "builtin", [turnOnly])])
      const result = yield* compiled.evaluateTurn(turnEvalCtx)
      expect(yield* Ref.get(counter)).toBe(1)
      expect(result.promptSections).toHaveLength(1)
      expect(result.promptSections[0]?.content).toBe("hi")
      expect(result.policyFragments).toEqual([{ include: ["hi"] }])
    }).pipe(Effect.provide(evalCtxLayer)),
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
    }).pipe(Effect.provide(evalCtxLayer)),
  )

  it.live("prompt sections with same id: higher-scope shadows lower-scope (id-keyed dedup)", () =>
    // Dynamic prompt sections used to be id-keyed in the legacy
    // registry. After the Projection.prompt migration, evaluateTurn
    // now dedups by section id with last-write-wins (entries scope-sorted
    // builtin → user → project).
    Effect.gen(function* () {
      const make = (id: string, content: string): AnyProjectionContribution => ({
        id,
        query: () => Effect.succeed(content),
        // Two projections emit a section with the SAME id — only the
        // higher-scope one should survive.
        prompt: (v) => [{ id: "shared-id", content: String(v), priority: 50 }],
      })
      const compiled = compileProjections([
        ext("a-built", "builtin", [make("p1", "builtin-content")]),
        ext("b-proj", "project", [make("p2", "project-content")]),
      ])
      const result = yield* compiled.evaluateTurn(turnEvalCtx)
      expect(result.promptSections).toHaveLength(1)
      expect(result.promptSections[0]?.content).toBe("project-content")
    }).pipe(Effect.provide(evalCtxLayer)),
  )

  it.live(
    "scope precedence preserves builtin → user → project order for distinct prompt sections",
    () =>
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
      }).pipe(Effect.provide(evalCtxLayer)),
  )

  it.live("query yields the highest-precedence value, or undefined for missing ids", () =>
    Effect.gen(function* () {
      const builtin: ProjectionContribution<string> = {
        id: "raw",
        query: () => Effect.succeed("builtin"),
      }
      const project: ProjectionContribution<string> = {
        id: "raw",
        query: () => Effect.succeed("project"),
      }
      const compiled = compileProjections([
        ext("shared", "builtin", [builtin]),
        ext("shared", "project", [project]),
      ])
      const hit = yield* compiled.query(ExtensionId.make("shared"), "raw", turnEvalCtx)
      const miss = yield* compiled.query(ExtensionId.make("shared"), "missing", turnEvalCtx)
      expect(hit).toBe("project")
      expect(miss).toBeUndefined()
    }).pipe(Effect.provide(evalCtxLayer)),
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
    }).pipe(Effect.provide(evalCtxLayer)),
  )

  it.live(
    "projection query reads context and service dependencies when the layer is composed",
    () =>
      Effect.gen(function* () {
        // ReadOnly-branded service Tag — required by `ProjectionContribution<A, R extends ReadOnlyTag>`.
        interface GreeterShape {
          readonly say: () => Effect.Effect<string>
        }
        class Greeter extends Context.Service<Greeter, ReadOnly<GreeterShape>>()("test/Greeter") {
          declare readonly [ReadOnlyBrand]: true
        }

        const projection: ProjectionContribution<string, Greeter> = {
          id: "greeter",
          query: (ctx) =>
            Effect.gen(function* () {
              const g = yield* Greeter
              return `${ctx.sessionCwd}:${yield* g.say()}`
            }),
          prompt: (v) => [{ id: "g", content: v, priority: 50 }],
        }
        const compiled = compileProjections([ext("a", "builtin", [projection])])
        const result = yield* compiled
          .evaluateTurn({
            ...turnEvalCtx,
            cwd: "/proj",
            home: "/home/test",
            sessionCwd: "/proj/feature",
          })
          .pipe(
            Effect.provide(
              Layer.succeed(
                Greeter,
                withReadOnly({
                  say: () => Effect.succeed("hi from service"),
                } satisfies GreeterShape),
              ),
            ),
          )
        expect(result.promptSections[0]?.content).toBe("/proj/feature:hi from service")
      }).pipe(Effect.provide(evalCtxLayer)),
  )

  // W10-2a.2: actor `behavior.view(state)` contributes prompt sections + tool
  // policy fragments to evaluateTurn alongside `ProjectionContribution`.
  // Routes are picked off either an explicit `actorRoute` on the extension
  // or the `serviceKey` on a behavior in the `actors:` bucket; the engine's
  // `peekView` samples each live actor's view at the post-receive state.
  it.live("actor view contributes prompt sections + policy alongside projections", () =>
    Effect.gen(function* () {
      interface ViewState {
        readonly count: number
      }
      const ViewMsg = TaggedEnumClass("ProjViewMsg", { Inc: {} })
      type ViewMsg = Schema.Schema.Type<typeof ViewMsg>
      const ViewKey = ServiceKey<ViewMsg>("proj-view-actor")
      const viewBehavior: Behavior<ViewMsg, ViewState, never> = {
        initialState: { count: 7 },
        receive: (_msg, state) =>
          Effect.succeed({ count: state.count + 1 }) as Effect.Effect<ViewState, never, never>,
        serviceKey: ViewKey,
        view: (state) => ({
          prompt: [{ id: "actor-view-section", content: `count=${state.count}`, priority: 50 }],
          toolPolicy: { include: ["actor-tool"] },
        }),
      }

      const engine = yield* ActorEngine
      yield* engine.spawn(viewBehavior)

      // Register the same behavior via an extension's `actorRoute` so the
      // projection registry can discover the live ref via Receptionist.
      const extension: LoadedExtension = {
        manifest: { id: ExtensionId.make("actor-view-ext") },
        scope: "builtin",
        sourcePath: "/test/actor-view-ext",
        contributions: { actorRoute: ViewKey },
      }

      const compiled = compileProjections([extension])
      const result = yield* compiled.evaluateTurn(turnEvalCtx)

      const section = result.promptSections.find((s) => s.id === "actor-view-section")
      expect(section?.content).toBe("count=7")
      expect(result.policyFragments).toContainEqual({ include: ["actor-tool"] })
    }).pipe(Effect.provide(evalCtxLayer)),
  )
})
