import { describe, test, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import type { GentExtension } from "@gent/core/domain/extension"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { SessionId, BranchId } from "@gent/core/domain/ids"
import {
  makeExtensionHostContext,
  type MakeExtensionHostContextDeps,
} from "@gent/core/runtime/make-extension-host-context"
import { WorkflowRuntime } from "@gent/core/runtime/extensions/workflow-runtime"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { ApprovalService } from "@gent/core/runtime/approval-service"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { createToolTestLayer } from "@gent/core/test-utils/extension-harness"
import { capability } from "@gent/core/domain/contribution"
import { toolPreset } from "../extensions/helpers/test-preset"

describe("extension command RPCs", () => {
  const invoked: Array<{ args: string; sessionId: string }> = []

  // Slash commands are now Capabilities with `audiences:["human-slash"]`.
  // The command's display description comes from `promptSnippet` (capabilities
  // expose `promptSnippet` as the slash-command short description; `description`
  // is reserved for the model-audience tool description).
  const TestCommandsExtension: GentExtension = {
    manifest: { id: "@test/commands" },
    setup: () =>
      Effect.succeed({
        capabilities: [
          capability({
            id: "greet",
            audiences: ["human-slash"],
            intent: "write",
            promptSnippet: "Say hello",
            input: Schema.String,
            output: Schema.Void,
            effect: (args: string, ctx: ExtensionHostContext) =>
              Effect.sync(() => {
                invoked.push({ args, sessionId: ctx.sessionId })
              }),
          }),
          capability({
            id: "noop",
            audiences: ["human-slash"],
            intent: "write",
            input: Schema.String,
            output: Schema.Void,
            effect: () => Effect.void,
          }),
        ],
      }),
  }

  const layer = createToolTestLayer({ ...toolPreset, extensions: [TestCommandsExtension] }).pipe(
    Layer.provideMerge(ApprovalService.Test()),
  )

  test("listCommands returns registered commands", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ExtensionRegistry
        const cmds = yield* registry.listCommands()
        const testCmds = cmds.filter((c) => c.name === "greet" || c.name === "noop")
        expect(testCmds).toHaveLength(2)
        expect(testCmds.find((c) => c.name === "greet")?.description).toBe("Say hello")
        expect(testCmds.find((c) => c.name === "noop")?.description).toBeUndefined()
      }).pipe(Effect.provide(layer)),
    )
  })

  test("invokeCommand calls handler with ExtensionHostContext", async () => {
    invoked.length = 0

    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ExtensionRegistry
        const stateRuntime = yield* WorkflowRuntime
        const platform = yield* RuntimePlatform
        const eventPublisher = yield* EventPublisher
        const approval = yield* ApprovalService
        const turnControl = yield* ExtensionTurnControl
        const storage = yield* Storage

        const cmds = yield* registry.listCommands()
        const cmd = cmds.find((c) => c.name === "greet")!

        const hostCtx = makeExtensionHostContext(
          { sessionId: SessionId.of("test-session"), branchId: BranchId.of("test-branch") },
          {
            platform,
            extensionStateRuntime: stateRuntime,
            approvalService: approval,
            promptPresenter: {
              present: () => Effect.void,
              confirm: () => Effect.succeed("yes" as const),
              review: () => Effect.succeed({ decision: "yes" as const, path: "", content: "" }),
            } as MakeExtensionHostContextDeps["promptPresenter"],
            extensionRegistry: registry,
            turnControl: turnControl as MakeExtensionHostContextDeps["turnControl"],
            storage,
            searchStorage: {
              searchMessages: () => Effect.succeed([]),
            } as MakeExtensionHostContextDeps["searchStorage"],
            agentRunner: {
              run: () => Effect.die("not used in this test"),
            } as MakeExtensionHostContextDeps["agentRunner"],
            eventPublisher,
          },
        )
        yield* cmd.handler("world", hostCtx)
      }).pipe(Effect.provide(layer)),
    )

    expect(invoked).toHaveLength(1)
    expect(invoked[0]!.args).toBe("world")
    expect(invoked[0]!.sessionId).toBe("test-session")
  })
})
