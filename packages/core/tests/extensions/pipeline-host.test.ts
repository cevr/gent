/**
 * Runtime slot legacy pipeline locks.
 *
 * `compileRuntimeSlots` owns the remaining pipeline-shim composition algorithm.
 * These tests pin its behavior:
 *   - empty registry no-ops to the base
 *   - chains compose left-fold inside-out (last registered is outermost)
 *
 * Scope ordering is covered separately in `scope-precedence.test.ts`.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { Agents } from "@gent/extensions/all-agents"
import type { LoadedExtension } from "@gent/core/domain/extension"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { compileRuntimeSlots } from "@gent/core/runtime/extensions/runtime-slots"
import { pipeline } from "@gent/core/domain/contribution"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"

const stubCtx = {
  sessionId: "test-session",
  branchId: "test-branch",
  cwd: "/tmp",
  home: "/tmp",
} as unknown as ExtensionHostContext

const stubProjectionCtx = {
  sessionId: SessionId.of("test-session"),
  branchId: BranchId.of("test-branch"),
  cwd: "/tmp",
  home: "/tmp",
  turn: {
    sessionId: SessionId.of("test-session"),
    branchId: BranchId.of("test-branch"),
    agent: Agents.cowork,
    allTools: [],
    agentName: "cowork",
  },
}

const ext = (
  id: string,
  kind: "builtin" | "user" | "project",
  pipelines: ReturnType<typeof pipeline>[],
): LoadedExtension => ({
  manifest: { id },
  kind,
  sourcePath: `/test/${id}`,
  contributions: { pipelines },
})

describe("runtime slots — legacy pipeline shim", () => {
  it.live("composes scope-ordered chain inside-out (builtin innermost)", () =>
    Effect.gen(function* () {
      const make = (label: string) =>
        pipeline("prompt.system", (input, next) =>
          next(input).pipe(Effect.map((s) => `${s}[${label}]`)),
        )

      const extensions = [
        ext("a", "builtin", [make("builtin")]),
        ext("b", "user", [make("user")]),
        ext("c", "project", [make("project")]),
      ]

      const facade = compileRuntimeSlots(extensions)
      const result = yield* facade.resolveSystemPrompt(
        { basePrompt: "x", agent: Agents.cowork },
        { projection: stubProjectionCtx, host: stubCtx },
      )
      expect(result).toBe("x[builtin][user][project]")
    }),
  )

  it.live("empty registry is a no-op (returns base output)", () =>
    Effect.gen(function* () {
      const facade = compileRuntimeSlots([])
      const result = yield* facade.resolveSystemPrompt(
        { basePrompt: "x", agent: Agents.cowork },
        { projection: stubProjectionCtx, host: stubCtx },
      )
      expect(result).toBe("x")
    }),
  )
})
