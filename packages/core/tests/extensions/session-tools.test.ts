import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { SessionToolsExtension } from "@gent/core/extensions/session-tools"
import { compileHooks } from "@gent/core/runtime/extensions/hooks"
import { Agents } from "@gent/core/domain/agent"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { testSetupCtx } from "@gent/core/test-utils"

const stubCtx = {} as unknown as ExtensionHostContext

describe("SessionToolsExtension", () => {
  test("injects naming instruction for interactive prompts", async () => {
    const setup = await Effect.runPromise(SessionToolsExtension.setup(testSetupCtx()))
    const hooks = compileHooks([
      {
        manifest: SessionToolsExtension.manifest,
        kind: "builtin",
        sourcePath: "test",
        setup,
      },
    ])

    const prompt = await Effect.runPromise(
      hooks.runInterceptor(
        "prompt.system",
        { basePrompt: "base", agent: Agents.cowork, interactive: true },
        (input) => Effect.succeed(input.basePrompt),
        stubCtx,
      ),
    )

    expect(prompt).toContain("## Session naming")
  })

  test("skips naming instruction for non-interactive prompts", async () => {
    const setup = await Effect.runPromise(SessionToolsExtension.setup(testSetupCtx()))
    const hooks = compileHooks([
      {
        manifest: SessionToolsExtension.manifest,
        kind: "builtin",
        sourcePath: "test",
        setup,
      },
    ])

    const prompt = await Effect.runPromise(
      hooks.runInterceptor(
        "prompt.system",
        { basePrompt: "base", agent: Agents.summarizer, interactive: false },
        (input) => Effect.succeed(input.basePrompt),
        stubCtx,
      ),
    )

    expect(prompt).toBe("base")
  })
})
