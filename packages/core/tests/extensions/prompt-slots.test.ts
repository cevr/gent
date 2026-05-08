import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { getBuiltinAgent } from "../../../extensions/tests/helpers/builtin-agents.js"
import type { LoadedExtension } from "../../src/domain/extension.js"
import { BranchId, ExtensionId, SessionId } from "@gent/core-internal/domain/ids"
import { compileExtensionReactions } from "../../src/runtime/extensions/extension-reactions"
import { testExtensionHostContext } from "@gent/core-internal/test-utils"
import { AgentName } from "@gent/core-internal/domain/agent"

const stubHostCtx = testExtensionHostContext()

const stubProjectionCtx = {
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  cwd: "/tmp",
  home: "/tmp",
  turn: {
    sessionId: SessionId.make("test-session"),
    branchId: BranchId.make("test-branch"),
    agent: getBuiltinAgent("cowork")!,
    allTools: [],
    agentName: AgentName.make("cowork"),
  },
}

const ext = (
  id: string,
  scope: "builtin" | "user" | "project",
  suffix: string,
): LoadedExtension => ({
  manifest: { id: ExtensionId.make(id) },
  scope,
  sourcePath: `/test/${id}`,
  contributions: {
    reactions: {
      systemPrompt: (input) => Effect.succeed(`${input.basePrompt}${suffix}`),
    },
  },
})

describe("prompt slots", () => {
  it.live("compose in scope order: builtin then user then project", () => {
    const compiled = compileExtensionReactions([
      ext("p", "project", "[project]"),
      ext("a", "builtin", "[builtin]"),
      ext("u", "user", "[user]"),
    ])

    return compiled
      .resolveSystemPrompt(
        { basePrompt: "x", agent: getBuiltinAgent("cowork")! },
        { projection: stubProjectionCtx, host: stubHostCtx },
      )
      .pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("x[builtin][user][project]"))),
      )
  })

  it.live("empty turn reactions are a no-op", () =>
    compileExtensionReactions([])
      .resolveSystemPrompt(
        { basePrompt: "x", agent: getBuiltinAgent("cowork")! },
        { projection: stubProjectionCtx, host: stubHostCtx },
      )
      .pipe(Effect.tap((result) => Effect.sync(() => expect(result).toBe("x")))),
  )
})
