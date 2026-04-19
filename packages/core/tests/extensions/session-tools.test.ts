/**
 * SessionToolsExtension pipeline behavior locks.
 *
 * The extension contributes a `prompt.system` pipeline that injects
 * a `## Session naming` instruction for interactive prompts and skips it
 * for non-interactive ones. Test pins both branches against the
 * contribution-native pipeline host (`compilePipelines`).
 */
import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { SessionToolsExtension } from "@gent/extensions/session-tools"
import { Agents } from "@gent/extensions/all-agents"
import { compilePipelines } from "@gent/core/runtime/extensions/pipeline-host"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { testSetupCtx } from "@gent/core/test-utils"

const stubCtx = {} as unknown as ExtensionHostContext

describe("SessionToolsExtension", () => {
  test("injects naming instruction for interactive prompts", async () => {
    const contributions = await Effect.runPromise(SessionToolsExtension.setup(testSetupCtx()))
    const compiled = compilePipelines([
      {
        manifest: SessionToolsExtension.manifest,
        kind: "builtin",
        sourcePath: "test",
        contributions,
      },
    ])

    const prompt = await Effect.runPromise(
      compiled.runPipeline(
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
    const contributions = await Effect.runPromise(SessionToolsExtension.setup(testSetupCtx()))
    const compiled = compilePipelines([
      {
        manifest: SessionToolsExtension.manifest,
        kind: "builtin",
        sourcePath: "test",
        contributions,
      },
    ])

    const prompt = await Effect.runPromise(
      compiled.runPipeline(
        "prompt.system",
        { basePrompt: "base", agent: Agents.cowork, interactive: false },
        (input) => Effect.succeed(input.basePrompt),
        stubCtx,
      ),
    )

    expect(prompt).toBe("base")
  })
})
