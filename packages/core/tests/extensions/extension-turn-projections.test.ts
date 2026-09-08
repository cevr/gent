/**
 * Explicit turn-projection hook regression locks.
 *
 * Locks the explicit turn-projection contract:
 *  - `hook("turnProjection", handler)` contributes prompt sections + tool policy
 *  - failures/defects are isolated so later extensions still run
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { BunServices } from "@effect/platform-bun"
import { builtinAgent } from "../../../extensions/tests/helpers/builtin-agents.js"
import type {
  ExtensionHookHandler,
  ExtensionTurnContext,
  LoadedExtension,
  ProjectionTurnContext,
} from "../../src/domain/extension.js"
import { hook } from "../../src/domain/extension.js"
import { BranchId, SessionId, ExtensionId } from "@gent/core-internal/domain/ids"
import { ProjectionError } from "@gent/core/extensions/api"
import { compileExtensionHooks } from "../../src/runtime/extensions/extension-hooks"
import { CurrentExtensionHostContext } from "../../src/runtime/agent/current-extension-host-context"
import { testExtensionHostContext } from "@gent/core-internal/test-utils"

const turnCtx: ExtensionTurnContext = {
  sessionId: SessionId.make("s"),
  branchId: BranchId.make("b"),
  agent: builtinAgent,
  allTools: [],
  interactive: true,
}

const turnEvalCtx: ProjectionTurnContext = {
  sessionId: turnCtx.sessionId,
  branchId: turnCtx.branchId,
  cwd: "/tmp",
  home: "/tmp",
  turn: turnCtx,
}
const hookCtx = {
  projection: turnEvalCtx,
  host: testExtensionHostContext({
    sessionId: turnCtx.sessionId,
    branchId: turnCtx.branchId,
    cwd: turnEvalCtx.cwd,
    home: turnEvalCtx.home,
  }),
}

const compile = (extensions: ReadonlyArray<LoadedExtension>) => compileExtensionHooks(extensions)

const hookExt = <E, R>(
  id: string,
  scope: "builtin" | "user" | "project",
  contribution: ExtensionHookHandler<"turnProjection", E, R>,
): LoadedExtension => ({
  manifest: { id: ExtensionId.make(id) },
  scope,
  sourcePath: `/test/${id}`,
  contributions: {
    hooks: [hook("turnProjection", contribution)],
  },
})

describe("turn projection hooks", () => {
  const test = it.live.layer(BunServices.layer)

  test("contribute prompt sections and tool policy in scope order", () =>
    Effect.gen(function* () {
      const compiled = compile([
        hookExt("builtin-hook", "builtin", () =>
          Effect.succeed({
            promptSections: [{ id: "shared", content: "builtin", priority: 50 }],
            toolPolicy: { include: ["builtin-tool"] },
          }),
        ),
        hookExt("project-hook", "project", () =>
          Effect.succeed({
            promptSections: [
              { id: "shared", content: "project", priority: 50 },
              { id: "project-only", content: "project-only", priority: 60 },
            ],
            toolPolicy: { exclude: ["project-blocked"] },
          }),
        ),
      ])

      const result = yield* compiled
        .resolveTurnProjection(hookCtx.projection)
        .pipe(Effect.provideService(CurrentExtensionHostContext, hookCtx.host))
      expect(result.promptSections).toEqual([
        { id: "shared", content: "project", priority: 50 },
        { id: "project-only", content: "project-only", priority: 60 },
      ])
      expect(result.policyFragments).toEqual([
        { include: ["builtin-tool"] },
        { exclude: ["project-blocked"] },
      ])
    }))

  test("failing hook is logged + skipped while later hooks continue", () =>
    Effect.gen(function* () {
      const compiled = compile([
        hookExt("bad-hook", "builtin", () =>
          Effect.fail(new ProjectionError({ projectionId: "bad", reason: "boom" })),
        ),
        hookExt("good-hook", "project", () =>
          Effect.succeed({
            promptSections: [{ id: "good", content: "still-runs", priority: 50 }],
            toolPolicy: { include: ["still-runs"] },
          }),
        ),
      ])

      const result = yield* compiled
        .resolveTurnProjection(hookCtx.projection)
        .pipe(Effect.provideService(CurrentExtensionHostContext, hookCtx.host))
      expect(result.promptSections).toEqual([{ id: "good", content: "still-runs", priority: 50 }])
      expect(result.policyFragments).toEqual([{ include: ["still-runs"] }])
    }))

  test("defecting hook is logged + skipped", () =>
    Effect.gen(function* () {
      const compiled = compile([
        hookExt("defect-hook", "builtin", () => Effect.die(new Error("defect"))),
        hookExt("good-hook", "project", () =>
          Effect.succeed({
            promptSections: [{ id: "good", content: "after-defect", priority: 50 }],
          }),
        ),
      ])

      const result = yield* compiled
        .resolveTurnProjection(hookCtx.projection)
        .pipe(Effect.provideService(CurrentExtensionHostContext, hookCtx.host))
      expect(result.promptSections).toEqual([{ id: "good", content: "after-defect", priority: 50 }])
      expect(result.policyFragments).toEqual([])
    }))

  test("empty hook result does not affect prompt sections or policy", () =>
    Effect.gen(function* () {
      const compiled = compile([hookExt("empty-hook", "builtin", () => Effect.succeed({}))])

      const result = yield* compiled
        .resolveTurnProjection(hookCtx.projection)
        .pipe(Effect.provideService(CurrentExtensionHostContext, hookCtx.host))
      expect(result.promptSections).toEqual([])
      expect(result.policyFragments).toEqual([])
    }))
})
