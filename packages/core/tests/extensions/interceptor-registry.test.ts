/**
 * InterceptorRegistry locks.
 *
 * `compileInterceptors` is now the sole owner of the contribution-side
 * interceptor composition algorithm. These tests pin its behavior:
 *   - empty registry no-ops to the base
 *   - chains compose left-fold inside-out (last registered is outermost)
 *
 * Scope ordering is covered separately in `scope-precedence.test.ts`.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { Agents } from "@gent/extensions/all-agents"
import { defineInterceptor, type LoadedExtension } from "@gent/core/domain/extension"
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
  it.live("composes scope-ordered chain inside-out (builtin innermost)", () =>
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

      const facade = compileInterceptors(extensions)
      const result = yield* facade.chain.runInterceptor(
        "prompt.system",
        { basePrompt: "x", agent: Agents.cowork },
        () => Effect.succeed("base"),
        stubCtx,
      )
      expect(result).toBe("base[builtin][user][project]")
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
