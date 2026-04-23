/**
 * SessionToolsExtension prompt-slot behavior locks.
 *
 * The extension contributes a `systemPrompt` projection slot that injects
 * a `## Session naming` instruction for interactive prompts and skips it
 * for non-interactive ones. Test pins both branches against the
 * runtime slot compiler.
 */
import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { SessionToolsExtension } from "@gent/extensions/session-tools"
import { Agents } from "@gent/extensions/all-agents"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { compileRuntimeSlots } from "@gent/core/runtime/extensions/runtime-slots"
import { testSetupCtx } from "@gent/core/test-utils"

const stubCtx = {} as unknown as ExtensionHostContext
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

describe("SessionToolsExtension", () => {
  test("injects naming instruction for interactive prompts", async () => {
    const contributions = await Effect.runPromise(SessionToolsExtension.setup(testSetupCtx()))
    const compiled = compileRuntimeSlots([
      {
        manifest: SessionToolsExtension.manifest,
        scope: "builtin",
        sourcePath: "test",
        contributions,
      },
    ])

    const prompt = await Effect.runPromise(
      compiled.resolveSystemPrompt(
        { basePrompt: "base", agent: Agents.cowork, interactive: true },
        { projection: stubProjectionCtx, host: stubCtx },
      ),
    )

    expect(prompt).toContain("## Session naming")
    expect(prompt.startsWith("base")).toBe(true)
  })

  test("non-interactive prompts pass through unchanged", async () => {
    const contributions = await Effect.runPromise(SessionToolsExtension.setup(testSetupCtx()))
    const compiled = compileRuntimeSlots([
      {
        manifest: SessionToolsExtension.manifest,
        scope: "builtin",
        sourcePath: "test",
        contributions,
      },
    ])

    const prompt = await Effect.runPromise(
      compiled.resolveSystemPrompt(
        { basePrompt: "base", agent: Agents.cowork, interactive: false },
        { projection: stubProjectionCtx, host: stubCtx },
      ),
    )

    expect(prompt).toBe("base")
  })
})
