/**
 * defineExtension regression locks.
 *
 * Locks the contract that the public `defineExtension({ id, contributions })` API
 * lowers a flat `Contribution[]` into the legacy `ExtensionSetup` shape that the
 * runtime registry consumes. Each contribution kind round-trips, lifecycle effects
 * compose in registration order, and the result wires into `ExtensionRegistry`.
 *
 * Tied to planify Commit 1 — without this, `defineExtension` is a paper API.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer, Schema } from "effect"
import { Agents } from "@gent/extensions/all-agents"
import {
  defineExtension,
  toolContribution,
  agentContribution,
  layerContribution,
  permissionRuleContribution,
  promptSectionContribution,
  commandContribution,
  jobContribution,
  busSubscriptionContribution,
  interceptorContribution,
  onStartupContribution,
  onShutdownContribution,
  type Contribution,
} from "@gent/core/extensions/api"
import { defineTool } from "@gent/core/domain/tool"
import { PermissionRule } from "@gent/core/domain/permission"
import {
  defineInterceptor,
  ExtensionLoadError,
  type ExtensionSetupContext,
  type SystemPromptInput,
} from "@gent/core/domain/extension"
import { resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { compileHooks } from "@gent/core/runtime/extensions/hooks"
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
  it.live("empty contribution array produces an empty setup with no fields", () =>
    Effect.gen(function* () {
      const ext = defineExtension({ id: "empty", contributions: () => [] })
      const setup = yield* setupOf(ext)
      expect(setup.tools).toBeUndefined()
      expect(setup.agents).toBeUndefined()
      expect(setup.providers).toBeUndefined()
      expect(setup.layer).toBeUndefined()
      expect(setup.actor).toBeUndefined()
      expect(setup.commands).toBeUndefined()
      expect(setup.permissionRules).toBeUndefined()
      expect(setup.promptSections).toBeUndefined()
      expect(setup.busSubscriptions).toBeUndefined()
      expect(setup.jobs).toBeUndefined()
      expect(setup.turnExecutors).toBeUndefined()
      expect(setup.hooks).toBeUndefined()
      expect(setup.onStartup).toBeUndefined()
      expect(setup.onShutdown).toBeUndefined()
    }),
  )

  it.live("each kind round-trips into the corresponding ExtensionSetup field", () =>
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
          jobContribution({
            id: "test-job",
            schedule: "0 0 * * *",
            target: { kind: "headless-agent", agent: "cowork", prompt: "hi" },
          }),
          busSubscriptionContribution("agent:*", () => Effect.void),
          interceptorContribution(defineInterceptor("prompt.system", (i, next) => next(i))),
          layerContribution(myLayer),
        ],
      })
      const setup = yield* setupOf(ext)
      expect(setup.tools?.[0]?.name).toBe("echo")
      expect(setup.agents?.[0]?.name).toBe("cowork")
      expect(setup.permissionRules?.[0]?.tool).toBe("echo")
      expect(setup.promptSections?.[0]?.id).toBe("rules")
      expect(setup.commands?.[0]?.name).toBe("test")
      expect(setup.jobs?.[0]?.id).toBe("test-job")
      expect(setup.busSubscriptions?.[0]?.pattern).toBe("agent:*")
      expect(setup.hooks?.interceptors?.[0]?.key).toBe("prompt.system")
      expect(setup.layer).toBeDefined()
    }),
  )

  it.live("multiple lifecycle effects compose in registration order", () =>
    Effect.gen(function* () {
      const log: string[] = []
      const append = (s: string) => Effect.sync(() => log.push(s))
      const ext = defineExtension({
        id: "lifecycle",
        contributions: () => [
          onStartupContribution(append("startup-1")),
          onStartupContribution(append("startup-2")),
          onShutdownContribution(append("shutdown-1")),
          onShutdownContribution(append("shutdown-2")),
        ],
      })
      const setup = yield* setupOf(ext)
      yield* setup.onStartup ?? Effect.void
      yield* setup.onShutdown ?? Effect.void
      expect(log).toEqual(["startup-1", "startup-2", "shutdown-1", "shutdown-2"])
    }),
  )

  it.live("multiple bus subscriptions and commands all accumulate", () =>
    Effect.gen(function* () {
      const ext = defineExtension({
        id: "multi",
        contributions: () => [
          busSubscriptionContribution("a:*", () => Effect.void),
          busSubscriptionContribution("b:*", () => Effect.void),
          commandContribution({ name: "cmd1", handler: () => Effect.void }),
          commandContribution({ name: "cmd2", handler: () => Effect.void }),
        ],
      })
      const setup = yield* setupOf(ext)
      expect(setup.busSubscriptions?.length).toBe(2)
      expect(setup.commands?.length).toBe(2)
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
      const setup = yield* setupOf(ext)
      expect(setup.commands?.[0]?.name).toBe("from-effect")
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

  it.live("defineExtension result wires through ExtensionRegistry + interceptor chain", () =>
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
          interceptorContribution(
            defineInterceptor(
              "prompt.system",
              (input: SystemPromptInput, next: (i: SystemPromptInput) => Effect.Effect<string>) =>
                next(input).pipe(Effect.map((s) => `${s}!!`)),
            ),
          ),
        ],
      })
      const setup = yield* setupOf(ext)
      const loaded = {
        manifest: { id: "wired" },
        kind: "builtin" as const,
        sourcePath: "/test/wired",
        setup,
      }
      const resolved = resolveExtensions([loaded])
      expect(resolved.tools.get("from-define")?.name).toBe("from-define")

      const compiled = compileHooks([loaded])
      const result = yield* compiled.runInterceptor(
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
        contributions: () => Effect.fail(new ExtensionLoadError("boom", "nope")),
      })
      const exit = yield* Effect.exit(setupOf(ext))
      expect(exit._tag).toBe("Failure")
    }),
  )
})
