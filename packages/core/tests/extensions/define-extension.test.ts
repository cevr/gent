/**
 * defineExtension regression locks.
 *
 * Locks the contract that the public `defineExtension({ id, contributions })` API
 * returns a flat `Contribution[]` from `setup()` that the runtime registry
 * consumes. Each contribution kind round-trips, lifecycle effects compose in
 * registration order, and the result wires into `ExtensionRegistry`.
 *
 * Tied to planify Commit 1 — without this, `defineExtension` is a paper API.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer, Schema } from "effect"
import { Agents } from "@gent/extensions/all-agents"
import {
  defineExtension,
  defineResource,
  toolContribution,
  agentContribution,
  permissionRuleContribution,
  promptSectionContribution,
  commandContribution,
  pipelineContribution,
  type Contribution,
} from "@gent/core/extensions/api"
import {
  extractAgents,
  extractCapabilities,
  extractCommands,
  extractPipelines,
  extractPermissionRules,
  extractPromptSections,
  extractMachine,
  extractResources,
  extractExternalDrivers,
  extractModelDrivers,
} from "@gent/core/domain/contribution"
import { buildResourceLayer } from "@gent/core/runtime/extensions/resource-host"
import { defineTool } from "@gent/core/domain/tool"
import { PermissionRule } from "@gent/core/domain/permission"
import {
  ExtensionLoadError,
  type ExtensionSetupContext,
  type SystemPromptInput,
} from "@gent/core/domain/extension"
import { definePipeline } from "@gent/core/domain/pipeline"
import { resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { compilePipelines } from "@gent/core/runtime/extensions/pipeline-host"
import { testSetupCtx } from "@gent/core/test-utils"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"

const stubHostCtx = {
  sessionId: "test-session",
  branchId: "test-branch",
  cwd: "/tmp",
  home: "/tmp",
} as unknown as ExtensionHostContext

const setupOf = (ext: ReturnType<typeof defineExtension>) => ext.setup(testSetupCtx())

describe("defineExtension", () => {
  it.live("empty contribution array produces an empty contribution list", () =>
    Effect.gen(function* () {
      const ext = defineExtension({ id: "empty", contributions: () => [] })
      const contributions = yield* setupOf(ext)
      expect(contributions).toEqual([])
      expect(extractCapabilities(contributions)).toEqual([])
      expect(extractAgents(contributions)).toEqual([])
      expect(extractModelDrivers(contributions)).toEqual([])
      expect(extractResources(contributions)).toEqual([])
      expect(extractMachine(contributions)).toBeUndefined()
      expect(extractCommands(contributions)).toEqual([])
      expect(extractPermissionRules(contributions)).toEqual([])
      expect(extractPromptSections(contributions)).toEqual([])
      expect(extractExternalDrivers(contributions)).toEqual([])
      expect(extractPipelines(contributions)).toEqual([])
    }),
  )

  it.live("each kind round-trips into its corresponding extractor", () =>
    Effect.gen(function* () {
      const myTool = defineTool({
        name: "echo",
        description: "echo",
        params: Schema.Struct({}),
        execute: () => Effect.succeed("ok"),
      })
      const myLayer = Layer.empty
      const ext = defineExtension({
        id: "all-kinds",
        contributions: () => [
          toolContribution(myTool),
          agentContribution(Agents.cowork),
          permissionRuleContribution(new PermissionRule({ tool: "echo", action: "allow" })),
          promptSectionContribution({ id: "rules", content: "rule one", priority: 50 }),
          commandContribution({
            name: "test",
            description: "test cmd",
            handler: () => Effect.void,
          }),
          pipelineContribution(definePipeline("prompt.system", (i, next) => next(i))),
          defineResource({
            scope: "process",
            layer: myLayer,
            subscriptions: [{ pattern: "agent:*", handler: () => Effect.void }],
            schedule: [
              {
                id: "test-job",
                cron: "0 0 * * *",
                target: { kind: "headless-agent", agent: "cowork" as never, prompt: "hi" },
              },
            ],
          }),
        ],
      })
      const contributions = yield* setupOf(ext)
      // After C4.4, `tool(...)` lowers into a Capability(audiences:["model"]).
      // C4.5 deleted the legacy `_kind: "tool"` extractor — tool-shaped entries
      // surface only through `extractCapabilities(...)`.
      const modelCaps = extractCapabilities(contributions).filter((c) =>
        c.audiences.includes("model"),
      )
      expect(modelCaps[0]?.id).toBe("echo")
      expect(extractAgents(contributions)[0]?.name).toBe("cowork")
      expect(extractPermissionRules(contributions)[0]?.tool).toBe("echo")
      expect(extractPromptSections(contributions)[0]?.id).toBe("rules")
      expect(extractCommands(contributions)[0]?.name).toBe("test")
      expect(extractPipelines(contributions)[0]?.hook).toBe("prompt.system")
      const resources = extractResources(contributions)
      expect(resources).toHaveLength(1)
      expect(resources[0]!.schedule?.[0]?.id).toBe("test-job")
      expect(resources[0]!.subscriptions?.[0]?.pattern).toBe("agent:*")
    }),
  )

  it.live(
    "Resource.start and Resource.stop run at scope build/teardown via buildResourceLayer in declaration / reverse order",
    () =>
      Effect.gen(function* () {
        const log: string[] = []
        const append = (s: string) => Effect.sync(() => log.push(s))
        const ext = defineExtension({
          id: "lifecycle",
          contributions: () => [
            defineResource({
              scope: "process",
              layer: Layer.empty,
              start: append("startup-1"),
              stop: append("shutdown-1"),
            }),
            defineResource({
              scope: "process",
              layer: Layer.empty,
              start: append("startup-2"),
              stop: append("shutdown-2"),
            }),
          ],
        })
        const loaded = {
          manifest: { id: ext.manifest.id },
          kind: "builtin" as const,
          sourcePath: "builtin",
          contributions: yield* setupOf(ext),
        }
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(buildResourceLayer([loaded as never], "process"))
          }),
        )
        // Strict ordering — no sorting. Codex C3.4 review flagged that the
        // prior `slice(...).sort()` masked a real ordering bug. Lifecycle
        // is now sequenced through one Effect, so this is deterministic.
        expect(log).toEqual(["startup-1", "startup-2", "shutdown-2", "shutdown-1"])
      }),
  )

  it.live("multiple Resource subscriptions and commands all accumulate", () =>
    Effect.gen(function* () {
      const ext = defineExtension({
        id: "multi",
        contributions: () => [
          defineResource({
            scope: "process",
            layer: Layer.empty,
            subscriptions: [
              { pattern: "a:*", handler: () => Effect.void },
              { pattern: "b:*", handler: () => Effect.void },
            ],
          }),
          commandContribution({ name: "cmd1", handler: () => Effect.void }),
          commandContribution({ name: "cmd2", handler: () => Effect.void }),
        ],
      })
      const contributions = yield* setupOf(ext)
      const resources = extractResources(contributions)
      expect(resources).toHaveLength(1)
      expect(resources[0]!.subscriptions).toHaveLength(2)
      expect(extractCommands(contributions).length).toBe(2)
    }),
  )

  it.live("Effect-returning contributions factory is awaited", () =>
    Effect.gen(function* () {
      const ext = defineExtension({
        id: "effectful",
        contributions: () =>
          Effect.gen(function* () {
            yield* Effect.void
            return [
              commandContribution({ name: "from-effect", handler: () => Effect.void }),
            ] satisfies ReadonlyArray<Contribution>
          }),
      })
      const contributions = yield* setupOf(ext)
      expect(extractCommands(contributions)[0]?.name).toBe("from-effect")
    }),
  )

  it.live("setup context is forwarded to the contributions factory", () =>
    Effect.gen(function* () {
      let captured: ExtensionSetupContext | undefined
      const ext = defineExtension({
        id: "captures-ctx",
        contributions: ({ ctx }) => {
          captured = ctx
          return []
        },
      })
      yield* setupOf(ext)
      expect(captured?.cwd).toBeDefined()
      expect(captured?.home).toBeDefined()
      expect(captured?.spawner).toBeDefined()
    }),
  )

  it.live("defineExtension result wires through ExtensionRegistry + pipeline chain", () =>
    Effect.gen(function* () {
      const myTool = defineTool({
        name: "from-define",
        description: "test",
        params: Schema.Struct({}),
        execute: () => Effect.succeed("hi"),
      })
      const ext = defineExtension({
        id: "wired",
        contributions: () => [
          toolContribution(myTool),
          pipelineContribution(
            definePipeline(
              "prompt.system",
              (input: SystemPromptInput, next: (i: SystemPromptInput) => Effect.Effect<string>) =>
                next(input).pipe(Effect.map((s) => `${s}!!`)),
            ),
          ),
        ],
      })
      const contributions = yield* setupOf(ext)
      const loaded = {
        manifest: { id: "wired" },
        kind: "builtin" as const,
        sourcePath: "/test/wired",
        contributions,
      }
      const resolved = resolveExtensions([loaded])
      expect(resolved.tools.get("from-define")?.name).toBe("from-define")

      const compiled = compilePipelines([loaded])
      const result = yield* compiled.runPipeline(
        "prompt.system",
        { basePrompt: "yo", agent: Agents.cowork },
        (input) => Effect.succeed(input.basePrompt),
        stubHostCtx,
      )
      expect(result).toBe("yo!!")
    }),
  )

  it.live("contributions factory error becomes ExtensionLoadError", () =>
    Effect.gen(function* () {
      const ext = defineExtension({
        id: "boom",
        contributions: () =>
          Effect.fail(new ExtensionLoadError({ extensionId: "boom", message: "nope" })),
      })
      const exit = yield* Effect.exit(setupOf(ext))
      expect(exit._tag).toBe("Failure")
    }),
  )
})
