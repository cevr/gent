import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { Agents } from "@gent/extensions/all-agents"
import type { LoadedExtension } from "../../src/domain/extension.js"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { compileRuntimeSlots } from "@gent/core/runtime/extensions/runtime-slots"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"

const stubHostCtx = {
  sessionId: "test-session",
  branchId: "test-branch",
  cwd: "/tmp",
  home: "/tmp",
} as unknown as ExtensionHostContext

const stubProjectionCtx = {
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  cwd: "/tmp",
  home: "/tmp",
  turn: {
    sessionId: SessionId.make("test-session"),
    branchId: BranchId.make("test-branch"),
    agent: Agents.cowork,
    allTools: [],
    agentName: "cowork",
  },
}

const ext = (
  id: string,
  scope: "builtin" | "user" | "project",
  suffix: string,
): LoadedExtension => ({
  manifest: { id },
  scope,
  sourcePath: `/test/${id}`,
  contributions: {
    projections: [
      {
        id: `prompt-${id}`,
        query: () => Effect.succeed(suffix),
        systemPrompt: (value, input) => Effect.succeed(`${input.basePrompt}${value}`),
      },
    ],
  },
})

describe("prompt slots", () => {
  it.live("compose in scope order: builtin then user then project", () => {
    const compiled = compileRuntimeSlots([
      ext("p", "project", "[project]"),
      ext("a", "builtin", "[builtin]"),
      ext("u", "user", "[user]"),
    ])

    return compiled
      .resolveSystemPrompt(
        { basePrompt: "x", agent: Agents.cowork },
        { projection: stubProjectionCtx, host: stubHostCtx },
      )
      .pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("x[builtin][user][project]"))),
      )
  })

  it.live("empty projection registry is a no-op", () =>
    compileRuntimeSlots([])
      .resolveSystemPrompt(
        { basePrompt: "x", agent: Agents.cowork },
        { projection: stubProjectionCtx, host: stubHostCtx },
      )
      .pipe(Effect.tap((result) => Effect.sync(() => expect(result).toBe("x")))),
  )
})
