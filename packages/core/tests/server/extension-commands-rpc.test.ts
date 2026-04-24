import { describe, test, expect } from "bun:test"
import { Context, Effect, Layer, Schema } from "effect"
import {
  ExtensionLoadError,
  type GentExtension,
  type LoadedExtension,
} from "../../src/domain/extension.js"
import { createSequenceProvider, textStep, toolCallStep } from "@gent/core/debug/provider"
import {
  ExtensionRegistry,
  listSlashCommands,
  resolveExtensions,
} from "../../src/runtime/extensions/registry"
import { setupExtension } from "../../src/runtime/extensions/loader"
import { ApprovalService } from "../../src/runtime/approval-service"
import { createToolTestLayer } from "@gent/core/test-utils/extension-harness"
import { createE2ELayer } from "@gent/core/test-utils/e2e-layer"
import { Gent } from "@gent/sdk"
import { BunServices } from "@effect/platform-bun"
import { CommandInfo } from "@gent/core/server/transport-contract"
import { e2ePreset, toolPreset } from "../extensions/helpers/test-preset"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { MachineEngine } from "../../src/runtime/extensions/resource-host/machine-engine"
import { SessionProfileCache, type SessionProfile } from "../../src/runtime/session-profile"
import { waitFor } from "@gent/core/test-utils/fixtures"
import { buildExtensionLayers } from "../../src/runtime/profile"
import { defineResource } from "@gent/core/domain/resource"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { ExtensionMessage } from "@gent/core/domain/extension-protocol"
import { reducerActor } from "../extensions/helpers/reducer-actor"

class ProfileToken extends Context.Service<
  ProfileToken,
  { readonly read: () => Effect.Effect<string> }
>()("@test/ProfileToken") {}

describe("extension command RPCs", () => {
  const invoked: Array<{ args: string; sessionId: string; cwd: string }> = []

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
                invoked.push({ args, sessionId: ctx.sessionId, cwd: ctx.cwd })
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

  const allowAllPermission = {
    check: () => Effect.succeed("allowed" as const),
    addRule: () => Effect.void,
    removeRule: () => Effect.void,
    getRules: () => Effect.succeed([]),
  }

  const makeProfile = (cwd: string, extensions: ReadonlyArray<LoadedExtension>) =>
    Effect.gen(function* () {
      const resolved = resolveExtensions(extensions)
      const layerContext = yield* Layer.build(buildExtensionLayers(resolved))
      return {
        cwd,
        extensions,
        resolved,
        layerContext,
        permissionService: allowAllPermission,
        registryService: Context.get(layerContext, ExtensionRegistry),
        driverRegistryService: Context.get(layerContext, DriverRegistry),
        extensionStateRuntime: Context.get(layerContext, MachineEngine),
        subscriptionEngine: undefined,
        baseSections: [],
        instructions: "",
      } satisfies SessionProfile
    })

  const makeCommandExtension = (extensionId: string, commandId: string): LoadedExtension => ({
    manifest: { id: extensionId },
    scope: "builtin",
    sourcePath: "test",
    contributions: {
      capabilities: [
        {
          id: commandId,
          audiences: ["human-slash", "transport-public"],
          intent: "write",
          input: Schema.String,
          output: Schema.Void,
          effect: () => Effect.void,
        },
      ],
    },
  })

  const boundaryReceived: Array<{ kind: "send" | "ask"; label: string }> = []
  const BoundaryProtocol = {
    Touch: ExtensionMessage.command("@test/transport-boundary", "Touch", {
      label: Schema.String,
    }),
    Ping: ExtensionMessage.reply(
      "@test/transport-boundary",
      "Ping",
      { label: Schema.String },
      Schema.Struct({ ok: Schema.Boolean }),
    ),
  }
  const boundaryExtension: LoadedExtension = {
    manifest: { id: "@test/transport-boundary" },
    scope: "builtin",
    sourcePath: "test",
    contributions: {
      resources: [
        defineResource({
          scope: "process",
          layer: Layer.empty as Layer.Layer<unknown>,
          machine: {
            ...reducerActor({
              id: "@test/transport-boundary",
              initial: {},
              stateSchema: Schema.Struct({}),
              reduce: (state) => ({ state }),
              messageSchema: Schema.Unknown,
              requestSchema: Schema.Unknown,
              receive: (state, message) => {
                const payload = message as { readonly label: string }
                boundaryReceived.push({ kind: "send", label: payload.label })
                return { state }
              },
              request: (state, message) => {
                const payload = message as { readonly label: string }
                boundaryReceived.push({ kind: "ask", label: payload.label })
                return Effect.succeed({ state, reply: { ok: true } })
              },
            }),
            protocols: BoundaryProtocol,
          },
        }),
      ],
    },
  }

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
          const { sessionId, branchId } = yield* client.session.create({
            cwd: "/tmp/gent-extension-request-session",
          })
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

    expect(invoked).toEqual([
      {
        args: "rpc-world",
        sessionId: createdSessionId,
        cwd: "/tmp/gent-extension-request-session",
      },
    ])
  })

  test("RPC request rejects missing sessions instead of using launch cwd", async () => {
    invoked.length = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* createSequenceProvider([textStep("ok")])
          const ext = yield* setupCommandsExt
          const { client } = yield* Gent.test(
            createE2ELayer({ ...e2ePreset, providerLayer, extensions: [ext] }),
          )

          const result = yield* Effect.result(
            client.extension.request({
              sessionId: SessionId.make("missing-extension-request-session"),
              extensionId: "@test/commands",
              capabilityId: "greet",
              intent: "write",
              input: "should-not-run",
              branchId: BranchId.make("missing-extension-request-branch"),
            }),
          )

          expect(result._tag).toBe("Failure")
          expect(invoked).toEqual([])
        }),
      ),
    )
  })

  test("RPC request rejects branches outside the requested session", async () => {
    invoked.length = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* createSequenceProvider([textStep("ok")])
          const ext = yield* setupCommandsExt
          const { client } = yield* Gent.test(
            createE2ELayer({ ...e2ePreset, providerLayer, extensions: [ext] }),
          )
          const first = yield* client.session.create({ cwd: "/tmp/gent-extension-request-first" })
          const second = yield* client.session.create({
            cwd: "/tmp/gent-extension-request-second",
          })

          const result = yield* Effect.result(
            client.extension.request({
              sessionId: first.sessionId,
              extensionId: "@test/commands",
              capabilityId: "greet",
              intent: "write",
              input: "wrong-branch",
              branchId: second.branchId,
            }),
          )

          expect(result._tag).toBe("Failure")
          expect(invoked).toEqual([])
        }),
      ),
    )
  })

  test("RPC send rejects missing sessions before actor dispatch", async () => {
    boundaryReceived.length = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* createSequenceProvider([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [boundaryExtension],
            }),
          )

          const result = yield* Effect.result(
            client.extension.send({
              sessionId: SessionId.make("missing-extension-send-session"),
              branchId: BranchId.make("missing-extension-send-branch"),
              message: BoundaryProtocol.Touch.make({ label: "should-not-run" }),
            }),
          )

          expect(result._tag).toBe("Failure")
          expect(boundaryReceived).toEqual([])
        }),
      ),
    )
  })

  test("RPC send rejects branches outside the requested session", async () => {
    boundaryReceived.length = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* createSequenceProvider([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [boundaryExtension],
            }),
          )
          const first = yield* client.session.create({ cwd: "/tmp/gent-extension-send-first" })
          const second = yield* client.session.create({ cwd: "/tmp/gent-extension-send-second" })

          const result = yield* Effect.result(
            client.extension.send({
              sessionId: first.sessionId,
              branchId: second.branchId,
              message: BoundaryProtocol.Touch.make({ label: "wrong-branch" }),
            }),
          )

          expect(result._tag).toBe("Failure")
          expect(boundaryReceived).toEqual([])
        }),
      ),
    )
  })

  test("RPC ask rejects missing sessions before actor dispatch", async () => {
    boundaryReceived.length = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* createSequenceProvider([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [boundaryExtension],
            }),
          )

          const result = yield* Effect.result(
            client.extension.ask({
              sessionId: SessionId.make("missing-extension-ask-session"),
              branchId: BranchId.make("missing-extension-ask-branch"),
              message: BoundaryProtocol.Ping.make({ label: "should-not-run" }),
            }),
          )

          expect(result._tag).toBe("Failure")
          expect(boundaryReceived).toEqual([])
        }),
      ),
    )
  })

  test("RPC ask rejects branches outside the requested session", async () => {
    boundaryReceived.length = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* createSequenceProvider([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [boundaryExtension],
            }),
          )
          const first = yield* client.session.create({ cwd: "/tmp/gent-extension-ask-first" })
          const second = yield* client.session.create({ cwd: "/tmp/gent-extension-ask-second" })

          const result = yield* Effect.result(
            client.extension.ask({
              sessionId: first.sessionId,
              branchId: second.branchId,
              message: BoundaryProtocol.Ping.make({ label: "wrong-branch" }),
            }),
          )

          expect(result._tag).toBe("Failure")
          expect(boundaryReceived).toEqual([])
        }),
      ),
    )
  })

  test("RPC request provides profile resource services to public capabilities", async () => {
    const profileCwd = "/tmp/gent-extension-request-profile-service"
    const ext: LoadedExtension = {
      manifest: { id: "@test/profile-service-request" },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        resources: [
          defineResource({
            tag: ProfileToken,
            scope: "process",
            layer: Layer.succeed(ProfileToken, {
              read: () => Effect.succeed("profile-token"),
            }),
          }),
        ],
        capabilities: [
          {
            id: "read-profile-token",
            audiences: ["transport-public"],
            intent: "read",
            input: Schema.String,
            output: Schema.String,
            effect: () =>
              Effect.gen(function* () {
                const token = yield* ProfileToken
                return yield* token.read()
              }),
          },
        ],
      },
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const profile = yield* makeProfile(profileCwd, [ext])
          const sessionProfileCacheLayer = SessionProfileCache.Test(
            new Map([[profileCwd, profile]]),
          )
          const { layer: providerLayer } = yield* createSequenceProvider([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [],
              sessionProfileCacheLayer,
            }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: profileCwd })

          const result = yield* client.extension.request({
            sessionId,
            extensionId: "@test/profile-service-request",
            capabilityId: "read-profile-token",
            intent: "read",
            input: "token",
            branchId,
          })

          expect(result).toBe("profile-token")
        }),
      ),
    )
  })

  test("RPC listStatus returns structurally tagged extension health", async () => {
    const failingExtension: GentExtension = {
      manifest: { id: "@test/failing-status" },
      setup: () =>
        Effect.fail(
          new ExtensionLoadError({
            extensionId: "@test/failing-status",
            message: "setup boom",
          }),
        ),
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* createSequenceProvider([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensionInputs: [failingExtension],
            }),
          )
          const { sessionId } = yield* client.session.create({ cwd: "/tmp" })

          const status = yield* client.extension.listStatus({ sessionId })

          expect(status._tag).toBe("degraded")
          if (status._tag !== "degraded") return
          expect(status.healthyExtensions).toEqual([])
          expect(status.degradedExtensions).toHaveLength(1)
          expect(status.degradedExtensions[0]?.manifest.id).toBe("@test/failing-status")
          expect(status.degradedExtensions[0]?.issues).toEqual([
            {
              _tag: "activation-failed",
              phase: "setup",
              error: "setup boom",
            },
          ])
        }),
      ),
    )
  })

  test("model tool execution receives live session mutation capabilities", async () => {
    const ext: LoadedExtension = {
      manifest: { id: "@test/session-mutations" },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        capabilities: [
          {
            id: "create-branch",
            description: "Create a branch through the extension host session API.",
            audiences: ["model"],
            intent: "write",
            input: Schema.Struct({}),
            output: Schema.String,
            effect: (_input, ctx) =>
              ctx.session
                .createBranch({ name: "from extension rpc" })
                .pipe(Effect.map(({ branchId }) => branchId)),
          },
        ],
      },
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* createSequenceProvider([
            toolCallStep("create-branch", {}),
            textStep("done"),
          ])
          const { client } = yield* Gent.test(
            createE2ELayer({ ...e2ePreset, providerLayer, extensions: [ext] }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })

          yield* client.message.send({
            sessionId,
            branchId,
            content: "create a branch",
          })

          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.messages.some((message) =>
                message.parts.some(
                  (part) =>
                    part.type === "tool-result" &&
                    part.toolName === "create-branch" &&
                    part.output.type === "json",
                ),
              ),
            5_000,
            "create-branch tool result",
          )
          const createdBranchId = snapshot.messages
            .flatMap((message) => message.parts)
            .find((part) => part.type === "tool-result" && part.toolName === "create-branch")
            ?.output.value

          expect(typeof createdBranchId).toBe("string")
          expect(createdBranchId).not.toBe(branchId)
        }),
      ),
    )
  })

  test("RPC listCommands omits human-slash capabilities that are not transport-public", async () => {
    const ext: LoadedExtension = {
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
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* createSequenceProvider([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({ ...e2ePreset, providerLayer, extensions: [ext] }),
          )
          const { sessionId } = yield* client.session.create({ cwd: "/tmp" })

          const commands = yield* client.extension.listCommands({ sessionId })

          expect(commands.map((command) => command.name)).toEqual(["visible"])
        }),
      ),
    )
  })

  test("RPC listCommands resolves commands from the requested session profile", async () => {
    const alphaCwd = "/tmp/gent-alpha-profile"
    const betaCwd = "/tmp/gent-beta-profile"
    const alphaExt = makeCommandExtension("@test/alpha-profile", "alpha")
    const betaExt = makeCommandExtension("@test/beta-profile", "beta")

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const alphaProfile = yield* makeProfile(alphaCwd, [alphaExt])
          const betaProfile = yield* makeProfile(betaCwd, [betaExt])
          const sessionProfileCacheLayer = SessionProfileCache.Test(
            new Map([
              [alphaCwd, alphaProfile],
              [betaCwd, betaProfile],
            ]),
          )
          const { layer: providerLayer } = yield* createSequenceProvider([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [],
              sessionProfileCacheLayer,
            }),
          )
          const alpha = yield* client.session.create({ cwd: alphaCwd })
          const beta = yield* client.session.create({ cwd: betaCwd })

          const alphaCommands = yield* client.extension.listCommands({
            sessionId: alpha.sessionId,
          })
          const betaCommands = yield* client.extension.listCommands({
            sessionId: beta.sessionId,
          })

          expect(alphaCommands.map((command) => command.name)).toEqual(["alpha"])
          expect(betaCommands.map((command) => command.name)).toEqual(["beta"])
        }),
      ),
    )
  })
})
