import { describe, test, expect } from "bun:test"
import { Context, Effect, Layer, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ExtensionLoadError,
  type GentExtension,
  type LoadedExtension,
} from "../../src/domain/extension.js"
import { textStep, toolCallStep } from "@gent/core/debug/provider"
import { Provider } from "@gent/core/providers/provider"
import {
  ExtensionRegistry,
  listSlashCommands,
  resolveExtensions,
} from "../../src/runtime/extensions/registry"
import { setupExtension } from "../../src/runtime/extensions/loader"
import { Storage } from "../../src/storage/sqlite-storage"
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
import { action, request, tool } from "@gent/core/extensions/api"
import { BranchId, type ExtensionId, SessionId } from "@gent/core/domain/ids"
import { ExtensionMessage } from "@gent/core/domain/extension-protocol"
import { reducerActor } from "../extensions/helpers/reducer-actor"
import { ConfigService } from "../../src/runtime/config-service"

class ProfileToken extends Context.Service<
  ProfileToken,
  { readonly read: () => Effect.Effect<string> }
>()("@test/ProfileToken") {}

describe("extension command RPCs", () => {
  const invoked: Array<{ args: string; sessionId: string; cwd: string }> = []

  // Slash commands are authored via `action({ surface: "slash" })` (lowers to
  // `audiences: ["human-slash"]` in the `commands:` bucket). `action()` requires
  // a `description` which is shown in the slash list; `promptSnippet` is an
  // optional system-prompt fragment.
  const TestCommandsExtension: GentExtension = {
    manifest: { id: "@test/commands" },
    setup: () =>
      Effect.succeed({
        commands: [
          action({
            id: "greet",
            name: "greet",
            description: "Say hello",
            surface: "slash",
            public: true,
            promptSnippet: "Say hello",
            input: Schema.String,
            output: Schema.Void,
            execute: (args, ctx) =>
              Effect.sync(() => {
                invoked.push({ args, sessionId: ctx.sessionId, cwd: ctx.cwd })
              }),
          }),
          action({
            id: "noop",
            name: "noop",
            description: "noop",
            surface: "slash",
            input: Schema.String,
            output: Schema.Void,
            execute: () => Effect.void,
          }),
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
      commands: [
        action({
          id: commandId,
          name: commandId,
          description: commandId,
          surface: "slash",
          public: true,
          input: Schema.String,
          output: Schema.Void,
          execute: () => Effect.void,
        }),
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
        expect(testCmds.find((c) => c.name === "noop")?.description).toBe("noop")
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
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
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
        }).pipe(Effect.timeout("4 seconds")),
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
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
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
        }).pipe(Effect.timeout("4 seconds")),
      ),
    )
  })

  test("RPC request rejects branches outside the requested session", async () => {
    invoked.length = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
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
        }).pipe(Effect.timeout("4 seconds")),
      ),
    )
  })

  test("RPC send rejects missing sessions before actor dispatch", async () => {
    boundaryReceived.length = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
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
        }).pipe(Effect.timeout("4 seconds")),
      ),
    )
  })

  test("RPC send rejects branches outside the requested session", async () => {
    boundaryReceived.length = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
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
        }).pipe(Effect.timeout("4 seconds")),
      ),
    )
  })

  test("RPC ask rejects missing sessions before actor dispatch", async () => {
    boundaryReceived.length = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
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
        }).pipe(Effect.timeout("4 seconds")),
      ),
    )
  })

  test("RPC ask rejects branches outside the requested session", async () => {
    boundaryReceived.length = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
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
        }).pipe(Effect.timeout("4 seconds")),
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
        rpc: [
          request({
            id: "read-profile-token",
            extensionId: "@test/profile-service-request" as ExtensionId,
            intent: "write",
            input: Schema.String,
            output: Schema.String,
            execute: () =>
              Effect.gen(function* () {
                const token = yield* ProfileToken
                return yield* token.read()
              }),
          }),
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
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
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
            intent: "write",
            input: "token",
            branchId,
          })

          expect(result).toBe("profile-token")
        }).pipe(Effect.timeout("4 seconds")),
      ),
    )
  })

  test("RPC request resolves resources from SessionProfileCache.Live", async () => {
    const home = mkdtempSync(join(tmpdir(), "gent-live-profile-home-"))
    const profileCwd = mkdtempSync(join(tmpdir(), "gent-live-profile-cwd-"))
    const ext: GentExtension = {
      manifest: { id: "@test/live-profile-service-request" },
      setup: (ctx) =>
        Effect.succeed({
          resources: [
            defineResource({
              tag: ProfileToken,
              scope: "process",
              layer: Layer.succeed(ProfileToken, {
                read: () => Effect.succeed(`live:${ctx.cwd}`),
              }),
            }),
          ],
          rpc: [
            request({
              id: "read-live-profile-token",
              extensionId: "@test/live-profile-service-request" as ExtensionId,
              intent: "write",
              input: Schema.String,
              output: Schema.String,
              execute: () =>
                Effect.gen(function* () {
                  const token = yield* ProfileToken
                  return yield* token.read()
                }),
            }),
          ],
        }),
    }

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const sessionProfileCacheLayer = SessionProfileCache.Live({
              home,
              platform: "test",
              extensions: [ext],
            }).pipe(
              Layer.provide(
                Layer.mergeAll(BunServices.layer, ConfigService.Test(), Storage.MemoryWithSql()),
              ),
            )
            const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
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
              extensionId: "@test/live-profile-service-request",
              capabilityId: "read-live-profile-token",
              intent: "write",
              input: "token",
              branchId,
            })

            expect(result).toBe(`live:${profileCwd}`)
          }).pipe(Effect.timeout("4 seconds")),
        ),
      )
    } finally {
      rmSync(profileCwd, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("RPC request gives transport-public handlers the wide host context (ctx.extension.send)", async () => {
    // Regression: `action({ public: true })` handlers are typed against
    // `ModelCapabilityContext` and call `ctx.extension.send(...)`. Pre-fix,
    // `extension.request` passed a narrow 4-key ctx so the narrowCtxGuard
    // threw on `ctx.extension` and the transport path silently no-op'd
    // (the exact bug behind `/executor-start` / `/executor-stop`).
    boundaryReceived.length = 0

    const wideExtension: GentExtension = {
      manifest: { id: "@test/wide-ctx-action" },
      setup: () =>
        Effect.succeed({
          commands: [
            action({
              id: "touch",
              name: "touch",
              description: "Touch the boundary",
              surface: "slash",
              public: true,
              input: Schema.String,
              output: Schema.Void,
              execute: (label, ctx) =>
                ctx.extension.send(BoundaryProtocol.Touch.make({ label })).pipe(Effect.orDie),
            }),
          ],
        }),
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wideExt = yield* Effect.provide(
            setupExtension(
              { extension: wideExtension, scope: "builtin", sourcePath: "builtin" },
              "/test/cwd",
              "/test/home",
            ),
            BunServices.layer,
          )
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [boundaryExtension, wideExt],
            }),
          )
          const { sessionId, branchId } = yield* client.session.create({
            cwd: "/tmp/gent-wide-ctx-action",
          })

          yield* client.extension.request({
            sessionId,
            extensionId: "@test/wide-ctx-action",
            capabilityId: "touch",
            intent: "write",
            input: "wide-ctx-ok",
            branchId,
          })

          yield* waitFor(
            Effect.sync(() => boundaryReceived.length),
            (count) => count > 0,
            5_000,
            "boundary to receive send",
          )
        }).pipe(Effect.timeout("4 seconds")),
      ),
    )

    expect(boundaryReceived).toEqual([{ kind: "send", label: "wide-ctx-ok" }])
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
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
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
        }).pipe(Effect.timeout("4 seconds")),
      ),
    )
  })

  test("model tool execution receives live session mutation capabilities", async () => {
    const ext: LoadedExtension = {
      manifest: { id: "@test/session-mutations" },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        tools: [
          tool({
            id: "create-branch",
            description: "Create a branch through the extension host session API.",
            params: Schema.Struct({}),
            execute: (_input, ctx) =>
              ctx.session
                .createBranch({ name: "from extension rpc" })
                .pipe(Effect.map(({ branchId }) => branchId)),
          }),
        ],
      },
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* Provider.Sequence([
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
        }).pipe(Effect.timeout("4 seconds")),
      ),
    )
  })

  test("RPC listCommands omits human-slash capabilities that are not transport-public", async () => {
    const ext: LoadedExtension = {
      manifest: { id: "@test/public-filter" },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        commands: [
          action({
            id: "visible",
            name: "visible",
            description: "visible",
            surface: "slash",
            public: true,
            input: Schema.String,
            output: Schema.Void,
            execute: () => Effect.void,
          }),
          action({
            id: "hidden",
            name: "hidden",
            description: "hidden",
            surface: "slash",
            input: Schema.String,
            output: Schema.Void,
            execute: () => Effect.void,
          }),
        ],
      },
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({ ...e2ePreset, providerLayer, extensions: [ext] }),
          )
          const { sessionId } = yield* client.session.create({ cwd: "/tmp" })

          const commands = yield* client.extension.listCommands({ sessionId })

          expect(commands.map((command) => command.name)).toEqual(["visible"])
        }).pipe(Effect.timeout("4 seconds")),
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
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
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
        }).pipe(Effect.timeout("4 seconds")),
      ),
    )
  })
})
