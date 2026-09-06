import { describe, expect, it } from "effect-bun-test"
import { Cause, Context, Effect, Exit, Layer, Option, Predicate, Schema } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { createHash } from "node:crypto"
import { ExtensionId, RequestId } from "@gent/core-internal/domain/ids"
import { LoadedArtifactIdentity } from "@gent/core-internal/domain/extension"
import { ResourceId, ResourceRevision } from "@gent/core-internal/domain/resource-graph"
import {
  CanonicalCwd,
  ResourceGraphDesiredCommand,
  ResourceGraphExtensionSource,
  ResourceGraphRevision,
  ResourceGraphSnapshot,
  ResourceGraphSource,
} from "@gent/core-internal/domain/resource-graph-state"
import { ResourceGraphStorage } from "@gent/core-internal/storage/resource-graph-storage"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { CurrentWorkspaceId, WorkspaceId } from "@gent/core-internal/server/workspace-rpc"
import { BunGentPlatformLive } from "../../src/runtime/gent-platform-bun"
import { SessionProfileCache } from "../../src/runtime/session-profile"
import { ResourceGraphCommandService } from "../../src/runtime/extensions/resource-host/resource-graph-command"
import { makeTempDirectoryScoped, waitFor } from "@gent/core-internal/test-utils/fixtures"
import { createE2ELayer } from "@gent/core-internal/test-utils/e2e-layer"
import { Gent } from "@gent/sdk"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { e2ePreset } from "../../../extensions/tests/helpers/test-preset"
import {
  defineExtension,
  defineResource,
  request,
  type GentExtension,
} from "@gent/core/extensions/api"

const emptySnapshot = ResourceGraphSnapshot.make({
  source: ResourceGraphSource.make({
    revision: ResourceGraphRevision.make("rpc-source/1"),
    config: {},
    extensions: [],
  }),
  descriptors: [],
})

class ColdResourceProbe extends Context.Service<ColdResourceProbe, { readonly instance: number }>()(
  "@gent/core/tests/server/resource-graph-rpc.test/ColdResourceProbe",
) {}

const coldResourceId = ResourceId.make("test/resource-graph-rpc/cold-probe")
const coldResourceRevision = ResourceRevision.make("cold-probe/1")
const coldResourceExtensionId = ExtensionId.make("@test/resource-graph-rpc-cold")
const coldResourceArtifact = LoadedArtifactIdentity.make("@test/resource-graph-rpc-cold@artifact-1")

const ColdResourceProbeRequest = request({
  id: "cold.current",
  input: Schema.Struct({}),
  output: Schema.Struct({ instance: Schema.Finite }),
  execute: () =>
    Effect.gen(function* () {
      const probe = yield* ColdResourceProbe
      return { instance: probe.instance }
    }),
})

const makeColdResourceExtension = (events: Array<string>): GentExtension => {
  let nextInstance = 0
  return {
    ...defineExtension({
      id: coldResourceExtensionId,
      requests: [ColdResourceProbeRequest],
      resources: [
        defineResource({
          id: coldResourceId,
          revision: coldResourceRevision,
          tag: ColdResourceProbe,
          scope: "process",
          layer: Layer.effect(
            ColdResourceProbe,
            Effect.acquireRelease(
              Effect.sync(() => {
                const instance = ++nextInstance
                events.push(`acquire:${instance}`)
                return ColdResourceProbe.of({ instance })
              }),
              (probe) => Effect.sync(() => events.push(`release:${probe.instance}`)),
            ),
          ),
          start: Effect.gen(function* () {
            const probe = yield* ColdResourceProbe
            events.push(`start:${probe.instance}`)
          }),
          stop: Effect.gen(function* () {
            const probe = yield* ColdResourceProbe
            events.push(`stop:${probe.instance}`)
          }),
        }),
      ],
    }),
    artifactIdentity: coldResourceArtifact,
  }
}

describe("resource graph RPC boundary", () => {
  it.scopedLive("canonicalizes owner aliases before durable command deduplication", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
        const { client } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          agents: [],
          extensionInputs: [],
          extensions: [],
          cwd: "/tmp",
        })
        const commandId = RequestId.make("resource-graph-rpc-alias")
        const desiredRevision = ResourceGraphRevision.make("rpc-desired/1")
        const first = yield* client.resourceGraph.submit({
          cwd: CanonicalCwd.make("/tmp/../tmp"),
          commandId,
          desiredRevision,
          snapshot: emptySnapshot,
        })
        const retry = yield* client.resourceGraph.submit({
          cwd: CanonicalCwd.make("/tmp"),
          commandId,
          desiredRevision,
          snapshot: emptySnapshot,
        })
        expect(retry).toEqual(first)

        const status = yield* client.resourceGraph.get({
          cwd: CanonicalCwd.make("/tmp/../tmp"),
        })
        const statusOption = Option.fromNullishOr(status)
        if (Option.isNone(statusOption)) {
          return yield* Effect.die("expected a durable graph status")
        }
        expect(String(statusOption.value.cwd)).toBe("/tmp")
        expect(String(statusOption.value.commandId)).toBe(String(commandId))
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.scopedLive("does not expose a default profile when launch recovery is unavailable", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDirectoryScoped("gent-resource-graph-rpc-")
      const dbPath = `${tempDir}/gent.db`
      const cwd = CanonicalCwd.make("/tmp")
      const workspaceId = WorkspaceId.make(createHash("sha256").update(cwd).digest("hex"))
      const seedLayer = SqliteStorage.LiveWithSql(dbPath).pipe(
        Layer.provide(BunFileSystem.layer),
        Layer.provide(BunServices.layer),
        Layer.provide(BunGentPlatformLive),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const storage = yield* ResourceGraphStorage
          yield* storage.recordDesired(
            ResourceGraphDesiredCommand.make({
              workspaceId,
              cwd,
              commandId: RequestId.make("resource-graph-rpc-unavailable"),
              desiredRevision: ResourceGraphRevision.make("rpc-unavailable/1"),
              snapshot: ResourceGraphSnapshot.make({
                source: ResourceGraphSource.make({
                  revision: ResourceGraphRevision.make("rpc-unavailable-source/1"),
                  config: {},
                  extensions: [
                    ResourceGraphExtensionSource.make({
                      extensionId: ExtensionId.make("@test/unavailable-resource-graph"),
                      scope: "builtin",
                      source: "restart-required:test",
                    }),
                  ],
                }),
                descriptors: [],
              }),
            }),
          )
          // oxlint-disable-next-line effect/noInlineProvide -- This test seeds one isolated disk database.
        }).pipe(Effect.provideService(CurrentWorkspaceId, workspaceId), Effect.provide(seedLayer)),
      )

      const result = yield* Effect.exit(
        Effect.scoped(
          Gent.test(
            createE2ELayer({
              providerLayer: LanguageModelLayers.debug(),
              agents: [],
              extensionInputs: [],
              extensions: [],
              storagePath: dbPath,
            }),
          ),
        ),
      )
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(Cause.pretty(result.cause)).toContain("ResourceGraphOwnerUnavailableError")
      }
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive("keeps launch access when an unrelated owner is unavailable", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDirectoryScoped("gent-resource-graph-rpc-unrelated-")
      const dbPath = `${tempDir}/gent.db`
      const cwd = CanonicalCwd.make("/tmp/unrelated")
      const workspaceId = WorkspaceId.make(createHash("sha256").update(cwd).digest("hex"))
      const seedLayer = SqliteStorage.LiveWithSql(dbPath).pipe(
        Layer.provide(BunFileSystem.layer),
        Layer.provide(BunServices.layer),
        Layer.provide(BunGentPlatformLive),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const storage = yield* ResourceGraphStorage
          yield* storage.recordDesired(
            ResourceGraphDesiredCommand.make({
              workspaceId,
              cwd,
              commandId: RequestId.make("resource-graph-rpc-unrelated"),
              desiredRevision: ResourceGraphRevision.make("rpc-unrelated/1"),
              snapshot: ResourceGraphSnapshot.make({
                source: ResourceGraphSource.make({
                  revision: ResourceGraphRevision.make("rpc-unrelated-source/1"),
                  config: {},
                  extensions: [
                    ResourceGraphExtensionSource.make({
                      extensionId: ExtensionId.make("@test/unrelated-resource-graph"),
                      scope: "builtin",
                      source: "restart-required:test",
                    }),
                  ],
                }),
                descriptors: [],
              }),
            }),
          )
          // oxlint-disable-next-line effect/noInlineProvide -- This test seeds one isolated disk database.
        }).pipe(Effect.provideService(CurrentWorkspaceId, workspaceId), Effect.provide(seedLayer)),
      )

      const { client } = yield* createRpcHarness({
        providerLayer: LanguageModelLayers.debug(),
        agents: [],
        extensionInputs: [],
        extensions: [],
        storagePath: dbPath,
        cwd: "/tmp",
      })
      const status = yield* client.resourceGraph.get({ cwd: CanonicalCwd.make("/tmp") })
      expect(Option.isNone(Option.fromNullishOr(status))).toBe(true)
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive("repairs a failed owner and reacquires its resource after restart", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDirectoryScoped("gent-resource-graph-rpc-repair-")
      const dbPath = `${tempDir}/gent.db`
      const cwd = CanonicalCwd.make(process.cwd())
      const workspaceId = WorkspaceId.make(createHash("sha256").update(cwd).digest("hex"))
      const events: Array<string> = []
      const extension = makeColdResourceExtension(events)
      const layer = createE2ELayer({
        providerLayer: LanguageModelLayers.debug(),
        agents: [],
        extensionInputs: [extension],
        storagePath: dbPath,
      })

      const validSnapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer)
          const cache = Context.get(context, SessionProfileCache)
          const profile = yield* cache
            .resolve(String(cwd))
            .pipe(Effect.provideService(CurrentWorkspaceId, workspaceId))
          return Option.getOrThrow(Option.fromUndefinedOr(profile.resourceGraphSnapshot))
        }),
      )

      const seedLayer = SqliteStorage.LiveWithSql(dbPath).pipe(
        Layer.provide(BunFileSystem.layer),
        Layer.provide(BunServices.layer),
        Layer.provide(BunGentPlatformLive),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const storage = yield* ResourceGraphStorage
          yield* storage.recordDesired(
            ResourceGraphDesiredCommand.make({
              workspaceId,
              cwd,
              commandId: RequestId.make("resource-graph-rpc-repair-seed"),
              desiredRevision: ResourceGraphRevision.make("rpc-repair/1"),
              snapshot: ResourceGraphSnapshot.make({
                source: ResourceGraphSource.make({
                  revision: ResourceGraphRevision.make("rpc-repair-source/1"),
                  config: {},
                  extensions: [
                    ResourceGraphExtensionSource.make({
                      extensionId: coldResourceExtensionId,
                      scope: "builtin",
                      source: "restart-required:test",
                    }),
                  ],
                }),
                descriptors: [],
              }),
            }),
          )
          // oxlint-disable-next-line effect/noInlineProvide -- This test seeds one isolated disk database.
        }).pipe(Effect.provideService(CurrentWorkspaceId, workspaceId), Effect.provide(seedLayer)),
      )

      const second = yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* Gent.test(layer)
          const status = yield* client.resourceGraph.get({ cwd })
          const statusOption = Option.fromNullishOr(status)
          if (Option.isNone(statusOption)) {
            return yield* Effect.die("expected the failed owner to remain queryable")
          }
          expect(statusOption.value.state).toBe("failed")

          const receipt = yield* client.resourceGraph.submit({
            cwd,
            commandId: RequestId.make("resource-graph-rpc-repair-command"),
            expectedRevision: statusOption.value.desiredRevision,
            desiredRevision: ResourceGraphRevision.make("rpc-repair/2"),
            snapshot: validSnapshot,
          })
          const applied = yield* waitFor(
            client.resourceGraph.get({ cwd }),
            (value) => {
              const current = Option.fromNullishOr(value)
              return (
                Option.isSome(current) &&
                current.value.state === "applied" &&
                current.value.desiredSequence === receipt.desiredSequence
              )
            },
            2_000,
            "RPC resource graph repair",
          )
          const appliedOption = Option.fromNullishOr(applied)
          if (Option.isNone(appliedOption)) {
            return yield* Effect.die("expected the repaired owner to be applied")
          }
          expect(appliedOption.value.snapshot).toEqual(validSnapshot)
        }),
      )

      expect(second).toBeUndefined()
      expect(events.some((event) => event.startsWith("acquire:"))).toBe(true)
      expect(events.some((event) => event.startsWith("start:"))).toBe(true)

      const thirdProbe = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer)
          const cache = Context.get(context, SessionProfileCache)
          const profile = yield* cache
            .requireCurrent(String(cwd))
            .pipe(Effect.provideService(CurrentWorkspaceId, workspaceId))
          return Context.get(profile.layerContext, ColdResourceProbe)
        }),
      )
      expect(thirdProbe.instance).toBeGreaterThan(1)
      expect(events).toContain(`start:${thirdProbe.instance}`)
      expect(events).toContain(`stop:${thirdProbe.instance}`)
      expect(events).toContain(`release:${thirdProbe.instance}`)
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("previews and repairs a failed owner through a healthy Gent server", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("gent-resource-graph-server-")
      const targetDirectory = yield* makeTempDirectoryScoped("gent-resource-graph-target-")
      const controlDirectory = yield* makeTempDirectoryScoped("gent-resource-graph-control-")
      const dbPath = `${home}/gent.db`
      const cwd = CanonicalCwd.make(targetDirectory)
      const workspaceId = WorkspaceId.make(createHash("sha256").update(cwd).digest("hex"))
      const events: Array<string> = []
      const extension = makeColdResourceExtension(events)
      const seedLayer = SqliteStorage.LiveWithSql(dbPath).pipe(
        Layer.provide(BunFileSystem.layer),
        Layer.provide(BunServices.layer),
        Layer.provide(BunGentPlatformLive),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const storage = yield* ResourceGraphStorage
          yield* storage.recordDesired(
            ResourceGraphDesiredCommand.make({
              workspaceId,
              cwd,
              commandId: RequestId.make("resource-graph-server-repair-seed"),
              desiredRevision: ResourceGraphRevision.make("server-repair/1"),
              snapshot: ResourceGraphSnapshot.make({
                source: ResourceGraphSource.make({
                  revision: ResourceGraphRevision.make("server-repair-source/1"),
                  config: {},
                  extensions: [
                    ResourceGraphExtensionSource.make({
                      extensionId: coldResourceExtensionId,
                      scope: "builtin",
                      source: "restart-required:test",
                    }),
                  ],
                }),
                descriptors: [],
              }),
            }),
          )
          // oxlint-disable-next-line effect/noInlineProvide -- This test seeds one isolated disk database.
        }).pipe(Effect.provideService(CurrentWorkspaceId, workspaceId), Effect.provide(seedLayer)),
      )

      let recoveredInstance = 0
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* Gent.server({
            cwd: controlDirectory,
            extensions: [extension],
            state: Gent.state.sqlite({ home, dbPath }),
            provider: Gent.provider.mock(),
          })
          const { client } = yield* Gent.client(server, { cwd: String(cwd) })
          const failed = yield* client.resourceGraph.get({ cwd })
          if (Predicate.isNull(failed)) return yield* Effect.die("expected a failed target owner")
          expect(failed.state).toBe("failed")

          const snapshot = yield* client.resourceGraph.preview({ cwd })
          expect(snapshot.source.extensions[0]?.source).toContain("artifact:")
          const stillFailed = yield* client.resourceGraph.get({ cwd })
          if (Predicate.isNull(stillFailed)) {
            return yield* Effect.die("preview removed the failed target owner")
          }
          expect(stillFailed.state).toBe("failed")
          const receipt = yield* client.resourceGraph.submit({
            cwd,
            commandId: RequestId.make("resource-graph-server-repair"),
            expectedRevision: failed.desiredRevision,
            desiredRevision: ResourceGraphRevision.make("server-repair/2"),
            snapshot,
          })
          const applied = yield* waitFor(
            client.resourceGraph.get({ cwd }),
            (value) =>
              !Predicate.isNull(value) &&
              value.state === "applied" &&
              value.desiredSequence === receipt.desiredSequence,
            2_000,
            "healthy-server graph repair",
          )
          if (Predicate.isNull(applied)) return yield* Effect.die("expected applied target owner")

          const { sessionId, branchId } = yield* client.session.create({
            cwd: String(cwd),
          })
          const liveProbe = yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: coldResourceExtensionId,
            capabilityId: "cold.current",
            input: {},
          })
          const probe = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ instance: Schema.Finite }),
          )(liveProbe)
          expect(events).toContain(`start:${probe.instance}`)
        }),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* Gent.server({
            cwd: targetDirectory,
            extensions: [extension],
            state: Gent.state.sqlite({ home, dbPath }),
            provider: Gent.provider.mock(),
          })
          const { client } = yield* Gent.client(server, { cwd: String(cwd) })
          const recovered = yield* waitFor(
            client.resourceGraph.get({ cwd }),
            (value) => !Predicate.isNull(value) && value.state === "applied",
            2_000,
            "target owner restart recovery",
          )
          if (Predicate.isNull(recovered)) {
            return yield* Effect.die("expected recovered target owner")
          }

          const { sessionId, branchId } = yield* client.session.create({
            cwd: String(cwd),
          })
          const liveProbe = yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: coldResourceExtensionId,
            capabilityId: "cold.current",
            input: {},
          })
          const probe = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ instance: Schema.Finite }),
          )(liveProbe)
          recoveredInstance = probe.instance
          expect(probe.instance).toBeGreaterThan(0)
          expect(events).toContain(`start:${probe.instance}`)
        }),
      )
      expect(events).toContain(`stop:${recoveredInstance}`)
      expect(events).toContain(`release:${recoveredInstance}`)
    }).pipe(Effect.timeout("15 seconds")),
  )

  it.scopedLive("reacquires process resources from durable SQL through the production cache", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDirectoryScoped("gent-resource-graph-rpc-cold-")
      const dbPath = `${tempDir}/gent.db`
      const targetCwd = yield* makeTempDirectoryScoped("gent-resource-graph-rpc-target-")
      const cwd = CanonicalCwd.make(targetCwd)
      const workspaceId = WorkspaceId.make(createHash("sha256").update(cwd).digest("hex"))
      const events: Array<string> = []
      const extension = makeColdResourceExtension(events)
      const layer = createE2ELayer({
        providerLayer: LanguageModelLayers.debug(),
        agents: [],
        extensionInputs: [extension],
        storagePath: dbPath,
      })

      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer)
          const cache = Context.get(context, SessionProfileCache)
          const commands = Context.get(context, ResourceGraphCommandService)
          const storage = Context.get(context, ResourceGraphStorage)
          const profile = yield* cache
            .resolve(targetCwd)
            .pipe(Effect.provideService(CurrentWorkspaceId, workspaceId))
          const probe = Context.get(profile.layerContext, ColdResourceProbe)
          const snapshot = Option.getOrThrow(Option.fromUndefinedOr(profile.resourceGraphSnapshot))

          const receipt = yield* commands
            .submit(
              ResourceGraphDesiredCommand.make({
                workspaceId,
                cwd,
                commandId: RequestId.make("resource-graph-rpc-cold-command"),
                desiredRevision: ResourceGraphRevision.make("resource-graph-rpc-cold/1"),
                snapshot,
              }),
            )
            .pipe(Effect.provideService(CurrentWorkspaceId, workspaceId))
          const status = yield* waitFor(
            storage
              .get({ workspaceId, cwd })
              .pipe(Effect.provideService(CurrentWorkspaceId, workspaceId)),
            (value) =>
              value?.state === "applied" && value.desiredSequence === receipt.desiredSequence,
            2_000,
            "first durable resource graph application",
          )
          expect(status?.state).toBe("applied")
          expect(probe.instance).toBe(2)
          return probe.instance
        }),
      )

      expect(first).toBe(2)
      expect(events).toContain("acquire:1")
      expect(events).toContain("start:1")
      expect(events).toContain("acquire:2")
      expect(events).toContain("start:2")
      expect(events).toContain("stop:2")
      expect(events).toContain("release:2")

      const second = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer)
          const cache = Context.get(context, SessionProfileCache)
          const profile = yield* cache
            .resolve(targetCwd)
            .pipe(Effect.provideService(CurrentWorkspaceId, workspaceId))
          const probe = Context.get(profile.layerContext, ColdResourceProbe)
          expect(probe.instance).toBe(3)
          return probe.instance
        }),
      )

      expect(second).toBe(3)
      expect(events).toContain("acquire:3")
      expect(events).toContain("start:3")
      expect(events).toContain("stop:3")
      expect(events).toContain("release:3")
    }).pipe(Effect.timeout("10 seconds")),
  )
})
