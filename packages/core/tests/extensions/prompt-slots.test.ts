import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { BunServices } from "@effect/platform-bun"
import { getBuiltinAgent } from "../../../extensions/tests/helpers/builtin-agents.js"
import type { LoadedExtension } from "../../src/domain/extension.js"
import { hook } from "../../src/domain/extension.js"
import { ExtensionId } from "../../src/domain/ids"
import {
  compileExtensionHooks,
  CurrentExtensionHostContext,
} from "../../src/runtime/extension-host"
import { testExtensionHostContext } from "../../src/test-utils"

const stubHostCtx = testExtensionHostContext()

const ext = (
  id: string,
  scope: "builtin" | "user" | "project",
  suffix: string,
): LoadedExtension => ({
  manifest: { id: ExtensionId.make(id) },
  scope,
  sourcePath: `/test/${id}`,
  contributions: {
    hooks: [hook("systemPrompt", (input) => Effect.succeed(`${input.basePrompt}${suffix}`))],
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
        Effect.provideService(CurrentExtensionHostContext, stubHostCtx),
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("x[builtin][user][project]"))),
      )
  })

  test("empty turn hooks are a no-op", () =>
    compileExtensionHooks([])
      .resolveSystemPrompt({ basePrompt: "x", agent: getBuiltinAgent("cowork")! })
      .pipe(
        Effect.provideService(CurrentExtensionHostContext, stubHostCtx),
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("x"))),
      ))
})
