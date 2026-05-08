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
import { getBuiltinAgent } from "@gent/extensions/all-agents"
import type { SystemPromptInput } from "@gent/core/extensions/api"
import { testExtensionHostContext, testSetupCtx } from "@gent/core-internal/test-utils"

const stubHostCtx = testExtensionHostContext()

const getSystemPrompt = Effect.gen(function* () {
  const contributions = yield* SessionToolsExtension.setup(testSetupCtx())
  const systemPrompt = contributions.reactions?.systemPrompt
  if (systemPrompt === undefined) throw new Error("expected session tools systemPrompt reaction")
  return systemPrompt as (
    input: SystemPromptInput,
    ctx: typeof stubHostCtx,
  ) => Effect.Effect<string>
})

describe("SessionToolsExtension", () => {
  it.live("injects naming instruction for interactive prompts", () =>
    Effect.gen(function* () {
      const systemPrompt = yield* getSystemPrompt
      const prompt = yield* systemPrompt(
        { basePrompt: "base", agent: getBuiltinAgent("cowork")!, interactive: true },
        stubHostCtx,
      )
      expect(prompt).toContain("## Session naming")
      expect(prompt.startsWith("base")).toBe(true)
    }),
  )
  it.live("non-interactive prompts pass through unchanged", () =>
    Effect.gen(function* () {
      const systemPrompt = yield* getSystemPrompt
      const prompt = yield* systemPrompt(
        { basePrompt: "base", agent: getBuiltinAgent("cowork")!, interactive: false },
        stubHostCtx,
      )
      expect(prompt).toBe("base")
    }),
  )
})
