import { describe, expect, it } from "effect-bun-test"
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
import { SlashCommandInfo } from "@gent/core/server/transport-contract"
import { e2ePreset, toolPreset } from "../extensions/helpers/test-preset"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { ExtensionRuntime } from "../../src/runtime/extensions/resource-host/extension-runtime"
import { ActorEngine } from "../../src/runtime/extensions/actor-engine"
import { Receptionist } from "../../src/runtime/extensions/receptionist"
import { SessionProfileCache, type SessionProfile } from "../../src/runtime/session-profile"
import { waitFor } from "@gent/core/test-utils/fixtures"
import { buildExtensionLayers } from "../../src/runtime/profile"
import { defineResource } from "@gent/core/domain/resource"
import { action, request, tool } from "@gent/core/extensions/api"
import { BranchId, ExtensionId, SessionId } from "@gent/core/domain/ids"
import { ConfigService } from "../../src/runtime/config-service"
class ProfileToken extends Context.Service<
  ProfileToken,
  {
    readonly read: () => Effect.Effect<string>
  }
>()("@test/ProfileToken") {}
const narrowR = <A, E>(e: Effect.Effect<A, E, unknown>): Effect.Effect<A, E, never> =>
  e as Effect.Effect<A, E, never>
describe("extension command RPCs", () => {
  const invoked: Array<{
    args: string
    sessionId: string
    cwd: string
  }> = []
  // Server-visible slash commands are slash-decorated RPC requests. Local
  // human-only commands stay in the `commands:` bucket and are not listed by
  // the transport API.
  const TestCommandsExtension: GentExtension = {
    manifest: { id: ExtensionId.make("@test/commands") },
    setup: () =>
      Effect.succeed({
        rpc: [
          request({
            id: "greet",
            extensionId: ExtensionId.make("@test/commands"),
            intent: "write",
            slash: { name: "greet", description: "Say hello" },
            description: "Say hello",
            input: Schema.String,
            output: Schema.Void,
            execute: (args, ctx) =>
              Effect.sync(() => {
                invoked.push({ args, sessionId: ctx.sessionId, cwd: ctx.cwd })
              }),
          }),
        ],
        commands: [
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
        extensionRuntime: Context.get(layerContext, ExtensionRuntime),
        actorEngine: Context.get(layerContext, ActorEngine),
        receptionist: Context.get(layerContext, Receptionist),
        baseSections: [],
        instructions: "",
      } satisfies SessionProfile
    })
  const makeCommandExtension = (extensionId: string, commandId: string): LoadedExtension => ({
    manifest: { id: ExtensionId.make(extensionId) },
    scope: "builtin",
    sourcePath: "test",
    contributions: {
      rpc: [
        request({
          id: commandId,
          extensionId: ExtensionId.make(extensionId),
          intent: "write",
          slash: { name: commandId, description: commandId },
          input: Schema.String,
          output: Schema.Void,
          execute: () => Effect.void,
        }),
      ],
    },
  })
  it.live("listSlashCommands returns registered commands", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const registry = yield* ExtensionRegistry
        const cmds = listSlashCommands(registry.getResolved().extensions)
        const testCmds = cmds.filter((c) => c.name === "greet" || c.name === "noop")
        expect(testCmds).toHaveLength(2)
        expect(testCmds.find((c) => c.name === "greet")?.description).toBe("Say hello")
        expect(testCmds.find((c) => c.name === "noop")?.description).toBe("noop")
      }).pipe(Effect.provide(layer)) as Effect.Effect<void, never, never>
    }),
  )
  it.live("RPC listSlashCommands + request round-trip through the transport boundary", () =>
    Effect.gen(function* () {
      invoked.length = 0
      let createdSessionId = ""
      yield* narrowR(
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
            const commands = yield* client.extension.listSlashCommands({ sessionId })
            expect(commands[0]).toBeInstanceOf(SlashCommandInfo)
            expect(commands.map((command) => command.name)).toEqual(["greet"])
            const greet = commands.find((command) => command.name === "greet")
            expect(greet?.description).toBe("Say hello")
            expect(greet?.extensionId).toBe(ExtensionId.make("@test/commands"))
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
    }),
  )
  it.live("RPC request rejects missing sessions instead of using launch cwd", () =>
    Effect.gen(function* () {
      invoked.length = 0
      yield* narrowR(
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
                extensionId: ExtensionId.make("@test/commands"),
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
    }),
  )
  it.live("RPC request rejects branches outside the requested session", () =>
    Effect.gen(function* () {
      invoked.length = 0
      yield* Effect.scoped(
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
              extensionId: ExtensionId.make("@test/commands"),
              capabilityId: "greet",
              intent: "write",
              input: "wrong-branch",
              branchId: second.branchId,
            }),
          )
          expect(result._tag).toBe("Failure")
          expect(invoked).toEqual([])
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("RPC request provides profile resource services to public capabilities", () =>
    Effect.gen(function* () {
      const profileCwd = "/tmp/gent-extension-request-profile-service"
      const ext: LoadedExtension = {
        manifest: { id: ExtensionId.make("@test/profile-service-request") },
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
              extensionId: ExtensionId.make("@test/profile-service-request") as ExtensionId,
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
      yield* narrowR(
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
              extensionId: ExtensionId.make("@test/profile-service-request"),
              capabilityId: "read-profile-token",
              intent: "write",
              input: "token",
              branchId,
            })
            expect(result).toBe("profile-token")
          }).pipe(Effect.timeout("4 seconds")),
        ),
      )
    }),
  )
  it.live("RPC request resolves resources from SessionProfileCache.Live", () =>
    Effect.gen(function* () {
      const home = mkdtempSync(join(tmpdir(), "gent-live-profile-home-"))
      const profileCwd = mkdtempSync(join(tmpdir(), "gent-live-profile-cwd-"))
      const ext: GentExtension = {
        manifest: { id: ExtensionId.make("@test/live-profile-service-request") },
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
                extensionId: ExtensionId.make("@test/live-profile-service-request") as ExtensionId,
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
      yield* Effect.acquireUseRelease(
        Effect.void,
        () =>
          Effect.gen(function* () {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const sessionProfileCacheLayer = SessionProfileCache.Live({
                  home,
                  platform: "test",
                  extensions: [ext],
                }).pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      BunServices.layer,
                      ConfigService.Test(),
                      Storage.MemoryWithSql(),
                    ),
                  ),
                ) as Layer.Layer<SessionProfileCache>
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
                  extensionId: ExtensionId.make("@test/live-profile-service-request"),
                  capabilityId: "read-live-profile-token",
                  intent: "write",
                  input: "token",
                  branchId,
                })
                expect(result).toBe(`live:${profileCwd}`)
              }).pipe(Effect.timeout("4 seconds")),
            )
          }),
        () =>
          Effect.sync(() => {
            rmSync(profileCwd, { recursive: true, force: true })
            rmSync(home, { recursive: true, force: true })
          }),
      )
    }),
  )
  it.live("RPC listStatus returns structurally tagged extension health", () =>
    Effect.gen(function* () {
      const failingExtension: GentExtension = {
        manifest: { id: ExtensionId.make("@test/failing-status") },
        setup: () =>
          Effect.fail(
            new ExtensionLoadError({
              extensionId: ExtensionId.make("@test/failing-status"),
              message: "setup boom",
            }),
          ),
      }
      yield* narrowR(
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
    }),
  )
  it.live("model tool execution receives live session mutation capabilities", () =>
    Effect.gen(function* () {
      const ext: LoadedExtension = {
        manifest: { id: ExtensionId.make("@test/session-mutations") },
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
      yield* Effect.scoped(
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
            5000,
            "create-branch tool result",
          )
          const createdBranchPart = snapshot.messages
            .flatMap((message) => message.parts)
            .find((part) => part.type === "tool-result" && part.toolName === "create-branch")
          const createdBranchId =
            createdBranchPart && createdBranchPart.type === "tool-result"
              ? createdBranchPart.output.value
              : undefined
          expect(typeof createdBranchId).toBe("string")
          expect(createdBranchId).not.toBe(branchId)
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("RPC listSlashCommands omits local slash actions and lists slash requests", () =>
    Effect.gen(function* () {
      const extensionId = ExtensionId.make("@test/public-filter")
      const ext: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "builtin",
        sourcePath: "test",
        contributions: {
          rpc: [
            request({
              id: "visible",
              extensionId,
              intent: "write",
              slash: { name: "visible", description: "visible" },
              input: Schema.String,
              output: Schema.Void,
              execute: () => Effect.void,
            }),
          ],
          commands: [
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
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({ ...e2ePreset, providerLayer, extensions: [ext] }),
          )
          const { sessionId } = yield* client.session.create({ cwd: "/tmp" })
          const commands = yield* client.extension.listSlashCommands({ sessionId })
          expect(commands.map((command) => command.name)).toEqual(["visible"])
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("RPC request cannot invoke lower-scope slash request shadowed by project command", () =>
    Effect.gen(function* () {
      const extensionId = ExtensionId.make("@test/public-shadow")
      const builtinExt: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "builtin",
        sourcePath: "builtin",
        contributions: {
          rpc: [
            request({
              id: "shadowed",
              extensionId,
              intent: "write",
              slash: { name: "shadowed", description: "shadowed" },
              input: Schema.Struct({ value: Schema.String }),
              output: Schema.Struct({ value: Schema.String }),
              execute: () => Effect.succeed({ value: "builtin" }),
            }),
          ],
        },
      }
      const projectExt: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "project",
        sourcePath: "project",
        contributions: {
          commands: [
            action({
              id: "shadowed",
              name: "shadowed private",
              description: "shadowed private",
              surface: "slash",
              input: Schema.Struct({ value: Schema.String }),
              output: Schema.Struct({ value: Schema.String }),
              execute: (input) => Effect.succeed({ value: input.value }),
            }),
          ],
        },
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [builtinExt, projectExt],
            }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
          const commands = yield* client.extension.listSlashCommands({ sessionId })
          expect(commands.map((command) => command.name)).toEqual([])
          const result = yield* client.extension
            .request({
              sessionId,
              branchId,
              extensionId,
              capabilityId: "shadowed",
              intent: "write",
              input: { value: "hi" },
            })
            .pipe(Effect.flip)
          expect(result._tag).toBe("ExtensionProtocolError")
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("RPC listSlashCommands omits lower-scope slash request shadowed by project request", () =>
    Effect.gen(function* () {
      const extensionId = ExtensionId.make("@test/public-rpc-shadow")
      const builtinExt: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "builtin",
        sourcePath: "builtin",
        contributions: {
          rpc: [
            request({
              id: "shadowed",
              extensionId,
              intent: "write",
              slash: { name: "shadowed", description: "shadowed" },
              input: Schema.Struct({ value: Schema.String }),
              output: Schema.Struct({ value: Schema.String }),
              execute: () => Effect.succeed({ value: "builtin" }),
            }),
          ],
        },
      }
      const projectExt: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "project",
        sourcePath: "project",
        contributions: {
          rpc: [
            request({
              id: "shadowed",
              extensionId,
              intent: "write",
              input: Schema.Struct({ value: Schema.String }),
              output: Schema.Struct({ value: Schema.String }),
              execute: (input) => Effect.succeed({ value: input.value }),
            }),
          ],
        },
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [builtinExt, projectExt],
            }),
          )
          const { sessionId } = yield* client.session.create({ cwd: "/tmp" })
          const commands = yield* client.extension.listSlashCommands({ sessionId })
          expect(commands.map((command) => command.name)).toEqual([])
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("RPC listSlashCommands omits lower-scope slash request shadowed by project tool", () =>
    Effect.gen(function* () {
      const extensionId = ExtensionId.make("@test/public-tool-shadow")
      const builtinExt: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "builtin",
        sourcePath: "builtin",
        contributions: {
          rpc: [
            request({
              id: "shadowed",
              extensionId,
              intent: "write",
              slash: { name: "shadowed", description: "shadowed" },
              input: Schema.Struct({ value: Schema.String }),
              output: Schema.Struct({ value: Schema.String }),
              execute: () => Effect.succeed({ value: "builtin" }),
            }),
          ],
        },
      }
      const projectExt: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "project",
        sourcePath: "project",
        contributions: {
          tools: [
            tool({
              id: "shadowed",
              description: "shadowed tool",
              params: Schema.Struct({ value: Schema.String }),
              execute: (input) => Effect.succeed({ value: input.value }),
            }),
          ],
        },
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [builtinExt, projectExt],
            }),
          )
          const { sessionId } = yield* client.session.create({ cwd: "/tmp" })
          const commands = yield* client.extension.listSlashCommands({ sessionId })
          expect(commands.map((command) => command.name)).toEqual([])
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("RPC listSlashCommands resolves commands from the requested session profile", () =>
    Effect.gen(function* () {
      const alphaCwd = "/tmp/gent-alpha-profile"
      const betaCwd = "/tmp/gent-beta-profile"
      const alphaExt = makeCommandExtension("@test/alpha-profile", "alpha")
      const betaExt = makeCommandExtension("@test/beta-profile", "beta")
      yield* Effect.scoped(
        narrowR(
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
            const alphaCommands = yield* client.extension.listSlashCommands({
              sessionId: alpha.sessionId,
            })
            const betaCommands = yield* client.extension.listSlashCommands({
              sessionId: beta.sessionId,
            })
            expect(alphaCommands.map((command) => command.name)).toEqual(["alpha"])
            expect(betaCommands.map((command) => command.name)).toEqual(["beta"])
          }).pipe(Effect.timeout("4 seconds")),
        ),
      )
    }),
  )
})
