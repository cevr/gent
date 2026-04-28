/**
 * Explicit turn-projection reaction regression locks.
 *
 * Locks the explicit turn-projection contract:
 *  - `reactions.turnProjection(ctx)` contributes prompt sections + tool policy
 *  - failures/defects are isolated so later extensions still run
 *  - actor `behavior.view(state)` contributes the same surfaces
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer, Stream, type Schema } from "effect"
import { Agents } from "@gent/extensions/all-agents"
import { type Behavior, ServiceKey } from "@gent/core/domain/actor"
import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class"
import type { ExtensionTurnContext, LoadedExtension } from "../../src/domain/extension.js"
import { ExtensionId } from "@gent/core/domain/ids"
import { behavior, ProjectionError, type ProjectionTurnContext } from "@gent/core/extensions/api"
import { ActorEngine } from "../../src/runtime/extensions/actor-engine.js"
import { compileExtensionReactions } from "../../src/runtime/extensions/extension-reactions"
import {
  Receptionist,
  type ReceptionistService,
} from "../../src/runtime/extensions/receptionist.js"

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

const evalCtxLayer = ActorEngine.Live

const compile = (extensions: ReadonlyArray<LoadedExtension>) =>
  compileExtensionReactions(extensions)

const reactionExt = (
  id: string,
  scope: "builtin" | "user" | "project",
  contribution: NonNullable<LoadedExtension["contributions"]["reactions"]>["turnProjection"],
): LoadedExtension => ({
  manifest: { id: ExtensionId.make(id) },
  scope,
  sourcePath: `/test/${id}`,
  contributions: {
    reactions: {
      turnProjection: contribution,
    },
  },
})

describe("turn projection reactions", () => {
  it.live("contribute prompt sections and tool policy in scope order", () =>
    Effect.gen(function* () {
      const compiled = compile([
        reactionExt("builtin-reaction", "builtin", () =>
          Effect.succeed({
            promptSections: [{ id: "shared", content: "builtin", priority: 50 }],
            toolPolicy: { include: ["builtin-tool"] },
          }),
        ),
        reactionExt("project-reaction", "project", () =>
          Effect.succeed({
            promptSections: [
              { id: "shared", content: "project", priority: 50 },
              { id: "project-only", content: "project-only", priority: 60 },
            ],
            toolPolicy: { exclude: ["project-blocked"] },
          }),
        ),
      ])

      const result = yield* compiled.resolveTurnProjection(turnEvalCtx)
      expect(result.promptSections).toEqual([
        { id: "shared", content: "project", priority: 50 },
        { id: "project-only", content: "project-only", priority: 60 },
      ])
      expect(result.policyFragments).toEqual([
        { include: ["builtin-tool"] },
        { exclude: ["project-blocked"] },
      ])
    }).pipe(Effect.provide(evalCtxLayer)),
  )

  it.live("failing reaction is logged + skipped while later reactions continue", () =>
    Effect.gen(function* () {
      const compiled = compile([
        reactionExt("bad-reaction", "builtin", () =>
          Effect.fail(new ProjectionError({ projectionId: "bad", reason: "boom" })),
        ),
        reactionExt("good-reaction", "project", () =>
          Effect.succeed({
            promptSections: [{ id: "good", content: "still-runs", priority: 50 }],
            toolPolicy: { include: ["still-runs"] },
          }),
        ),
      ])

      const result = yield* compiled.resolveTurnProjection(turnEvalCtx)
      expect(result.promptSections).toEqual([{ id: "good", content: "still-runs", priority: 50 }])
      expect(result.policyFragments).toEqual([{ include: ["still-runs"] }])
    }).pipe(Effect.provide(evalCtxLayer)),
  )

  it.live("defecting reaction is logged + skipped", () =>
    Effect.gen(function* () {
      const compiled = compile([
        reactionExt("defect-reaction", "builtin", () =>
          Effect.sync(() => {
            throw new Error("defect")
          }),
        ),
        reactionExt("good-reaction", "project", () =>
          Effect.succeed({
            promptSections: [{ id: "good", content: "after-defect", priority: 50 }],
          }),
        ),
      ])

      const result = yield* compiled.resolveTurnProjection(turnEvalCtx)
      expect(result.promptSections).toEqual([{ id: "good", content: "after-defect", priority: 50 }])
      expect(result.policyFragments).toEqual([])
    }).pipe(Effect.provide(evalCtxLayer)),
  )

  it.live("empty reaction result does not affect prompt sections or policy", () =>
    Effect.gen(function* () {
      const compiled = compile([reactionExt("empty-reaction", "builtin", () => Effect.succeed({}))])

      const result = yield* compiled.resolveTurnProjection(turnEvalCtx)
      expect(result.promptSections).toEqual([])
      expect(result.policyFragments).toEqual([])
    }).pipe(Effect.provide(evalCtxLayer)),
  )

  it.live("actor view contributes prompt sections + policy alongside reactions", () =>
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

      const extension: LoadedExtension = {
        manifest: { id: ExtensionId.make("actor-view-ext") },
        scope: "builtin",
        sourcePath: "/test/actor-view-ext",
        contributions: { actors: [behavior(viewBehavior)] },
      }

      const compiled = compile([
        reactionExt("reaction-ext", "builtin", () =>
          Effect.succeed({
            promptSections: [{ id: "reaction-section", content: "reaction", priority: 40 }],
          }),
        ),
        extension,
      ])
      const result = yield* compiled.resolveTurnProjection(turnEvalCtx)

      expect(result.promptSections).toContainEqual({
        id: "reaction-section",
        content: "reaction",
        priority: 40,
      })
      expect(result.promptSections).toContainEqual({
        id: "actor-view-section",
        content: "count=7",
        priority: 50,
      })
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

      const extension: LoadedExtension = {
        manifest: { id: ExtensionId.make("actor-view-failing-ext") },
        scope: "builtin",
        sourcePath: "/test/actor-view-failing-ext",
        contributions: { actors: [behavior(viewBehavior)] },
      }

      const compiled = compile([extension])
      const result = yield* compiled.resolveTurnProjection(turnEvalCtx)

      expect(result.promptSections).toEqual([])
      expect(result.policyFragments).toEqual([])
    }).pipe(Effect.provide(evalCtxLayer)),
  )

  it.live("failing receptionist lookup is isolated", () => {
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
      const extension: LoadedExtension = {
        manifest: { id: ExtensionId.make("actor-view-failing-find-ext") },
        scope: "builtin",
        sourcePath: "/test/actor-view-failing-find-ext",
        contributions: {
          actors: [
            behavior({
              initialState: {},
              receive: () => Effect.succeed({}),
              serviceKey: ViewKey,
            }),
          ],
        },
      }

      const compiled = compile([extension])
      const result = yield* compiled.resolveTurnProjection(turnEvalCtx)

      expect(result.promptSections).toEqual([])
      expect(result.policyFragments).toEqual([])
    }).pipe(Effect.provide(layer))
  })
})
