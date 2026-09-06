import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import {
  Cause,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Scope,
} from "effect"
import {
  defineExtension,
  defineResource,
  request,
  type GentExtension,
} from "@gent/core/extensions/api"
import { e2ePreset } from "../../../extensions/tests/helpers/test-preset"
import { createRpcHarness } from "../../src/test-utils/rpc-harness"
import { LanguageModelLayers } from "../../src/test-utils/language-model"
import { textStep } from "@gent/core-internal/debug/provider"
import { BunPlatformLive } from "../../src/runtime/gent-platform-bun"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { ConfigService } from "../../src/runtime/config-service"
import { RuntimeEnvironment } from "../../src/runtime/runtime-environment"
import { ProcessRunnerLive } from "../../src/utils/run-process"
import { SessionProfileCache } from "../../src/runtime/session-profile"
import { CurrentWorkspaceId, WorkspaceId } from "../../src/server/workspace-rpc"
import { ExtensionId } from "../../src/domain/ids"
import { AgentName } from "../../src/domain/agent"
import { ResourceId } from "../../src/domain/resource-graph"
import { SqliteStorage } from "../../src/storage/sqlite-storage"
import { ExtensionProtocolError } from "../../src/server/errors"
import { CronRuntime } from "../../src/runtime/extensions/resource-host/schedule-engine"

class ProviderToken extends Context.Service<ProviderToken, { readonly value: string }>()(
  "@gent/core/tests/runtime/live-profile-availability.test/ProviderToken",
) {}

class ConsumerToken extends Context.Service<
  ConsumerToken,
  { readonly read: Effect.Effect<string> }
>()("@gent/core/tests/runtime/live-profile-availability.test/ConsumerToken") {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

describe("live profile resource availability", () => {
  it.scopedLive("suspends and restores resource-dependent RPC capabilities", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const platform = yield* GentPlatform
      const home = yield* fs.makeTempDirectoryScoped()
      const profileCwd = yield* fs.makeTempDirectoryScoped()
      const providerId = ExtensionId.make("@test/live-profile-availability-provider")
      const consumerId = ExtensionId.make("@test/live-profile-availability-consumer")
      const providerResourceId = ResourceId.make("test/live-profile-availability/provider")
      const consumerResourceId = ResourceId.make("test/live-profile-availability/consumer")
      const requestId = "read-live-profile-availability"
      const configPath = path.join(home, ".gent", "config.json")
      let providerStarts = 0
      let providerStops = 0
      let consumerStarts = 0
      let consumerStops = 0
      let schedulerInstalls = 0
      let schedulerRemoves = 0

      yield* fs.makeDirectory(path.dirname(configPath), { recursive: true })
      yield* fs.writeFileString(configPath, encodeJson({ disabledExtensions: [providerId] }))

      const providerExtension = defineExtension({
        id: providerId,
        resources: [
          defineResource({
            id: providerResourceId,
            tag: ProviderToken,
            scope: "process",
            layer: Layer.succeed(ProviderToken, ProviderToken.of({ value: "provider-ready" })),
            start: Effect.sync(() => {
              providerStarts += 1
            }),
            stop: Effect.sync(() => {
              providerStops += 1
            }),
          }),
        ],
      })
      const consumerExtension = defineExtension({
        id: consumerId,
        resources: [
          defineResource({
            id: consumerResourceId,
            requires: [providerResourceId],
            tag: ConsumerToken,
            scope: "process",
            layer: Layer.effect(
              ConsumerToken,
              Effect.gen(function* () {
                const provider = yield* ProviderToken
                return ConsumerToken.of({
                  read: Effect.succeed(`consumer:${provider.value}`),
                })
              }),
            ),
            start: Effect.sync(() => {
              consumerStarts += 1
            }),
            stop: Effect.sync(() => {
              consumerStops += 1
            }),
          }),
        ],
        scheduledJobs: [
          {
            id: "availability-job",
            cron: "0 * * * *",
            target: { agent: AgentName.make("cowork"), prompt: "availability" },
          },
        ],
        requests: [
          request({
            id: requestId,
            input: Schema.String,
            output: Schema.String,
            execute: () =>
              Effect.gen(function* () {
                const consumer = yield* ConsumerToken
                return yield* consumer.read
              }),
          }),
        ],
      }) satisfies GentExtension

      const runtimeEnvironmentLive = RuntimeEnvironment.Live({
        cwd: profileCwd,
        home,
        platform: "test",
      })
      const configServiceLive = ConfigService.Live.pipe(
        Layer.provide(Layer.merge(BunServices.layer, runtimeEnvironmentLive)),
      )
      const sessionProfileCacheLayer = Layer.unwrap(
        Effect.map(Effect.scope, (scope) =>
          SessionProfileCache.Live({
            home,
            platform: "test",
            scheduledJobCommand: ["gent"],
            extensions: [providerExtension, consumerExtension],
          }).pipe(
            Layer.provide(
              Layer.mergeAll(
                BunServices.layer,
                ProcessRunnerLive.pipe(Layer.provide(BunServices.layer)),
                configServiceLive,
                SqliteStorage.MemoryWithSql().pipe(Layer.provide(BunPlatformLive)),
                Layer.succeed(
                  CronRuntime,
                  CronRuntime.of({
                    install: () =>
                      Effect.sync(() => {
                        schedulerInstalls += 1
                      }),
                    remove: () =>
                      Effect.sync(() => {
                        schedulerRemoves += 1
                      }),
                  }),
                ),
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
          const workspaceId = WorkspaceId.make(platform.hash("sha256", path.resolve(process.cwd())))
          yield* cache
            .resolve(profileCwd)
            .pipe(Effect.provideService(CurrentWorkspaceId, workspaceId))
          expect(providerStarts).toBe(0)
          expect(providerStops).toBe(0)
          expect(consumerStarts).toBe(0)
          expect(consumerStops).toBe(0)
          expect(schedulerInstalls).toBe(0)

          const unavailableProfile = yield* cache
            .current(profileCwd)
            .pipe(Effect.provideService(CurrentWorkspaceId, workspaceId))
          expect(Option.isSome(unavailableProfile)).toBe(true)
          if (Option.isSome(unavailableProfile)) {
            expect(
              unavailableProfile.value.resolved.extensions.some(
                (extension) => extension.manifest.id === consumerId,
              ),
            ).toBe(false)
            expect(unavailableProfile.value.publication?.plan.inactive).toEqual([
              { id: consumerResourceId, missing: [providerResourceId] },
            ])
          }

          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [],
            sessionProfileCacheLayer: Layer.succeed(SessionProfileCache, cache),
            cwd: profileCwd,
          })

          const unavailable = yield* client.extension
            .request({
              sessionId,
              branchId,
              extensionId: consumerId,
              capabilityId: requestId,
              input: "read",
            })
            .pipe(Effect.exit)
          expect(Exit.isFailure(unavailable)).toBe(true)
          if (Exit.isFailure(unavailable)) {
            const error = Cause.squash(unavailable.cause)
            expect(Schema.is(ExtensionProtocolError)(error)).toBe(true)
            if (Schema.is(ExtensionProtocolError)(error)) {
              expect(error.extensionId).toBe(consumerId)
              expect(error.tag).toBe(requestId)
              expect(error.phase).toBe("request")
            }
          }

          yield* fs.writeFileString(configPath, encodeJson({ disabledExtensions: [] }))
          yield* cache
            .refresh(profileCwd)
            .pipe(Effect.provideService(CurrentWorkspaceId, workspaceId))
          expect(providerStarts).toBe(1)
          expect(providerStops).toBe(0)
          expect(consumerStarts).toBe(1)
          expect(consumerStops).toBe(0)
          expect(schedulerInstalls).toBe(1)
          const available = yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: consumerId,
            capabilityId: requestId,
            input: "read",
          })
          expect(available).toBe("consumer:provider-ready")

          yield* fs.writeFileString(configPath, encodeJson({ disabledExtensions: [providerId] }))
          yield* cache
            .refresh(profileCwd)
            .pipe(Effect.provideService(CurrentWorkspaceId, workspaceId))
          expect(providerStarts).toBe(1)
          expect(providerStops).toBe(1)
          expect(consumerStarts).toBe(1)
          expect(consumerStops).toBe(1)
          expect(schedulerInstalls).toBe(1)
          expect(schedulerRemoves).toBe(1)
          const revoked = yield* client.extension
            .request({
              sessionId,
              branchId,
              extensionId: consumerId,
              capabilityId: requestId,
              input: "read",
            })
            .pipe(Effect.exit)
          expect(Exit.isFailure(revoked)).toBe(true)
          if (Exit.isFailure(revoked)) {
            const error = Cause.squash(revoked.cause)
            expect(Schema.is(ExtensionProtocolError)(error)).toBe(true)
            if (Schema.is(ExtensionProtocolError)(error)) {
              expect(error.extensionId).toBe(consumerId)
              expect(error.tag).toBe(requestId)
              expect(error.phase).toBe("request")
            }
          }
        }).pipe(Effect.timeout("4 seconds")),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )
})
