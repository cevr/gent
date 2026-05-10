import { describe, expect, it } from "effect-bun-test"
import { Cause, Context, Effect, Exit, FileSystem, Layer, Option, Schema } from "effect"
import { narrowR } from "../helpers/effect"
import {
  ExtensionLoadError,
  type GentExtension,
  type LoadedExtension,
} from "../../src/domain/extension.js"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import {
  ExtensionRegistry,
  listSlashCommands,
  resolveExtensions,
} from "../../src/runtime/extensions/registry"
import { SqliteStorage } from "../../src/storage/sqlite-storage"
import { ApprovalService } from "../../src/runtime/approval-service"
import { createToolTestLayer } from "@gent/core-internal/test-utils/extension-harness"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { BunPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun"
import { SlashCommandInfo } from "@gent/core-internal/server/transport-contract"
import { e2ePreset, toolPreset } from "../../../extensions/tests/helpers/test-preset"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { SessionProfileCache, type SessionProfile } from "../../src/runtime/session-profile"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"
import { buildExtensionLayers } from "../../src/runtime/profile"
import { defineResource } from "@gent/core-internal/domain/resource"
import { CapabilityError, ExtensionContext, request, tool } from "@gent/core/extensions/api"
import * as ExtensionApi from "@gent/core/extensions/api"
import { BranchId, ExtensionId, MessageId, SessionId } from "@gent/core-internal/domain/ids"
import { ConfigService } from "../../src/runtime/config-service"
import { TodoStorage } from "../../../extensions/src/todo-storage.js"
class ProfileToken extends Context.Service<
  ProfileToken,
  {
    readonly read: () => Effect.Effect<string, never, never>
  }
>()("@gent/core/tests/server/extension-commands-rpc.test/ProfileToken") {}
const expectExtensionProtocolFailure = (cause: Cause.Cause<unknown>, message?: string) => {
  const error = Cause.squash(cause) as { readonly _tag?: string; readonly message?: string }
  expect(error._tag).toBe("ExtensionProtocolError")
  if (message !== undefined) expect(error.message).toBe(message)
}
describe("extension command RPCs", () => {
  const invoked: Array<{
    args: string
    sessionId: string
    cwd: string
  }> = []
  // Server-visible slash commands are slash-decorated requests.
  const TestCommandsExtension: GentExtension = {
    manifest: { id: ExtensionId.make("@test/commands") },
    setup: () =>
      Effect.succeed({
        requests: [
          request({
            id: "greet",
            extensionId: ExtensionId.make("@test/commands"),
            slash: { name: "greet", description: "Say hello" },
            description: "Say hello",
            input: Schema.String,
            output: Schema.Void,
            execute: (args) =>
              Effect.gen(function* () {
                const ctx = yield* ExtensionContext
                invoked.push({ args, sessionId: ctx.sessionId, cwd: ctx.cwd })
              }),
          }),
          request({
            id: "noop",
            extensionId: ExtensionId.make("@test/commands"),
            slash: { name: "noop", description: "noop" },
            description: "noop",
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
  it.live("extension author API does not export capability authority providers", () =>
    Effect.sync(() => {
      expect("CapabilityAccess" in ExtensionApi).toBe(false)
      expect("provideCapabilityAccessNeeds" in ExtensionApi).toBe(false)
    }),
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
        baseSections: [],
        instructions: "",
      } satisfies SessionProfile
    })
  const makeCommandExtension = (extensionId: string, commandId: string): LoadedExtension => ({
    manifest: { id: ExtensionId.make(extensionId) },
    scope: "builtin",
    sourcePath: "test",
    contributions: {
      requests: [
        request({
          id: commandId,
          extensionId: ExtensionId.make(extensionId),
          slash: { name: commandId, description: commandId },
          input: Schema.String,
          output: Schema.Void,
          execute: () => Effect.void,
        }),
      ],
    },
  })
  it.live(
    "listSlashCommands returns registered commands",
    () =>
      Effect.gen(function* () {
        const registry = yield* ExtensionRegistry
        const cmds = listSlashCommands(registry.getResolved())
        const testCmds = cmds.filter((c) => c.name === "greet" || c.name === "noop")
        expect(testCmds).toHaveLength(2)
        expect(testCmds.find((c) => c.name === "greet")?.description).toBe("Say hello")
        expect(testCmds.find((c) => c.name === "noop")?.description).toBe("noop")
      }).pipe(Effect.provide(layer)) as Effect.Effect<void, never, never>,
  )
  it.live("RPC listSlashCommands + request round-trip through the transport boundary", () =>
    Effect.gen(function* () {
      invoked.length = 0
      let createdSessionId = ""
      yield* narrowR(
        Effect.scoped(
          Effect.gen(function* () {
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
            const { client, sessionId, branchId } = yield* createRpcHarness({
              ...e2ePreset,
              providerLayer,
              extensionInputs: [TestCommandsExtension],
              cwd: "/tmp/gent-extension-request-session",
            })
            createdSessionId = sessionId
            const commands = yield* client.extension.listSlashCommands({ sessionId })
            expect(commands[0]).toBeInstanceOf(SlashCommandInfo)
            expect(commands.map((command) => command.name)).toEqual(["greet", "noop"])
            const greet = commands.find((command) => command.name === "greet")
            expect(greet?.description).toBe("Say hello")
            expect(greet?.extensionId).toBe(ExtensionId.make("@test/commands"))
            expect(greet?.capabilityId).toBe("greet")
            yield* client.extension.request({
              sessionId,
              extensionId: greet!.extensionId,
              capabilityId: greet!.capabilityId,
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
  it.live("RPC request can queue follow-up through ExtensionContext service", () =>
    Effect.gen(function* () {
      const extensionId = ExtensionId.make("@test/queue-follow-up-request")
      const ext: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "builtin",
        sourcePath: "test",
        contributions: {
          requests: [
            request({
              id: "queue-follow-up",
              extensionId,
              input: Schema.String,
              output: Schema.Void,
              execute: (input) =>
                Effect.gen(function* () {
                  const ctx = yield* ExtensionContext
                  yield* ctx.Session.queueFollowUp({ sourceId: "test-rpc-request", content: input })
                }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new CapabilityError({
                        extensionId,
                        capabilityId: "queue-follow-up",
                        reason: cause.message,
                      }),
                  ),
                ),
            }),
          ],
        },
      }
      yield* narrowR(
        Effect.scoped(
          Effect.gen(function* () {
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
            const { client, sessionId, branchId } = yield* createRpcHarness({
              ...e2ePreset,
              providerLayer,
              extensions: [ext],
              cwd: "/tmp/gent-extension-queue-follow-up",
            })
            yield* client.extension.request({
              sessionId,
              branchId,
              extensionId,
              capabilityId: "queue-follow-up",
              input: "queued through public rpc",
            })
            const queue = yield* client.queue.get({ sessionId, branchId })
            expect(queue.steering).toEqual([])
            expect(queue.followUp).toEqual([
              expect.objectContaining({
                _tag: "follow-up",
                content: "queued through public rpc",
              }),
            ])
          }).pipe(Effect.timeout("4 seconds")),
        ),
      )
    }),
  )
  it.live("RPC request runs slash request with ExtensionContext service", () =>
    Effect.gen(function* () {
      const extensionId = ExtensionId.make("@test/queue-follow-up-slash")
      const ext: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "builtin",
        sourcePath: "test",
        contributions: {
          requests: [
            request({
              id: "queue-follow-up-slash",
              extensionId,
              slash: {
                trigger: "queue-follow-up",
                name: "Queue Follow Up",
                description: "Queue follow-up request",
              },
              description: "Queue follow-up request",
              input: Schema.String,
              output: Schema.Void,
              execute: (input: string) =>
                Effect.gen(function* () {
                  const ctx = yield* ExtensionContext
                  yield* ctx.Session.queueFollowUp({
                    sourceId: "test-slash-request",
                    content: input,
                  })
                }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new CapabilityError({
                        extensionId,
                        capabilityId: "queue-follow-up-slash",
                        reason: cause.message,
                      }),
                  ),
                ),
            }),
          ],
        },
      }
      yield* narrowR(
        Effect.scoped(
          Effect.gen(function* () {
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
            const { client, sessionId, branchId } = yield* createRpcHarness({
              ...e2ePreset,
              providerLayer,
              extensions: [ext],
              cwd: "/tmp/gent-extension-queue-follow-up-slash",
            })
            const commands = yield* client.extension.listSlashCommands({ sessionId })
            expect(commands.map((command) => command.name)).toEqual(["queue-follow-up"])
            yield* client.extension.request({
              sessionId,
              branchId,
              extensionId,
              capabilityId: "queue-follow-up-slash",
              input: "queued through slash request",
            })
            const queue = yield* client.queue.get({ sessionId, branchId })
            expect(queue.followUp).toEqual([
              expect.objectContaining({
                _tag: "follow-up",
                content: "queued through slash request",
              }),
            ])
          }).pipe(Effect.timeout("4 seconds")),
        ),
      )
    }),
  )
  it.live("RPC request rejects missing sessions instead of using launch cwd", () =>
    Effect.gen(function* () {
      invoked.length = 0
      yield* narrowR(
        Effect.scoped(
          Effect.gen(function* () {
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
            const { client } = yield* createRpcHarness({
              ...e2ePreset,
              providerLayer,
              extensionInputs: [TestCommandsExtension],
            })
            const result = yield* Effect.exit(
              client.extension.request({
                sessionId: SessionId.make("missing-extension-request-session"),
                extensionId: ExtensionId.make("@test/commands"),
                capabilityId: "greet",
                input: "should-not-run",
                branchId: BranchId.make("missing-extension-request-branch"),
              }),
            )
            expect(result._tag).toBe("Failure")
            if (result._tag === "Failure") {
              expectExtensionProtocolFailure(
                result.cause,
                "Session not found for extension transport",
              )
            }
            expect(invoked).toEqual([])
          }).pipe(Effect.timeout("4 seconds")),
        ),
      )
    }),
  )
  it.live("RPC request rejects missing branches", () =>
    Effect.gen(function* () {
      invoked.length = 0
      yield* narrowR(
        Effect.scoped(
          Effect.gen(function* () {
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
            const { client, sessionId } = yield* createRpcHarness({
              ...e2ePreset,
              providerLayer,
              extensionInputs: [TestCommandsExtension],
              cwd: "/tmp/gent-extension-request-missing-branch",
            })
            const result = yield* Effect.exit(
              client.extension.request({
                sessionId,
                extensionId: ExtensionId.make("@test/commands"),
                capabilityId: "greet",
                input: "should-not-run",
                branchId: BranchId.make("missing-extension-request-branch"),
              }),
            )
            expect(result._tag).toBe("Failure")
            if (result._tag === "Failure") {
              expectExtensionProtocolFailure(
                result.cause,
                "Branch does not belong to extension transport session",
              )
            }
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
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [TestCommandsExtension],
            cwd: "/tmp/gent-extension-request-first",
          })
          const first = { sessionId, branchId }
          const second = yield* client.session.create({
            cwd: "/tmp/gent-extension-request-second",
          })
          const result = yield* Effect.exit(
            client.extension.request({
              sessionId: first.sessionId,
              extensionId: ExtensionId.make("@test/commands"),
              capabilityId: "greet",
              input: "wrong-branch",
              branchId: second.branchId,
            }),
          )
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expectExtensionProtocolFailure(
              result.cause,
              "Branch does not belong to extension transport session",
            )
          }
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
          requests: [
            request({
              id: "read-profile-token",
              extensionId: ExtensionId.make("@test/profile-service-request") as ExtensionId,
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
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
            const { client, sessionId, branchId } = yield* createRpcHarness({
              ...e2ePreset,
              providerLayer,
              extensions: [],
              sessionProfileCacheLayer,
              cwd: profileCwd,
            })
            const result = yield* client.extension.request({
              sessionId,
              extensionId: ExtensionId.make("@test/profile-service-request"),
              capabilityId: "read-profile-token",
              input: "token",
              branchId,
            })
            expect(result).toBe("profile-token")
          }).pipe(Effect.timeout("4 seconds")),
        ),
      )
    }),
  )
  it.scoped("RPC request resolves resources from SessionProfileCache.Live", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const profileCwd = yield* fs.makeTempDirectoryScoped()
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
            requests: [
              request({
                id: "read-live-profile-token",
                extensionId: ExtensionId.make("@test/live-profile-service-request") as ExtensionId,
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
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sessionProfileCacheLayer = SessionProfileCache.Live({
            home,
            platform: "test",
            extensions: [ext],
          }).pipe(
            Layer.provide(
              Layer.mergeAll(BunPlatformLive, ConfigService.Test(), SqliteStorage.MemoryWithSql()),
            ),
          ) as Layer.Layer<SessionProfileCache>
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [],
            sessionProfileCacheLayer,
            cwd: profileCwd,
          })
          const result = yield* client.extension.request({
            sessionId,
            extensionId: ExtensionId.make("@test/live-profile-service-request"),
            capabilityId: "read-live-profile-token",
            input: "token",
            branchId,
          })
          expect(result).toBe(`live:${profileCwd}`)
        }).pipe(Effect.timeout("4 seconds")),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
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
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
            const { client, sessionId } = yield* createRpcHarness({
              ...e2ePreset,
              providerLayer,
              extensionInputs: [failingExtension],
              cwd: "/tmp",
            })
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
              output: Schema.String,
              execute: () =>
                Effect.gen(function* () {
                  const ctx = yield* ExtensionContext
                  return yield* ctx.Session.createBranch({ name: "from extension rpc" }).pipe(
                    Effect.map(({ branchId }) => branchId),
                  )
                }),
            }),
          ],
        },
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("create-branch", {}),
            textStep("done"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [ext],
            cwd: "/tmp",
          })
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
                    part.type === "tool-result" && part.name === "create-branch" && !part.isFailure,
                ),
              ),
            5000,
            "create-branch tool result",
          )
          const createdBranchPart = snapshot.messages
            .flatMap((message) => message.parts)
            .find((part) => part.type === "tool-result" && part.name === "create-branch")
          const createdBranchInteraction = snapshot.messages
            .flatMap((message) => message.toolInteractions)
            .find((interaction) => interaction.toolName === "create-branch")
          const createdBranchId =
            createdBranchPart && createdBranchPart.type === "tool-result"
              ? createdBranchPart.result
              : undefined
          if (typeof createdBranchId !== "string") {
            throw new Error("expected create-branch tool result to contain branch id")
          }
          expect(createdBranchId).not.toBe(branchId)
          expect(createdBranchInteraction?.status).toBe("completed")
          expect(createdBranchInteraction?.output).toBe(createdBranchId)
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("RPC requests receive live fork/delete session mutation capabilities", () =>
    Effect.gen(function* () {
      const extensionId = ExtensionId.make("@test/session-mutation-requests")
      const mapHostError = (capabilityId: string) => (cause: { readonly message: string }) =>
        new CapabilityError({ extensionId, capabilityId, reason: cause.message })
      const ext: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "builtin",
        sourcePath: "test",
        contributions: {
          requests: [
            request({
              id: "fork-current-branch",
              extensionId,
              input: Schema.String,
              output: Schema.String,
              execute: (messageId) =>
                Effect.gen(function* () {
                  const ctx = yield* ExtensionContext
                  return yield* ctx.Session.forkBranch({
                    atMessageId: MessageId.make(messageId),
                    name: "forked through extension rpc",
                  }).pipe(
                    Effect.map(({ branchId }) => String(branchId)),
                    Effect.mapError(mapHostError("fork-current-branch")),
                  )
                }),
            }),
            request({
              id: "create-temporary-branch",
              extensionId,
              input: Schema.Void,
              output: Schema.String,
              execute: () =>
                Effect.gen(function* () {
                  const ctx = yield* ExtensionContext
                  return yield* ctx.Session.createBranch({
                    name: "temporary through extension rpc",
                  }).pipe(
                    Effect.map(({ branchId }) => String(branchId)),
                    Effect.mapError(mapHostError("create-temporary-branch")),
                  )
                }),
            }),
            request({
              id: "delete-branch",
              extensionId,
              input: Schema.String,
              output: Schema.Void,
              execute: (branchId) =>
                Effect.gen(function* () {
                  const ctx = yield* ExtensionContext
                  yield* ctx.Session.deleteBranch(BranchId.make(branchId)).pipe(
                    Effect.mapError(mapHostError("delete-branch")),
                  )
                }),
            }),
            request({
              id: "delete-messages-after",
              extensionId,
              input: Schema.String,
              output: Schema.Void,
              execute: (messageId) =>
                Effect.gen(function* () {
                  const ctx = yield* ExtensionContext
                  yield* ctx.Session.deleteMessages({
                    afterMessageId: MessageId.make(messageId),
                  }).pipe(Effect.mapError(mapHostError("delete-messages-after")))
                }),
            }),
          ],
        },
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("assistant reply before mutation"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [ext],
            cwd: "/tmp",
          })

          yield* client.message.send({
            sessionId,
            branchId,
            content: "message copied by fork",
          })
          const originalSnapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.messages.some((message) =>
                message.parts.some(
                  (part) => part.type === "text" && part.text === "assistant reply before mutation",
                ),
              ),
            5000,
            "seed messages before extension mutation request",
          )
          const userMessage = originalSnapshot.messages.find((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text === "message copied by fork",
            ),
          )
          if (userMessage === undefined) throw new Error("expected seeded user message")

          const decodeString = (value: unknown) =>
            Schema.decodeUnknownEffect(Schema.String)(value).pipe(Effect.orDie)
          const forkedBranchId = yield* decodeString(
            yield* client.extension.request({
              sessionId,
              branchId,
              extensionId,
              capabilityId: "fork-current-branch",
              input: userMessage.id,
            }),
          )
          const forkedSnapshot = yield* client.session.getSnapshot({
            sessionId,
            branchId: BranchId.make(forkedBranchId),
          })
          expect(forkedSnapshot.messages.map((message) => message.role)).toEqual(["user"])
          expect(
            forkedSnapshot.messages[0]?.parts.some(
              (part) => part.type === "text" && part.text === "message copied by fork",
            ),
          ).toBe(true)

          const temporaryBranchId = yield* decodeString(
            yield* client.extension.request({
              sessionId,
              branchId,
              extensionId,
              capabilityId: "create-temporary-branch",
              input: undefined,
            }),
          )
          expect((yield* client.branch.list({ sessionId })).map((branch) => branch.id)).toContain(
            BranchId.make(temporaryBranchId),
          )
          yield* client.extension.request({
            sessionId,
            branchId,
            extensionId,
            capabilityId: "delete-branch",
            input: temporaryBranchId,
          })
          expect(
            (yield* client.branch.list({ sessionId })).map((branch) => branch.id),
          ).not.toContain(BranchId.make(temporaryBranchId))

          yield* client.extension.request({
            sessionId,
            branchId,
            extensionId,
            capabilityId: "delete-messages-after",
            input: userMessage.id,
          })
          const truncatedSnapshot = yield* client.session.getSnapshot({ sessionId, branchId })
          expect(truncatedSnapshot.messages.map((message) => message.id)).toEqual([userMessage.id])
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("RPC listSlashCommands lists slash-decorated requests only", () =>
    Effect.gen(function* () {
      const extensionId = ExtensionId.make("@test/public-filter")
      const ext: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "builtin",
        sourcePath: "test",
        contributions: {
          requests: [
            request({
              id: "visible",
              extensionId,
              slash: { name: "visible", description: "visible" },
              input: Schema.String,
              output: Schema.Void,
              execute: () => Effect.void,
            }),
          ],
        },
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [ext],
            cwd: "/tmp",
          })
          const commands = yield* client.extension.listSlashCommands({ sessionId })
          expect(commands.map((command) => command.name)).toEqual(["visible"])
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("RPC handlers receive ExtensionContext authority without intent ceremony", () =>
    Effect.gen(function* () {
      const extensionId = ExtensionId.make("@test/read-context")
      const ext: GentExtension = {
        manifest: { id: extensionId },
        setup: () =>
          Effect.succeed({
            requests: [
              request({
                id: "inspect",
                extensionId,
                input: Schema.Void,
                output: Schema.Struct({
                  hasSessionMutations: Schema.Boolean,
                  hasAgentRun: Schema.Boolean,
                  profileStorageAvailable: Schema.Boolean,
                  extensionContextProcessAvailable: Schema.Boolean,
                  extensionContextFollowUpQueued: Schema.Boolean,
                  extensionContextParentEnvIsObject: Schema.Boolean,
                }),
                execute: () =>
                  narrowR(
                    Effect.gen(function* () {
                      const todoStorage = yield* Effect.serviceOption(TodoStorage)
                      const extensionCtx = yield* ExtensionContext
                      const processExit = yield* Effect.exit(
                        extensionCtx.Process.run("echo", ["hi"]),
                      )
                      const followUpExit = yield* Effect.exit(
                        extensionCtx.Session.queueFollowUp({
                          sourceId: "rpc",
                          content: "queued",
                        }),
                      )
                      return {
                        hasSessionMutations: false,
                        hasAgentRun: false,
                        profileStorageAvailable: Option.isSome(todoStorage),
                        extensionContextProcessAvailable: Exit.isSuccess(processExit),
                        extensionContextFollowUpQueued: Exit.isSuccess(followUpExit),
                        extensionContextParentEnvIsObject:
                          typeof extensionCtx.Process.parentEnv === "object",
                      }
                    }),
                  ),
              }),
            ],
          }),
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [...e2ePreset.extensionInputs, ext],
            cwd: "/tmp",
          })
          const result = yield* client.extension.request({
            sessionId,
            branchId,
            extensionId,
            capabilityId: "inspect",
            input: undefined,
          })
          expect(result).toEqual({
            hasSessionMutations: false,
            hasAgentRun: false,
            profileStorageAvailable: true,
            extensionContextProcessAvailable: true,
            extensionContextFollowUpQueued: true,
            extensionContextParentEnvIsObject: true,
          })
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("RPC request invokes slash-decorated requests through the transport boundary", () =>
    Effect.gen(function* () {
      const extensionId = ExtensionId.make("@test/public-shadow")
      const projectExt: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "project",
        sourcePath: "project",
        contributions: {
          requests: [
            request({
              id: "shadowed",
              extensionId,
              slash: { name: "shadowed private", description: "shadowed private" },
              description: "shadowed private",
              input: Schema.Struct({ value: Schema.String }),
              output: Schema.Struct({ value: Schema.String }),
              execute: (input: { value: string }) => Effect.succeed({ value: input.value }),
            }),
          ],
        },
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [projectExt],
            cwd: "/tmp",
          })
          const commands = yield* client.extension.listSlashCommands({ sessionId })
          expect(commands.map((command) => command.name)).toEqual(["shadowed"])
          const result = yield* client.extension.request({
            sessionId,
            branchId,
            extensionId,
            capabilityId: "shadowed",
            input: { value: "hi" },
          })
          expect(result).toEqual({ value: "hi" })
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
          requests: [
            request({
              id: "shadowed",
              extensionId,
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
          requests: [
            request({
              id: "shadowed",
              extensionId,
              input: Schema.Struct({ value: Schema.String }),
              output: Schema.Struct({ value: Schema.String }),
              execute: (input) => Effect.succeed({ value: input.value }),
            }),
          ],
        },
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [builtinExt, projectExt],
            cwd: "/tmp",
          })
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
          requests: [
            request({
              id: "shadowed",
              extensionId,
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
              output: Schema.Struct({ value: Schema.String }),
              execute: (input) => Effect.succeed({ value: input.value }),
            }),
          ],
        },
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [builtinExt, projectExt],
            cwd: "/tmp",
          })
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
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
            const { client, sessionId, branchId } = yield* createRpcHarness({
              ...e2ePreset,
              providerLayer,
              extensions: [],
              sessionProfileCacheLayer,
              cwd: alphaCwd,
            })
            const alpha = { sessionId, branchId }
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
