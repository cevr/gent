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
import { SessionToolsExtension } from "../src/index.js"
import { getBuiltinAgent } from "./helpers/builtin-agents.js"
import type { SystemPromptInput } from "@gent/core/extensions/api"
import { provideTestSetupContext } from "@gent/core-internal/test-utils"

const getSystemPrompt = Effect.gen(function* () {
  const contributions = yield* SessionToolsExtension.setup.pipe(provideTestSetupContext())
  const systemPrompt = contributions.hooks?.find((slot) => slot.kind === "systemPrompt")
  if (systemPrompt === undefined) throw new Error("expected session tools systemPrompt hook")
  return systemPrompt.hook.handler
})

describe("SessionToolsExtension", () => {
  it.live("injects naming instruction for interactive prompts", () =>
    Effect.gen(function* () {
      const systemPrompt = yield* getSystemPrompt
      const prompt = yield* systemPrompt({
        basePrompt: "base",
        agent: getBuiltinAgent("cowork")!,
        interactive: true,
      } satisfies SystemPromptInput)
      expect(prompt).toContain("## Session naming")
      expect(prompt.startsWith("base")).toBe(true)
    }),
  )
  it.live("non-interactive prompts pass through unchanged", () =>
    Effect.gen(function* () {
      const systemPrompt = yield* getSystemPrompt
      const prompt = yield* systemPrompt({
        basePrompt: "base",
        agent: getBuiltinAgent("cowork")!,
        interactive: false,
      } satisfies SystemPromptInput)
      expect(prompt).toBe("base")
    }),
  )
})
