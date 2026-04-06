import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agents } from "@gent/core/domain/agent"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import type { SessionId, BranchId } from "@gent/core/domain/ids"
import {
  makeExtensionHostContext,
  type MakeExtensionHostContextDeps,
} from "@gent/core/runtime/make-extension-host-context"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"

describe("extension command RPCs", () => {
  const invoked: Array<{ args: string; sessionId: string }> = []

  const resolved = resolveExtensions([
    {
      manifest: { id: "test-agents" },
      kind: "builtin",
      sourcePath: "test",
      setup: { agents: Object.values(Agents), tools: [] },
    },
    {
      manifest: { id: "test-cmds" },
      kind: "builtin",
      sourcePath: "test",
      setup: {
        commands: [
          {
            name: "greet",
            description: "Say hello",
            handler: async (args: string, ctx: ExtensionHostContext) => {
              invoked.push({ args, sessionId: ctx.sessionId })
            },
          },
          { name: "noop", handler: async () => {} },
        ],
      },
    },
  ])

  const registryLayer = ExtensionRegistry.fromResolved(resolved)

  test("listCommands returns registered commands", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ExtensionRegistry
        const cmds = yield* registry.listCommands()
        expect(cmds).toHaveLength(2)
        expect(cmds[0]!.name).toBe("greet")
        expect(cmds[0]!.description).toBe("Say hello")
        expect(cmds[1]!.name).toBe("noop")
        expect(cmds[1]!.description).toBeUndefined()
      }).pipe(Effect.provide(registryLayer)),
    )
  })

  test("invokeCommand calls handler with ExtensionHostContext", async () => {
    invoked.length = 0

    const die = (label: string) => () => Effect.die(`${label} not available`)
    const deps = Layer.mergeAll(
      registryLayer,
      ExtensionStateRuntime.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ExtensionRegistry
        const stateRuntime = yield* ExtensionStateRuntime
        const platform = yield* RuntimePlatform

        const cmds = yield* registry.listCommands()
        const cmd = cmds.find((c) => c.name === "greet")!

        const hostDeps: MakeExtensionHostContextDeps = {
          platform,
          extensionStateRuntime: stateRuntime,
          approvalService: {
            present: die("ApprovalService"),
            storeResolution: die("ApprovalService"),
            respond: die("ApprovalService"),
            rehydrate: die("ApprovalService"),
          } as MakeExtensionHostContextDeps["approvalService"],
          promptPresenter: {
            present: die("PromptPresenter"),
            confirm: die("PromptPresenter"),
            review: die("PromptPresenter"),
          } as MakeExtensionHostContextDeps["promptPresenter"],
          extensionRegistry: registry,
          turnControl: {
            queueFollowUp: die("TurnControl"),
            interject: die("TurnControl"),
            bind: die("TurnControl"),
          } as MakeExtensionHostContextDeps["turnControl"],
          storage: {} as MakeExtensionHostContextDeps["storage"],
          searchStorage: {
            searchMessages: () => Effect.succeed([]),
          } as MakeExtensionHostContextDeps["searchStorage"],
          agentRunner: {
            run: die("AgentRunnerService"),
          } as MakeExtensionHostContextDeps["agentRunner"],
          eventPublisher: {
            publish: () => Effect.void,
            terminateSession: die("EventPublisher"),
          } as MakeExtensionHostContextDeps["eventPublisher"],
        }

        const ctx = makeExtensionHostContext(
          { sessionId: "test-session" as SessionId, branchId: "test-branch" as BranchId },
          hostDeps,
        )
        yield* Effect.promise(() => Promise.resolve(cmd.handler("world", ctx)))
      }).pipe(Effect.provide(deps)),
    )

    expect(invoked).toHaveLength(1)
    expect(invoked[0]!.args).toBe("world")
    expect(invoked[0]!.sessionId).toBe("test-session")
  })
})
