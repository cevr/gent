/**
 * PipelineHost locks.
 *
 * `compilePipelines` is the sole owner of the pipeline composition algorithm.
 * These tests pin its behavior:
 *   - empty registry no-ops to the base
 *   - chains compose left-fold inside-out (last registered is outermost)
 *
 * Scope ordering is covered separately in `scope-precedence.test.ts`.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { Agents } from "@gent/extensions/all-agents"
import type { LoadedExtension } from "@gent/core/domain/extension"
import { compilePipelines } from "@gent/core/runtime/extensions/pipeline-host"
import { pipeline } from "@gent/core/domain/contribution"
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
  pipelines: ReturnType<typeof pipeline>[],
): LoadedExtension => ({
  manifest: { id },
  kind,
  sourcePath: `/test/${id}`,
  contributions: { pipelines },
})

describe("pipeline host", () => {
  it.live("composes scope-ordered chain inside-out (builtin innermost)", () =>
    Effect.gen(function* () {
      const make = (label: string) =>
        pipeline("prompt.system", (input, next) =>
          next(input).pipe(Effect.map((s) => `${s}[${label}]`)),
        )

      const extensions = [
        ext("a", "builtin", [make("builtin")]),
        ext("b", "user", [make("user")]),
        ext("c", "project", [make("project")]),
      ]

      const facade = compilePipelines(extensions)
      const result = yield* facade.runPipeline(
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
      const facade = compilePipelines([])
      const result = yield* facade.runPipeline(
        "prompt.system",
        { basePrompt: "x", agent: Agents.cowork },
        () => Effect.succeed("base"),
        stubCtx,
      )
      expect(result).toBe("base")
    }),
  )
})
