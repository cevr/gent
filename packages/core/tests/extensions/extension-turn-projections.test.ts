/**
 * Projection-backed turn reaction regression locks.
 *
 * Locks the projection contract:
 *  - `resolveTurnProjection(ctx)` runs only `prompt`/`policy`-bearing projections;
 *    emits promptSections + policyFragments. `turn` is type-required.
 *  - query runs once per projection per evaluator pass
 *  - failing query / prompt / policy projector is isolated and skipped
 *  - scope precedence: builtin < user < project (later contributions appear
 *    later in result lists)
 */
import { describe, it, expect } from "effect-bun-test"
import { Context, Effect, Layer, Ref, Stream, type Schema } from "effect"
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
import { compileExtensionReactions } from "../../src/runtime/extensions/extension-reactions"
import {
  Receptionist,
  type ReceptionistService,
} from "../../src/runtime/extensions/receptionist.js"

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

// `resolveTurnProjection` requires `ActorEngine | Receptionist` so it can sample
// each registered actor's `behavior.view(state)` alongside projections.
// These tests only exercise the projection path; supplying `ActorEngine.Live`
// (which composes `Receptionist.Live` via `provideMerge`) keeps actor route
// collection a no-op when no extensions register actors.
const evalCtxLayer = ActorEngine.Live

const compile = (extensions: ReadonlyArray<LoadedExtension>) =>
  compileExtensionReactions(extensions)

describe("projection-backed turn reactions", () => {
  it.live("resolveTurnProjection queries once and runs only prompt/policy projectors", () =>
    Effect.gen(function* () {
      const counter = yield* Ref.make(0)
      const turnOnly: ProjectionContribution<{ greeting: string }> = {
        id: "greeter",
        query: () =>
          Ref.updateAndGet(counter, (n) => n + 1).pipe(Effect.map(() => ({ greeting: "hi" }))),
        prompt: (v) => [{ id: "g", content: v.greeting, priority: 50 }],
        policy: (v) => ({ include: [v.greeting] }),
      }
      const compiled = compile([ext("a", "builtin", [turnOnly])])
      const result = yield* compiled.resolveTurnProjection(turnEvalCtx)
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

      const compiled = compile([
        ext("a", "builtin", [
          { id: "bad", query: badFn, prompt: () => [{ id: "x", content: "x", priority: 1 }] },
          {
            id: "good",
            query: goodFn,
            prompt: (v) => [{ id: "g", content: v.value, priority: 50 }],
          },
        ]),
      ])
      const result = yield* compiled.resolveTurnProjection(turnEvalCtx)
      expect(result.promptSections).toHaveLength(1)
      expect(result.promptSections[0]?.content).toBe("good")
    }).pipe(Effect.provide(evalCtxLayer)),
  )

  it.live("prompt sections with same id: higher-scope shadows lower-scope (id-keyed dedup)", () =>
    // Dynamic prompt sections used to be id-keyed in the legacy
    // registry. After the Projection.prompt migration, resolveTurnProjection
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
      const compiled = compile([
        ext("a-built", "builtin", [make("p1", "builtin-content")]),
        ext("b-proj", "project", [make("p2", "project-content")]),
      ])
      const result = yield* compiled.resolveTurnProjection(turnEvalCtx)
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
        const compiled = compile([
          ext("c-proj", "project", [make("project-section")]),
          ext("a-built", "builtin", [make("builtin-section")]),
          ext("b-user", "user", [make("user-section")]),
        ])
        const result = yield* compiled.resolveTurnProjection(turnEvalCtx)
        expect(result.promptSections.map((s) => s.content)).toEqual([
          "builtin-section",
          "user-section",
          "project-section",
        ])
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
      const compiled = compile([ext("a", "builtin", [projection])])
      yield* compiled.resolveTurnProjection({
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
        const compiled = compile([ext("a", "builtin", [projection])])
        const result = yield* compiled
          .resolveTurnProjection({
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
  // policy fragments to resolveTurnProjection alongside `ProjectionContribution`.
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

      // Register the same behavior via an extension's `actorRoute` so turn
      // reactions can discover the live ref via Receptionist.
      const extension: LoadedExtension = {
        manifest: { id: ExtensionId.make("actor-view-ext") },
        scope: "builtin",
        sourcePath: "/test/actor-view-ext",
        contributions: { actorRoute: ViewKey },
      }

      const compiled = compile([extension])
      const result = yield* compiled.resolveTurnProjection(turnEvalCtx)

      const section = result.promptSections.find((s) => s.id === "actor-view-section")
      expect(section?.content).toBe("count=7")
      expect(result.policyFragments).toContainEqual({ include: ["actor-tool"] })
    }).pipe(Effect.provide(evalCtxLayer)),
  )

  it.live("actor view can be discovered from behavior.serviceKey", () =>
    Effect.gen(function* () {
      interface ViewState {
        readonly label: string
      }
      const ViewMsg = TaggedEnumClass("ImplicitRouteMsg", { Ping: {} })
      type ViewMsg = Schema.Schema.Type<typeof ViewMsg>
      const ViewKey = ServiceKey<ViewMsg>("implicit-route-view-actor")
      const viewBehavior: Behavior<ViewMsg, ViewState, never> = {
        initialState: { label: "implicit-route" },
        receive: (_msg, state) => Effect.succeed(state),
        serviceKey: ViewKey,
        view: (state) => ({
          prompt: [{ id: "implicit-route-section", content: state.label, priority: 50 }],
          toolPolicy: { include: ["implicit-route-tool"] },
        }),
      }

      const engine = yield* ActorEngine
      yield* engine.spawn(viewBehavior)

      const extension: LoadedExtension = {
        manifest: { id: ExtensionId.make("actor-view-implicit-ext") },
        scope: "builtin",
        sourcePath: "/test/actor-view-implicit-ext",
        contributions: { actors: [viewBehavior] },
      }

      const compiled = compile([extension])
      const result = yield* compiled.resolveTurnProjection(turnEvalCtx)

      expect(result.promptSections).toContainEqual({
        id: "implicit-route-section",
        content: "implicit-route",
        priority: 50,
      })
      expect(result.policyFragments).toContainEqual({ include: ["implicit-route-tool"] })
    }).pipe(Effect.provide(evalCtxLayer)),
  )

  it.live("failing actor view sampling is isolated and skipped", () =>
    Effect.gen(function* () {
      const ViewMsg = TaggedEnumClass("FailingViewMsg", { Ping: {} })
      type ViewMsg = Schema.Schema.Type<typeof ViewMsg>
      const ViewKey = ServiceKey<ViewMsg>("failing-view-actor")
      const viewBehavior: Behavior<ViewMsg, { readonly count: number }, never> = {
        initialState: { count: 1 },
        receive: (_msg, state) => Effect.succeed(state),
        serviceKey: ViewKey,
        view: () => {
          throw new Error("view boom")
        },
      }

      const engine = yield* ActorEngine
      yield* engine.spawn(viewBehavior)

      const projection: ProjectionContribution<string> = {
        id: "still-runs",
        query: () => Effect.succeed("projection-ok"),
        prompt: (value) => [{ id: "projection-section", content: value, priority: 50 }],
      }
      const extension: LoadedExtension = {
        manifest: { id: ExtensionId.make("actor-view-failing-ext") },
        scope: "builtin",
        sourcePath: "/test/actor-view-failing-ext",
        contributions: { actorRoute: ViewKey, projections: [projection] },
      }

      const compiled = compile([extension])
      const result = yield* compiled.resolveTurnProjection(turnEvalCtx)

      expect(result.promptSections).toContainEqual({
        id: "projection-section",
        content: "projection-ok",
        priority: 50,
      })
      expect(result.policyFragments).toEqual([])
    }).pipe(Effect.provide(evalCtxLayer)),
  )

  it.live("failing receptionist lookup is isolated and projection slots continue", () => {
    const failingReceptionist: Layer.Layer<Receptionist> = Layer.succeed(Receptionist, {
      register: () => Effect.void,
      unregister: () => Effect.void,
      find: () => Effect.die("find failed"),
      findOne: () => Effect.succeed(undefined),
      subscribe: () => Stream.empty,
    } satisfies ReceptionistService)
    const layer = Layer.merge(
      ActorEngine.Live.pipe(Layer.provide(failingReceptionist)),
      failingReceptionist,
    )

    return Effect.gen(function* () {
      const ViewMsg = TaggedEnumClass("FailingFindMsg", { Ping: {} })
      type ViewMsg = Schema.Schema.Type<typeof ViewMsg>
      const ViewKey = ServiceKey<ViewMsg>("failing-find-view-actor")
      const projection: ProjectionContribution<string> = {
        id: "still-runs",
        query: () => Effect.succeed("projection-ok"),
        prompt: (value) => [{ id: "projection-section", content: value, priority: 50 }],
      }
      const extension: LoadedExtension = {
        manifest: { id: ExtensionId.make("actor-view-failing-find-ext") },
        scope: "builtin",
        sourcePath: "/test/actor-view-failing-find-ext",
        contributions: { actorRoute: ViewKey, projections: [projection] },
      }

      const compiled = compile([extension])
      const result = yield* compiled.resolveTurnProjection(turnEvalCtx)

      expect(result.promptSections).toContainEqual({
        id: "projection-section",
        content: "projection-ok",
        priority: 50,
      })
      expect(result.policyFragments).toEqual([])
    }).pipe(Effect.provide(layer))
  })
})
