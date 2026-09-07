import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import {
  Predicate,
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  MutableRef,
  Option,
  Path,
  Schema,
  Scope,
  Stream,
} from "effect"
import { MinimumLogLevel } from "effect/References"
import { narrowR } from "../helpers/effect"
import {
  ExtensionLoadError,
  type GentExtension,
  type LoadedExtension,
} from "../../src/domain/extension.js"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
} from "@gent/core-internal/test-utils/language-model"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"
import { messageSingleText } from "@gent/core-internal/domain/message-part-projection"
import type { Message } from "@gent/core-internal/domain/message"
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
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform"
import { SlashCommandInfo } from "@gent/core-internal/server/transport-contract"
import { ToolCallSucceeded } from "@gent/core-internal/domain/event"
import { e2ePreset, toolPreset } from "../../../extensions/tests/helpers/test-preset"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { SessionProfileCache, type SessionProfile } from "../../src/runtime/session-profile"
import { buildExtensionLayers } from "../../src/runtime/profile"
import { defineResource } from "@gent/core-internal/domain/resource"
import type { PermissionService } from "../../src/domain/permission"
import {
  CapabilityError,
  defineExtension,
  ExtensionContext,
  ExtensionSetupContext,
  request,
  tool,
} from "@gent/core/extensions/api"
import * as ExtensionApi from "@gent/core/extensions/api"
import { BranchId, ExtensionId, SessionId } from "@gent/core-internal/domain/ids"
import { CurrentWorkspaceId, WorkspaceId } from "@gent/core-internal/server/workspace-rpc"
import { ConfigService } from "../../src/runtime/config-service"
import { RuntimeEnvironment } from "../../src/runtime/runtime-environment"
import { ProcessRunnerLive } from "../../src/utils/run-process"
import { WideEventLogger, type LogEvent } from "../../src/runtime/wide-event-boundary"
import DynamicScratchpadExtension from "../../../../examples/extensions/dynamic-scratchpad.js"
import { ExtensionProtocolError } from "../../src/server/errors"
class ProfileToken extends Context.Service<
  ProfileToken,
  {
    readonly read: Effect.Effect<string, never, never>
  }
>()("@gent/core/tests/server/extension-commands-rpc.test/ProfileToken") {}
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const expectExtensionProtocolFailure = (cause: Cause.Cause<unknown>, message?: string) => {
  const error = Cause.squash(cause)
  expect(Schema.is(ExtensionProtocolError)(error)).toBe(true)
  if (!Schema.is(ExtensionProtocolError)(error)) return
  expect(error._tag).toBe("ExtensionProtocolError")
  if (!Predicate.isUndefined(message)) expect(error.message).toBe(message)
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
    setup: Effect.succeed({
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
    check: () => Effect.succeed("allowed" satisfies "allowed"),
  } satisfies PermissionService
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
  it.live("listSlashCommands returns registered commands", () =>
    narrowR(
      Effect.gen(function* () {
        const registry = yield* ExtensionRegistry
        const cmds = listSlashCommands(registry.getResolved())
        const testCmds = cmds.filter((c) => c.name === "greet" || c.name === "noop")
        expect(testCmds).toHaveLength(2)
        expect(testCmds.find((c) => c.name === "greet")?.description).toBe("Say hello")
        expect(testCmds.find((c) => c.name === "noop")?.description).toBe("noop")
      }).pipe(Effect.provide(layer)),
    ),
  )
  it.live("RPC listSlashCommands + request round-trip through the transport boundary", () =>
    Effect.gen(function* () {
      invoked.length = 0
      let createdSessionId = ""
      yield* narrowR(
        Effect.scoped(
          Effect.gen(function* () {
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
            const wideEvents = MutableRef.make<Array<LogEvent>>([])
            const minimumLogLevel = Layer.effectContext(
              Effect.succeed(Context.make(MinimumLogLevel, "Info")),
            )
            const { client, sessionId, branchId } = yield* createRpcHarness({
              ...e2ePreset,
              providerLayer,
              extensionInputs: [TestCommandsExtension],
              cwd: "/tmp/gent-extension-request-session",
              extraLayers: [WideEventLogger.Capture(wideEvents), minimumLogLevel],
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
            const extensionRequestEvent = MutableRef.get(wideEvents).find(
              (event) =>
                event.annotations["service"] === "rpc" &&
                event.annotations["method"] === "extension.request",
            )
            expect(extensionRequestEvent).not.toBeUndefined()
            expect(extensionRequestEvent?.annotations["sessionId"]).toBe(sessionId)
            expect(extensionRequestEvent?.annotations["branchId"]).toBe(branchId)
            expect(extensionRequestEvent?.annotations["extensionId"]).toBe(greet!.extensionId)
            expect(extensionRequestEvent?.annotations["capabilityId"]).toBe(greet!.capabilityId)

            const missingCapabilityId = "missing-greet"
            const failed = yield* client.extension
              .request({
                sessionId,
                extensionId: greet!.extensionId,
                capabilityId: missingCapabilityId,
                input: "rpc-world",
                branchId,
              })
              .pipe(Effect.exit)
            expect(failed._tag).toBe("Failure")

            const failedRequestEvent = MutableRef.get(wideEvents).find(
              (event) =>
                event.annotations["service"] === "rpc" &&
                event.annotations["method"] === "extension.request" &&
                event.annotations["capabilityId"] === missingCapabilityId,
            )
            expect(failedRequestEvent).not.toBeUndefined()
            expect(failedRequestEvent?.annotations["sessionId"]).toBe(sessionId)
            expect(failedRequestEvent?.annotations["branchId"]).toBe(branchId)
            expect(failedRequestEvent?.annotations["extensionId"]).toBe(greet!.extensionId)
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
  it.live("RPC event subscriptions mark the move from replay to live", () =>
    narrowR(
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("synced reply"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [],
            cwd: "/tmp/gent-extension-stream-synchronized",
          })
          const untilMarker = (after: number) =>
            client.session.events({ sessionId, branchId, after }).pipe(
              Stream.takeUntil((env) => env.event._tag === "StreamSynchronized"),
              Stream.runCollect,
            )
          // A fresh branch replays its creation events, then the marker closes the replay.
          const fresh = yield* untilMarker(0)
          expect(fresh.map((env) => env.event._tag)).toEqual([
            "SessionStarted",
            "StreamSynchronized",
          ])
          expect(fresh[1]?.id).toBe(fresh[0]?.id)
          yield* client.message.send({ sessionId, branchId, content: "sync" })
          yield* waitFor(
            client.message.list({ branchId }),
            (messages) =>
              messages.some(
                (message) =>
                  message.role === "assistant" &&
                  messageSingleText(message.parts) === "synced reply",
              ),
            4000,
            "synced reply",
          )
          // After a turn, the marker closes the replay and names the last replayed id.
          const replayed = yield* untilMarker(0)
          const marker = replayed[replayed.length - 1]
          const events = replayed.slice(0, -1)
          expect(marker?.event).toMatchObject({ _tag: "StreamSynchronized", sessionId, branchId })
          expect(events.length).toBeGreaterThan(1)
          expect(events.every((env) => env.event._tag !== "StreamSynchronized")).toBe(true)
          expect(marker?.id).toBe(events[events.length - 1]?.id)
          // Resuming from the marker id replays nothing and synchronizes at once.
          const resumed = yield* untilMarker(Number(marker?.id))
          expect(resumed.map((env) => env.event._tag)).toEqual(["StreamSynchronized"])
        }),
      ),
    ).pipe(Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
  )

  it.live("RPC request follow-up on a warm idle branch runs the queued turn", () =>
    Effect.gen(function* () {
      const extensionId = ExtensionId.make("@test/queue-follow-up-warm")
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
                  yield* ctx.Session.queueFollowUp({
                    sourceId: "test-warm-request",
                    content: input,
                  })
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
            const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
              textStep("first reply"),
              textStep("follow-up reply"),
            ])
            const { client, sessionId, branchId } = yield* createRpcHarness({
              ...e2ePreset,
              providerLayer,
              extensions: [ext],
              cwd: "/tmp/gent-extension-queue-follow-up-warm",
            })
            const assistantReplies = (
              messages: ReadonlyArray<{ role: string; parts: Message["parts"] }>,
            ) =>
              messages
                .filter((message) => message.role === "assistant")
                .map((message) => messageSingleText(message.parts))
            yield* client.message.send({ sessionId, branchId, content: "warm the branch" })
            yield* waitFor(
              client.message.list({ branchId }),
              (messages) => assistantReplies(messages).includes("first reply"),
              4000,
              "first reply",
            )
            // The request runs under the loop's side-mutation permit. Admission
            // queues the item; the turn starts once the permit is released.
            yield* client.extension
              .request({
                sessionId,
                branchId,
                extensionId,
                capabilityId: "queue-follow-up",
                input: "queued while idle",
              })
              .pipe(Effect.timeout("4 seconds"))
            const messages = yield* waitFor(
              client.message.list({ branchId }),
              (current) => assistantReplies(current).includes("follow-up reply"),
              4000,
              "follow-up reply",
            )
            expect(
              messages.some(
                (message) =>
                  message.role === "user" &&
                  messageSingleText(message.parts) === "queued while idle",
              ),
            ).toBe(true)
            yield* controls.assertDone
          }).pipe(Effect.timeout("10 seconds")),
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
                "Session not found: missing-extension-request-session",
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
                `Branch not found for session: ${sessionId}/missing-extension-request-branch`,
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
              `Branch not found for session: ${first.sessionId}/${second.branchId}`,
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
              id: "test/extension-commands-rpc/profile-token",
              tag: ProfileToken,
              scope: "process",
              layer: Layer.succeed(
                ProfileToken,
                ProfileToken.of({
                  read: Effect.succeed("profile-token"),
                }),
              ),
            }),
          ],
          requests: [
            request({
              id: "read-profile-token",
              extensionId: ExtensionId.make("@test/profile-service-request"),
              input: Schema.String,
              output: Schema.String,
              execute: () =>
                Effect.gen(function* () {
                  const token = yield* ProfileToken
                  return yield* token.read
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
        setup: Effect.gen(function* () {
          const ctx = yield* ExtensionSetupContext
          return {
            resources: [
              defineResource({
                id: "test/extension-commands-rpc/live-profile-token",
                tag: ProfileToken,
                scope: "process",
                layer: Layer.succeed(
                  ProfileToken,
                  ProfileToken.of({
                    read: Effect.succeed(`live:${ctx.cwd}`),
                  }),
                ),
              }),
            ],
            requests: [
              request({
                id: "read-live-profile-token",
                extensionId: ExtensionId.make("@test/live-profile-service-request"),
                input: Schema.String,
                output: Schema.String,
                execute: () =>
                  Effect.gen(function* () {
                    const token = yield* ProfileToken
                    return yield* token.read
                  }),
              }),
            ],
          }
        }),
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sessionProfileCacheLayer = Layer.unwrap(
            Effect.map(Effect.scope, (scope) =>
              SessionProfileCache.Live({
                home,
                platform: "test",
                extensions: [ext],
              }).pipe(
                Layer.provide(
                  Layer.mergeAll(
                    BunPlatformLive,
                    ConfigService.Test(),
                    SqliteStorage.MemoryWithSql().pipe(Layer.provide(BunPlatformLive)),
                  ),
                ),
                Layer.orDie,
                Layer.provide(Layer.succeed(Scope.Scope, scope)),
              ),
            ),
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
  it.scopedLive("RPC resource use drains before a live profile replacement", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const platform = yield* GentPlatform
      const home = yield* fs.makeTempDirectoryScoped()
      const profileCwd = yield* fs.makeTempDirectoryScoped()
      const configPath = path.join(home, ".gent", "config.json")
      yield* fs.makeDirectory(path.dirname(configPath), { recursive: true })
      yield* fs.writeFileString(configPath, encodeJson({ permissions: [] }))

      const readStarted = yield* Deferred.make<void>()
      const releaseRead = yield* Deferred.make<void>()
      const resourceStopped = yield* Deferred.make<void>()
      const ext: GentExtension = {
        manifest: { id: ExtensionId.make("@test/live-profile-drain") },
        setup: Effect.gen(function* () {
          const ctx = yield* ExtensionSetupContext
          return {
            resources: [
              defineResource({
                id: "test/extension-commands-rpc/live-profile-drain-token",
                tag: ProfileToken,
                scope: "process",
                layer: Layer.effect(
                  ProfileToken,
                  Effect.acquireRelease(
                    Effect.succeed(
                      ProfileToken.of({
                        read: Effect.gen(function* () {
                          yield* Deferred.succeed(readStarted, void 0)
                          yield* Deferred.await(releaseRead)
                          return `drained:${ctx.cwd}`
                        }),
                      }),
                    ),
                    () => Deferred.succeed(resourceStopped, void 0),
                  ),
                ),
              }),
            ],
            requests: [
              request({
                id: "read-live-profile-drain-token",
                extensionId: ExtensionId.make("@test/live-profile-drain"),
                input: Schema.String,
                output: Schema.String,
                execute: () =>
                  Effect.gen(function* () {
                    const token = yield* ProfileToken
                    return yield* token.read
                  }),
              }),
            ],
          }
        }),
      }

      const runtimeEnvironmentLive = RuntimeEnvironment.Live({
        cwd: profileCwd,
        home,
        platform: "test",
      })
      const configServiceLive = ConfigService.Live.pipe(
        Layer.provide(Layer.merge(BunServices.layer, runtimeEnvironmentLive)),
      )
      const processRunnerLive = ProcessRunnerLive.pipe(Layer.provide(BunServices.layer))
      const sessionProfileCacheLayer = Layer.unwrap(
        Effect.map(Effect.scope, (scope) =>
          SessionProfileCache.Live({
            home,
            platform: "test",
            extensions: [ext],
          }).pipe(
            Layer.provide(
              Layer.mergeAll(
                BunServices.layer,
                processRunnerLive,
                configServiceLive,
                SqliteStorage.MemoryWithSql().pipe(Layer.provide(BunPlatformLive)),
              ),
            ),
            Layer.orDie,
            Layer.provide(Layer.succeed(Scope.Scope, scope)),
          ),
        ),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const cacheContext = yield* Layer.build(sessionProfileCacheLayer)
          const cache = Context.get(cacheContext, SessionProfileCache)
          const requestWorkspace = WorkspaceId.make(
            platform.hash("sha256", path.resolve(process.cwd())),
          )
          const initial = yield* cache
            .resolve(profileCwd)
            .pipe(Effect.provideService(CurrentWorkspaceId, requestWorkspace))
          const initialPublication = Option.fromUndefinedOr(initial.publication)
          expect(Option.isSome(initialPublication)).toBe(true)

          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [],
            sessionProfileCacheLayer: Layer.succeed(SessionProfileCache, cache),
            cwd: profileCwd,
          })
          const requestFiber = yield* client.extension
            .request({
              sessionId,
              extensionId: ExtensionId.make("@test/live-profile-drain"),
              capabilityId: "read-live-profile-drain-token",
              input: "token",
              branchId,
            })
            .pipe(Effect.forkChild)
          const earlyRequest = yield* Fiber.await(requestFiber).pipe(
            Effect.timeoutOption("500 millis"),
          )
          expect(Option.isNone(earlyRequest)).toBe(true)
          yield* Deferred.await(readStarted)

          yield* fs.writeFileString(
            configPath,
            encodeJson({ disabledExtensions: ["@test/live-profile-drain"] }),
          )
          const refreshing = yield* cache
            .refresh(profileCwd)
            .pipe(Effect.provideService(CurrentWorkspaceId, requestWorkspace), Effect.forkChild)
          const earlyRefresh = yield* Fiber.await(refreshing).pipe(
            Effect.timeoutOption("100 millis"),
          )
          expect(Option.isNone(earlyRefresh)).toBe(true)
          expect(Option.isNone(yield* Deferred.poll(resourceStopped))).toBe(true)

          yield* Deferred.succeed(releaseRead, void 0)
          const result = yield* Fiber.join(requestFiber)
          expect(result).toBe(`drained:${profileCwd}`)
          expect(Exit.isSuccess(yield* Fiber.await(refreshing))).toBe(true)
          yield* Deferred.await(resourceStopped)
        }).pipe(
          Effect.ensuring(Deferred.succeed(releaseRead, void 0).pipe(Effect.asVoid)),
          Effect.timeout("4 seconds"),
        ),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )
  it.scopedLive("cancelling a leased turn reaches idle before the next turn", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const platform = yield* GentPlatform
      const home = yield* fs.makeTempDirectoryScoped()
      const profileCwd = yield* fs.makeTempDirectoryScoped()
      const configPath = path.join(home, ".gent", "config.json")
      yield* fs.makeDirectory(path.dirname(configPath), { recursive: true })
      yield* fs.writeFileString(configPath, encodeJson({ permissions: [] }))

      const streamStarted = yield* Deferred.make<void>()
      const resourceStopped = yield* Deferred.make<void>()
      const agentExtension = defineExtension({
        id: "@test/live-profile-agents",
        agents: e2ePreset.agents,
      })
      const ext: GentExtension = {
        manifest: { id: ExtensionId.make("@test/live-profile-cancel") },
        setup: Effect.succeed({
          resources: [
            defineResource({
              id: "test/extension-commands-rpc/live-profile-cancel-token",
              tag: ProfileToken,
              scope: "process",
              layer: Layer.effect(
                ProfileToken,
                Effect.acquireRelease(
                  Effect.succeed(ProfileToken.of({ read: Effect.succeed("unused") })),
                  () => Deferred.succeed(resourceStopped, void 0),
                ),
              ),
            }),
          ],
        }),
      }

      let streamCall = 0
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.gen(function* () {
          const call = streamCall
          streamCall += 1
          if (call === 0) {
            yield* Deferred.succeed(streamStarted, void 0)
            return Stream.never
          }
          return Stream.fromIterable([
            textDeltaPart("recovered after cancellation"),
            finishPart({ finishReason: "stop" }),
          ])
        }),
      )
      const runtimeEnvironmentLive = RuntimeEnvironment.Live({
        cwd: profileCwd,
        home,
        platform: "test",
      })
      const configServiceLive = ConfigService.Live.pipe(
        Layer.provide(Layer.merge(BunServices.layer, runtimeEnvironmentLive)),
      )
      const processRunnerLive = ProcessRunnerLive.pipe(Layer.provide(BunServices.layer))
      const sessionProfileCacheLayer = Layer.unwrap(
        Effect.map(Effect.scope, (scope) =>
          SessionProfileCache.Live({
            home,
            platform: "test",
            extensions: [agentExtension, ext],
          }).pipe(
            Layer.provide(
              Layer.mergeAll(
                BunServices.layer,
                processRunnerLive,
                configServiceLive,
                SqliteStorage.MemoryWithSql().pipe(Layer.provide(BunPlatformLive)),
              ),
            ),
            Layer.orDie,
            Layer.provide(Layer.succeed(Scope.Scope, scope)),
          ),
        ),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const cacheContext = yield* Layer.build(sessionProfileCacheLayer)
          const cache = Context.get(cacheContext, SessionProfileCache)
          const requestWorkspace = WorkspaceId.make(
            platform.hash("sha256", path.resolve(process.cwd())),
          )
          const initial = yield* cache
            .resolve(profileCwd)
            .pipe(Effect.provideService(CurrentWorkspaceId, requestWorkspace))
          expect(Option.isSome(Option.fromUndefinedOr(initial.publication))).toBe(true)

          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [],
            sessionProfileCacheLayer: Layer.succeed(SessionProfileCache, cache),
            cwd: profileCwd,
          })
          const errorEvents = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter((envelope) => envelope.event._tag === "ErrorOccurred"),
            Stream.runHead,
            Effect.forkScoped,
          )
          const firstMessage = yield* client.message
            .send({
              sessionId,
              branchId,
              content: "hold this turn",
            })
            .pipe(Effect.forkChild)
          yield* Deferred.await(streamStarted)
          yield* Fiber.join(firstMessage)

          yield* fs.writeFileString(
            configPath,
            encodeJson({ disabledExtensions: ["@test/live-profile-cancel"] }),
          )
          const refreshing = yield* cache
            .refresh(profileCwd, { retireMode: "cancel" })
            .pipe(Effect.provideService(CurrentWorkspaceId, requestWorkspace), Effect.forkChild)
          const refreshExit = yield* Fiber.await(refreshing)
          expect(Exit.isSuccess(refreshExit)).toBe(true)
          if (Exit.isFailure(refreshExit)) return
          yield* Deferred.await(resourceStopped)
          const idle = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (snapshot) => snapshot.runtime._tag === "Idle",
            2_000,
            "cancelled leased turn reaches idle",
          )
          expect(idle.runtime._tag).toBe("Idle")
          const errorEventExit = yield* Fiber.await(errorEvents).pipe(
            Effect.timeoutOption("1 second"),
          )
          expect(Option.isSome(errorEventExit)).toBe(true)
          if (Option.isNone(errorEventExit)) return
          expect(Exit.isSuccess(errorEventExit.value)).toBe(true)
          if (Exit.isFailure(errorEventExit.value)) return
          expect(Option.isSome(errorEventExit.value.value)).toBe(true)
          if (Option.isNone(errorEventExit.value.value)) return
          expect(errorEventExit.value.value.value.event._tag).toBe("ErrorOccurred")

          yield* client.message.send({
            sessionId,
            branchId,
            content: "recover after cancellation",
          })
          const recovered = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (snapshot) =>
              snapshot.runtime._tag === "Idle" &&
              snapshot.messages.some((message) =>
                message.parts.some(
                  (part) => part.type === "text" && part.text === "recovered after cancellation",
                ),
              ),
            2_000,
            "next turn completes after cancellation",
          )
          expect(
            recovered.messages.some((message) =>
              message.parts.some(
                (part) => part.type === "text" && part.text === "recovered after cancellation",
              ),
            ),
          ).toBe(true)
        }).pipe(Effect.timeout("4 seconds")),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )
  it.scopedLive("interaction parking releases the publication lease", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const platform = yield* GentPlatform
      const home = yield* fs.makeTempDirectoryScoped()
      const profileCwd = yield* fs.makeTempDirectoryScoped()
      const configPath = path.join(home, ".gent", "config.json")
      yield* fs.makeDirectory(path.dirname(configPath), { recursive: true })
      yield* fs.writeFileString(configPath, encodeJson({ permissions: [] }))

      const resourceStopped = yield* Deferred.make<void>()
      const agentExtension = defineExtension({
        id: "@test/live-profile-agents-interaction",
        agents: e2ePreset.agents,
      })
      const ext: GentExtension = {
        manifest: { id: ExtensionId.make("@test/live-profile-interaction") },
        setup: Effect.succeed({
          resources: [
            defineResource({
              id: "test/extension-commands-rpc/live-profile-interaction-token",
              tag: ProfileToken,
              scope: "process",
              layer: Layer.effect(
                ProfileToken,
                Effect.acquireRelease(
                  Effect.succeed(ProfileToken.of({ read: Effect.succeed("unused") })),
                  () => Deferred.succeed(resourceStopped, void 0),
                ),
              ),
            }),
          ],
          tools: [
            tool({
              id: "live-profile-interaction-tool",
              description: "Park a turn for approval",
              params: Schema.Struct({ text: Schema.String }),
              output: Schema.Struct({ approved: Schema.Boolean }),
              execute: (params) =>
                Effect.gen(function* () {
                  const ctx = yield* ExtensionContext
                  const decision = yield* ctx.Interaction.approve({ text: params.text })
                  return { approved: decision.approved }
                }),
            }),
          ],
        }),
      }
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("live-profile-interaction-tool", { text: "park this turn" }),
      ])
      const runtimeEnvironmentLive = RuntimeEnvironment.Live({
        cwd: profileCwd,
        home,
        platform: "test",
      })
      const configServiceLive = ConfigService.Live.pipe(
        Layer.provide(Layer.merge(BunServices.layer, runtimeEnvironmentLive)),
      )
      const processRunnerLive = ProcessRunnerLive.pipe(Layer.provide(BunServices.layer))
      const sessionProfileCacheLayer = Layer.unwrap(
        Effect.map(Effect.scope, (scope) =>
          SessionProfileCache.Live({
            home,
            platform: "test",
            extensions: [agentExtension, ext],
          }).pipe(
            Layer.provide(
              Layer.mergeAll(
                BunServices.layer,
                processRunnerLive,
                configServiceLive,
                SqliteStorage.MemoryWithSql().pipe(Layer.provide(BunPlatformLive)),
              ),
            ),
            Layer.orDie,
            Layer.provide(Layer.succeed(Scope.Scope, scope)),
          ),
        ),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const cacheContext = yield* Layer.build(sessionProfileCacheLayer)
          const cache = Context.get(cacheContext, SessionProfileCache)
          const requestWorkspace = WorkspaceId.make(
            platform.hash("sha256", path.resolve(process.cwd())),
          )
          const initial = yield* cache
            .resolve(profileCwd)
            .pipe(Effect.provideService(CurrentWorkspaceId, requestWorkspace))
          expect(Option.isSome(Option.fromUndefinedOr(initial.publication))).toBe(true)

          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [],
            durableApproval: true,
            sessionProfileCacheLayer: Layer.succeed(SessionProfileCache, cache),
            cwd: profileCwd,
          })
          const interactionFiber = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter((envelope) => envelope.event._tag === "InteractionPresented"),
            Stream.runHead,
            Effect.forkScoped,
          )
          const interactionMessage = yield* client.message
            .send({
              sessionId,
              branchId,
              content: "request approval",
            })
            .pipe(Effect.forkChild)
          const presented = yield* Fiber.join(interactionFiber)
          expect(Option.isSome(presented)).toBe(true)
          const waiting = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (snapshot) => snapshot.runtime._tag === "WaitingForInteraction",
            2_000,
            "interaction turn parks",
          )
          expect(waiting.runtime._tag).toBe("WaitingForInteraction")
          yield* Fiber.join(interactionMessage)

          yield* fs.writeFileString(
            configPath,
            encodeJson({ disabledExtensions: ["@test/live-profile-interaction"] }),
          )
          yield* cache
            .refresh(profileCwd)
            .pipe(
              Effect.provideService(CurrentWorkspaceId, requestWorkspace),
              Effect.timeout("2 seconds"),
            )
          yield* Deferred.await(resourceStopped)
          expect(Option.isSome(yield* Deferred.poll(resourceStopped))).toBe(true)
        }).pipe(Effect.timeout("4 seconds")),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )
  it.live("RPC listStatus returns structurally tagged extension health", () =>
    Effect.gen(function* () {
      const failingExtension: GentExtension = {
        manifest: { id: ExtensionId.make("@test/failing-status") },
        setup: Effect.fail(
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
        setup: Effect.succeed({
          requests: [
            request({
              id: "inspect",
              extensionId,
              input: Schema.Void,
              output: Schema.Struct({
                hasSessionMutations: Schema.Boolean,
                hasAgentRun: Schema.Boolean,
                extensionContextProcessAvailable: Schema.Boolean,
                extensionContextFollowUpQueued: Schema.Boolean,
                extensionContextParentEnvIsObject: Schema.Boolean,
              }),
              execute: () =>
                narrowR(
                  Effect.gen(function* () {
                    const extensionCtx = yield* ExtensionContext
                    const processExit = yield* Effect.exit(extensionCtx.Process.run("echo", ["hi"]))
                    const followUpExit = yield* Effect.exit(
                      extensionCtx.Session.queueFollowUp({
                        sourceId: "rpc",
                        content: "queued",
                      }),
                    )
                    return {
                      hasSessionMutations: false,
                      hasAgentRun: false,
                      extensionContextProcessAvailable: Exit.isSuccess(processExit),
                      extensionContextFollowUpQueued: Exit.isSuccess(followUpExit),
                      extensionContextParentEnvIsObject: Predicate.isObjectOrArray(
                        extensionCtx.Process.parentEnv,
                      ),
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
            // oxlint-disable-next-line effect/noNullish -- Keep the absent field in this schema boundary fixture.
            input: undefined,
          })
          expect(result).toEqual({
            hasSessionMutations: false,
            hasAgentRun: false,
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
  it.live("RPC dynamic registrations update slash, request, and model tool surfaces", () =>
    Effect.gen(function* () {
      const extensionId = ExtensionId.make("@test/dynamic-authoring")
      const DynamicEchoTool = tool({
        id: "dynamic_echo",
        description: "Dynamic echo",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.String,
        execute: ({ text }) => Effect.succeed(`tool:${text}`),
      })
      const DynamicEchoRequest = request({
        id: "dynamic-echo",
        extensionId,
        slash: { name: "dynamic-echo", description: "Dynamic echo" },
        description: "Dynamic echo",
        input: Schema.String,
        output: Schema.String,
        execute: (input) => Effect.succeed(`request:${input}`),
      })
      const ext: GentExtension = {
        manifest: { id: extensionId },
        setup: Effect.succeed({
          requests: [
            request({
              id: "install-dynamic",
              extensionId,
              description: "Install dynamic capabilities",
              input: Schema.Void,
              output: Schema.Void,
              execute: () =>
                Effect.gen(function* () {
                  const ctx = yield* ExtensionContext
                  const unregisterTool = yield* ctx.Dynamic.registerTool(DynamicEchoTool)
                  const unregisterRequest = yield* ctx.Dynamic.registerRequest(DynamicEchoRequest)
                  void unregisterTool
                  void unregisterRequest
                }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new CapabilityError({
                        extensionId,
                        capabilityId: "install-dynamic",
                        reason: cause.message,
                      }),
                  ),
                ),
            }),
          ],
        }),
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            {
              ...textStep("dynamic registered"),
              assertOptions: (options) => {
                expect(options.tools.map((entry) => entry.name)).toContain("dynamic_echo")
              },
            },
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [...e2ePreset.extensionInputs, ext],
            cwd: "/tmp/gent-dynamic-authoring",
          })

          yield* client.extension.request({
            sessionId,
            branchId,
            extensionId,
            capabilityId: "install-dynamic",
            // oxlint-disable-next-line effect/noNullish -- Keep the absent field in this schema boundary fixture.
            input: undefined,
          })

          const commands = yield* client.extension.listSlashCommands({ sessionId })
          expect(commands.map((command) => command.name)).toContain("dynamic-echo")

          const requestResult = yield* client.extension.request({
            sessionId,
            branchId,
            extensionId,
            capabilityId: "dynamic-echo",
            input: "hello",
          })
          expect(requestResult).toBe("request:hello")

          yield* client.message.send({
            sessionId,
            branchId,
            content: "use the dynamic tool",
          })
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("reference dynamic extension registers session tools and slash requests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          {
            ...toolCallStep("scratchpad_append", { text: "from the model" }),
            assertOptions: (options) => {
              expect(options.tools.map((entry) => entry.name)).toContain("scratchpad_append")
            },
          },
          textStep("noted"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          extensionInputs: [...e2ePreset.extensionInputs, DynamicScratchpadExtension],
          cwd: "/tmp/gent-dynamic-scratchpad",
        })
        const extensionId = ExtensionId.make("dynamic-scratchpad")

        const installResult = yield* client.extension.request({
          sessionId,
          branchId,
          extensionId,
          capabilityId: "scratchpad-install",
          input: {},
        })
        expect(installResult).toEqual({
          tool: "scratchpad_append",
          request: "scratchpad-show",
        })

        const commands = yield* client.extension.listSlashCommands({ sessionId })
        const commandNames = commands.map((command) => command.name)
        expect(commandNames).toContain("scratchpad-install")
        expect(commandNames).toContain("scratchpad")

        const toolEventFiber = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter(
            (envelope) =>
              Schema.is(ToolCallSucceeded)(envelope.event) &&
              envelope.event.toolName === "scratchpad_append",
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        )

        yield* client.message.send({
          sessionId,
          branchId,
          content: "store the scratchpad note",
        })
        const toolEvents = Array.from(yield* Fiber.join(toolEventFiber))
        expect(toolEvents).toHaveLength(1)

        const scratchpad = yield* client.extension.request({
          sessionId,
          branchId,
          extensionId,
          capabilityId: "scratchpad-show",
          input: {},
        })
        expect(scratchpad).toBe("1. from the model")
      }).pipe(Effect.timeout("4 seconds")),
    ),
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
