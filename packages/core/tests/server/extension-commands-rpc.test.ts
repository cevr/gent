import { describe, test, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import type { GentExtension, LoadedExtension } from "../../src/domain/extension.js"
import { createSequenceProvider, textStep } from "@gent/core/debug/provider"
import { ExtensionRegistry, listSlashCommands } from "@gent/core/runtime/extensions/registry"
import { setupExtension } from "@gent/core/runtime/extensions/loader"
import { ApprovalService } from "@gent/core/runtime/approval-service"
import { createToolTestLayer } from "@gent/core/test-utils/extension-harness"
import { createE2ELayer } from "@gent/core/test-utils/e2e-layer"
import { Gent } from "@gent/sdk"
import { BunServices } from "@effect/platform-bun"
import { buildExtensionRpcHandlers } from "@gent/core/server/rpc-handler-groups/extension"
import { CommandInfo } from "@gent/core/server/transport-contract"
import { e2ePreset, toolPreset } from "../extensions/helpers/test-preset"

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
          {
            id: "greet",
            audiences: ["human-slash", "transport-public"],
            intent: "write",
            promptSnippet: "Say hello",
            input: Schema.String,
            output: Schema.Void,
            effect: (args: string, ctx) =>
              Effect.sync(() => {
                invoked.push({ args, sessionId: ctx.sessionId })
              }),
          },
          {
            id: "noop",
            audiences: ["human-slash"],
            intent: "write",
            input: Schema.String,
            output: Schema.Void,
            effect: () => Effect.void,
          },
        ],
      }),
  }

  const layer = createToolTestLayer({ ...toolPreset, extensions: [TestCommandsExtension] }).pipe(
    Layer.provideMerge(ApprovalService.Test()),
  )

  const setupCommandsExt = Effect.provide(
    setupExtension(
      { extension: TestCommandsExtension, scope: "builtin", sourcePath: "builtin" },
      "/test/cwd",
      "/test/home",
    ),
    BunServices.layer,
  )

  test("listCommands returns registered commands", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ExtensionRegistry
        const cmds = listSlashCommands(registry.getResolved().extensions)
        const testCmds = cmds.filter((c) => c.name === "greet" || c.name === "noop")
        expect(testCmds).toHaveLength(2)
        expect(testCmds.find((c) => c.name === "greet")?.description).toBe("Say hello")
        expect(testCmds.find((c) => c.name === "noop")?.description).toBeUndefined()
      }).pipe(Effect.provide(layer)),
    )
  })

  test("RPC listCommands + request round-trip through the transport boundary", async () => {
    invoked.length = 0
    let createdSessionId = ""

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ext = yield* setupCommandsExt
          const { layer: providerLayer } = yield* createSequenceProvider([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({ ...e2ePreset, providerLayer, extensions: [ext] }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
          createdSessionId = sessionId

          const commands = yield* client.extension.listCommands({ sessionId })
          expect(commands[0]).toBeInstanceOf(CommandInfo)
          expect(commands.map((command) => command.name)).toEqual(["greet"])
          const greet = commands.find((command) => command.name === "greet")
          expect(greet?.description).toBe("Say hello")
          expect(greet?.extensionId).toBe("@test/commands")
          expect(greet?.capabilityId).toBe("greet")
          expect(greet?.intent).toBe("write")

          yield* client.extension.request({
            sessionId,
            extensionId: greet!.extensionId,
            capabilityId: greet!.capabilityId,
            intent: greet!.intent,
            input: "rpc-world",
            branchId,
          })
        }),
      ),
    )

    expect(invoked).toEqual([{ args: "rpc-world", sessionId: createdSessionId }])
  })

  test("listCommands resolves through the active session profile", async () => {
    const alphaExtension: LoadedExtension = {
      manifest: { id: "@test/alpha" },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        capabilities: [
          {
            id: "alpha",
            audiences: ["human-slash", "transport-public"],
            intent: "write",
            promptSnippet: "Alpha command",
            input: Schema.String,
            output: Schema.Void,
            effect: () => Effect.void,
          },
        ],
      },
    }

    const betaExtension: LoadedExtension = {
      manifest: { id: "@test/beta" },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        capabilities: [
          {
            id: "beta",
            audiences: ["human-slash", "transport-public"],
            intent: "write",
            promptSnippet: "Beta command",
            input: Schema.String,
            output: Schema.Void,
            effect: () => Effect.void,
          },
        ],
      },
    }

    const handlers = buildExtensionRpcHandlers({
      resolveSessionServices: (sessionId) =>
        Effect.succeed({
          registry: {
            getResolved: () => ({
              extensions: sessionId === "session-alpha" ? [alphaExtension] : [betaExtension],
            }),
          },
          stateRuntime: {} as never,
        }),
    } as never)

    const alpha = await Effect.runPromise(
      handlers["extension.listCommands"]({ sessionId: "session-alpha" }),
    )
    const beta = await Effect.runPromise(
      handlers["extension.listCommands"]({ sessionId: "session-beta" }),
    )

    expect(alpha.map((command) => command.name)).toEqual(["alpha"])
    expect(beta.map((command) => command.name)).toEqual(["beta"])
  })

  test("listCommands omits human-slash capabilities that are not transport-public", async () => {
    const handlers = buildExtensionRpcHandlers({
      resolveSessionServices: () =>
        Effect.succeed({
          registry: {
            getResolved: () => ({
              extensions: [
                {
                  manifest: { id: "@test/public-filter" },
                  scope: "builtin",
                  sourcePath: "test",
                  contributions: {
                    capabilities: [
                      {
                        id: "visible",
                        audiences: ["human-slash", "transport-public"],
                        intent: "write",
                        input: Schema.String,
                        output: Schema.Void,
                        effect: () => Effect.void,
                      },
                      {
                        id: "hidden",
                        audiences: ["human-slash"],
                        intent: "write",
                        input: Schema.String,
                        output: Schema.Void,
                        effect: () => Effect.void,
                      },
                    ],
                  },
                } satisfies LoadedExtension,
              ],
            }),
          },
          stateRuntime: {} as never,
        }),
    } as never)

    const commands = await Effect.runPromise(
      handlers["extension.listCommands"]({ sessionId: "session-filter" }),
    )

    expect(commands.map((command) => command.name)).toEqual(["visible"])
  })
})
