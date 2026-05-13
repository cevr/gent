import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { BunServices } from "@effect/platform-bun"
import { getBuiltinAgent } from "../../../extensions/tests/helpers/builtin-agents.js"
import type { LoadedExtension } from "../../src/domain/extension.js"
import { hook } from "../../src/domain/extension.js"
import { BranchId, ExtensionId, SessionId } from "@gent/core-internal/domain/ids"
import { compileExtensionHooks } from "../../src/runtime/extensions/extension-hooks"
import { provideExtensionHookContext } from "../../src/runtime/extensions/extension-hook-context"
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
    hooks: [hook.systemPrompt((input) => Effect.succeed(`${input.basePrompt}${suffix}`))],
  },
})

describe("prompt slots", () => {
  const test = it.live.layer(BunServices.layer)

  test("compose in scope order: builtin then user then project", () => {
    const compiled = compileExtensionHooks([
      ext("p", "project", "[project]"),
      ext("a", "builtin", "[builtin]"),
      ext("u", "user", "[user]"),
    ])

    return compiled
      .resolveSystemPrompt({ basePrompt: "x", agent: getBuiltinAgent("cowork")! })
      .pipe(
        provideExtensionHookContext({ projection: stubProjectionCtx, host: stubHostCtx }),
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("x[builtin][user][project]"))),
      )
  })

  test("empty turn hooks are a no-op", () =>
    compileExtensionHooks([])
      .resolveSystemPrompt({ basePrompt: "x", agent: getBuiltinAgent("cowork")! })
      .pipe(
        provideExtensionHookContext({ projection: stubProjectionCtx, host: stubHostCtx }),
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("x"))),
      ))
})
