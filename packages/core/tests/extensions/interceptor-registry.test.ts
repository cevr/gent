/**
 * InterceptorRegistry composition equivalence locks.
 *
 * Locks that `compileInterceptors` (the contribution-native facade) produces
 * the same chain as `compileHooks` did directly. Both share the underlying
 * algorithm — this test guards against accidental drift while the migration
 * to contribution-native authoring is under way.
 *
 * Tied to planify Commit 2. If the facade diverges from the hook chain, the
 * later commits (3-12) that move callers onto `InterceptorContribution` would
 * silently change semantics.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { Agents } from "@gent/extensions/all-agents"
import { defineInterceptor, type LoadedExtension } from "@gent/core/domain/extension"
import { compileHooks } from "@gent/core/runtime/extensions/hooks"
import { compileInterceptors } from "@gent/core/runtime/extensions/interceptor-registry"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"

const stubCtx = {
  sessionId: "test-session",
  branchId: "test-branch",
  cwd: "/tmp",
  home: "/tmp",
} as unknown as ExtensionHostContext

const ext = (
  id: string,
  kind: "builtin" | "user" | "project",
  setup: LoadedExtension["setup"],
): LoadedExtension => ({ manifest: { id }, kind, sourcePath: `/test/${id}`, setup })

describe("interceptor registry", () => {
  it.live("compileInterceptors matches compileHooks output for the same inputs", () =>
    Effect.gen(function* () {
      const make = (label: string) =>
        defineInterceptor("prompt.system", (input, next) =>
          next(input).pipe(Effect.map((s) => `${s}[${label}]`)),
        )

      const extensions = [
        ext("a", "builtin", { hooks: { interceptors: [make("builtin")] } }),
        ext("b", "user", { hooks: { interceptors: [make("user")] } }),
        ext("c", "project", { hooks: { interceptors: [make("project")] } }),
      ]

      const direct = compileHooks(extensions)
      const facade = compileInterceptors(extensions)

      const directResult = yield* direct.runInterceptor(
        "prompt.system",
        { basePrompt: "x", agent: Agents.cowork },
        () => Effect.succeed("base"),
        stubCtx,
      )
      const facadeResult = yield* facade.chain.runInterceptor(
        "prompt.system",
        { basePrompt: "x", agent: Agents.cowork },
        () => Effect.succeed("base"),
        stubCtx,
      )
      expect(facadeResult).toBe(directResult)
      expect(facadeResult).toBe("base[builtin][user][project]")
    }),
  )

  it.live("empty registry is a no-op (returns base output)", () =>
    Effect.gen(function* () {
      const facade = compileInterceptors([])
      const result = yield* facade.chain.runInterceptor(
        "prompt.system",
        { basePrompt: "x", agent: Agents.cowork },
        () => Effect.succeed("base"),
        stubCtx,
      )
      expect(result).toBe("base")
    }),
  )
})
