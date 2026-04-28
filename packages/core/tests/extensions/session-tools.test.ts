/**
 * SessionToolsExtension prompt-slot behavior locks.
 *
 * The extension contributes a `systemPrompt` projection slot that injects
 * a `## Session naming` instruction for interactive prompts and skips it
 * for non-interactive ones. Test pins both branches against the
 * runtime slot compiler.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { SessionToolsExtension } from "@gent/extensions/session-tools"
import { Agents } from "@gent/extensions/all-agents"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { compileExtensionReactions } from "../../src/runtime/extensions/extension-reactions"
import { testSetupCtx } from "@gent/core/test-utils"
import { AgentName } from "@gent/core/domain/agent"
const stubCtx = {} as unknown as ExtensionHostContext
const stubProjectionCtx = {
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  cwd: "/tmp",
  home: "/tmp",
  turn: {
    sessionId: SessionId.make("test-session"),
    branchId: BranchId.make("test-branch"),
    agent: Agents["cowork"]!,
    allTools: [],
    agentName: AgentName.make("cowork"),
  },
}
describe("SessionToolsExtension", () => {
  it.live("injects naming instruction for interactive prompts", () =>
    Effect.gen(function* () {
      const contributions = yield* SessionToolsExtension.setup(testSetupCtx())
      const compiled = compileExtensionReactions([
        {
          manifest: SessionToolsExtension.manifest,
          scope: "builtin",
          sourcePath: "test",
          contributions,
        },
      ])
      const prompt = yield* compiled.resolveSystemPrompt(
        { basePrompt: "base", agent: Agents["cowork"]!, interactive: true },
        { projection: stubProjectionCtx, host: stubCtx },
      )
      expect(prompt).toContain("## Session naming")
      expect(prompt.startsWith("base")).toBe(true)
    }),
  )
  it.live("non-interactive prompts pass through unchanged", () =>
    Effect.gen(function* () {
      const contributions = yield* SessionToolsExtension.setup(testSetupCtx())
      const compiled = compileExtensionReactions([
        {
          manifest: SessionToolsExtension.manifest,
          scope: "builtin",
          sourcePath: "test",
          contributions,
        },
      ])
      const prompt = yield* compiled.resolveSystemPrompt(
        { basePrompt: "base", agent: Agents["cowork"]!, interactive: false },
        { projection: stubProjectionCtx, host: stubCtx },
      )
      expect(prompt).toBe("base")
    }),
  )
})
