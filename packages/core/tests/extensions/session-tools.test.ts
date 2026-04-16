/**
 * SessionToolsExtension interceptor behavior locks.
 *
 * The extension contributes a `prompt.system` interceptor that injects
 * a `## Session naming` instruction for interactive prompts and skips it
 * for non-interactive ones. Test pins both branches against the
 * contribution-native pipeline (`compileInterceptors`).
 */
import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { SessionToolsExtension } from "@gent/extensions/session-tools"
import { Agents } from "@gent/extensions/all-agents"
import { compileInterceptors } from "@gent/core/runtime/extensions/interceptor-registry"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { testSetupCtx } from "@gent/core/test-utils"

const stubCtx = {} as unknown as ExtensionHostContext

describe("SessionToolsExtension", () => {
  test("injects naming instruction for interactive prompts", async () => {
    const setup = await Effect.runPromise(SessionToolsExtension.setup(testSetupCtx()))
    const compiled = compileInterceptors([
      {
        manifest: SessionToolsExtension.manifest,
        kind: "builtin",
        sourcePath: "test",
        setup,
      },
    ]).chain

    const prompt = await Effect.runPromise(
      compiled.runInterceptor(
        "prompt.system",
        { basePrompt: "base", agent: Agents.cowork, interactive: true },
        (input) => Effect.succeed(input.basePrompt),
        stubCtx,
      ),
    )

    expect(prompt).toContain("## Session naming")
    expect(prompt.startsWith("base")).toBe(true)
  })

  test("non-interactive prompts pass through unchanged", async () => {
    const setup = await Effect.runPromise(SessionToolsExtension.setup(testSetupCtx()))
    const compiled = compileInterceptors([
      {
        manifest: SessionToolsExtension.manifest,
        kind: "builtin",
        sourcePath: "test",
        setup,
      },
    ]).chain

    const prompt = await Effect.runPromise(
      compiled.runInterceptor(
        "prompt.system",
        { basePrompt: "base", agent: Agents.cowork, interactive: false },
        (input) => Effect.succeed(input.basePrompt),
        stubCtx,
      ),
    )

    expect(prompt).toBe("base")
  })
})
