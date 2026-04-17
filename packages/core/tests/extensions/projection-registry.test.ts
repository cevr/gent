/**
 * ProjectionRegistry regression locks.
 *
 * Locks the projection contract:
 *  - `evaluateUi(ctx)` runs only `ui`-bearing projections; emits ExtensionUiSnapshots
 *  - `evaluateTurn(ctx)` runs only `prompt`/`policy`-bearing projections;
 *    emits promptSections + policyFragments. `turn` is type-required.
 *  - `query` runs once per projection per evaluator pass
 *  - `ui.project(value)` (with optional schema validation) emits an
 *    ExtensionUiSnapshot
 *  - failing query / prompt / policy / ui projector is isolated and skipped
 *  - scope precedence: builtin < user < project (later contributions appear
 *    later in result lists)
 *  - structural UI ownership: an extension with `actor.snapshot` cannot also
 *    contribute a `projection.ui` (demoted at compile time)
 *
 * Tied to planify Commit 2 + Commit 3 counsel revision. If projections stop
 * being read-only-derive primitives or stop respecting scope/UI ownership,
 * the substrate has regressed.
 */
import { describe, it, expect } from "effect-bun-test"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { Machine, State as MState, Event as MEvent } from "effect-machine"
import { Agents } from "@gent/extensions/all-agents"
import type {
  AnyExtensionActorDefinition,
  ExtensionTurnContext,
  LoadedExtension,
} from "@gent/core/domain/extension"
import {
  type AnyProjectionContribution,
  type ProjectionContribution,
  type ProjectionTurnContext,
  type ProjectionUiContext,
  ProjectionError,
} from "@gent/core/domain/projection"
import { resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { compileProjections } from "@gent/core/runtime/extensions/projection-registry"
import {
  projection as projectionContribution,
  workflow as workflowContribution,
} from "@gent/core/domain/contribution"

const ext = (
  id: string,
  kind: "builtin" | "user" | "project",
  projections: ReadonlyArray<AnyProjectionContribution>,
  extra?: { readonly actor?: AnyExtensionActorDefinition },
): LoadedExtension => ({
  manifest: { id },
  kind,
  sourcePath: `/test/${id}`,
  contributions: [
    ...projections.map(projectionContribution),
    ...(extra?.actor !== undefined ? [workflowContribution(extra.actor)] : []),
  ],
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

const uiEvalCtx: ProjectionUiContext = {
  sessionId: turnCtx.sessionId,
  branchId: turnCtx.branchId,
  cwd: "/tmp",
  home: "/tmp",
}

// Minimal actor stub used to exercise the actor.snapshot ↔ projection.ui
// compile-time conflict rule. The actor never runs in these tests; only its
// `snapshot` config presence is inspected.
const ActorState = MState({ Idle: { _marker: Schema.Literal("idle") } })
const ActorEvent = MEvent({ Noop: {} })
const stubActor: AnyExtensionActorDefinition = {
  machine: Machine.make({
    state: ActorState,
    event: ActorEvent,
    initial: ActorState.Idle({ _marker: "idle" as const }),
  }),
  snapshot: { project: (s: { readonly _tag: string }) => s },
} as AnyExtensionActorDefinition

describe("projection registry", () => {
  it.live("evaluateUi runs ui-bearing projections only; emits ExtensionUiSnapshot", () =>
    Effect.gen(function* () {
      const uiOnly: ProjectionContribution<{ greeting: string }> = {
        id: "greeter",
        query: () => Effect.succeed({ greeting: "hi" }),
        ui: { project: (v) => ({ rendered: v.greeting }) },
      }
      const turnOnly: ProjectionContribution<string> = {
        id: "turn-only",
        query: () => Effect.succeed("should-not-be-emitted-as-ui"),
        prompt: (v) => [{ id: "t", content: v, priority: 50 }],
      }
      const compiled = compileProjections([ext("a", "builtin", [uiOnly, turnOnly])])
      const result = yield* compiled.evaluateUi(uiEvalCtx)
      expect(result.uiSnapshots).toHaveLength(1)
      expect(result.uiSnapshots[0]?.extensionId).toBe("a")
      expect(result.uiSnapshots[0]?.model).toEqual({ rendered: "hi" })
    }),
  )

  it.live("evaluateTurn runs prompt/policy projections only; skips ui-only entries", () =>
    Effect.gen(function* () {
      let uiOnlyQueried = false
      const uiOnly: ProjectionContribution<string> = {
        id: "ui-only",
        query: () =>
          Effect.sync(() => {
            uiOnlyQueried = true
            return "x"
          }),
        ui: { project: (v) => v },
      }
      const turnOnly: ProjectionContribution<{ greeting: string }> = {
        id: "greeter",
        query: () => Effect.succeed({ greeting: "hi" }),
        prompt: (v) => [{ id: "g", content: v.greeting, priority: 50 }],
        policy: (v) => ({ include: [v.greeting] }),
      }
      const compiled = compileProjections([ext("a", "builtin", [uiOnly, turnOnly])])
      const result = yield* compiled.evaluateTurn(turnEvalCtx)
      expect(result.promptSections).toHaveLength(1)
      expect(result.promptSections[0]?.content).toBe("hi")
      expect(result.policyFragments).toEqual([{ include: ["hi"] }])
      // ui-only projection's query was NOT executed during evaluateTurn
      expect(uiOnlyQueried).toBe(false)
    }),
  )

  it.live("evaluateUi skips projections that have no ui surface", () =>
    Effect.gen(function* () {
      let promptOnlyQueried = false
      const promptOnly: ProjectionContribution<string> = {
        id: "prompt-only",
        query: () =>
          Effect.sync(() => {
            promptOnlyQueried = true
            return "x"
          }),
        prompt: () => [{ id: "p", content: "x", priority: 1 }],
      }
      const compiled = compileProjections([ext("a", "builtin", [promptOnly])])
      const result = yield* compiled.evaluateUi(uiEvalCtx)
      expect(result.uiSnapshots).toEqual([])
      // prompt-only projection's query was NOT executed during evaluateUi
      expect(promptOnlyQueried).toBe(false)
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

  it.live("ui.schema validation rejects malformed model — snapshot omitted", () =>
    Effect.gen(function* () {
      const Schema_ = Schema.Struct({ count: Schema.Number })
      const projection: ProjectionContribution<{ count: string }> = {
        id: "typed",
        query: () => Effect.succeed({ count: "not-a-number" }),
        ui: { schema: Schema_, project: (v) => v },
      }
      const compiled = compileProjections([ext("a", "builtin", [projection])])
      const result = yield* compiled.evaluateUi(uiEvalCtx)
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

  it.live(
    "ui collisions: only one ui-bearing projection per extension; later ones lose ui surface",
    () =>
      Effect.gen(function* () {
        const winner: ProjectionContribution<string> = {
          id: "winner",
          query: () => Effect.succeed("first"),
          ui: { project: (v) => ({ kind: "winner", v }) },
        }
        const demoted: ProjectionContribution<string> = {
          id: "demoted",
          query: () => Effect.succeed("second"),
          prompt: (v) => [{ id: "p", content: v, priority: 50 }],
          ui: { project: (v) => ({ kind: "demoted", v }) },
        }
        const compiled = compileProjections([ext("a", "builtin", [winner, demoted])])
        expect(compiled.uiCollisions).toEqual([
          { extensionId: "a", projectionId: "demoted", reason: "duplicate-projection-ui" },
        ])
        const uiResult = yield* compiled.evaluateUi(uiEvalCtx)
        expect(uiResult.uiSnapshots).toHaveLength(1)
        expect(uiResult.uiSnapshots[0]?.model).toEqual({ kind: "winner", v: "first" })
        // Demoted projection's prompt still fires on the turn path
        const turnResult = yield* compiled.evaluateTurn(turnEvalCtx)
        expect(turnResult.promptSections).toHaveLength(1)
        expect(turnResult.promptSections[0]?.content).toBe("second")
      }),
  )

  it.live("ui ownership: actor.snapshot wins — projection.ui demoted on the same extension", () =>
    Effect.gen(function* () {
      const projUi: ProjectionContribution<string> = {
        id: "from-projection",
        query: () => Effect.succeed("derived"),
        prompt: (v) => [{ id: "p", content: v, priority: 50 }],
        ui: { project: (v) => ({ from: "projection", v }) },
      }
      const compiled = compileProjections([ext("a", "builtin", [projUi], { actor: stubActor })])
      expect(compiled.uiCollisions).toEqual([
        { extensionId: "a", projectionId: "from-projection", reason: "actor-snapshot-owns-ui" },
      ])
      // No projection UI snapshot is emitted — actor.snapshot owns the surface.
      const uiResult = yield* compiled.evaluateUi(uiEvalCtx)
      expect(uiResult.uiSnapshots).toEqual([])
      // Prompt surface still works (only ui was demoted).
      const turnResult = yield* compiled.evaluateTurn(turnEvalCtx)
      expect(turnResult.promptSections).toHaveLength(1)
      expect(turnResult.promptSections[0]?.content).toBe("derived")
    }),
  )

  it.live("ui collisions: project scope wins UI when same extension id appears twice", () =>
    Effect.gen(function* () {
      const builtinUi: ProjectionContribution<string> = {
        id: "ui",
        query: () => Effect.succeed("from-builtin"),
        ui: { project: (v) => ({ from: v }) },
      }
      const projectUi: ProjectionContribution<string> = {
        id: "ui",
        query: () => Effect.succeed("from-project"),
        ui: { project: (v) => ({ from: v }) },
      }
      const compiled = compileProjections([
        ext("shared", "builtin", [builtinUi]),
        ext("shared", "project", [projectUi]),
      ])
      const result = yield* compiled.evaluateUi(uiEvalCtx)
      expect(result.uiSnapshots).toHaveLength(1)
      expect(result.uiSnapshots[0]?.model).toEqual({ from: "from-project" })
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
