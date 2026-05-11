/**
 * Explicit turn-projection reaction regression locks.
 *
 * Locks the explicit turn-projection contract:
 *  - `reactions.turnProjection()` contributes prompt sections + tool policy
 *  - failures/defects are isolated so later extensions still run
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { BunServices } from "@effect/platform-bun"
import { getBuiltinAgent } from "../../../extensions/tests/helpers/builtin-agents.js"
import type {
  ExtensionTurnContext,
  LoadedExtension,
  ProjectionTurnContext,
} from "../../src/domain/extension.js"
import { ExtensionId } from "@gent/core-internal/domain/ids"
import { ProjectionError } from "@gent/core/extensions/api"
import { compileExtensionReactions } from "../../src/runtime/extensions/extension-reactions"
import { testExtensionHostContext } from "@gent/core-internal/test-utils"

const turnCtx: ExtensionTurnContext = {
  sessionId: "s" as ExtensionTurnContext["sessionId"],
  branchId: "b" as ExtensionTurnContext["branchId"],
  agent: getBuiltinAgent("cowork"),
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
const reactionCtx = {
  projection: turnEvalCtx,
  host: testExtensionHostContext({
    sessionId: turnCtx.sessionId,
    branchId: turnCtx.branchId,
    cwd: turnEvalCtx.cwd,
    home: turnEvalCtx.home,
  }),
}

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
  const test = it.live.layer(BunServices.layer)

  test("contribute prompt sections and tool policy in scope order", () =>
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

      const result = yield* compiled.resolveTurnProjection(reactionCtx)
      expect(result.promptSections).toEqual([
        { id: "shared", content: "project", priority: 50 },
        { id: "project-only", content: "project-only", priority: 60 },
      ])
      expect(result.policyFragments).toEqual([
        { include: ["builtin-tool"] },
        { exclude: ["project-blocked"] },
      ])
    }))

  test("failing reaction is logged + skipped while later reactions continue", () =>
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

      const result = yield* compiled.resolveTurnProjection(reactionCtx)
      expect(result.promptSections).toEqual([{ id: "good", content: "still-runs", priority: 50 }])
      expect(result.policyFragments).toEqual([{ include: ["still-runs"] }])
    }))

  test("defecting reaction is logged + skipped", () =>
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

      const result = yield* compiled.resolveTurnProjection(reactionCtx)
      expect(result.promptSections).toEqual([{ id: "good", content: "after-defect", priority: 50 }])
      expect(result.policyFragments).toEqual([])
    }))

  test("empty reaction result does not affect prompt sections or policy", () =>
    Effect.gen(function* () {
      const compiled = compile([reactionExt("empty-reaction", "builtin", () => Effect.succeed({}))])

      const result = yield* compiled.resolveTurnProjection(reactionCtx)
      expect(result.promptSections).toEqual([])
      expect(result.policyFragments).toEqual([])
    }))
})
