import {
  Cause,
  Context,
  Crypto,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  MutableRef,
  Option,
  Path,
  Predicate,
  Ref,
  References,
  Schema,
  Scope,
  Stream,
  Schema as S,
} from "effect"
import * as EffectEntry from "effect"
import { describe, expect, it, test } from "effect-bun-test"
import * as ExtensionApiEntry from "../../src/extensions/api"
import * as BranchToolsEntry from "../../src/extensions/branch-tools"
import {
  type CallRecord,
  createRpcHarness,
  RecordingEventStore,
  runToolWithCtx,
  SequenceRecorder,
  testExtensionHostContext,
  testHostFacts,
  testToolContext,
  ensureStorageParents,
  testSqliteStorage,
} from "../../src/test-utils/harness"
import { BunChildProcessSpawner, BunCrypto, BunFileSystem, BunServices } from "@effect/platform-bun"
import { BunGentPlatformLive, BunPlatformLive } from "../../src/runtime/gent-platform-bun"
import {
  defineExtension,
  defineRequests,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  type GentExtension,
  getToolId,
  request,
  type RequestCapability,
  tool,
  type ToolCapability,
} from "@gent/core/extensions/api"
import {
  ApprovalService,
  buildScopeResources,
  compileExtensionHooks,
  configHealthStatuses,
  CurrentExtensionHostContext,
  type DiscoveredExtension,
  discoverExtensions,
  ExtensionRegistry,
  listModelCatalog,
  makeExtensionHostContextProvider,
  provideCurrentCapabilityContext,
  provideCurrentHostCtx,
  resolveExtensions,
  resolveTurnProfile,
  RunOpener,
  type SessionProfile,
  SessionProfileCache,
  type SessionProfileCacheService,
  setupExtension,
  setupExtensions,
  type TurnProfileDefaults,
  validateLoadedExtensions,
  loadRuntimeProfileDeclarations,
  scanRuntimeProfileExtensions,
  type RuntimeProfileInputs,
} from "../../src/runtime/extension-host"
import {
  ConfigService,
  isProjectExtensionDirectoryTrusted,
  RuntimeEnvironment,
} from "../../src/runtime/config"
import {
  MessageStorage,
  SessionStorage,
  type SessionStorageService,
  SqliteStorage,
  StorageError,
  BranchStorage,
} from "../../src/storage/storage"
import { CurrentWorkspaceId, WorkspaceId, workspaceIdForCwd } from "../../src/server/workspace-rpc"
import {
  ActorCommandId,
  BranchId,
  ClientRequestGrant,
  ExtensionId,
  MessageId,
  ProcessGenerationId,
  RequestId,
  SessionId,
} from "../../src/domain/ids"
import {
  dateFromMillis,
  Session,
  Branch,
  type MessageMetadata,
  messagePartsDisplayText,
} from "../../src/domain/message"
import { GentPlatform, writeFileAtomic } from "../../src/runtime/gent-platform"
import { omitUndefined } from "../../src/domain/guards"
import {
  type ModelDriverContribution,
  ProviderAuthInfo,
  type ProviderResolution,
} from "../../src/domain/driver"
import { Model as AiModel, LanguageModel } from "effect/unstable/ai"
import { ModelRegistry } from "../../src/runtime/provider"
import { LanguageModelLayers, textStep, waitFor } from "../../src/test-utils/language-model"
import {
  AgentDefinition,
  AgentName,
  DEFAULT_AGENT_NAME,
  Model,
  ModelId,
  ProviderId,
} from "../../src/domain/agent"
import { failingLanguageModel } from "../helpers/failing-language-model"
import * as AiTool from "effect/unstable/ai/Tool"
import {
  bindRequestCapabilityExtension,
  CapabilityError,
  CapabilityNotFoundError,
  GentToolMetadataTag,
  getToolMetadata,
  isToolCapability,
} from "../../src/domain/capability"
import { e2ePreset, testAgent } from "../helpers/test-preset"
import { ref } from "../../src/extensions/api.js"
import {
  type AnyResourceContribution,
  type ExtensionContributions,
  type LoadedExtension,
  SessionMutations,
  type ExtensionHostContext,
  type ExtensionLoadError,
  hook,
  LoadedArtifactIdentity,
  registerContributions,
  type SystemPromptInput,
  sortExtensionsByScope,
  type TurnAfterInput,
  type ExtensionHookHandler,
} from "../../src/domain/extension"
import { compileToolPolicy, noBranchTools, ToolRunner } from "../../src/runtime/tools"
import { SingleRunner } from "effect/unstable/cluster"
import { AgentEvent, EventStore } from "../../src/domain/event"
import { SessionMutationsLive } from "../../src/server/server"
import { AgentLoopLiveActor, AgentLoopSessionGovernance } from "../../src/runtime/agent-loop"
import { EventStoreLive, SessionRuntime } from "../../src/runtime/session"

// ── ambient host context ─────────────────────────────────────────────────────

/**
 * The ambient host context resolves each facet from its own service Tag.
 *
 * A facet whose service is absent from the ambient context is not an error at
 * build time: the context still assembles, and the facet reports the absence
 * only if something calls it. That keeps a deployment that ships no approval
 * flow from having to provide a stub for one.
 */

const sessionId = SessionId.make("ambient-host-session")
const branchId = BranchId.make("ambient-host-branch")
const approvalRequest = { text: "Approve?", metadata: {} }

const ambientContext = Effect.gen(function* () {
  const provider = yield* makeExtensionHostContextProvider({
    host: testHostFacts().host,
  })
  return provider.forRun({ sessionId, branchId, interactive: true, clientRequest: Option.none() })
}).pipe(
  Effect.provide(RuntimeEnvironment.Live({ cwd: "/tmp", home: "/nonexistent/gent-test-home" })),
)

describe("ambient extension host context", () => {
  it.live("assembles with no host services in scope", () =>
    Effect.gen(function* () {
      const ctx = yield* ambientContext
      expect(ctx.sessionId).toBe(sessionId)
      expect(ctx.branchId).toBe(branchId)
    }),
  )

  it.live("reports the absence only when an unwired facet is called", () =>
    Effect.gen(function* () {
      const ctx = yield* ambientContext
      const exit = yield* Effect.exit(ctx.Interaction.approve(approvalRequest))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true)
        expect(exit.cause.toString()).toContain("ApprovalService not available")
      }
    }),
  )

  it.live("an unwired file lock or state facet reports its absence, not a pass-through", () =>
    Effect.gen(function* () {
      const ctx = yield* ambientContext
      const ran = yield* Ref.make(false)
      const lockExit = yield* Effect.exit(ctx.FileLock.withLock("/tmp/a", Ref.set(ran, true)))
      const stateExit = yield* Effect.exit(
        ctx.State(Option.some(ExtensionId.make("probe"))).changed(),
      )

      expect(yield* Ref.get(ran)).toBe(false)
      const expectAbsent = (exit: Exit.Exit<unknown, unknown>, name: string) => {
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true)
          expect(exit.cause.toString()).toContain(`${name} not available`)
        }
      }
      expectAbsent(lockExit, "FileLockService")
      expectAbsent(stateExit, "EventStore")
    }),
  )

  it.live("uses the real service once its Tag is in scope", () =>
    Effect.gen(function* () {
      const ctx = yield* ambientContext
      expect(yield* ctx.Interaction.approve(approvalRequest)).toStrictEqual({ approved: true })
    }).pipe(
      Effect.provideService(ApprovalService, {
        present: () => Effect.succeed({ approved: true }),
        storeResolution: () => Effect.die("not used"),
        rehydrate: () => Effect.die("not used"),
        answered: () => Effect.die("not used"),
        endTurn: () => Effect.die("not used"),
        beginStep: () => Effect.die("not used"),
        ownCall: () => (self) => self,
      }),
    ),
  )

  it.scopedLive("present stores a hidden assistant message and delivers it", () =>
    Effect.gen(function* () {
      const ctx = yield* ambientContext
      const store = yield* EventStore
      const delivered = yield* store
        .subscribe({ sessionId, branchId })
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* ensureStorageParents({ sessionId, branchId })

      yield* ctx.Interaction.present({ title: "Goal", content: "Ship it" })

      const messages = yield* (yield* MessageStorage).listMessages(branchId)
      expect(messages.map((m) => [m.role, m.metadata])).toStrictEqual([
        ["assistant", { customType: "prompt-present", hidden: true }],
      ])
      const envelopes = yield* Fiber.join(delivered)
      expect(envelopes.map((envelope) => envelope.event._tag)).toStrictEqual(["MessageReceived"])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          testSqliteStorage(noBranchTools.storage, noBranchTools.migrations),
          EventStore.Memory,
        ),
      ),
    ),
  )

  it.live("a session read lands in the workspace the run was built under, not the caller's", () =>
    Effect.gen(function* () {
      const runWorkspace = workspaceIdForCwd("/tmp/run-workspace")
      const otherWorkspace = workspaceIdForCwd("/tmp/other-workspace")
      const storage = yield* SessionStorage
      // The session exists only in the workspace the run was opened under.
      yield* storage
        .createSession(
          new Session({
            id: sessionId,
            name: "pinned",
            cwd: "/tmp/run-workspace",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          }),
        )
        .pipe(Effect.provideService(CurrentWorkspaceId, runWorkspace))

      // Build the run's context under the run's workspace, the way the
      // actor does after decoding it from the entity id.
      const ctx = yield* ambientContext.pipe(
        Effect.provideService(CurrentWorkspaceId, runWorkspace),
      )

      // Read it back from a caller sitting in a different workspace.
      const found = yield* ctx.Session.getSession().pipe(
        Effect.provideService(CurrentWorkspaceId, otherWorkspace),
      )
      expect(found?.name).toBe("pinned")
    }).pipe(Effect.provide(testSqliteStorage(noBranchTools.storage, noBranchTools.migrations))),
  )

  it.scopedLive(
    "an event replay lands in the workspace the run was built under, not the puller's",
    () =>
      Effect.gen(function* () {
        const runWorkspace = workspaceIdForCwd("/tmp/run-workspace")
        const otherWorkspace = workspaceIdForCwd("/tmp/other-workspace")
        // The branch and its one event exist only in the run's workspace.
        yield* ensureStorageParents({ sessionId, branchId }).pipe(
          Effect.provideService(CurrentWorkspaceId, runWorkspace),
        )
        const publisher = yield* EventStore
        yield* publisher
          .publish(AgentEvent.cases.SessionStarted.make({ sessionId, branchId }))
          .pipe(Effect.provideService(CurrentWorkspaceId, runWorkspace))

        const ctx = yield* ambientContext.pipe(
          Effect.provideService(CurrentWorkspaceId, runWorkspace),
        )

        // The subscription reads at pull time; the puller sits elsewhere.
        const replayed = yield* ctx.Session.events({ sessionId, branchId }).pipe(
          Stream.takeUntil((event) => event._tag === "StreamSynchronized"),
          Stream.runCollect,
          Effect.provideService(CurrentWorkspaceId, otherWorkspace),
        )
        expect(replayed.map((event) => event._tag)).toStrictEqual([
          "SessionStarted",
          "StreamSynchronized",
        ])
      }).pipe(
        // The storage-backed store validates the session and loads the rows
        // under the workspace in scope at pull time; the memory store reads none.
        Effect.provide(
          Layer.provideMerge(
            EventStoreLive,
            testSqliteStorage(noBranchTools.storage, noBranchTools.migrations),
          ),
        ),
      ),
  )

  it.scopedLive("a subscription from now replays no history, then delivers new events", () =>
    Effect.gen(function* () {
      const workspace = workspaceIdForCwd("/tmp/run-workspace")
      yield* ensureStorageParents({ sessionId, branchId }).pipe(
        Effect.provideService(CurrentWorkspaceId, workspace),
      )
      const publisher = yield* EventStore
      const publish = (event: AgentEvent) =>
        publisher.publish(event).pipe(Effect.provideService(CurrentWorkspaceId, workspace))
      yield* publish(AgentEvent.cases.SessionStarted.make({ sessionId, branchId }))
      yield* publish(AgentEvent.cases.StreamStarted.make({ sessionId, branchId }))
      const ctx = yield* ambientContext.pipe(Effect.provideService(CurrentWorkspaceId, workspace))
      const events = ctx.Session.events({ sessionId, branchId, from: "now" })
      // Nothing before the marker: the history stays unread.
      const replayed = yield* events.pipe(
        Stream.takeUntil((event) => event._tag === "StreamSynchronized"),
        Stream.runCollect,
      )
      expect(replayed.map((event) => event._tag)).toStrictEqual(["StreamSynchronized"])
      // An event after the cursor still arrives. The marker says the
      // subscription is open, so the publish cannot land before it.
      const open = yield* Deferred.make<boolean>()
      const next = yield* events.pipe(
        // The first event is the marker; completing twice is a no-op.
        Stream.tap(() => Deferred.succeed(open, true)),
        Stream.filter((event) => event._tag !== "StreamSynchronized"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* Deferred.await(open)
      yield* publish(AgentEvent.cases.TurnCompleted.make({ sessionId, branchId, durationMs: 1 }))
      const [delivered] = yield* Fiber.join(next).pipe(Effect.timeout("4 seconds"))
      expect(delivered?._tag).toBe("TurnCompleted")
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          EventStoreLive,
          testSqliteStorage(noBranchTools.storage, noBranchTools.migrations),
        ),
      ),
    ),
  )
})

// ── session profile resolution ───────────────────────────────────────────────

class SessionProfileResourceMarker extends Context.Service<
  SessionProfileResourceMarker,
  { readonly value: string }
>()("@gent/core/tests/runtime/extension-host.test/SessionProfileResourceMarker") {}

class SessionProfileStartProbe extends Context.Service<
  SessionProfileStartProbe,
  { readonly value: string }
>()("@gent/core/tests/runtime/extension-host.test/SessionProfileStartProbe") {}

/** A process resource whose layer runs `start` as it builds. */
const startResource = (id: string, start: Effect.Effect<void>) =>
  defineResource({
    id,
    scope: "process",
    layer: Layer.effect(
      SessionProfileStartProbe,
      Effect.as(start, SessionProfileStartProbe.of({ value: id })),
    ),
  })

const makeCacheLayer = (params: {
  readonly cwd: string
  readonly home: string
  readonly extensions: ReadonlyArray<GentExtension>
  /** Only for a test about a failing extension. */
  readonly allowFailedExtensions?: boolean
  /** Wraps the config service the cache reads, for a test that orders its reads. */
  readonly wrapConfig?: (live: ConfigService["Service"]) => ConfigService["Service"]
}) => {
  const runtimeEnvironmentLive = RuntimeEnvironment.Live({
    cwd: params.cwd,
    home: params.home,
  })
  // The config service and environment are outputs too, so a test reads
  // config health from the same instance the cache builds profiles with.
  const baseConfigLive = ConfigService.Live.pipe(
    Layer.provide(BunServices.layer),
    Layer.provideMerge(runtimeEnvironmentLive),
  )
  const configLive = Option.match(Option.fromUndefinedOr(params.wrapConfig), {
    onNone: () => baseConfigLive,
    onSome: (wrap) =>
      Layer.merge(
        Layer.effect(ConfigService, Effect.map(Effect.service(ConfigService), wrap)).pipe(
          Layer.provide(baseConfigLive),
        ),
        runtimeEnvironmentLive,
      ),
  })
  return SessionProfileCache.Live({
    failOnExtensionFailure: params.allowFailedExtensions !== true,
    home: params.home,
    platform: "darwin",
    extensions: params.extensions,
  }).pipe(
    Layer.provide(
      Layer.merge(
        BunServices.layer,
        SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(Layer.provide(BunPlatformLive)),
      ),
    ),
    Layer.provideMerge(configLive),
  )
}

const markerExtension = (id: string, value: string, stop: Effect.Effect<void> = Effect.void) =>
  defineExtension({
    id,
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* host.register(
        "resource",
        defineResource({
          id: `${id}/marker`,
          scope: "process",
          layer: Layer.effect(
            SessionProfileResourceMarker,
            Effect.as(
              Effect.addFinalizer(() => stop),
              SessionProfileResourceMarker.of({ value }),
            ),
          ),
        }),
      )
    }),
  })

describe("session profile resolution", () => {
  it.scopedLive("a trust grant and a trust revoke each reach the next resolve", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "gent-profile-trust-",
      })
      const home = path.join(directory, "home")
      const project = path.join(directory, "project")
      const userConfig = path.join(home, ".gent", "config.json")
      yield* fs.makeDirectory(path.join(home, ".gent"), { recursive: true })
      yield* fs.makeDirectory(path.join(project, ".gent", "extensions"), { recursive: true })
      const projectRoot = yield* fs.realPath(project)
      yield* fs.writeFileString(
        path.join(project, ".gent", "extensions", "entry.ts"),
        `import { Effect } from "effect";
export default { manifest: { id: "profile-trust" }, setup: Effect.void };`,
      )
      yield* fs.writeFileString(userConfig, "{}")
      const activeIds = (profile: SessionProfile) =>
        profile.resolved.extensions.map((extension) => String(extension.manifest.id))
      const failedErrors = (profile: SessionProfile) =>
        profile.resolved.failedExtensions.map((extension) => extension.error)

      yield* Effect.gen(function* () {
        const cache = yield* SessionProfileCache
        const resolve = Effect.scoped(cache.resolve(project))
        const untrusted = yield* resolve
        expect(activeIds(untrusted)).not.toContain("profile-trust")
        expect(failedErrors(untrusted).join("\n")).toContain("not trusted")

        yield* fs.writeFileString(userConfig, encodeJson({ trustedProjects: [projectRoot] }))
        const granted = yield* resolve
        expect(activeIds(granted)).toContain("profile-trust")

        yield* fs.writeFileString(userConfig, encodeJson({ trustedProjects: [] }))
        const revoked = yield* resolve
        expect(activeIds(revoked)).not.toContain("profile-trust")
        expect(failedErrors(revoked).join("\n")).toContain("not trusted")
      }).pipe(
        Effect.provide(
          makeCacheLayer({ cwd: project, home, extensions: [], allowFailedExtensions: true }),
        ),
        Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("7".repeat(64))),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )

  it.scopedLive("a revoke that also breaks the user config stops project extensions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "gent-profile-broken-trust-",
      })
      const home = path.join(directory, "home")
      const project = path.join(directory, "project")
      const userConfig = path.join(home, ".gent", "config.json")
      yield* fs.makeDirectory(path.join(home, ".gent"), { recursive: true })
      yield* fs.makeDirectory(path.join(project, ".gent", "extensions"), { recursive: true })
      const projectRoot = yield* fs.realPath(project)
      yield* fs.writeFileString(
        path.join(project, ".gent", "extensions", "entry.ts"),
        `import { Effect } from "effect";
export default { manifest: { id: "profile-broken-trust" }, setup: Effect.void };`,
      )
      yield* fs.writeFileString(userConfig, encodeJson({ trustedProjects: [projectRoot] }))
      const activeIds = (profile: SessionProfile) =>
        profile.resolved.extensions.map((extension) => String(extension.manifest.id))
      const clientTrust = isProjectExtensionDirectoryTrusted({
        userDir: path.join(home, ".gent", "extensions"),
        projectDir: path.join(project, ".gent", "extensions"),
      })

      yield* Effect.gen(function* () {
        const cache = yield* SessionProfileCache
        const resolve = Effect.scoped(cache.resolve(project))
        expect(activeIds(yield* resolve)).toContain("profile-broken-trust")
        expect(yield* clientTrust).toBe(true)

        // One edit revokes the grant and leaves a trailing comma.
        yield* fs.writeFileString(userConfig, '{"trustedProjects":[],}')
        // The server and the client give one answer: the project is not trusted.
        expect(activeIds(yield* resolve)).not.toContain("profile-broken-trust")
        expect(yield* clientTrust).toBe(false)
      }).pipe(
        Effect.provide(
          makeCacheLayer({ cwd: project, home, extensions: [], allowFailedExtensions: true }),
        ),
        Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("8".repeat(64))),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )

  it.scopedLive("an edited extension file builds its process resource again", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "gent-profile-version-",
      })
      const home = path.join(directory, "home")
      const launch = path.join(directory, "launch")
      const entry = path.join(home, ".gent", "extensions", "marker.ts")
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true })
      yield* fs.makeDirectory(launch, { recursive: true })
      const writeMarker = (value: string) =>
        writeFileAtomic(
          entry,
          `import { Context, Effect, Layer } from "effect";
import { defineExtension, defineResource, ExtensionHost } from "@gent/core/extensions/api";
class Marker extends Context.Service<Marker, { readonly value: string }>()(
  "@gent/core/tests/runtime/extension-host.test/SessionProfileResourceMarker",
) {}
export default defineExtension({
  id: "profile-version",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost;
    yield* host.register("resource", defineResource({
      id: "profile-version/marker",
      scope: "process",
      layer: Layer.succeed(Marker, Marker.of({ value: "${value}" })),
    }));
  }),
});
`,
        )
      const marker = (profile: SessionProfile) =>
        Context.get(profile.layerContext, SessionProfileResourceMarker).value

      yield* Effect.gen(function* () {
        const cache = yield* SessionProfileCache
        // A running turn holds the first profile, so its resource stays open
        // and the second profile could share it.
        const runningTurn = yield* Scope.make()
        yield* writeMarker("first")
        const first = yield* cache.resolve(launch).pipe(Scope.provide(runningTurn))
        expect(marker(first)).toBe("first")

        yield* writeMarker("second edit")
        const second = yield* Effect.scoped(cache.resolve(launch))
        expect(marker(second)).toBe("second edit")
        yield* Scope.close(runningTurn, Exit.void)
      }).pipe(
        Effect.provide(makeCacheLayer({ cwd: launch, home, extensions: [] })),
        Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("6".repeat(64))),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )

  // A branch's loop closes while one of its fibers resolves: the lease lands
  // on a scope that is already closed, and is released at once.
  it.scopedLive(
    "a resolve whose caller scope already closed returns and releases its lease",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const launch = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()

        yield* Effect.gen(function* () {
          const cache = yield* SessionProfileCache
          const closed = yield* Scope.make()
          yield* Scope.close(closed, Exit.void)
          const profile = yield* cache.resolve(launch).pipe(Scope.provide(closed))
          // The place still works: the next resolve takes its lock.
          const again = yield* Effect.scoped(cache.resolve(launch))
          expect(again).toBe(profile)
        }).pipe(
          Effect.provide(makeCacheLayer({ cwd: launch, home, extensions: [] })),
          Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("5".repeat(64))),
        )
      }).pipe(Effect.provide(BunPlatformLive)),
    5_000,
  )

  it.scopedLive("isolates profiles by workspace and reuses one per key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const launch = yield* fs.makeTempDirectoryScoped()
      const home = yield* fs.makeTempDirectoryScoped()
      const workspaceA = WorkspaceId.make("a".repeat(64))
      const workspaceB = WorkspaceId.make("b".repeat(64))
      const setups = yield* Ref.make(0)
      const counted = defineExtension({
        id: "@gent/test-session-profile/counted",
        setup: Ref.update(setups, (count) => count + 1),
      })

      yield* Effect.gen(function* () {
        const cache = yield* SessionProfileCache
        const profileA = yield* cache
          .resolve(path.join(launch, "."))
          .pipe(Effect.provideService(CurrentWorkspaceId, workspaceA))
        const profileB = yield* cache
          .resolve(launch)
          .pipe(Effect.provideService(CurrentWorkspaceId, workspaceB))
        const again = yield* cache
          .resolve(launch)
          .pipe(Effect.provideService(CurrentWorkspaceId, workspaceA))

        expect(profileA).not.toBe(profileB)
        expect(again).toBe(profileA)
        expect(profileA.generationId).toBe(profileB.generationId)
        expect(yield* Ref.get(setups)).toBe(2)
      }).pipe(Effect.provide(makeCacheLayer({ cwd: launch, home, extensions: [counted] })))
    }).pipe(Effect.provide(BunPlatformLive)),
  )

  it.scopedLive(
    "a broken config file still resolves the profile; health, not the profile, reports it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const launch = yield* fs.makeTempDirectoryScoped()
        const project = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const projectConfig = path.join(project, ".gent", "config.json")
        yield* fs.makeDirectory(path.dirname(projectConfig), { recursive: true })
        // A trailing comma: not JSON.
        yield* fs.writeFileString(projectConfig, '{ "disabledExtensions": ["x"], }')
        const healthy = markerExtension("@gent/test-session-profile/config-healthy", "live")

        yield* Effect.gen(function* () {
          const cache = yield* SessionProfileCache
          const profile = yield* cache.resolve(project)
          expect(profile.resolved.extensions.map((extension) => extension.manifest.id)).toEqual([
            ExtensionId.make("@gent/test-session-profile/config-healthy"),
          ])
          // The cached profile outlives a fix to the file, so it holds no config
          // failure; the live health read reports the file.
          expect(profile.resolved.failedExtensions).toEqual([])
          expect(yield* configHealthStatuses(project)).toMatchObject([
            { sourcePath: projectConfig, scope: "project", phase: "load", status: "failed" },
          ])
        }).pipe(
          Effect.provide(
            makeCacheLayer({
              cwd: launch,
              home,
              extensions: [healthy],
              allowFailedExtensions: true,
            }),
          ),
        )
      }).pipe(Effect.provide(BunPlatformLive)),
  )

  it.scopedLive("suspends only the extension whose process resource fails to start", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const launch = yield* fs.makeTempDirectoryScoped()
      const home = yield* fs.makeTempDirectoryScoped()
      const healthy = markerExtension("@gent/test-session-profile/healthy", "live")
      const broken = defineExtension({
        id: "@gent/test-session-profile/broken",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            startResource("test/session-profile/broken", Effect.die("boom")),
          )
        }),
      })

      yield* Effect.gen(function* () {
        const cache = yield* SessionProfileCache
        const profile = yield* cache.resolve(launch)
        expect(profile.resolved.extensions.map((extension) => extension.manifest.id)).toEqual([
          ExtensionId.make("@gent/test-session-profile/healthy"),
        ])
        expect(profile.resolved.failedExtensions).toMatchObject([
          {
            manifest: { id: ExtensionId.make("@gent/test-session-profile/broken") },
            phase: "startup",
          },
        ])
        expect(Context.get(profile.layerContext, SessionProfileResourceMarker).value).toBe("live")
      }).pipe(
        Effect.provide(
          makeCacheLayer({
            cwd: launch,
            home,
            extensions: [healthy, broken],
            allowFailedExtensions: true,
          }),
        ),
        Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("e".repeat(64))),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )

  it.scopedLive("a project-only disabledExtensions entry keeps that extension out", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const launch = yield* fs.makeTempDirectoryScoped()
      const home = yield* fs.makeTempDirectoryScoped()
      const kept = markerExtension("@gent/test-session-profile/kept", "live")
      const dropped = defineExtension({
        id: "@gent/test-session-profile/dropped",
        setup: Effect.void,
      })
      // Only the project config names it; the user config stays silent.
      yield* fs.makeDirectory(path.join(launch, ".gent"), { recursive: true })
      yield* fs.writeFileString(
        path.join(launch, ".gent", "config.json"),
        '{"disabledExtensions":["@gent/test-session-profile/dropped"]}',
      )

      yield* Effect.gen(function* () {
        const cache = yield* SessionProfileCache
        const profile = yield* cache.resolve(launch)
        expect(profile.resolved.extensions.map((extension) => extension.manifest.id)).toEqual([
          ExtensionId.make("@gent/test-session-profile/kept"),
        ])
      }).pipe(
        Effect.provide(makeCacheLayer({ cwd: launch, home, extensions: [kept, dropped] })),
        Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("d".repeat(64))),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )

  // A profile is derived from its cwd and the config's disabled list; an edit
  // to the list must reach the next session without a restart.
  it.scopedLive("a disabledExtensions edit reaches the next resolve without a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const launch = yield* fs.makeTempDirectoryScoped()
      const home = yield* fs.makeTempDirectoryScoped()
      const kept = markerExtension("@gent/test-session-profile/kept-live", "live")
      const toggled = defineExtension({
        id: "@gent/test-session-profile/toggled",
        setup: Effect.void,
      })
      const projectConfig = path.join(launch, ".gent", "config.json")
      yield* fs.makeDirectory(path.dirname(projectConfig), { recursive: true })
      const ids = (profile: SessionProfile) =>
        profile.resolved.extensions.map((extension) => String(extension.manifest.id))

      yield* Effect.gen(function* () {
        const cache = yield* SessionProfileCache
        const before = yield* cache.resolve(launch)
        expect(ids(before)).toEqual([
          "@gent/test-session-profile/kept-live",
          "@gent/test-session-profile/toggled",
        ])
        yield* fs.writeFileString(
          projectConfig,
          '{"disabledExtensions":["@gent/test-session-profile/toggled"]}',
        )
        const disabled = yield* cache.resolve(launch)
        expect(ids(disabled)).toEqual(["@gent/test-session-profile/kept-live"])
        // The same list again is the same profile, not a rebuild.
        expect(yield* cache.resolve(launch)).toBe(disabled)
        yield* fs.writeFileString(projectConfig, "{}")
        expect(yield* cache.resolve(launch)).toBe(before)
      }).pipe(
        Effect.provide(makeCacheLayer({ cwd: launch, home, extensions: [kept, toggled] })),
        Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("f".repeat(64))),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )

  // Each edit to the list derives a new profile. The one it replaces holds
  // process resources, so it closes when its last user lets go.
  it.scopedLive("an edited disabledExtensions list retires the profile it replaced", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const launch = yield* fs.makeTempDirectoryScoped()
      const home = yield* fs.makeTempDirectoryScoped()
      const open = yield* Ref.make(0)
      const tracked = defineExtension({
        id: "@gent/test-session-profile/tracked",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            defineResource({
              id: "@gent/test-session-profile/tracked/marker",
              scope: "process",
              layer: Layer.effect(
                SessionProfileResourceMarker,
                Effect.acquireRelease(
                  Ref.update(open, (count) => count + 1),
                  () => Ref.update(open, (count) => count - 1),
                ).pipe(Effect.as(SessionProfileResourceMarker.of({ value: "tracked" }))),
              ),
            }),
          )
        }),
      })
      // Each toggle holds a process resource and sorts before `tracked`, so
      // every list builds `tracked` over a different context: no profile
      // shares it with another.
      const toggles = ["a", "b", "c", "d"].map((name) =>
        defineExtension({
          id: `@gent/test-session-profile/toggle-${name}`,
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register(
              "resource",
              startResource(`@gent/test-session-profile/toggle-${name}/resource`, Effect.void),
            )
          }),
        }),
      )
      const projectConfig = path.join(launch, ".gent", "config.json")
      yield* fs.makeDirectory(path.dirname(projectConfig), { recursive: true })
      const disable = (ids: ReadonlyArray<string>) =>
        // Replaced, as gent and most editors save: two same-size edits in one
        // millisecond differ only by the new file's inode (`fileVersion`).
        writeFileAtomic(projectConfig, encodeJson({ disabledExtensions: ids }))

      yield* Effect.gen(function* () {
        const cache = yield* SessionProfileCache
        // A turn that resolved the second profile is still running.
        const runningTurn = yield* Scope.make()
        for (const [index, toggle] of toggles.entries()) {
          yield* disable([toggle.manifest.id])
          if (index === 1) {
            yield* cache.resolve(launch).pipe(Scope.provide(runningTurn))
            continue
          }
          yield* Effect.scoped(cache.resolve(launch))
        }
        // The current profile and the one the running turn holds.
        expect(yield* Ref.get(open)).toBe(2)
        yield* Scope.close(runningTurn, Exit.void)
        expect(yield* Ref.get(open)).toBe(1)

        // An id no extension has leaves the same extensions active: no new profile.
        const current = yield* Effect.scoped(cache.resolve(launch))
        yield* disable([
          "@gent/test-session-profile/toggle-d",
          "@gent/test-session-profile/unknown",
        ])
        expect(yield* Effect.scoped(cache.resolve(launch))).toBe(current)
        expect(yield* Ref.get(open)).toBe(1)
      }).pipe(
        Effect.timeout("20 seconds"),
        Effect.provide(makeCacheLayer({ cwd: launch, home, extensions: [tracked, ...toggles] })),
        Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("2".repeat(64))),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )

  // A resolve interrupted right after its build stored the profile: the
  // entry, its lease and `current` are one step, so the profile still
  // retires when a later edit supersedes it.
  it.scopedLive("a resolve interrupted after its build still retires the profile it built", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const launch = yield* fs.makeTempDirectoryScoped()
      const home = yield* fs.makeTempDirectoryScoped()
      const open = yield* Ref.make<ReadonlyArray<string>>([])
      const toggles = ["a", "b"].map((name) =>
        defineExtension({
          id: `@gent/test-session-profile/held-${name}`,
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register(
              "resource",
              defineResource({
                id: `@gent/test-session-profile/held-${name}/marker`,
                scope: "process",
                layer: Layer.effect(
                  SessionProfileResourceMarker,
                  Effect.acquireRelease(
                    Ref.update(open, (names) => [...names, name]),
                    () => Ref.update(open, (names) => names.filter((entry) => entry !== name)),
                  ).pipe(Effect.as(SessionProfileResourceMarker.of({ value: name }))),
                ),
              }),
            )
          }),
        }),
      )
      const projectConfig = path.join(launch, ".gent", "config.json")
      yield* fs.makeDirectory(path.dirname(projectConfig), { recursive: true })
      const disable = (ids: ReadonlyArray<string>) =>
        // Replaced, as gent and most editors save: two same-size edits in one
        // millisecond differ only by the new file's inode (`fileVersion`).
        writeFileAtomic(projectConfig, encodeJson({ disabledExtensions: ids }))
      // The interrupt lands on the first profile's build log, the last step
      // of its build.
      const interrupted = MutableRef.make(false)
      const interruptAfterBuild = Logger.make(({ message, fiber }) => {
        let rendered = String(message)
        if (Array.isArray(message)) rendered = message.join(" ")
        if (!rendered.includes("session-profile.initialized") || MutableRef.get(interrupted)) return
        MutableRef.set(interrupted, true)
        fiber.interruptUnsafe()
      })

      yield* Effect.gen(function* () {
        const cache = yield* SessionProfileCache
        yield* disable(["@gent/test-session-profile/held-a"])
        const first = yield* Effect.scoped(cache.resolve(launch)).pipe(Effect.forkChild)
        expect(Exit.hasInterrupts(yield* Fiber.await(first))).toBe(true)
        expect(yield* Ref.get(open)).toEqual(["b"])
        yield* disable(["@gent/test-session-profile/held-b"])
        yield* Effect.scoped(cache.resolve(launch))
        expect(yield* Ref.get(open)).toEqual(["a"])
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.provide(
          Layer.mergeAll(
            makeCacheLayer({ cwd: launch, home, extensions: toggles }),
            Logger.layer([interruptAfterBuild]),
            Layer.succeed(References.MinimumLogLevel, "Info"),
          ),
        ),
        Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("3".repeat(64))),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )

  // A resolve that read the config before an edit takes the place lock
  // after the resolve that read the edit: it must not make the older
  // profile current again and retire the newer one.
  it.scopedLive("a config read before an edit cannot put the older profile back", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const launch = yield* fs.makeTempDirectoryScoped()
      const home = yield* fs.makeTempDirectoryScoped()
      const toggles = ["a", "b"].map((name) =>
        defineExtension({ id: `@gent/test-session-profile/order-${name}`, setup: Effect.void }),
      )
      const projectConfig = path.join(launch, ".gent", "config.json")
      yield* fs.makeDirectory(path.dirname(projectConfig), { recursive: true })
      const disable = (ids: ReadonlyArray<string>) =>
        // Replaced, as gent and most editors save: two same-size edits in one
        // millisecond differ only by the new file's inode (`fileVersion`).
        writeFileAtomic(projectConfig, encodeJson({ disabledExtensions: ids }))
      // The first config read waits, after it read, until the test lets it go.
      const firstRead = yield* Deferred.make<void>()
      const letGo = yield* Deferred.make<void>()
      const reads = MutableRef.make(0)
      const holdFirstRead = (live: ConfigService["Service"]): ConfigService["Service"] => ({
        ...live,
        getFresh: (cwd) =>
          live.getFresh(cwd).pipe(
            Effect.tap(() => {
              MutableRef.update(reads, (count) => count + 1)
              if (MutableRef.get(reads) !== 1) return Effect.void
              return Deferred.succeed(firstRead, void 0).pipe(Effect.andThen(Deferred.await(letGo)))
            }),
          ),
      })
      const ids = (profile: SessionProfile) =>
        profile.resolved.extensions.map((extension) => String(extension.manifest.id))

      yield* Effect.gen(function* () {
        const cache = yield* SessionProfileCache
        yield* disable(["@gent/test-session-profile/order-a"])
        const older = yield* Effect.scoped(cache.resolve(launch)).pipe(Effect.forkChild)
        yield* Deferred.await(firstRead)
        yield* disable(["@gent/test-session-profile/order-b"])
        const newer = yield* Effect.scoped(cache.resolve(launch)).pipe(Effect.forkChild)
        // A resolve that reads outside the lock finishes here, before the
        // older read goes on; one that reads under the lock waits behind it.
        // Only the unfixed order depends on this wait, so it cannot flake
        // the fixed one.
        yield* Fiber.await(newer).pipe(Effect.timeout("500 millis"), Effect.ignore)
        yield* Deferred.succeed(letGo, void 0)
        expect(ids(yield* Fiber.join(older))).toEqual(["@gent/test-session-profile/order-b"])
        const newerProfile = yield* Fiber.join(newer)
        expect(ids(newerProfile)).toEqual(["@gent/test-session-profile/order-a"])
        // The edit read last stays current: the next resolve reuses it.
        expect(yield* Effect.scoped(cache.resolve(launch))).toBe(newerProfile)
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.provide(
          makeCacheLayer({ cwd: launch, home, extensions: toggles, wrapConfig: holdFirstRead }),
        ),
        Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("4".repeat(64))),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )

  // A profile is keyed on the extension files on disk as well as the config:
  // a file added, broken, fixed or edited reaches the next resolve without a
  // restart or a config edit.
  it.scopedLive("an added, broken, fixed or edited extension file reaches the next resolve", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const launch = yield* fs.makeTempDirectoryScoped()
      // The loader binds `effect`, so the extension file needs no node_modules.
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-profile-files-" })
      const extensionDir = path.join(home, ".gent", "extensions")
      yield* fs.makeDirectory(extensionDir, { recursive: true })
      const extensionFile = path.join(extensionDir, "probe.ts")
      const writeExtension = (id: string) =>
        fs.writeFileString(
          extensionFile,
          `import { Effect } from "effect"\nexport default { manifest: { id: "${id}" }, setup: Effect.void }\n`,
        )
      const kept = defineExtension({
        id: "@gent/test-session-profile/files-kept",
        setup: Effect.void,
      })
      const ids = (profile: SessionProfile) =>
        profile.resolved.extensions.map((extension) => String(extension.manifest.id))
      const failedPaths = (profile: SessionProfile) =>
        profile.resolved.failedExtensions.map((extension) => extension.sourcePath)

      yield* Effect.gen(function* () {
        const cache = yield* SessionProfileCache
        const resolve = Effect.scoped(cache.resolve(launch))
        expect(ids(yield* resolve)).toEqual(["@gent/test-session-profile/files-kept"])

        yield* writeExtension("@gent/test-file-added")
        expect(ids(yield* resolve)).toContain("@gent/test-file-added")

        yield* fs.writeFileString(extensionFile, "export const = ;\n")
        const broken = yield* resolve
        expect(ids(broken)).toEqual(["@gent/test-session-profile/files-kept"])
        expect(failedPaths(broken)).toEqual([extensionFile])

        // The same path again, with new content: imported afresh, not from
        // the module cache.
        yield* writeExtension("@gent/test-file-fixed-and-renamed")
        const fixed = yield* resolve
        expect(ids(fixed)).toContain("@gent/test-file-fixed-and-renamed")
        expect(failedPaths(fixed)).toEqual([])
        // Nothing changed since: the same profile.
        expect(yield* resolve).toBe(fixed)
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.provide(
          makeCacheLayer({ cwd: launch, home, extensions: [kept], allowFailedExtensions: true }),
        ),
        Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("5".repeat(64))),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )

  // A profile rebuilt for a config edit shares the process resources it
  // builds over the same context, so an open pane, a watcher or a running job
  // keeps its state. Only resources the edit touches close and rebuild.
  it.scopedLive(
    "a profile rebuilt for an edit keeps the process resources the edit leaves alone",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const launch = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const builds = yield* Ref.make<ReadonlyArray<string>>([])
        const open = yield* Ref.make<ReadonlyArray<string>>([])
        const withResource = (name: string) =>
          defineExtension({
            id: `@gent/test-session-profile/${name}`,
            setup: Effect.gen(function* () {
              const host = yield* ExtensionHost
              yield* host.register(
                "resource",
                defineResource({
                  id: `@gent/test-session-profile/${name}/marker`,
                  scope: "process",
                  layer: Layer.effect(
                    SessionProfileResourceMarker,
                    Effect.acquireRelease(
                      Ref.update(builds, (names) => [...names, name]).pipe(
                        Effect.andThen(Ref.update(open, (names) => [...names, name])),
                      ),
                      // One release closes one build of the resource.
                      () =>
                        Ref.update(open, (names) =>
                          names.filter((_, index) => index !== names.indexOf(name)),
                        ),
                    ).pipe(Effect.as(SessionProfileResourceMarker.of({ value: name }))),
                  ),
                }),
              )
            }),
          })
        // Resolution order: `shared-a`, then `shared-b` (no resource), then `shared-c`.
        const extensions = [
          withResource("shared-a"),
          defineExtension({ id: "@gent/test-session-profile/shared-b", setup: Effect.void }),
          withResource("shared-c"),
        ]
        const projectConfig = path.join(launch, ".gent", "config.json")
        yield* fs.makeDirectory(path.dirname(projectConfig), { recursive: true })
        // Replaced, as gent and most editors save: see `fileVersion`.
        const disable = (names: ReadonlyArray<string>) =>
          writeFileAtomic(
            projectConfig,
            encodeJson({
              disabledExtensions: names.map((name) => `@gent/test-session-profile/${name}`),
            }),
          )
        const sorted = (names: ReadonlyArray<string>) => names.toSorted()

        yield* Effect.gen(function* () {
          const cache = yield* SessionProfileCache
          const resolve = Effect.scoped(cache.resolve(launch))
          const first = yield* resolve
          expect(sorted(yield* Ref.get(open))).toEqual(["shared-a", "shared-c"])

          // An extension with no resource: both resources carry over.
          yield* disable(["shared-b"])
          expect(yield* resolve).not.toBe(first)
          expect(sorted(yield* Ref.get(builds))).toEqual(["shared-a", "shared-c"])
          expect(sorted(yield* Ref.get(open))).toEqual(["shared-a", "shared-c"])

          // The last resource's extension: only its resource closes.
          yield* disable(["shared-c"])
          yield* resolve
          expect(sorted(yield* Ref.get(builds))).toEqual(["shared-a", "shared-c"])
          expect(yield* Ref.get(open)).toEqual(["shared-a"])

          yield* disable(["shared-b"])
          yield* resolve
          expect(sorted(yield* Ref.get(builds))).toEqual(["shared-a", "shared-c", "shared-c"])
          expect(sorted(yield* Ref.get(open))).toEqual(["shared-a", "shared-c"])

          // An extension before `shared-c`: `shared-c` is built over another
          // context now, so it is built again.
          yield* disable(["shared-a"])
          yield* resolve
          expect(sorted(yield* Ref.get(builds))).toEqual([
            "shared-a",
            "shared-c",
            "shared-c",
            "shared-c",
          ])
          expect(yield* Ref.get(open)).toEqual(["shared-c"])
        }).pipe(
          Effect.timeout("10 seconds"),
          Effect.provide(makeCacheLayer({ cwd: launch, home, extensions })),
          Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("6".repeat(64))),
        )
      }).pipe(Effect.provide(BunPlatformLive)),
  )

  it.scopedLive("releases a partially built profile when its build is interrupted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const launch = yield* fs.makeTempDirectoryScoped()
      const home = yield* fs.makeTempDirectoryScoped()
      const workspace = WorkspaceId.make("1".repeat(64))
      const stopped = yield* Deferred.make<void>()
      const startEntered = yield* Deferred.make<void>()
      const releaseStart = yield* Deferred.make<void>()
      const starts = yield* Ref.make(0)
      // Resources start in id order, so the healthy extension is built before
      // the blocking one enters its start effect.
      const healthy = markerExtension(
        "@gent/test-session-profile/built-first",
        "live",
        Deferred.succeed(stopped, void 0).pipe(Effect.asVoid),
      )
      const blocking = defineExtension({
        id: "@gent/test-session-profile/waiting-start",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            startResource(
              "test/session-profile/waiting-start",
              Effect.gen(function* () {
                yield* Ref.update(starts, (count) => count + 1)
                yield* Deferred.succeed(startEntered, void 0)
                yield* Deferred.await(releaseStart)
              }),
            ),
          )
        }),
      })

      yield* Effect.ensuring(
        Effect.gen(function* () {
          const cache = yield* SessionProfileCache
          const resolving = yield* cache
            .resolve(launch)
            .pipe(Effect.provideService(CurrentWorkspaceId, workspace), Effect.forkChild)
          yield* Deferred.await(startEntered)
          yield* Fiber.interrupt(resolving)
          expect(Exit.isFailure(yield* Fiber.await(resolving))).toBe(true)
          // The healthy extension's resource was already built and must be released.
          expect(Option.isSome(yield* Deferred.poll(stopped))).toBe(true)

          yield* Deferred.succeed(releaseStart, void 0)
          const profile = yield* cache
            .resolve(launch)
            .pipe(Effect.provideService(CurrentWorkspaceId, workspace))
          expect(yield* Ref.get(starts)).toBe(2)
          expect(profile.resolved.failedExtensions).toEqual([])
          expect(Context.get(profile.layerContext, SessionProfileResourceMarker).value).toBe("live")
        }).pipe(
          Effect.provide(makeCacheLayer({ cwd: launch, home, extensions: [healthy, blocking] })),
        ),
        Deferred.succeed(releaseStart, void 0).pipe(Effect.asVoid),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )
})

// ── turn profile resolution ──────────────────────────────────────────────────

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const emptyRegistryLayer = ExtensionRegistry.fromResolved(resolveExtensions([]))
describe("resolveTurnProfile", () => {
  it.scopedLive("uses the stored session cwd to resolve the profile-scoped host context", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const launch = yield* fs.makeTempDirectoryScoped()
      const secondary = yield* fs.makeTempDirectoryScoped()
      const home = yield* fs.makeTempDirectoryScoped()
      const writeProjectConfig = (cwd: string) =>
        Effect.gen(function* () {
          const configDir = path.join(cwd, ".gent")
          yield* fs.makeDirectory(configDir, { recursive: true })
          yield* fs.writeFileString(path.join(configDir, "config.json"), encodeJson({}))
        })
      yield* writeProjectConfig(launch)
      yield* writeProjectConfig(secondary)
      const runtimeEnvironmentLive = RuntimeEnvironment.Live({
        cwd: launch,
        home,
      })
      const configServiceLive = ConfigService.Live.pipe(
        Layer.provide(Layer.merge(BunServices.layer, runtimeEnvironmentLive)),
      )
      const sessionProfileCacheLive = SessionProfileCache.Live({
        failOnExtensionFailure: true,
        home,
        platform: "darwin",
        extensions: [],
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            BunServices.layer,
            configServiceLive,
            SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(Layer.provide(BunPlatformLive)),
          ),
        ),
      )
      const testLayer = Layer.mergeAll(
        BunServices.layer,
        SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(Layer.provide(BunPlatformLive)),
        emptyRegistryLayer,
        runtimeEnvironmentLive,
        sessionProfileCacheLive,
      )
      yield* Effect.gen(function* () {
        const sessionStorage = yield* SessionStorage
        const profileCache = yield* SessionProfileCache
        const now = dateFromMillis(1_767_225_600_000)
        yield* sessionStorage.createSession(
          new Session({
            id: SessionId.make("session-runtime-context-profile"),
            cwd: secondary,
            createdAt: now,
            updatedAt: now,
          }),
        )
        const hostProvider = yield* makeExtensionHostContextProvider({
          host: testHostFacts().host,
        })
        const resolved = yield* resolveTurnProfile({
          sessionId: SessionId.make("session-runtime-context-profile"),
          branchId: BranchId.make("branch-runtime-context-profile"),
          opener: RunOpener.cases.Turn.make({ openedByClient: true }),
          profileCache,
          hostProvider,
          defaults: { baseSections: [] },
        })
        expect(resolved.turnHostCtx.cwd).toBe(secondary)
      }).pipe(Effect.provide(testLayer), Effect.scoped)
    }).pipe(Effect.provide(BunPlatformLive)),
  )
  it.scopedLive("falls back to host deps and defaults when no session profile is available", () =>
    Effect.gen(function* () {
      const runtimeEnvironmentLayer = RuntimeEnvironment.Live({
        cwd: "/tmp/runtime-context-default",
        home: "/nonexistent/runtime-context-home",
      })
      const defaults: TurnProfileDefaults = {
        baseSections: [{ id: "default", content: "Default", priority: 1 }],
      }
      const testLayer = Layer.mergeAll(
        testSqliteStorage(() => Layer.empty, {}),
        emptyRegistryLayer,
        runtimeEnvironmentLayer,
      )
      yield* Effect.gen(function* () {
        const hostProvider = yield* makeExtensionHostContextProvider({
          host: testHostFacts().host,
        })
        const resolved = yield* resolveTurnProfile({
          sessionId: SessionId.make("missing-session"),
          branchId: BranchId.make("missing-branch"),
          opener: RunOpener.cases.Turn.make({ openedByClient: true }),
          hostProvider,
          defaults,
        })
        expect(resolved.turnHostCtx.cwd).toBe("/tmp/runtime-context-default")
        expect(resolved.turnBaseSections).toEqual([
          { id: "default", content: "Default", priority: 1 },
        ])
      }).pipe(Effect.provide(testLayer))
    }),
  )
  it.scopedLive("preserves storage lookup failures when fallback is disabled", () =>
    Effect.gen(function* () {
      const runtimeEnvironmentLayer = RuntimeEnvironment.Live({
        cwd: "/tmp/runtime-context-fail",
        home: "/nonexistent/runtime-context-home",
      })
      const testLayer = Layer.mergeAll(
        testSqliteStorage(() => Layer.empty, {}),
        emptyRegistryLayer,
        runtimeEnvironmentLayer,
      )
      yield* Effect.gen(function* () {
        const sessionStorage = yield* SessionStorage
        const failingSessionStorage: SessionStorageService = {
          ...sessionStorage,
          getSession: () => Effect.fail(new StorageError({ message: "lookup failed" })),
        }
        const hostProvider = yield* makeExtensionHostContextProvider({
          host: testHostFacts().host,
        })
        const exit = yield* Effect.exit(
          resolveTurnProfile({
            sessionId: SessionId.make("session-runtime-context-storage-failure"),
            branchId: BranchId.make("branch-runtime-context-storage-failure"),
            opener: RunOpener.cases.Turn.make({ openedByClient: true }),
            hostProvider,
            defaults: { baseSections: [] },
          }).pipe(Effect.provideService(SessionStorage, failingSessionStorage)),
        )
        expect(exit._tag).toBe("Success")
        if (exit._tag === "Success") {
          expect(exit.value.turnHostCtx.cwd).toBe("/tmp/runtime-context-fail")
        }
      }).pipe(Effect.provide(testLayer))
    }),
  )
  it.scopedLive("prefers the profile registry and its drivers over fallback defaults", () =>
    Effect.gen(function* () {
      const profileResolved = resolveExtensions([
        {
          manifest: { id: ExtensionId.make("profile-driver-ext") },
          scope: "project",
          sourcePath: "/test/profile-driver-ext",
          contributions: {
            modelDrivers: [
              {
                id: "profile-driver",
                name: "Profile driver",
                resolveModel: () => stubResolution(),
              },
            ],
          },
        },
      ])
      const runtimeEnvironmentLayer = RuntimeEnvironment.Live({
        cwd: "/tmp/runtime-context-default",
        home: "/nonexistent/runtime-context-home",
      })
      const testLayer = Layer.mergeAll(
        testSqliteStorage(() => Layer.empty, {}),
        emptyRegistryLayer,
        runtimeEnvironmentLayer,
      )
      yield* Effect.gen(function* () {
        const sessionStorage = yield* SessionStorage
        const extensionRegistry = yield* ExtensionRegistry
        const now = dateFromMillis(1_767_225_600_000)
        yield* sessionStorage.createSession(
          new Session({
            id: SessionId.make("session-runtime-context-driver"),
            cwd: "/tmp/profile-driver-scope",
            createdAt: now,
            updatedAt: now,
          }),
        )
        const fakeProfile: SessionProfile = {
          cwd: "/tmp/profile-driver-scope",
          resolved: profileResolved,
          layerContext: Context.makeUnsafe(new Map<string, unknown>()),
          registryService: { getResolved: () => profileResolved },
          baseSections: [],
          generationId: ProcessGenerationId.make("test"),
        }
        const fakeProfileCache: SessionProfileCacheService = {
          resolve: () => Effect.succeed(fakeProfile),
        }
        const hostProvider = yield* makeExtensionHostContextProvider({
          host: testHostFacts().host,
        })
        const resolved = yield* resolveTurnProfile({
          sessionId: SessionId.make("session-runtime-context-driver"),
          branchId: BranchId.make("branch-runtime-context-driver"),
          opener: RunOpener.cases.Turn.make({ openedByClient: true }),
          profileCache: fakeProfileCache,
          hostProvider,
          defaults: { baseSections: [] },
        })
        const drivers = resolved.turnExtensionRegistry.getResolved().modelDrivers
        expect(resolved.turnHostCtx.cwd).toBe("/tmp/profile-driver-scope")
        expect(drivers.get("profile-driver")?.id).toBe("profile-driver")
        expect(extensionRegistry.getResolved().modelDrivers.has("profile-driver")).toBe(false)
      }).pipe(Effect.provide(testLayer))
    }),
  )
})

// ── driver resolution ────────────────────────────────────────────────────────

/**
 * Driver resolution — model drivers resolve into the extension registry with
 * scope precedence, and listModelCatalog concatenates every driver's catalog. Every agent turn dispatches through
 * `agent.driver: DriverRef → ExtensionRegistry`, so a scope-precedence
 * regression breaks per-cwd extension resolution.
 */
const stubResolution = (): Effect.Effect<ProviderResolution> =>
  Effect.succeed(
    AiModel.make("test", "model", Layer.succeed(LanguageModel.LanguageModel, failingLanguageModel)),
  )
const makeModel = (id: string, name?: string): ModelDriverContribution => ({
  id,
  name: Option.getOrElse(Option.fromUndefinedOr(name), () => id),
  resolveModel: stubResolution,
})
const makeCatalogModel = (id: string, keep = true): Model => {
  let contextLength = 0
  if (keep) contextLength = 1
  return Model.make({
    id: ModelId.make(id),
    name: id,
    provider: ProviderId.make(id.split("/", 1)[0] ?? id),
    contextLength,
  })
}
const makeExt = (
  id: string,
  scope: "builtin" | "user" | "project",
  opts: { readonly modelDrivers: ReadonlyArray<ModelDriverContribution> },
): LoadedExtension => ({
  manifest: { id: ExtensionId.make(id) },
  scope,
  sourcePath: `/test/${id}`,
  contributions: { modelDrivers: opts.modelDrivers },
})
describe("driver resolution", () => {
  test("getModel resolves a registered model driver", () => {
    const resolved = resolveExtensions([
      makeExt("anthropic-ext", "builtin", { modelDrivers: [makeModel("anthropic")] }),
    ])
    const result = resolved.modelDrivers.get("anthropic")
    expect(result?.id).toBe("anthropic")
  })
  test("project scope shadows builtin for same model driver id", () => {
    const resolved = resolveExtensions([
      makeExt("ext-builtin", "builtin", { modelDrivers: [makeModel("openai", "Builtin")] }),
      makeExt("ext-project", "project", { modelDrivers: [makeModel("openai", "Project")] }),
    ])
    const result = resolved.modelDrivers.get("openai")
    expect(result?.name).toBe("Project")
  })
  it.live("listModelCatalog concatenates every driver's own catalog", () =>
    Effect.gen(function* () {
      const first: ModelDriverContribution = {
        id: "first",
        name: "First",
        resolveModel: stubResolution,
        listModels: () => Effect.succeed([makeCatalogModel("first/one")]),
      }
      const second: ModelDriverContribution = {
        id: "second",
        name: "Second",
        resolveModel: stubResolution,
        listModels: () => Effect.succeed([makeCatalogModel("second/one")]),
      }
      const resolved = resolveExtensions([
        makeExt("ext", "builtin", { modelDrivers: [first, second] }),
      ])
      const result = yield* listModelCatalog(resolved.modelDrivers)
      expect(result.models.map((model) => model.id)).toEqual([
        ModelId.make("first/one"),
        ModelId.make("second/one"),
      ])
    }),
  )
  it.live("a driver without listModels contributes nothing to the catalog", () =>
    Effect.gen(function* () {
      const listing: ModelDriverContribution = {
        id: "listing",
        name: "Listing",
        resolveModel: stubResolution,
        listModels: () => Effect.succeed([makeCatalogModel("listing/one")]),
      }
      const silent: ModelDriverContribution = {
        id: "silent",
        name: "Silent",
        resolveModel: stubResolution,
      }
      const resolved = resolveExtensions([
        makeExt("ext", "builtin", { modelDrivers: [listing, silent] }),
      ])
      const result = yield* listModelCatalog(resolved.modelDrivers)
      expect(result.models.map((model) => model.id)).toEqual([ModelId.make("listing/one")])
    }),
  )
  it.live("listModelCatalog passes resolveAuth(driverId) into each driver's listModels", () =>
    Effect.gen(function* () {
      const seenAuth: Array<{
        driverId: string
        auth: Option.Option<ProviderAuthInfo>
      }> = []
      const driverA: ModelDriverContribution = {
        id: "auth-a",
        name: "AuthA",
        resolveModel: stubResolution,
        listModels: (auth) =>
          Effect.sync(() => {
            seenAuth.push({ driverId: "auth-a", auth: Option.fromUndefinedOr(auth) })
            return [makeCatalogModel("auth-a/one")]
          }),
      }
      const driverB: ModelDriverContribution = {
        id: "auth-b",
        name: "AuthB",
        resolveModel: stubResolution,
        listModels: (auth) =>
          Effect.sync(() => {
            seenAuth.push({ driverId: "auth-b", auth: Option.fromUndefinedOr(auth) })
            return [makeCatalogModel("auth-b/one")]
          }),
      }
      const resolved = resolveExtensions([
        makeExt("auth-ext", "builtin", { modelDrivers: [driverA, driverB] }),
      ])
      yield* listModelCatalog(resolved.modelDrivers, (driverId) => {
        if (driverId === "auth-a") {
          return Effect.succeed(ProviderAuthInfo.cases.Api.make({ key: "secret-a" }))
        }
        return Effect.succeed(Option.getOrUndefined(Option.none<ProviderAuthInfo>()))
      })
      // Each driver's listModels should have been called with the auth from resolveAuth(its id)
      const authAEntry = Option.fromUndefinedOr(seenAuth.find((s) => s.driverId === "auth-a"))
      expect(Option.isSome(authAEntry)).toBe(true)
      if (Option.isNone(authAEntry)) return
      expect(Option.isSome(authAEntry.value.auth)).toBe(true)
      if (Option.isNone(authAEntry.value.auth)) return
      expect(authAEntry.value.auth.value).toEqual(
        ProviderAuthInfo.cases.Api.make({ key: "secret-a" }),
      )
      const authBEntry = Option.fromUndefinedOr(seenAuth.find((s) => s.driverId === "auth-b"))
      expect(Option.isSome(authBEntry)).toBe(true)
      if (Option.isNone(authBEntry)) return
      expect(Option.isNone(authBEntry.value.auth)).toBe(true)
    }),
  )
  it.live("a failing driver catalog is skipped and reported; the others still list", () =>
    Effect.gen(function* () {
      const malformed = makeCatalogModel("broken/invalid")
      Reflect.set(malformed, "name", 42)
      const broken: ModelDriverContribution = {
        id: "broken",
        name: "Broken",
        resolveModel: stubResolution,
        listModels: () => Effect.succeed([malformed]),
      }
      // A user driver whose local server is down.
      const offline: ModelDriverContribution = {
        id: "offline",
        name: "Offline",
        resolveModel: stubResolution,
        listModels: () => Effect.die(new Error("connect ECONNREFUSED 127.0.0.1:11434")),
      }
      const working: ModelDriverContribution = {
        id: "working",
        name: "Working",
        resolveModel: stubResolution,
        listModels: () => Effect.succeed([makeCatalogModel("working/one")]),
      }
      const resolved = resolveExtensions([
        makeExt("drivers-ext", "builtin", { modelDrivers: [broken, offline, working] }),
      ])
      const result = yield* listModelCatalog(resolved.modelDrivers)
      expect(result.models.map((model) => model.id)).toEqual([ModelId.make("working/one")])
      expect(result.failures.map((failure) => failure.driverId)).toEqual(["broken", "offline"])
      expect(result.failures[0]?.error).toContain("invalid model catalog")
      expect(result.failures[1]?.error).toContain("ECONNREFUSED")
    }),
  )
})

// ── extension activation isolation ───────────────────────────────────────────

const childProcessSpawnerLive = BunChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer)),
)

const fsLayer = Layer.provideMerge(
  Layer.mergeAll(BunFileSystem.layer, Path.layer, BunCrypto.layer, BunGentPlatformLive),
  childProcessSpawnerLive,
)

const builtin = (extension: ReturnType<typeof makeBuiltin>): DiscoveredExtension => ({
  extension,
  scope: "builtin",
  sourcePath: "builtin",
})

const makeBuiltin = (
  id: string,
  setup: Effect.Effect<ExtensionContributions, ExtensionLoadError>,
): GentExtension => ({
  manifest: { id: ExtensionId.make(id) },
  setup: setup.pipe(Effect.flatMap(registerContributions)),
})

const makeLoaded = (id: string, contributions: ExtensionContributions): LoadedExtension => ({
  manifest: { id: ExtensionId.make(id) },
  scope: "builtin",
  sourcePath: "builtin",
  contributions,
})

test("extensions of one scope resolve in code-unit order of their ids", () => {
  // The later extension wins a service conflict; the locale must not pick it.
  const order = sortExtensionsByScope([makeLoaded("alpha", {}), makeLoaded("Zeta", {})])
  expect(order.map((extension) => String(extension.manifest.id))).toEqual(["Zeta", "alpha"])
})

describe("extension activation isolation", () => {
  it.live("builtin setup failure is isolated instead of crashing activation", () =>
    Effect.gen(function* () {
      const good = makeBuiltin(
        "good-ext",
        Effect.succeed({
          tools: [
            tool({
              id: "good_tool",
              description: "good",
              params: Schema.Struct({}),
              output: Schema.Void,
              execute: () => Effect.void,
            }),
          ],
        }),
      )
      const bad = makeBuiltin("bad-ext", Effect.die(new Error("setup boom")))

      const result = yield* setupExtensions({
        extensions: [good, bad].map(builtin),
        cwd: "/tmp",
        home: "/nonexistent/gent-test-home",
        disabled: new Set(),
      })

      expect(result.active.map((ext) => ext.manifest.id)).toEqual([ExtensionId.make("good-ext")])
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]!.manifest.id).toBe(ExtensionId.make("bad-ext"))
      expect(result.failed[0]!.phase).toBe("setup")
      expect(result.failed[0]!.error).toContain("setup boom")
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("does not infer builtin identity without a compiled build token", () =>
    Effect.gen(function* () {
      const extension = makeBuiltin("compiled-artifact", Effect.succeed({}))
      const result = yield* setupExtensions({
        extensions: [builtin(extension)],
        cwd: "/tmp",
        home: "/nonexistent/gent-test-home",
        disabled: new Set(),
      })
      expect(result.active[0]?.artifactIdentity).toBeUndefined()
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("discovered setup failure is isolated instead of crashing activation", () =>
    Effect.gen(function* () {
      const result = yield* setupExtensions({
        extensions: [
          {
            extension: makeBuiltin("good-ext", Effect.succeed({})),
            scope: "user",
            sourcePath: "/tmp/good.ts",
          },
          {
            extension: makeBuiltin("bad-ext", Effect.die(new Error("setup boom"))),
            scope: "project",
            sourcePath: "/tmp/bad.ts",
          },
        ],
        cwd: "/tmp",
        home: "/nonexistent/gent-test-home",
        disabled: new Set(),
      })

      expect(result.active.map((ext) => ext.manifest.id)).toEqual([ExtensionId.make("good-ext")])
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]).toMatchObject({
        manifest: { id: ExtensionId.make("bad-ext") },
        scope: "project",
        sourcePath: "/tmp/bad.ts",
        phase: "setup",
      })
      expect(result.failed[0]?.error).toContain("setup boom")
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live(
    "validation collisions fail the conflicting extensions instead of crashing host activation",
    () =>
      Effect.gen(function* () {
        const result = yield* validateLoadedExtensions([
          makeLoaded("healthy-ext", {
            tools: [
              tool({
                id: "healthy_tool",
                description: "healthy",
                params: Schema.Struct({}),
                output: Schema.Void,
                execute: () => Effect.void,
              }),
            ],
          }),
          makeLoaded("collider-a", {
            tools: [
              tool({
                id: "shared_tool",
                description: "a",
                params: Schema.Struct({}),
                output: Schema.Void,
                execute: () => Effect.void,
              }),
            ],
          }),
          makeLoaded("collider-b", {
            tools: [
              tool({
                id: "shared_tool",
                description: "b",
                params: Schema.Struct({}),
                output: Schema.Void,
                execute: () => Effect.void,
              }),
            ],
          }),
        ])

        expect(result.active.map((ext) => ext.manifest.id)).toEqual([
          ExtensionId.make("healthy-ext"),
        ])
        expect(result.failed).toHaveLength(2)
        expect(result.failed.map((ext) => ext.manifest.id).sort()).toEqual([
          ExtensionId.make("collider-a"),
          ExtensionId.make("collider-b"),
        ])
        expect(result.failed.every((ext) => ext.phase === "validation")).toBe(true)
        expect(result.failed.every((ext) => ext.error.includes("shared_tool"))).toBe(true)
      }),
  )

  // Activation must catch cross-bucket capability collisions in addition to
  // tool/tool. The resolver overwrites silently in last-write-wins order
  // without this check.
  const rawToolLeaf = (id: string, description?: string) => {
    let normalizedDescription = ""
    if (!Predicate.isUndefined(description)) normalizedDescription = description
    return tool({
      id,
      description: normalizedDescription,
      params: Schema.Unknown,
      output: Schema.Void,
      execute: () => Effect.void,
    })
  }

  const metadataSpoofedToolLeaf = (
    id: string,
    metadata: {
      readonly id?: string
    } = {},
  ): never => {
    const legit = tool({
      id: metadata.id ?? "legit",
      description: "legit",
      params: Schema.Unknown,
      output: Schema.Void,
      execute: () => Effect.void,
    })
    // oxlint-disable-next-line effect/noAs -- This metadata-spoofed native tool is a runtime validation fixture.
    return AiTool.dynamic(id, {
      description: "native with copied Gent metadata but no private brand",
      parameters: Schema.Unknown,
    }).annotate(GentToolMetadataTag, getToolMetadata(legit)) as never
  }

  const rawRpcLeaf = (id: string): never =>
    // oxlint-disable-next-line effect/noAs -- This invalid RPC leaf is a runtime validation fixture.
    ({
      id,
      input: Schema.Unknown,
      output: Schema.Unknown,
      effect: () => Effect.void,
    }) as never

  it.live("validation catches same-scope tool/tool name collision", () =>
    Effect.gen(function* () {
      const result = yield* validateLoadedExtensions([
        makeLoaded("collider-a", { tools: [rawToolLeaf("shared_cap", "a")] }),
        makeLoaded("collider-b", { tools: [rawToolLeaf("shared_cap", "b")] }),
      ])

      expect(result.active).toEqual([])
      expect(result.failed.map((ext) => ext.manifest.id).sort()).toEqual([
        ExtensionId.make("collider-a"),
        ExtensionId.make("collider-b"),
      ])
      expect(result.failed.every((ext) => ext.error.includes("shared_cap"))).toBe(true)
    }),
  )

  it.live("validation fails a tool and a request that share an id in one scope", () =>
    Effect.gen(function* () {
      // Tools and requests share one id namespace: resolution keeps one
      // winner per id, so a passing pair would silently drop the tool.
      const result = yield* validateLoadedExtensions([
        makeLoaded("model-tool", {
          tools: [
            tool({
              id: "shared_name",
              description: "model",
              params: Schema.Struct({}),
              output: Schema.Void,
              execute: () => Effect.void,
            }),
          ],
        }),
        makeLoaded("rpc-only", { requests: [rawRpcLeaf("shared_name")] }),
      ])

      expect(result.active).toEqual([])
      expect(result.failed.map((ext) => ext.manifest.id).sort()).toEqual([
        ExtensionId.make("model-tool"),
        ExtensionId.make("rpc-only"),
      ])
      expect(result.failed.every((ext) => ext.error.includes('capability "shared_name"'))).toBe(
        true,
      )
    }),
  )

  it.live("validation fails one extension whose own tool and request share an id", () =>
    Effect.gen(function* () {
      // One extension, one id twice: resolution would keep only the request.
      // Setup owns this check; the cross-extension pass never sees the package.
      const result = yield* setupExtensions({
        extensions: [
          builtin(
            makeBuiltin(
              "self-shadow",
              Effect.succeed({
                tools: [
                  tool({
                    id: "shared_name",
                    description: "model",
                    params: Schema.Struct({}),
                    output: Schema.Void,
                    execute: () => Effect.void,
                  }),
                ],
                requests: [
                  request({
                    id: "shared_name",
                    input: Schema.Struct({}),
                    output: Schema.String,
                    execute: () => Effect.succeed("ok"),
                  }),
                ],
              }),
            ),
          ),
        ],
        cwd: "/tmp",
        home: "/nonexistent/gent-test-home",
        disabled: new Set(),
      })

      expect(result.active).toEqual([])
      expect(result.failed.map((ext) => ext.manifest.id)).toEqual([ExtensionId.make("self-shadow")])
      expect(result.failed[0]?.phase).toBe("setup")
      expect(result.failed[0]?.error).toContain("requests[0] (shared_name): duplicate id")
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("a tool with a blank description keeps its extension out of the active set", () =>
    Effect.gen(function* () {
      const result = yield* setupExtensions({
        extensions: [
          makeBuiltin(
            "healthy-ext",
            Effect.succeed({
              tools: [
                tool({
                  id: "healthy_tool",
                  description: "healthy",
                  params: Schema.Unknown,
                  output: Schema.Void,
                  execute: () => Effect.void,
                }),
              ],
            }),
          ),
          makeBuiltin("blank-desc", Effect.succeed({ tools: [rawToolLeaf("blanky", "   \t\n")] })),
        ].map(builtin),
        cwd: "/tmp",
        home: "/nonexistent/gent-test-home",
        disabled: new Set(),
      })

      expect(result.active.map((ext) => ext.manifest.id)).toEqual([ExtensionId.make("healthy-ext")])
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]?.manifest.id).toBe(ExtensionId.make("blank-desc"))
      expect(result.failed[0]?.error).toContain(
        "tools[0] (blanky): tool requires a non-empty `description`",
      )
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("a metadata-spoofed tool never collides with a healthy tool of the same id", () =>
    Effect.gen(function* () {
      const result = yield* setupExtensions({
        extensions: [
          makeBuiltin(
            "healthy-ext",
            Effect.succeed({
              tools: [
                tool({
                  id: "shared_cap",
                  description: "healthy",
                  params: Schema.Unknown,
                  output: Schema.Void,
                  execute: () => Effect.void,
                }),
              ],
            }),
          ),
          makeBuiltin(
            "metadata-spoof",
            Effect.succeed({
              tools: [metadataSpoofedToolLeaf("spoofed_native", { id: "shared_cap" })],
            }),
          ),
        ].map(builtin),
        cwd: "/tmp",
        home: "/nonexistent/gent-test-home",
        disabled: new Set(),
      })

      expect(result.active.map((ext) => ext.manifest.id)).toEqual([ExtensionId.make("healthy-ext")])
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]?.manifest.id).toBe(ExtensionId.make("metadata-spoof"))
      expect(result.failed[0]?.error).toContain(
        "tools[0]: tool must be created with `tool({...})` so Gent metadata is attached",
      )
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("a request capability without a description stays active", () =>
    Effect.gen(function* () {
      // Requests never ship to the LLM as a tool schema, so the description
      // rule does not reach them.
      const undescribedRequest = request({
        id: "internal",
        input: Schema.Struct({}),
        output: Schema.String,
        execute: () => Effect.succeed("ok"),
      })
      const result = yield* setupExtensions({
        extensions: [
          builtin(makeBuiltin("rpc-no-desc", Effect.succeed({ requests: [undescribedRequest] }))),
        ],
        cwd: "/tmp",
        home: "/nonexistent/gent-test-home",
        disabled: new Set(),
      })

      expect(result.active.map((ext) => ext.manifest.id)).toEqual([ExtensionId.make("rpc-no-desc")])
      expect(result.failed).toEqual([])
    }).pipe(Effect.provide(fsLayer)),
  )

  it.scopedLive("live Profile isolates setup and scheduler failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const context = yield* Layer.build(
        SessionProfileCache.Live({
          // Failure isolation is the subject here, so the build keeps going.
          failOnExtensionFailure: false,
          home,
          platform: "test",
          extensions: [
            makeBuiltin(
              "healthy-ext",
              Effect.succeed({
                tools: [
                  tool({
                    id: "healthy_tool",
                    description: "healthy",
                    params: Schema.Struct({}),
                    output: Schema.Void,
                    execute: () => Effect.void,
                  }),
                ],
              }),
            ),
            makeBuiltin("broken-setup", Effect.die(new Error("setup boom"))),
          ],
        }),
      )
      const cache = Context.get(context, SessionProfileCache)
      const profile = yield* cache.resolve(home)
      expect(profile.resolved.extensions.map((ext) => ext.manifest.id)).toEqual([
        ExtensionId.make("healthy-ext"),
      ])
      expect([...profile.resolved.modelCapabilities.keys()]).toEqual(["healthy_tool"])
      expect(profile.resolved.failedExtensions).toHaveLength(1)
      expect(profile.resolved.failedExtensions[0]).toMatchObject({
        manifest: { id: ExtensionId.make("broken-setup") },
        phase: "setup",
      })
      expect(profile.resolved.failedExtensions[0]?.error).toContain("setup boom")
      expect(profile.resolved.extensionStatuses[0]).toMatchObject({ status: "active" })
    }).pipe(Effect.provide(Layer.merge(fsLayer, ConfigService.Test()))),
  )

  it.scopedLive("a failed resource layer suspends only its extension and keeps siblings live", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      let released = 0
      const healthy = defineExtension({
        id: "healthy",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            // oxlint-disable-next-line effect/noAs -- The fixture erases a resource with no service output at the contribution boundary.
            defineResource({
              id: "test/healthy",
              scope: "process",
              layer: Layer.effectDiscard(
                Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    released++
                  }),
                ),
              ),
            }) as never,
          )
        }),
      })
      const broken = defineExtension({
        id: "broken",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            // oxlint-disable-next-line effect/noAs -- The fixture erases a resource with no service output at the contribution boundary.
            defineResource({
              id: "test/broken",
              scope: "process",
              layer: Layer.effectDiscard(Effect.die("resource layer boom")),
            }) as never,
          )
        }),
      })
      const context = yield* Layer.build(
        SessionProfileCache.Live({
          // Failure isolation is the subject here, so the build keeps going.
          failOnExtensionFailure: false,
          home,
          platform: "test",
          extensions: [healthy, broken],
        }),
      )
      const cache = Context.get(context, SessionProfileCache)
      const profile = yield* cache.resolve(home)
      expect(profile.resolved.extensions.map((ext) => ext.manifest.id)).toEqual([
        ExtensionId.make("healthy"),
      ])
      expect(profile.resolved.failedExtensions).toMatchObject([
        { manifest: { id: ExtensionId.make("broken") }, phase: "startup" },
      ])
      expect(profile.resolved.failedExtensions[0]?.error).toContain("resource layer boom")
      // The healthy resource stays acquired until the server scope closes.
      expect(released).toBe(0)
    }).pipe(Effect.provide(Layer.merge(fsLayer, ConfigService.Test()))),
  )

  // Only an interrupt of the resolve stops the build. An extension whose
  // resource interrupts itself is a failed extension, like any other failure.
  it.scopedLive("a resource layer that interrupts itself fails only its extension", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const selfInterrupting = defineExtension({
        id: "self-interrupting",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            // oxlint-disable-next-line effect/noAs -- The fixture erases a resource with no service output at the contribution boundary.
            defineResource({
              id: "test/self-interrupting",
              scope: "process",
              layer: Layer.effectDiscard(Effect.interrupt),
            }) as never,
          )
        }),
      })
      const context = yield* Layer.build(
        SessionProfileCache.Live({
          failOnExtensionFailure: false,
          home,
          platform: "test",
          extensions: [selfInterrupting],
        }),
      )
      const cache = Context.get(context, SessionProfileCache)
      const profile = yield* cache.resolve(home).pipe(Effect.timeout("5 seconds"))
      expect(profile.resolved.failedExtensions).toMatchObject([
        { manifest: { id: ExtensionId.make("self-interrupting") }, phase: "startup" },
      ])
    }).pipe(Effect.provide(Layer.merge(fsLayer, ConfigService.Test()))),
  )
})

// ── setup platform services ──────────────────────────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/

// A user-shaped extension whose setup mints an id with Effect `Crypto` and
// names its slash command's description after it.
const cryptoSetupExtension = defineExtension({
  id: "crypto-setup",
  setup: Effect.gen(function* () {
    const id = yield* (yield* Crypto.Crypto).randomUUIDv7.pipe(Effect.orDie)
    const host = yield* ExtensionHost
    yield* host.register(
      "request",
      request({
        id: "minted",
        slash: { name: "minted", description: id },
        description: id,
        input: Schema.String,
        output: Schema.Void,
        execute: () => Effect.void,
      }),
    )
  }),
})

describe("setup platform services", () => {
  it.live("the loader gives setup the Crypto service", () =>
    Effect.gen(function* () {
      const result = yield* setupExtensions({
        extensions: [{ extension: cryptoSetupExtension, scope: "user", sourcePath: "/tmp/c.ts" }],
        cwd: "/tmp",
        home: "/nonexistent/gent-test-home",
        disabled: new Set(),
      })
      expect(result.failed).toEqual([])
      const minted = result.active[0]?.contributions.requests?.[0]
      expect(minted?.description).toMatch(UUID_PATTERN)
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("the E2E root gives setup the Crypto service", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, sessionId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer: LanguageModelLayers.debug(),
          extensionInputs: [...e2ePreset.extensionInputs, cryptoSetupExtension],
        })
        const commands = yield* client.extension.listSlashCommands({ sessionId })
        const minted = commands.find((command) => command.name === "minted")
        expect(minted?.description).toMatch(UUID_PATTERN)
      }).pipe(Effect.timeout("20 seconds")),
    ),
  )
})

// ── capability registries ────────────────────────────────────────────────────

/**
 * Extension capability registry regression locks.
 *
 * Model tools are compiled through the model tool registry. Public command
 * dispatch accepts slash-capable requests.
 */

const extensionId = ExtensionId.make("@test/c")
const ctx = testExtensionHostContext({
  sessionId: SessionId.make("s"),
  branchId: BranchId.make("b"),
})
const extWith = (
  scope: "builtin" | "user" | "project",
  requests: ReadonlyArray<RequestCapability>,
): LoadedExtension => ({
  manifest: { id: extensionId },
  scope,
  sourcePath: `/test/${scope}`,
  contributions: { requests },
})

const echoRequest = (params?: { readonly id?: string; readonly value?: string }) =>
  request({
    id: params?.id ?? "echo",
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.Struct({ value: Schema.String }),
    execute: (input) => Effect.succeed({ value: params?.value ?? input.value }),
  })

const pingRequest = (params?: { readonly id?: string; readonly value?: string }) =>
  request({
    id: params?.id ?? "ping",
    slash: { name: "Ping", description: "Ping request" },
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.Struct({ value: Schema.String }),
    execute: (input: { value: string }) => Effect.succeed({ value: params?.value ?? input.value }),
  })

const shadowTool = (params?: { readonly id?: string }): ToolCapability =>
  tool({
    id: params?.id ?? "tool-shadow",
    description: "Tool shadow",
    params: Schema.Struct({ value: Schema.String }),
    output: Schema.Struct({ value: Schema.String }),
    execute: (input) => Effect.succeed({ value: input.value }),
  })

const expectRpcFailure = (
  effect: Effect.Effect<
    unknown,
    CapabilityError | CapabilityNotFoundError,
    FileSystem.FileSystem | Path.Path
  >,
) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return yield* Effect.die("expected rpc failure")
    const reason = exit.cause.reasons.find(Cause.isFailReason)
    if (Predicate.isUndefined(reason)) return yield* Effect.die("expected failed cause")
    return reason.error
  })

const runRpc = (
  registry: ReturnType<typeof resolveExtensions>["rpcRegistry"],
  capabilityId: string,
  input: Readonly<Record<string, string | number>>,
  hostCtx = ctx,
) => registry.run(extensionId, capabilityId, input).pipe(provideCurrentHostCtx(hostCtx))

describe("extension capability registries", () => {
  const test = it.live.layer(BunServices.layer)

  test("dispatches request capabilities by (extensionId, capabilityId)", () =>
    Effect.gen(function* () {
      const cap = echoRequest()
      const resolved = resolveExtensions([extWith("builtin", [cap])])
      const result = yield* runRpc(resolved.rpcRegistry, cap.id, { value: "hi" })
      expect(result).toEqual({ value: "hi" })
    }))

  test("request handlers receive ExtensionContext authority without intent ceremony", () =>
    Effect.gen(function* () {
      const cap = request({
        id: "context-facade",
        input: Schema.Struct({}),
        output: Schema.Struct({
          followUpQueued: Schema.Boolean,
          interactionPresented: Schema.Boolean,
        }),
        execute: () =>
          Effect.gen(function* () {
            const extensionCtx = yield* ExtensionContext
            const followUpExit = yield* Effect.exit(
              extensionCtx.Session.send({ delivery: "queue", sourceId: "request", content: "ok" }),
            )
            const interactionExit = yield* Effect.exit(
              extensionCtx.Interaction.present({ content: "ok", title: "request" }),
            )
            return {
              followUpQueued: Exit.isSuccess(followUpExit),
              interactionPresented: Exit.isSuccess(interactionExit),
            }
          }),
      })
      const resolved = resolveExtensions([extWith("builtin", [cap])])
      const result = yield* runRpc(
        resolved.rpcRegistry,
        cap.id,
        {},
        testExtensionHostContext({
          sessionId: SessionId.make("request-session"),
          branchId: BranchId.make("request-branch"),
          Session: { send: () => Effect.void },
          Interaction: { present: () => Effect.void },
        }),
      )
      expect(result).toEqual({
        followUpQueued: true,
        interactionPresented: true,
      })
    }))

  test("dispatches slash-decorated request capabilities through the rpc registry", () =>
    Effect.gen(function* () {
      const cap = request({
        id: "ping",
        slash: { name: "Ping", description: "Ping request" },
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        execute: (input) => Effect.succeed({ value: input.value }),
      })
      const ext: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "builtin",
        sourcePath: "/test/rpc",
        contributions: { requests: [cap] },
      }
      const resolved = resolveExtensions([ext])
      const result = yield* runRpc(resolved.rpcRegistry, cap.id, { value: "hi" })
      expect(result).toEqual({ value: "hi" })
    }))

  test("provides ExtensionContext to request handlers carrying slash metadata", () =>
    Effect.gen(function* () {
      const cap = request({
        id: "context-request",
        slash: { name: "Context Request", description: "Request with host context service" },
        input: Schema.Struct({}),
        output: Schema.Struct({ hasSessionSend: Schema.Boolean }),
        execute: () =>
          Effect.gen(function* () {
            const extensionCtx = yield* ExtensionContext
            return { hasSessionSend: "send" in extensionCtx.Session }
          }),
      })
      const ext: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "builtin",
        sourcePath: "/test/context-request",
        contributions: { requests: [cap] },
      }
      const resolved = resolveExtensions([ext])
      const result = yield* runRpc(
        resolved.rpcRegistry,
        cap.id,
        {},
        testExtensionHostContext({
          sessionId: SessionId.make("request-context-session"),
          branchId: BranchId.make("request-context-branch"),
        }),
      )
      expect(result).toEqual({ hasSessionSend: true })
    }))

  test("higher-scope slash request shadows lower-scope slash request", () =>
    Effect.gen(function* () {
      const builtin = request({
        id: "shadowed",
        slash: { name: "Shadowed", description: "Shadowed request" },
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        execute: () => Effect.succeed({ value: "builtin" }),
      })
      const project = request({
        id: "shadowed",
        slash: { name: "Project Override", description: "Project override request" },
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        execute: (input: { value: string }) => Effect.succeed({ value: input.value }),
      })
      const resolved = resolveExtensions([
        {
          manifest: { id: extensionId },
          scope: "builtin",
          sourcePath: "/test/builtin-request",
          contributions: { requests: [builtin] },
        },
        {
          manifest: { id: extensionId },
          scope: "project",
          sourcePath: "/test/project-override-request",
          contributions: { requests: [project] },
        },
      ])
      const result = yield* runRpc(resolved.rpcRegistry, project.id, { value: "hi" })
      expect(result).toEqual({ value: "hi" })
    }))

  test("request dispatch follows higher-scope slash request shadowing lower request", () =>
    Effect.gen(function* () {
      const builtin = echoRequest({ id: "same", value: "builtin-request" })
      const project = pingRequest({ id: "same", value: "project-request" })
      const resolved = resolveExtensions([
        {
          manifest: { id: extensionId },
          scope: "builtin",
          sourcePath: "/test/builtin-request",
          contributions: { requests: [builtin] },
        },
        {
          manifest: { id: extensionId },
          scope: "project",
          sourcePath: "/test/project-public-request",
          contributions: { requests: [project] },
        },
      ])
      const result = yield* runRpc(resolved.rpcRegistry, builtin.id, { value: "hi" })
      expect(result).toEqual({ value: "project-request" })
    }))

  test("request dispatch rejects higher-scope tool shadowing lower request", () =>
    Effect.gen(function* () {
      const builtin = echoRequest({ id: "same", value: "builtin-request" })
      const project = shadowTool({ id: "same" })
      const resolved = resolveExtensions([
        {
          manifest: { id: extensionId },
          scope: "builtin",
          sourcePath: "/test/builtin-request",
          contributions: { requests: [builtin] },
        },
        {
          manifest: { id: extensionId },
          scope: "project",
          sourcePath: "/test/project-tool",
          contributions: { tools: [project] },
        },
      ])
      const result = yield* expectRpcFailure(
        runRpc(resolved.rpcRegistry, builtin.id, { value: "hi" }),
      )
      expect(Schema.is(CapabilityNotFoundError)(result)).toBe(true)
    }))

  test("request dispatch rejects lower request shadowed by higher-scope tool", () =>
    Effect.gen(function* () {
      const builtin = echoRequest({ id: "same", value: "builtin-request" })
      const project = shadowTool({ id: "same" })
      const resolved = resolveExtensions([
        {
          manifest: { id: extensionId },
          scope: "builtin",
          sourcePath: "/test/builtin-request",
          contributions: { requests: [builtin] },
        },
        {
          manifest: { id: extensionId },
          scope: "project",
          sourcePath: "/test/project-tool",
          contributions: { tools: [project] },
        },
      ])
      const result = yield* expectRpcFailure(
        runRpc(resolved.rpcRegistry, builtin.id, { value: "hi" }),
      )
      expect(Schema.is(CapabilityNotFoundError)(result)).toBe(true)
    }))

  test("scope precedence shadows lower-scope request capabilities by identity", () =>
    Effect.gen(function* () {
      const builtin = echoRequest({ id: "thing", value: "builtin" })
      const project = echoRequest({ id: "thing", value: "project" })
      const resolved = resolveExtensions([
        extWith("builtin", [builtin]),
        extWith("project", [project]),
      ])
      const result = yield* runRpc(resolved.rpcRegistry, project.id, { value: "x" })
      expect(result).toEqual({ value: "project" })
    }))

  test("scope precedence picks the winning request without intent matching", () =>
    Effect.gen(function* () {
      const lowerCap = request({
        id: "thing",
        input: Schema.Unknown,
        output: Schema.Unknown,
        execute: () => Effect.succeed("builtin-write"),
      })
      const higherCap = request({
        id: "thing",
        input: Schema.Unknown,
        output: Schema.Unknown,
        execute: () => Effect.succeed("project-read"),
      })
      const resolved = resolveExtensions([
        extWith("builtin", [lowerCap]),
        extWith("project", [higherCap]),
      ])

      const readResult = yield* runRpc(resolved.rpcRegistry, higherCap.id, {})
      expect(readResult).toBe("project-read")
    }))

  test("input decode failure is wrapped in CapabilityError", () =>
    Effect.gen(function* () {
      const cap = echoRequest()
      const resolved = resolveExtensions([extWith("builtin", [cap])])
      const result = yield* expectRpcFailure(runRpc(resolved.rpcRegistry, cap.id, { value: 42 }))
      expect(Schema.is(CapabilityError)(result)).toBe(true)
      if (!Schema.is(CapabilityError)(result)) return
      expect(result.reason).toMatch(/input decode failed/)
    }))

  test("output validation failure is wrapped in CapabilityError", () =>
    Effect.gen(function* () {
      const cap = request({
        id: "bad",
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        // oxlint-disable-next-line effect/noAs, effect/noKnownValueWidening, effect/noChainedTypeAssertions -- Deliberately malformed output exercises the registry's output-boundary validation.
        execute: () => Effect.succeed({ value: 42 } as unknown as { value: string }),
      })
      const resolved = resolveExtensions([extWith("builtin", [cap])])
      const result = yield* expectRpcFailure(runRpc(resolved.rpcRegistry, cap.id, { value: "x" }))
      expect(Schema.is(CapabilityError)(result)).toBe(true)
      if (!Schema.is(CapabilityError)(result)) return
      expect(result.reason).toMatch(/output validation failed/)
    }))

  test("a bound handler's own tagged error reaches the caller as CapabilityError under its ids", () =>
    Effect.gen(function* () {
      class DiskFull extends Schema.TaggedError<DiskFull>()("DiskFull", {
        message: Schema.String,
      }) {}
      const { Save } = defineRequests(extensionId, {
        Save: request({
          id: "save",
          input: Schema.Struct({ value: Schema.String }),
          output: Schema.Struct({ value: Schema.String }),
          execute: () => new DiskFull({ message: "no space left on device" }),
        }),
      })
      const resolved = resolveExtensions([extWith("builtin", [Save])])
      const result = yield* expectRpcFailure(runRpc(resolved.rpcRegistry, Save.id, { value: "x" }))
      expect(result).toEqual(
        new CapabilityError({
          extensionId,
          capabilityId: "save",
          reason: "no space left on device",
        }),
      )
    }))

  test("a CapabilityError the handler built passes through a bound request unchanged", () =>
    Effect.gen(function* () {
      const built = new CapabilityError({
        extensionId: ExtensionId.make("@other/owner"),
        capabilityId: "elsewhere",
        reason: "forwarded",
      })
      const { Forward } = defineRequests(extensionId, {
        Forward: request({
          id: "forward",
          input: Schema.Struct({ value: Schema.String }),
          output: Schema.Struct({ value: Schema.String }),
          execute: () => Effect.fail(built),
        }),
      })
      const resolved = resolveExtensions([extWith("builtin", [Forward])])
      const result = yield* expectRpcFailure(
        runRpc(resolved.rpcRegistry, Forward.id, { value: "x" }),
      )
      expect(result).toBe(built)
    }))

  test("handler defects are coerced into typed CapabilityError", () =>
    Effect.gen(function* () {
      const cap = request({
        id: "boom",
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        execute: () => Effect.die("boom"),
      })
      const resolved = resolveExtensions([extWith("builtin", [cap])])
      const result = yield* expectRpcFailure(runRpc(resolved.rpcRegistry, cap.id, { value: "x" }))
      expect(Schema.is(CapabilityError)(result)).toBe(true)
      if (!Schema.is(CapabilityError)(result)) return
      expect(result.reason).toMatch(/handler defect/)
    }))
})

// ── runtime slots ────────────────────────────────────────────────────────────

const stubHostCtx = testExtensionHostContext()

const makeExtExtensionHooks = (
  id: string,
  scope: "builtin" | "user" | "project",
  contributions: ExtensionContributions,
): LoadedExtension => ({
  manifest: { id: ExtensionId.make(id) },
  scope,
  sourcePath: `/test/${id}`,
  contributions,
})

class BoomError extends Data.TaggedError("@gent/core/tests/runtime/extension-host.test/BoomError")<{
  readonly reason: string
}> {}

class HookCounter extends Context.Service<
  HookCounter,
  {
    readonly increment: Effect.Effect<void>
    readonly get: Effect.Effect<number>
  }
>()("@gent/core/tests/runtime/extension-host.test/HookCounter") {}

describe("runtime slots", () => {
  const test = it.live.layer(BunServices.layer)

  test("systemPrompt composes explicit hook rewrites in scope order", () => {
    const extensions = [
      makeExtExtensionHooks("builtin", "builtin", {
        hooks: [hook("systemPrompt", (input) => Effect.succeed(`${input.basePrompt}[builtin]`))],
      }),
      makeExtExtensionHooks("project", "project", {
        hooks: [hook("systemPrompt", (input) => Effect.succeed(`${input.basePrompt}[project]`))],
      }),
    ]

    const slots = compileExtensionHooks(extensions)

    return slots
      .resolveSystemPrompt({
        basePrompt: "base",
        agent: testAgent,
      } satisfies SystemPromptInput)
      .pipe(
        Effect.provideService(CurrentExtensionHostContext, stubHostCtx),
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("base[builtin][project]"))),
      )
  })

  test("systemPrompt isolates failing hook rewrites", () => {
    const extensions = [
      makeExtExtensionHooks("builtin", "builtin", {
        hooks: [
          hook("systemPrompt", (input) => Effect.succeed(`${input.basePrompt}[builtin-hook]`)),
        ],
      }),
      makeExtExtensionHooks("project", "project", {
        hooks: [hook("systemPrompt", () => Effect.fail(new BoomError({ reason: "bad prompt" })))],
      }),
    ]

    const slots = compileExtensionHooks(extensions)

    return slots
      .resolveSystemPrompt({
        basePrompt: "base",
        agent: testAgent,
      } satisfies SystemPromptInput)
      .pipe(
        Effect.provideService(CurrentExtensionHostContext, stubHostCtx),
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("base[builtin-hook]"))),
      )
  })

  test("systemPrompt receives host authority through ExtensionContext", () =>
    Effect.gen(function* () {
      const sawHostAuthority = yield* Ref.make(false)
      const slots = compileExtensionHooks([
        makeExtExtensionHooks("readonly", "project", {
          hooks: [
            hook("systemPrompt", () =>
              Effect.gen(function* () {
                const ctx = yield* ExtensionContext
                yield* Ref.set(sawHostAuthority, "send" in ctx.Session)
                return "readonly"
              }),
            ),
          ],
        }),
      ])

      const result = yield* slots
        .resolveSystemPrompt({
          basePrompt: "base",
          agent: testAgent,
        })
        .pipe(Effect.provideService(CurrentExtensionHostContext, stubHostCtx))

      expect(result).toBe("readonly")
      expect(yield* Ref.get(sawHostAuthority)).toBe(true)
    }))

  test("turnAfter isolates failing hooks; all handlers still run", () => {
    const calls: string[] = []
    const extensions = [
      makeExtExtensionHooks("first", "builtin", {
        hooks: [
          hook("turnAfter", () => {
            calls.push("first")
            return Effect.fail(new BoomError({ reason: "first" }))
          }),
        ],
      }),
      makeExtExtensionHooks("second", "user", {
        hooks: [
          hook("turnAfter", () => {
            calls.push("second")
            return Effect.fail(new BoomError({ reason: "second" }))
          }),
        ],
      }),
      makeExtExtensionHooks("third", "project", {
        hooks: [
          hook("turnAfter", () => {
            calls.push("third")
            return Effect.fail(new BoomError({ reason: "third" }))
          }),
        ],
      }),
    ]

    const slots = compileExtensionHooks(extensions)

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        slots
          .emitTurnAfter(
            {
              sessionId: SessionId.make("test-session"),
              branchId: BranchId.make("test-branch"),
              durationMs: 10,
              joinedMessageIds: new Set(),
              startedAtMs: 0,
              agentName: AgentName.make("cowork"),
              interrupted: false,
              streamFailed: false,
              unanswered: false,

              messageId: MessageId.make("turn-message"),
              usage: {
                known: {
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  costUsd: Option.none(),
                },
                complete: true,
              },
            } satisfies Omit<TurnAfterInput, "readNotices">,
            new Map(),
          )
          .pipe(Effect.provideService(CurrentExtensionHostContext, stubHostCtx)),
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(calls).toEqual(["first", "second", "third"])
    })
  })

  test("turnAfter receives host authority through ExtensionContext", () =>
    Effect.gen(function* () {
      const sawHostAuthority = yield* Ref.make(false)
      const slots = compileExtensionHooks([
        makeExtExtensionHooks("readonly-lifecycle", "project", {
          hooks: [
            hook("turnAfter", () =>
              Effect.gen(function* () {
                const ctx = yield* ExtensionContext
                yield* Ref.set(sawHostAuthority, "send" in ctx.Session)
              }),
            ),
          ],
        }),
      ])

      yield* slots
        .emitTurnAfter(
          {
            sessionId: SessionId.make("test-session"),
            branchId: BranchId.make("test-branch"),
            durationMs: 10,
            joinedMessageIds: new Set(),
            startedAtMs: 0,
            agentName: AgentName.make("cowork"),
            interrupted: false,
            streamFailed: false,
            unanswered: false,

            messageId: MessageId.make("turn-message"),
            usage: {
              known: {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsd: Option.none(),
              },
              complete: true,
            },
          } satisfies Omit<TurnAfterInput, "readNotices">,
          new Map(),
        )
        .pipe(Effect.provideService(CurrentExtensionHostContext, stubHostCtx))

      expect(yield* Ref.get(sawHostAuthority)).toBe(true)
    }))

  test("turnAfter hooks run inside lifecycle capability context", () =>
    Effect.gen(function* () {
      const ref = yield* Ref.make(0)
      const counter = {
        increment: Ref.update(ref, (n) => n + 1),
        get: Ref.get(ref),
      }
      const slots = compileExtensionHooks([
        makeExtExtensionHooks("resource-backed", "builtin", {
          hooks: [
            hook("turnAfter", () =>
              Effect.gen(function* () {
                const service = yield* HookCounter
                yield* service.increment
              }),
            ),
          ],
        }),
      ])
      const hostCtx: ExtensionHostContext = stubHostCtx

      yield* slots
        .emitTurnAfter(
          {
            sessionId: SessionId.make("test-session"),
            branchId: BranchId.make("test-branch"),
            durationMs: 10,
            joinedMessageIds: new Set(),
            startedAtMs: 0,
            agentName: AgentName.make("cowork"),
            interrupted: false,
            streamFailed: false,
            unanswered: false,

            messageId: MessageId.make("turn-message"),
            usage: {
              known: {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsd: Option.none(),
              },
              complete: true,
            },
          } satisfies Omit<TurnAfterInput, "readNotices">,
          new Map(),
        )
        .pipe(
          Effect.provideService(CurrentExtensionHostContext, hostCtx),
          provideCurrentCapabilityContext(Context.make(HookCounter, counter)),
        )

      const count = yield* counter.get
      expect(count).toBe(1)
    }))
})

// ── host session facet ───────────────────────────────────────────────────────

/**
 * `ctx.Session.listBranches` is a host-wired facet verb with no other direct
 * coverage. The RPC suites exercise the durable mutation surface from the
 * public RPC angle; this test pins the facet from the extension angle.
 */

const SESSION_ID = SessionId.make("test-session")
const BRANCH_ID = BranchId.make("test-branch")
const FIXTURE_DATE = dateFromMillis(0)

describe("host session facet", () => {
  it.live("ctx.Session.listBranches returns branches for the current session", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      yield* sessions.createSession(
        new Session({
          id: SESSION_ID,
          name: "test",
          cwd: "/tmp",
          createdAt: FIXTURE_DATE,
          updatedAt: FIXTURE_DATE,
        }),
      )
      yield* branches.createBranch(
        new Branch({ id: BRANCH_ID, sessionId: SESSION_ID, createdAt: FIXTURE_DATE }),
      )
      const provider = yield* makeExtensionHostContextProvider({
        host: testHostFacts().host,
      })
      const ctx = provider.forRun({
        sessionId: SESSION_ID,
        branchId: BRANCH_ID,
        interactive: true,
        clientRequest: Option.none(),
      })
      const listed = yield* ctx.Session.listBranches
      expect(listed).toHaveLength(1)
      expect(listed[0]!.id).toBe(BRANCH_ID)
    }).pipe(
      Effect.provide(
        Layer.merge(
          testSqliteStorage(noBranchTools.storage, noBranchTools.migrations),
          RuntimeEnvironment.Live({ cwd: "/tmp", home: "/nonexistent/gent-test-home" }),
        ),
      ),
    ),
  )
})

/**
 * A client request's send carries its grant, and the host decides no origin.
 * The loop decides it when it admits the message (`admitWithOrigin`), so a
 * send the request started but the loop admits after the request ended is an
 * extension send. Here the loop's control is held between the send and the
 * admission: what reaches it must still carry no client origin.
 */
describe("client request origin", () => {
  it.live("a send held before admission carries the grant, never the client origin", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      yield* sessions.createSession(
        new Session({
          id: SESSION_ID,
          name: "test",
          cwd: "/tmp",
          createdAt: FIXTURE_DATE,
          updatedAt: FIXTURE_DATE,
        }),
      )
      yield* branches.createBranch(
        new Branch({ id: BRANCH_ID, sessionId: SESSION_ID, createdAt: FIXTURE_DATE }),
      )
      const reached = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      interface Reached {
        readonly metadata?: MessageMetadata
        readonly clientRequest?: ClientRequestGrant
      }
      const reachedLoop = yield* Ref.make<ReadonlyArray<Reached>>([])
      const hold = (input: Reached) =>
        Deferred.succeed(reached, void 0).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Ref.update(reachedLoop, (all) => [...all, input])),
        )
      const provider = yield* makeExtensionHostContextProvider({
        host: testHostFacts().host,
        sessionControl: {
          queueFollowUp: hold,
          dequeueFollowUp: () => Effect.succeed(false),
          send: () => Effect.void,
          stopMessage: () => Effect.succeed(false),
          holdResident: Effect.void,
          steer: (command, clientRequest) => {
            if (command._tag !== "Interject") return Effect.void
            return hold(omitUndefined({ metadata: command.metadata, clientRequest }))
          },
        },
      })
      const grant = ClientRequestGrant.make("request-grant")
      const ctx = provider.forRun({
        sessionId: SESSION_ID,
        branchId: BRANCH_ID,
        interactive: true,
        clientRequest: Option.some(grant),
      })
      const sends = Effect.all([
        ctx.Session.send({ delivery: "queue", sourceId: "held", content: "queued" }),
        ctx.Session.send({ delivery: "steer", content: "steered" }),
      ])
      const fiber = yield* sends.pipe(Effect.forkChild)
      yield* Deferred.await(reached)
      // The request ends here; the loop has not admitted anything yet.
      yield* Deferred.succeed(release, void 0)
      yield* Fiber.join(fiber)
      const admitted = yield* Ref.get(reachedLoop)
      expect(admitted.map((input) => input.clientRequest)).toEqual([grant, grant])
      expect(admitted.map((input) => input.metadata?.fromClient === true)).toEqual([false, false])
    }).pipe(
      Effect.timeout("5 seconds"),
      Effect.provide(
        Layer.merge(
          testSqliteStorage(noBranchTools.storage, noBranchTools.migrations),
          RuntimeEnvironment.Live({ cwd: "/tmp", home: "/nonexistent/gent-test-home" }),
        ),
      ),
    ),
  )
})

// ── extension entries ────────────────────────────────────────────────────────

/** Each specifier the loader binds, with the module this process runs for it. */
const boundEntries = {
  "@gent/core/extensions/api": ExtensionApiEntry,
  "@gent/core/extensions/branch-tools": BranchToolsEntry,
  effect: EffectEntry,
}

// gent/no-dynamic-imports: allow the test reads the exports of an extension file it wrote
const importFile = (file: string) => Effect.promise(() => import(file))

/**
 * The compiled binary has no node_modules. A user extension outside the
 * repository resolves the public entries only because the loader binds them,
 * and it gets the modules this process runs, not copies.
 */
describe("extension entries", () => {
  it.scopedLive(
    "a user extension outside the repository imports every public entry and registers its tool",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        // The system temp directory: no node_modules above it.
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-entries-" })
        const userDir = path.join(home, ".gent", "extensions")
        yield* fs.makeDirectory(userDir, { recursive: true })
        const specifiers = Object.keys(boundEntries)
        const extensionFile = path.join(userDir, "entries.ts")
        yield* fs.writeFileString(
          extensionFile,
          [
            ...specifiers.map((specifier, index) => `import * as E${index} from "${specifier}"`),
            `export const bound = { ${specifiers.map((specifier, index) => `${encodeJson(specifier)}: E${index}`).join(", ")} }`,
            `const api = E${specifiers.indexOf("@gent/core/extensions/api")}`,
            `const { Effect, Schema } = E${specifiers.indexOf("effect")}`,
            "export default api.defineExtension({",
            '  id: "@user/entries",',
            "  setup: Effect.gen(function* () {",
            "    const host = yield* api.ExtensionHost",
            '    yield* host.register("tool", api.tool({ id: "entries_probe", description: "probe", params: Schema.Struct({}), output: Schema.String, execute: () => Effect.succeed("ok") }))',
            "  }),",
            "})",
          ].join("\n"),
        )

        const discovered = yield* discoverExtensions({
          userDir,
          projectDir: "/nonexistent/gent-entries-project",
        })
        expect(discovered.failed).toEqual([])
        const loaded = yield* Effect.forEach(discovered.loaded, (entry) =>
          setupExtension(entry, home, home),
        )
        expect(
          loaded.map((extension) => ({
            id: String(extension.manifest.id),
            tools: extension.contributions.tools?.map((tool) => String(getToolId(tool))),
          })),
        ).toEqual([{ id: "@user/entries", tools: ["entries_probe"] }])

        const bound: object = (yield* importFile(extensionFile)).bound
        for (const [specifier, entryModule] of Object.entries(boundEntries)) {
          const imported: object = Reflect.get(bound, specifier)
          expect(Object.keys(imported).sort()).toEqual(Object.keys(entryModule).sort())
          for (const [name, value] of Object.entries(entryModule)) {
            const same = Reflect.get(imported, name) === value
            expect({ specifier, name, same }).toEqual({
              specifier,
              name,
              same: true,
            })
          }
        }
      }).pipe(Effect.timeout("20 seconds"), Effect.provide(fsLayer)),
  )

  it.scopedLive("an internal entry and the client entry do not resolve for a user extension", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-entries-internal-" })
      const userDir = path.join(home, ".gent", "extensions")
      yield* fs.makeDirectory(userDir, { recursive: true })
      const writeImporter = (file: string, specifier: string, name: string) =>
        fs.writeFileString(
          path.join(userDir, file),
          [
            'import { Effect } from "effect"',
            `import { ${name} } from "${specifier}"`,
            `export default { manifest: { id: "@user/${file}" }, setup: Effect.sync(() => void ${name}) }`,
          ].join("\n"),
        )
      yield* writeImporter("host.ts", "@gent/core/host", "BunPlatformLive")
      yield* writeImporter("protocol.ts", "@gent/core/protocol", "SessionId")
      const discovered = yield* discoverExtensions({
        userDir,
        projectDir: "/nonexistent/gent-entries-project",
      })
      expect(discovered.loaded).toEqual([])
      expect(discovered.failed.map((failure) => failure.error)).toEqual([
        expect.stringContaining("Cannot find package '@gent/core'"),
        expect.stringContaining("Cannot find package '@gent/core'"),
      ])
    }).pipe(Effect.timeout("20 seconds"), Effect.provide(fsLayer)),
  )
})

// ── extension setup ──────────────────────────────────────────────────────────

describe("setupExtension", () => {
  it.scopedLive("requires user trust before project module code runs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "gent-project-trust-",
      })
      const userDir = path.join(directory, "home/.gent/extensions")
      const projectDir = path.join(directory, "project/.gent/extensions")
      yield* fs.makeDirectory(userDir, { recursive: true })
      yield* fs.makeDirectory(projectDir, { recursive: true })
      const projectRoot = yield* fs.realPath(path.join(directory, "project"))
      const marker = path.join(directory, "import-ran")
      yield* fs.writeFileString(
        path.join(projectDir, "entry.ts"),
        `import { writeFileSync } from "node:fs";
import { Effect } from "effect";
writeFileSync(${encodeJson(marker)}, "ran");
export default { manifest: { id: "trusted-project" }, setup: Effect.void };`,
      )
      const grant = encodeJson({ trustedProjects: [projectRoot] })
      yield* fs.writeFileString(path.join(projectDir, "../config.json"), grant)
      const denied = yield* discoverExtensions({ userDir, projectDir })
      expect(denied.loaded).toHaveLength(0)
      expect(denied.failed[0]?.error).toContain("not trusted")
      expect(yield* fs.exists(marker)).toBe(false)
      yield* fs.writeFileString(path.join(userDir, "../config.json"), grant)
      const allowed = yield* discoverExtensions({ userDir, projectDir })
      expect(allowed.loaded.map((entry) => entry.extension.manifest.id)).toEqual([
        ExtensionId.make("trusted-project"),
      ])
      expect(yield* fs.readFileString(marker)).toBe("ran")
      yield* fs.writeFileString(path.join(userDir, "../config.json"), "invalid JSON")
      const revoked = yield* discoverExtensions({ userDir, projectDir })
      expect(revoked.loaded).toHaveLength(0)
    }).pipe(Effect.provide(fsLayer)),
  )

  it.scopedLive("launched from home, the user extensions load once and only as user", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "gent-home-launch-",
      })
      const home = yield* fs.realPath(directory)
      const userDir = path.join(home, ".gent/extensions")
      yield* fs.makeDirectory(userDir, { recursive: true })
      yield* fs.writeFileString(
        path.join(userDir, "entry.ts"),
        `import { Effect } from "effect";
export default { manifest: { id: "home-user" }, setup: Effect.void };`,
      )
      const loadedAs = (result: Effect.Success<ReturnType<typeof discoverExtensions>>) =>
        result.loaded.map((entry) => `${entry.scope}:${entry.extension.manifest.id}`)
      // Untrusted (the default): no "not trusted" failure for the user's own files.
      const untrusted = yield* discoverExtensions({ userDir, projectDir: userDir })
      expect(loadedAs(untrusted)).toEqual(["user:home-user"])
      expect(untrusted.failed).toEqual([])
      // Trusted: still one copy, as user.
      yield* fs.writeFileString(
        path.join(userDir, "../config.json"),
        encodeJson({ trustedProjects: [home] }),
      )
      const trusted = yield* discoverExtensions({ userDir, projectDir: userDir })
      expect(loadedAs(trusted)).toEqual(["user:home-user"])
      expect(trusted.failed).toEqual([])
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("preserves the explicit loaded artifact identity", () =>
    Effect.gen(function* () {
      const artifactIdentity = LoadedArtifactIdentity.make("@gent/test-loader@artifact-1")
      const extension: GentExtension = {
        manifest: { id: ExtensionId.make("@gent/test-loader-artifact") },
        artifactIdentity,
        setup: Effect.void,
      }

      const loaded = yield* setupExtension(
        {
          extension,
          scope: "user",
          sourcePath: "/tmp/test-loader-artifact.ts",
        },
        "/tmp/project",
        "/tmp/home",
      )

      expect(loaded.artifactIdentity).toBe(artifactIdentity)
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("seals runtime-loaded setup failures to ExtensionLoadError", () =>
    Effect.gen(function* () {
      // oxlint-disable-next-line effect/noAs, effect/noChainedTypeAssertions -- This malformed runtime setup is a boundary rejection fixture.
      const badSetup = Effect.fail("boom") as unknown as GentExtension["setup"]
      const extension: GentExtension = {
        manifest: { id: ExtensionId.make("@gent/test-loader") },
        setup: badSetup,
      }

      const exit = yield* Effect.exit(
        setupExtension(
          {
            extension,
            scope: "user",
            sourcePath: "/tmp/test-loader.ts",
          },
          "/tmp/project",
          "/tmp/home",
        ),
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain("ExtensionLoadError")
        expect(rendered).toContain("Extension setup failed: boom")
      }
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("runtime-loaded setup receives host facts and no process facade", () =>
    Effect.gen(function* () {
      const sawHostFacts = yield* Effect.sync(() => ({ value: false }))
      const extension: GentExtension = {
        manifest: { id: ExtensionId.make("@gent/test-public-setup") },
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          sawHostFacts.value = "osInfo" in host.host && !("Process" in host)
        }),
      }

      yield* setupExtension(
        {
          extension,
          scope: "project",
          sourcePath: "/tmp/test-public-setup.ts",
        },
        "/tmp/project",
        "/tmp/home",
      )

      expect(sawHostFacts.value).toBe(true)
    }).pipe(Effect.provide(fsLayer)),
  )

  it.scopedLive("does not infer identity from mutable package metadata or cached modules", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const packageDir = yield* fs.makeTempDirectoryScoped({
        prefix: "gent-loader-package-",
      })
      yield* fs.writeFileString(
        path.join(packageDir, "package.json"),
        encodeJson({ name: "@gent/test-pinned", version: "1.2.3" }),
      )
      const extensionPath = path.join(packageDir, "extension.ts")
      yield* fs.writeFileString(
        extensionPath,
        'import { Effect } from "effect"\nexport default { manifest: { id: "@gent/test-pinned-v1" }, setup: Effect.void }\n',
      )

      const first = yield* discoverExtensions({
        userDir: packageDir,
        projectDir: "/nonexistent-project-dir-loader-test",
      })
      expect(first.loaded).toHaveLength(1)
      expect(first.loaded[0]?.extension.artifactIdentity).toBeUndefined()

      // An edited file is imported again under its new version. The loader
      // still attaches no identity to what it imported.
      yield* fs.writeFileString(
        extensionPath,
        'import { Effect } from "effect"\nexport default { manifest: { id: "@gent/test-pinned-v2" }, setup: Effect.void }\n',
      )
      const second = yield* discoverExtensions({
        userDir: packageDir,
        projectDir: "/nonexistent-project-dir-loader-test",
      })
      expect(second.loaded[0]?.extension.artifactIdentity).toBeUndefined()

      // A changed manifest is also not a proof that the already imported
      // module changed. Replay remains explicitly unsupported.
      yield* fs.writeFileString(
        path.join(packageDir, "package.json"),
        encodeJson({ name: "@gent/test-pinned", version: "2.0.0" }),
      )
      const third = yield* discoverExtensions({
        userDir: packageDir,
        projectDir: "/nonexistent-project-dir-loader-test",
      })
      expect(third.loaded[0]?.extension.artifactIdentity).toBeUndefined()
    }).pipe(Effect.provide(fsLayer)),
  )

  // Raw hand-rolled `{ manifest, setup }` (no `defineExtension`) must yield
  // the `ExtensionHost` Tag to read setup facts. There is no ctx-as-param escape.
  it.live("setup sees cwd and home from the host", () =>
    Effect.gen(function* () {
      const captured = yield* Effect.sync(() => ({
        cwd: "",
        home: "",
        hasReadAuthority: false,
      }))
      const extension: GentExtension = {
        manifest: { id: ExtensionId.make("@gent/test-raw-setup") },
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          captured.cwd = host.cwd
          captured.home = host.home
          captured.hasReadAuthority =
            "readFileString" in host.host || "writeFileString" in host.host
        }),
      }

      yield* setupExtension(
        {
          extension,
          scope: "user",
          sourcePath: "/tmp/raw-setup.ts",
        },
        "/tmp/project-cwd",
        "/nonexistent/home-dir",
      )

      // Loader-built narrowed shape is observable from raw setup
      expect(captured.cwd).toBe("/tmp/project-cwd")
      expect(captured.home).toBe("/nonexistent/home-dir")
      // Public host facts strip read/write authority; only narrowed facts remain
      expect(captured.hasReadAuthority).toBe(false)
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("loader binds registered requests to the extension id", () =>
    Effect.gen(function* () {
      const capability = request({
        id: "bound-request",
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.String,
        execute: (input) => Effect.succeed(input.value),
      })
      const capabilityRef = ref(capability)
      expect(() => capabilityRef.extensionId).toThrow("not bound to an extension")

      const extension = defineExtension({
        id: "@gent/test-bound-requests",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register("request", capability)
        }),
      })

      const loaded = yield* setupExtension(
        {
          extension,
          scope: "user",
          sourcePath: "/tmp/test-bound-requests.ts",
        },
        "/tmp/project",
        "/tmp/home",
      )

      expect(String(capabilityRef.extensionId)).toBe("@gent/test-bound-requests")
      expect(String(capabilityRef.capabilityId)).toBe("bound-request")
      expect(loaded.contributions.requests?.map((entry) => String(ref(entry).extensionId))).toEqual(
        ["@gent/test-bound-requests"],
      )
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("loader rejects raw native tools that lack Gent metadata", () =>
    Effect.gen(function* () {
      const extension = defineExtension({
        id: "@gent/test-raw-native",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "tool",
            // oxlint-disable-next-line effect/noAs -- This invalid native tool is deliberately injected to test rejection.
            AiTool.dynamic("raw_tool", {
              description: "native but missing Gent metadata",
              parameters: Schema.Unknown,
            }) as never,
          )
        }),
      })

      const exit = yield* Effect.exit(
        setupExtension(
          { extension, scope: "user", sourcePath: "/tmp/test-raw-native.ts" },
          "/tmp/project",
          "/tmp/home",
        ),
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain("ExtensionLoadError")
        expect(rendered).toContain(
          "tools[0]: tool must be created with `tool({...})` so Gent metadata is attached",
        )
      }
    }).pipe(Effect.provide(fsLayer)),
  )

  // Blocking advisory: malformed runtime-loaded modules whose `setup` is not
  // an Effect (e.g. a function, raw object, or `null`) must be rejected at
  // discovery — `loadExtensionFile`'s `isGentExtension` guard returns false
  // and the file is skipped rather than crashing later.
  it.scopedLive("malformed setup values that are not Effects are skipped at discovery", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "gent-loader-test-" })

      const fnSetupPath = path.join(dir, "fn-setup.ts")
      const objectSetupPath = path.join(dir, "object-setup.ts")
      const nullSetupPath = path.join(dir, "null-setup.ts")
      const validPath = path.join(dir, "valid.ts")

      // `setup` as a thunk — old contract, must be rejected now.
      yield* fs.writeFileString(
        fnSetupPath,
        `export default { manifest: { id: "fn-setup" }, setup: () => ({ tools: [] }) }`,
      )
      // `setup` as a plain object — never valid.
      yield* fs.writeFileString(
        objectSetupPath,
        `export default { manifest: { id: "object-setup" }, setup: { tools: [] } }`,
      )
      // `setup` as null — never valid.
      yield* fs.writeFileString(
        nullSetupPath,
        `export default { manifest: { id: "null-setup" }, setup: null }`,
      )
      // Sanity sibling: a no-extension file is also skipped but for a different reason.
      yield* fs.writeFileString(validPath, `export const notAnExtension = 42`)

      const result = yield* discoverExtensions({
        userDir: dir,
        projectDir: "/nonexistent-project-dir-loader-test",
      })

      // None of the malformed files load — they hit `loadExtensionFile`'s
      // `candidates.length === 0` branch via the `isGentExtension` guard.
      expect(result.loaded).toHaveLength(0)
      expect(result.failed.length).toBeGreaterThanOrEqual(4)
      for (const target of [fnSetupPath, objectSetupPath, nullSetupPath, validPath]) {
        const entry = result.failed.find((s) => s.sourcePath === target)
        expect(entry).toBeDefined()
        expect(entry?.error).toContain("No GentExtension found")
      }
    }).pipe(Effect.provide(fsLayer)),
  )

  // Load order decides which of two same-named services wins, so it must not
  // follow the locale: `Zeta.ts` sorts before `alpha.ts` by code unit.
  it.scopedLive("extension files load in code-unit order of their paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped({
        prefix: "gent-loader-order-",
      })
      for (const id of ["alpha", "Zeta"]) {
        yield* fs.writeFileString(
          path.join(dir, `${id}.ts`),
          `import { Effect } from "effect"\nexport default { manifest: { id: "${id}" }, setup: Effect.void }\n`,
        )
      }

      const result = yield* discoverExtensions({
        userDir: dir,
        projectDir: "/nonexistent-project-dir-loader-test",
      })

      expect(result.loaded.map((entry) => entry.extension.manifest.id)).toEqual([
        ExtensionId.make("Zeta"),
        ExtensionId.make("alpha"),
      ])
    }).pipe(Effect.provide(fsLayer)),
  )

  it.scopedLive("a dangling symlink fails alone; its siblings still load", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped({
        prefix: "gent-loader-dangling-",
      })
      yield* fs.writeFileString(
        path.join(dir, "good.ts"),
        'import { Effect } from "effect"\nexport default { manifest: { id: "good" }, setup: Effect.void }\n',
      )
      const danglingPath = path.join(dir, "zz-dangling.ts")
      yield* fs.symlink(path.join(dir, "nowhere.ts"), danglingPath)

      const result = yield* discoverExtensions({
        userDir: dir,
        projectDir: "/nonexistent-project-dir-loader-test",
      })

      expect(result.loaded.map((entry) => entry.extension.manifest.id)).toEqual([
        ExtensionId.make("good"),
      ])
      expect(result.failed).toMatchObject([
        { sourcePath: danglingPath, scope: "user", phase: "load" },
      ])
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("a setup that returns the old contribution object is rejected", () =>
    Effect.gen(function* () {
      // oxlint-disable-next-line effect/noAs, effect/noChainedTypeAssertions -- This old-contract setup is a boundary rejection fixture.
      const oldSetup = Effect.succeed({ tools: [] }) as unknown as GentExtension["setup"]
      const extension: GentExtension = {
        manifest: { id: ExtensionId.make("@gent/test-old-contract") },
        setup: oldSetup,
      }
      const exit = yield* Effect.exit(
        setupExtension(
          { extension, scope: "user", sourcePath: "/tmp/test-old-contract.ts" },
          "/tmp/project",
          "/tmp/home",
        ),
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain("ExtensionLoadError")
        expect(rendered).toContain("setup must return void")
      }
    }).pipe(Effect.provide(fsLayer)),
  )
})

// ── prompt slots ─────────────────────────────────────────────────────────────

const ext = (
  id: string,
  scope: "builtin" | "user" | "project",
  suffix: string,
): LoadedExtension => ({
  manifest: { id: ExtensionId.make(id) },
  scope,
  sourcePath: `/test/${id}`,
  contributions: {
    hooks: [hook("systemPrompt", (input) => Effect.succeed(`${input.basePrompt}${suffix}`))],
  },
})

describe("prompt slots", () => {
  const test = it.live.layer(BunServices.layer)

  test("compose in scope order: builtin then user then project", () => {
    const compiled = compileExtensionHooks([
      ext("p", "project", "[project]"),
      ext("a", "builtin", "[builtin]"),
      ext("u", "user", "[user]"),
    ])

    return compiled.resolveSystemPrompt({ basePrompt: "x", agent: testAgent }).pipe(
      Effect.provideService(CurrentExtensionHostContext, stubHostCtx),
      Effect.tap((result) => Effect.sync(() => expect(result).toBe("x[builtin][user][project]"))),
    )
  })

  test("empty turn hooks are a no-op", () =>
    compileExtensionHooks([])
      .resolveSystemPrompt({ basePrompt: "x", agent: testAgent })
      .pipe(
        Effect.provideService(CurrentExtensionHostContext, stubHostCtx),
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("x"))),
      ))
})

// ── extension resolution ─────────────────────────────────────────────────────

// Test helper: build a no-op model Capability directly. The `tool({...})`
// factory rejects metadata-free tool records, so fixtures here construct the
// lowered Capability literal.
const makeTool = (name: string): ToolCapability =>
  tool({
    id: name,
    description: `test tool ${name}`,
    params: Schema.Struct({}),
    output: Schema.Void,
    execute: () => Effect.void,
  })
const compileRegistryPolicy = (
  registry: ExtensionRegistry["Service"],
  agent: AgentDefinition,
  projections: Parameters<typeof compileToolPolicy>[3] = [],
) =>
  compileToolPolicy(
    [...registry.getResolved().modelCapabilities.values()].map((entry) => entry.capability),
    agent,
    {},
    projections,
  )
const makeAgent = (
  name: string,
  options?: Partial<ConstructorParameters<typeof AgentDefinition>[0]>,
) => AgentDefinition.make({ name: AgentName.make(name), ...options })
const makeProvider = (providerId: string, name?: string): ModelDriverContribution => ({
  id: providerId,
  name: name ?? providerId,
  resolveModel: (modelName) =>
    Effect.succeed(
      AiModel.make(
        providerId,
        modelName,
        Layer.succeed(LanguageModel.LanguageModel, failingLanguageModel),
      ),
    ),
})
const makeExtRegistry = (
  id: string,
  scope: "builtin" | "user" | "project",
  opts?: {
    tools?: ToolCapability[]
    requests?: RequestCapability[]
    agents?: AgentDefinition[]
    modelDrivers?: ModelDriverContribution[]
  },
): LoadedExtension => {
  const tools = opts?.tools ?? []
  let contributions: ExtensionContributions = {}
  if (tools.length > 0) contributions = { ...contributions, tools }
  if (!Predicate.isUndefined(opts?.requests))
    contributions = { ...contributions, requests: opts.requests }
  if (!Predicate.isUndefined(opts?.agents))
    contributions = { ...contributions, agents: opts.agents }
  if (!Predicate.isUndefined(opts?.modelDrivers)) {
    contributions = { ...contributions, modelDrivers: opts.modelDrivers }
  }
  return {
    manifest: { id: ExtensionId.make(id) },
    scope,
    sourcePath: `/test/${id}`,
    contributions,
  }
}
const makeSlashRequest = (
  id: string,
  options?: {
    readonly description?: string
  },
): RequestCapability => {
  let description = `${id} command`
  if (!Predicate.isUndefined(options?.description)) description = options.description
  let optionalDescription: Pick<RequestCapability, "description"> = {}
  if (!Predicate.isUndefined(options?.description)) optionalDescription = { description }
  return bindRequestCapabilityExtension(
    request({
      id,
      slash: { name: id, description },
      ...optionalDescription,
      input: Schema.String,
      output: Schema.Void,
      execute: () => Effect.void,
    }),
    ExtensionId.make(`@test/${id}-slash`),
  )
}
const makeRequest = (id: string): RequestCapability =>
  request({
    id,
    input: Schema.Unknown,
    output: Schema.Unknown,
    execute: () => Effect.void,
  })
describe("resolveExtensions", () => {
  test("empty extensions produce empty maps", () => {
    const resolved = resolveExtensions([])
    expect(resolved.modelCapabilities.size).toBe(0)
    expect(resolved.agents.size).toBe(0)
  })
  test("collects tools from multiple extensions", () => {
    const resolved = resolveExtensions([
      makeExtRegistry("a", "builtin", { tools: [makeTool("read"), makeTool("write")] }),
      makeExtRegistry("b", "builtin", { tools: [makeTool("bash")] }),
    ])
    expect(resolved.modelCapabilities.size).toBe(3)
    expect(resolved.modelCapabilities.has("read")).toBe(true)
    expect(resolved.modelCapabilities.has("write")).toBe(true)
    expect(resolved.modelCapabilities.has("bash")).toBe(true)
  })
  test("later scope wins for same-name tool", () => {
    const builtinRead = makeTool("read")
    const projectRead = { ...makeTool("read"), description: "project override" }
    const resolved = resolveExtensions([
      makeExtRegistry("a", "builtin", { tools: [builtinRead] }),
      makeExtRegistry("b", "project", { tools: [projectRead] }),
    ])
    expect(resolved.modelCapabilities.get("read")?.capability.description).toBe("project override")
  })
  test("later scope wins for same-name agent", () => {
    const builtinExplore = makeAgent("explore")
    const projectExplore = AgentDefinition.make({
      name: AgentName.make("explore"),
      description: "project explore",
    })
    const resolved = resolveExtensions([
      makeExtRegistry("a", "builtin", { agents: [builtinExplore] }),
      makeExtRegistry("b", "project", { agents: [projectExplore] }),
    ])
    expect(resolved.agents.get("explore")?.description).toBe("project explore")
  })
  test("allows same-name tool/agent from different scopes (override)", () => {
    expect(() =>
      resolveExtensions([
        makeExtRegistry("a", "builtin", {
          tools: [makeTool("read")],
          agents: [makeAgent("explore")],
        }),
        makeExtRegistry("b", "project", {
          tools: [makeTool("read")],
          agents: [makeAgent("explore")],
        }),
      ]),
    ).not.toThrow()
  })
  test("collects providers from extensions", () => {
    const resolved = resolveExtensions([
      makeExtRegistry("a", "builtin", {
        modelDrivers: [makeProvider("anthropic"), makeProvider("openai")],
      }),
    ])
    expect(resolved.modelDrivers.size).toBe(2)
    expect(resolved.modelDrivers.has("anthropic")).toBe(true)
    expect(resolved.modelDrivers.has("openai")).toBe(true)
  })
  test("later scope wins for same-id provider", () => {
    const resolved = resolveExtensions([
      makeExtRegistry("a", "builtin", {
        modelDrivers: [makeProvider("anthropic", "Builtin Anthropic")],
      }),
      makeExtRegistry("b", "project", {
        modelDrivers: [makeProvider("anthropic", "Custom Anthropic")],
      }),
    ])
    expect(resolved.modelDrivers.get("anthropic")?.name).toBe("Custom Anthropic")
  })
  test("surfaces provided failed extensions without recomputing validation", () => {
    const resolved = resolveExtensions(
      [makeExtRegistry("healthy", "builtin", { tools: [makeTool("read")] })],
      [
        {
          manifest: { id: ExtensionId.make("broken") },
          scope: "builtin",
          sourcePath: "builtin",
          phase: "validation",
          error: "duplicate tool read",
        },
      ],
    )
    expect(resolved.extensions.map((ext) => ext.manifest.id)).toEqual([ExtensionId.make("healthy")])
    expect(resolved.failedExtensions).toEqual([
      {
        manifest: { id: ExtensionId.make("broken") },
        scope: "builtin",
        sourcePath: "builtin",
        phase: "validation",
        error: "duplicate tool read",
      },
    ])
    expect(resolved.extensionStatuses).toEqual([
      {
        manifest: { id: ExtensionId.make("healthy") },
        scope: "builtin",
        sourcePath: "/test/healthy",
        status: "active",
      },
      {
        manifest: { id: ExtensionId.make("broken") },
        scope: "builtin",
        sourcePath: "builtin",
        phase: "validation",
        error: "duplicate tool read",
        status: "failed",
      },
    ])
  })
})
describe("resolveExtensions — disabled filtering", () => {
  test("disabled extensions are excluded when filtered before resolve", () => {
    const disabledSet = new Set(["@gent/todo"])
    const extensions = [
      makeExtRegistry("@gent/fs-tools", "builtin", { tools: [makeTool("read")] }),
      makeExtRegistry("@gent/todo", "builtin", { tools: [makeTool("add_todo")] }),
    ]
    const enabled = extensions.filter((ext) => !disabledSet.has(ext.manifest.id))
    const resolved = resolveExtensions(enabled)
    expect(resolved.modelCapabilities.has("read")).toBe(true)
    expect(resolved.modelCapabilities.has("add_todo")).toBe(false)
    expect(resolved.extensions.length).toBe(1)
  })
  test("disabled extensions agents are excluded", () => {
    const disabledSet = new Set(["@gent/agents"])
    const extensions = [
      makeExtRegistry("@gent/agents", "builtin", {
        agents: [makeAgent("cowork", { model: ModelId.make("anthropic/claude-opus-4-6") })],
      }),
      makeExtRegistry("@gent/fs-tools", "builtin", { tools: [makeTool("read")] }),
    ]
    const enabled = extensions.filter((ext) => !disabledSet.has(ext.manifest.id))
    const resolved = resolveExtensions(enabled)
    expect(resolved.agents.size).toBe(0)
    expect(resolved.modelCapabilities.has("read")).toBe(true)
  })
  test("disabled extensions providers are excluded", () => {
    const disabledSet = new Set(["@gent/openai"])
    const extensions = [
      makeExtRegistry("@gent/anthropic", "builtin", { modelDrivers: [makeProvider("anthropic")] }),
      makeExtRegistry("@gent/openai", "builtin", { modelDrivers: [makeProvider("openai")] }),
    ]
    const enabled = extensions.filter((ext) => !disabledSet.has(ext.manifest.id))
    const resolved = resolveExtensions(enabled)
    expect(resolved.modelDrivers.has("anthropic")).toBe(true)
    expect(resolved.modelDrivers.has("openai")).toBe(false)
  })
  test("multiple disabled extensions are all excluded", () => {
    const disabledSet = new Set(["@gent/todo", "@gent/agents", "@gent/openai"])
    const extensions = [
      makeExtRegistry("@gent/todo", "builtin", { tools: [makeTool("add_todo")] }),
      makeExtRegistry("@gent/agents", "builtin", {
        agents: [makeAgent("cowork", { model: ModelId.make("anthropic/claude-opus-4-6") })],
      }),
      makeExtRegistry("@gent/openai", "builtin", { modelDrivers: [makeProvider("openai")] }),
      makeExtRegistry("@gent/fs-tools", "builtin", { tools: [makeTool("read")] }),
    ]
    const enabled = extensions.filter((ext) => !disabledSet.has(ext.manifest.id))
    const resolved = resolveExtensions(enabled)
    expect(resolved.modelCapabilities.size).toBe(1)
    expect(resolved.modelCapabilities.has("read")).toBe(true)
    expect(resolved.agents.size).toBe(0)
    expect(resolved.modelDrivers.size).toBe(0)
  })
})
describe("ExtensionRegistry", () => {
  const buildRegistry = (
    extensions: LoadedExtension[],
    failedExtensions: Parameters<typeof resolveExtensions>[1] = [],
  ) => {
    const resolved = resolveExtensions(extensions, failedExtensions)
    return Effect.service(ExtensionRegistry).pipe(
      Effect.provide(ExtensionRegistry.fromResolved(resolved)),
    )
  }
  it.live("registered model capability is findable by name", () =>
    Effect.gen(function* () {
      const registry = yield* buildRegistry([
        makeExtRegistry("a", "builtin", { tools: [makeTool("read")] }),
      ])
      const tools = [...registry.getResolved().modelCapabilities.values()].map(
        (entry) => entry.capability,
      )
      const tool = tools.find((capability) => String(getToolId(capability)) === "read")
      expect(tool).toBeDefined()
      if (Predicate.isUndefined(tool)) return
      expect(String(getToolId(tool))).toBe("read")
    }),
  )
  it.live("unregistered model capability name returns undefined", () =>
    Effect.gen(function* () {
      const registry = yield* buildRegistry([])
      const tools = [...registry.getResolved().modelCapabilities.values()].map(
        (entry) => entry.capability,
      )
      const tool = tools.find((capability) => String(getToolId(capability)) === "nonexistent")
      expect(tool).toBeUndefined()
    }),
  )
  it.live("lists all registered tools across extensions", () =>
    Effect.gen(function* () {
      const registry = yield* buildRegistry([
        makeExtRegistry("a", "builtin", { tools: [makeTool("read"), makeTool("write")] }),
      ])
      const tools = [...registry.getResolved().modelCapabilities.values()].map(
        (entry) => entry.capability,
      )
      expect(tools.length).toBe(2)
    }),
  )
  it.live("extension diagnostics expose both active and failed activation state", () =>
    Effect.gen(function* () {
      const registry = yield* buildRegistry(
        [makeExtRegistry("healthy", "builtin", { tools: [makeTool("read")] })],
        [
          {
            manifest: { id: ExtensionId.make("broken") },
            scope: "builtin",
            sourcePath: "builtin",
            phase: "startup",
            error: "startup boom",
          },
        ],
      )
      const tools = [...registry.getResolved().modelCapabilities.values()].map(
        (entry) => entry.capability,
      )
      const failed = registry.getResolved().failedExtensions
      const statuses = registry.getResolved().extensionStatuses
      expect(tools.map((tool) => String(getToolId(tool)))).toEqual(["read"])
      expect(failed).toEqual([
        {
          manifest: { id: ExtensionId.make("broken") },
          scope: "builtin",
          sourcePath: "builtin",
          phase: "startup",
          error: "startup boom",
        },
      ])
      expect(statuses).toEqual([
        {
          manifest: { id: ExtensionId.make("healthy") },
          scope: "builtin",
          sourcePath: "/test/healthy",
          status: "active",
        },
        {
          manifest: { id: ExtensionId.make("broken") },
          scope: "builtin",
          sourcePath: "builtin",
          status: "failed",
          phase: "startup",
          error: "startup boom",
        },
      ])
    }),
  )
  it.live("registered agent is findable by name", () =>
    Effect.gen(function* () {
      const registry = yield* buildRegistry([
        makeExtRegistry("a", "builtin", { agents: [makeAgent("explore")] }),
      ])
      const agents = [...registry.getResolved().agents.values()]
      const agent = agents.find((entry) => entry.name === AgentName.make("explore"))
      expect(agent?.name).toBe(AgentName.make("explore"))
    }),
  )
  it.live("lists all agents including override winners", () =>
    Effect.gen(function* () {
      const cowork = AgentDefinition.make({
        name: AgentName.make("cowork"),
        model: ModelId.make("anthropic/claude-opus-4-6"),
      })
      const explore = makeAgent("explore")
      const deepwork = AgentDefinition.make({
        name: AgentName.make("deepwork"),
        model: ModelId.make("openai/gpt-5.4"),
      })
      const registry = yield* buildRegistry([
        makeExtRegistry("a", "builtin", { agents: [cowork, explore, deepwork] }),
      ])
      const agents = [...registry.getResolved().agents.values()]
      expect(agents.length).toBe(3)
      expect(agents.map((a) => a.name)).toContain(AgentName.make("cowork"))
      expect(agents.map((a) => a.name)).toContain(AgentName.make("explore"))
      expect(agents.map((a) => a.name)).toContain(AgentName.make("deepwork"))
    }),
  )
  it.live("allowedTools narrows the resolved tool set", () =>
    Effect.gen(function* () {
      const readTool = makeTool("read")
      const bashTool = makeTool("bash")
      const agent = AgentDefinition.make({
        name: AgentName.make("explore"),
        allowedTools: ["read"],
      })
      const registry = yield* buildRegistry([
        makeExtRegistry("a", "builtin", { tools: [readTool, bashTool], agents: [agent] }),
      ])
      const { tools } = compileRegistryPolicy(registry, agent)
      expect(tools.length).toBe(1)
      const firstTool = tools[0]
      expect(firstTool).toBeDefined()
      if (Predicate.isUndefined(firstTool)) return
      expect(String(getToolId(firstTool))).toBe("read")
    }),
  )
  it.live("allowedTools restricts the resolved set to exactly the listed names", () =>
    Effect.gen(function* () {
      const readTool = makeTool("read")
      const bashTool = makeTool("bash")
      const editTool = makeTool("edit")
      const agent = AgentDefinition.make({
        name: AgentName.make("explore"),
        allowedTools: ["read", "bash"],
      })
      const registry = yield* buildRegistry([
        makeExtRegistry("a", "builtin", { tools: [readTool, bashTool, editTool], agents: [agent] }),
      ])
      const { tools } = compileRegistryPolicy(registry, agent)
      const names = tools.map((t) => String(getToolId(t)))
      expect(names).toContain("read")
      expect(names).toContain("bash")
      expect(names).not.toContain("edit")
    }),
  )
  it.live("deniedTools removes matching entries from the resolved set", () =>
    Effect.gen(function* () {
      const readTool = makeTool("read")
      const writeTool = makeTool("write")
      const agent = AgentDefinition.make({
        name: AgentName.make("cowork"),
        deniedTools: ["write"],
      })
      const registry = yield* buildRegistry([
        makeExtRegistry("a", "builtin", { tools: [readTool, writeTool], agents: [agent] }),
      ])
      const { tools } = compileRegistryPolicy(registry, agent)
      const names = tools.map((t) => String(getToolId(t)))
      expect(names).toContain("read")
      expect(names).not.toContain("write")
    }),
  )
  it.live("denied tools cannot be injected via projection", () =>
    Effect.gen(function* () {
      const readTool = makeTool("read")
      const secretTool = makeTool("secret")
      const agent = AgentDefinition.make({
        name: AgentName.make("cowork"),
        deniedTools: ["secret"],
      })
      const registry = yield* buildRegistry([
        makeExtRegistry("core", "builtin", { tools: [readTool, secretTool] }),
      ])
      // Try to force-include via projection
      const { tools } = compileRegistryPolicy(registry, agent, [
        { toolPolicy: { include: ["secret"] } },
      ])
      expect(tools.map((t) => String(getToolId(t)))).not.toContain("secret")
    }),
  )
  test("registered model driver is findable by ID", () => {
    const registry = resolveExtensions([
      makeExtRegistry("a", "builtin", { modelDrivers: [makeProvider("anthropic")] }),
    ])
    const provider = registry.modelDrivers.get("anthropic")
    expect(provider?.id).toBe("anthropic")
  })
  test("unregistered model driver ID returns undefined", () => {
    const registry = resolveExtensions([])
    const provider = registry.modelDrivers.get("nonexistent")
    expect(provider).toBeUndefined()
  })
  test("lists all registered model drivers", () => {
    const registry = resolveExtensions([
      makeExtRegistry("a", "builtin", {
        modelDrivers: [makeProvider("anthropic"), makeProvider("openai")],
      }),
    ])
    expect(registry.modelDrivers.size).toBe(2)
  })
  it.live("test layer starts with empty registry", () =>
    Effect.gen(function* () {
      const resolved = yield* Effect.gen(function* () {
        const ext = yield* ExtensionRegistry
        return ext.getResolved()
      }).pipe(Effect.provide(ExtensionRegistry.Test()))
      expect(resolved.modelCapabilities.size).toBe(0)
      expect(resolved.agents.size).toBe(0)
      expect(resolved.modelDrivers.size).toBe(0)
    }),
  )
})
// Slash-command discovery — identity-first scope shadowing followed by
// bucket/surface authorization.
describe("resolveExtensions — slash command discovery", () => {
  test("slash-decorated request appears in commands", () => {
    const cap = makeSlashRequest("echo", { description: "Echo the args back." })
    const resolved = resolveExtensions([
      makeExtRegistry("@test/echo", "builtin", { requests: [cap] }),
    ])
    const commands = resolved.slashCommands
    expect(commands.map((c) => c.name)).toContain("echo")
    expect(commands.find((c) => c.name === "echo")?.description).toBe("Echo the args back.")
  })
  test("slash request keeps registry description separate from slash metadata", () => {
    const cap = request({
      id: "inspect",
      description: "Registry description.",
      slash: {
        name: "Inspect",
        description: "Slash menu description.",
        category: "Diagnostics",
        keybind: "ctrl+i",
      },
      input: Schema.Unknown,
      output: Schema.Unknown,
      execute: () => Effect.void,
    })
    const resolved = resolveExtensions([
      makeExtRegistry("@test/request", "builtin", { requests: [cap] }),
    ])
    const command = resolved.slashCommands.find((c) => c.name === "inspect")
    expect(cap.description).toBe("Registry description.")
    expect(command?.displayName).toBe("Inspect")
    expect(command?.description).toBe("Slash menu description.")
    expect(command?.category).toBe("Diagnostics")
    expect(command?.keybind).toBe("ctrl+i")
  })
  test("higher-scope plain request shadows lower-scope slash request from the command list", () => {
    const builtinCap = makeSlashRequest("act")
    const builtin = makeExtRegistry("@test/shadow", "builtin", { requests: [builtinCap] })
    const projectCap = makeRequest("act")
    const project = makeExtRegistry("@test/shadow", "project", { requests: [projectCap] })
    const resolved = resolveExtensions([builtin, project])
    const commands = resolved.slashCommands
    expect(commands.map((c) => c.name)).not.toContain("act")
  })
  test("request without slash metadata does not appear in the slash-backed command list", () => {
    const cap = makeRequest("rpc-only")
    const resolved = resolveExtensions([
      makeExtRegistry("@test/rpc-only", "builtin", { requests: [cap] }),
    ])
    const commands = resolved.slashCommands
    expect(commands.map((c) => c.name)).not.toContain("rpc-only")
  })
  // ── Model capability surface ────────────────────────────────────────
  test("tool appears as a model capability", () => {
    const cap = tool({
      id: "echo",
      description: "Echo input back as output.",
      params: Schema.String,
      output: Schema.Void,
      execute: () => Effect.void,
    })
    const resolved = resolveExtensions([makeExtRegistry("@test/echo", "builtin", { tools: [cap] })])
    expect(resolved.modelCapabilities.has("echo")).toBe(true)
    expect(resolved.modelCapabilities.get("echo")?.capability.description).toBe(
      "Echo input back as output.",
    )
  })
  test("project rpc shadows builtin tool", () => {
    const builtin = makeExtRegistry("@test/shadow", "builtin", { tools: [makeTool("act")] })
    const projectCap = makeRequest("act")
    const project = makeExtRegistry("@test/shadow", "project", { requests: [projectCap] })
    const resolved = resolveExtensions([builtin, project])
    expect(resolved.modelCapabilities.has("act")).toBe(false)
  })
  test("project slash request shadows builtin tool", () => {
    const builtin = makeExtRegistry("@test/shadow", "builtin", { tools: [makeTool("look")] })
    const projectCap = makeSlashRequest("look")
    const project = makeExtRegistry("@test/shadow", "project", { requests: [projectCap] })
    const resolved = resolveExtensions([builtin, project])
    expect(resolved.modelCapabilities.has("look")).toBe(false)
  })
  test("project tool overrides builtin tool", () => {
    const builtin = makeExtRegistry("@test/shadow", "builtin", { tools: [makeTool("run")] })
    const projectCap = tool({
      id: "run",
      description: "project run override",
      params: Schema.Unknown,
      output: Schema.Void,
      execute: () => Effect.void,
    })
    const project = makeExtRegistry("@test/shadow", "project", { tools: [projectCap] })
    const resolved = resolveExtensions([builtin, project])
    expect(resolved.modelCapabilities.has("run")).toBe(true)
    expect(resolved.modelCapabilities.get("run")?.capability.description).toBe(
      "project run override",
    )
  })
  test("model capability preserves all tool metadata fields", () => {
    const cap = tool({
      id: "rich",
      description: "rich tool",
      params: Schema.Unknown,
      output: Schema.Void,
      promptSnippet: "Snippet here.",
      promptGuidelines: ["use carefully", "log result"],
      interactive: true,
      execute: () => Effect.void,
    })
    const resolved = resolveExtensions([makeExtRegistry("@test/rich", "builtin", { tools: [cap] })])
    const resolvedTool = resolved.modelCapabilities.get("rich")?.capability
    expect(resolvedTool).toBeDefined()
    if (Predicate.isUndefined(resolvedTool)) return
    expect(resolvedTool.description).toBe("rich tool")
    const metadata = getToolMetadata(resolvedTool)
    expect(metadata?.promptSnippet).toBe("Snippet here.")
    expect(metadata?.promptGuidelines).toEqual(["use carefully", "log result"])
    expect(metadata?.interactive).toBe(true)
  })
  test("rpc does not appear as a tool", () => {
    const cap = makeRequest("rpc-only")
    const resolved = resolveExtensions([
      makeExtRegistry("@test/rpc", "builtin", { requests: [cap] }),
    ])
    expect(resolved.modelCapabilities.has("rpc-only")).toBe(false)
  })
})

// ── resources ────────────────────────────────────────────────────────────────

/**
 * ResourceHost — service/lifecycle Resource tests.
 *
 * Covers:
 *   - Resource shape: defineResource produces a contribution with
 *     the typed scope literal flowing through the shape.
 *   - Resource layer assembly merges services and runs lifecycle effects.
 *   - Scheduled jobs are their own contribution shape, not Resource metadata.
 *
 * @module
 */

// ── Resource shape + helpers ──

class TestServiceA extends Context.Service<TestServiceA, { readonly value: string }>()(
  "@gent/core/tests/runtime/extension-host.test/TestServiceA",
) {}
class TestServiceB extends Context.Service<TestServiceB, { readonly value: string }>()(
  "@gent/core/tests/runtime/extension-host.test/TestServiceB",
) {}
const layerA = Layer.succeed(TestServiceA, TestServiceA.of({ value: "A" }))
const layerB = Layer.succeed(TestServiceB, TestServiceB.of({ value: "B" }))

const stubManifest = (id: string) => ({
  id: ExtensionId.make(id),
  version: "0.0.0",
})

const makeStubExtension = (
  id: string,
  resources: ReadonlyArray<AnyResourceContribution>,
): LoadedExtension =>
  ({
    manifest: stubManifest(id),
    scope: "builtin",
    sourcePath: "builtin",
    contributions: { resources },
  }) satisfies LoadedExtension

describe("defineResource", () => {
  test("emits a contribution with the declared scope", () => {
    const r = defineResource({
      id: "test/resource-host/declared-scope",
      scope: "process",
      layer: layerA,
    })
    expect(String(r.id)).toBe("test/resource-host/declared-scope")
    expect(r.scope).toBe("process")
  })

  test("rejects an empty resource id", () => {
    expect(() =>
      defineResource({
        id: "",
        scope: "process",
        layer: Layer.empty,
      }),
    ).toThrow()
  })
})

/** One scope's Resources built into the caller's scope, over no other services. */
const buildProcessResources = (extensions: ReadonlyArray<LoadedExtension>) =>
  Effect.gen(function* () {
    return yield* buildScopeResources({
      extensions,
      scope: "process",
      context: Context.makeUnsafe<unknown>(new Map()),
      parent: yield* Effect.scope,
      restore: (effect) => effect,
    })
  })

describe("buildScopeResources", () => {
  it.live("an extension with no Resources adds no service", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ext = makeStubExtension("ext", [])
        const started = yield* buildProcessResources([ext])
        expect(started.active).toEqual([ext])
        expect(Option.isNone(Context.getOption(started.context, TestServiceA))).toBe(true)
        expect(Option.isNone(Context.getOption(started.context, TestServiceB))).toBe(true)
      }),
    ),
  )

  it.live("merges service layers across multiple Resources", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ext = makeStubExtension("ext", [
          defineResource({
            id: "test/resource-host/merge/service-a",
            scope: "process",
            layer: layerA,
          }),
          defineResource({
            id: "test/resource-host/merge/service-b",
            scope: "process",
            layer: layerB,
          }),
        ])
        const started = yield* buildProcessResources([ext])
        expect(Context.get(started.context, TestServiceA).value).toBe("A")
        expect(Context.get(started.context, TestServiceB).value).toBe("B")
      }),
    ),
  )
})

// ── resource layer lifecycle ──

describe("buildScopeResources lifecycle", () => {
  const lifecycleLog = () => {
    const log: string[] = []
    const append = (s: string) => Effect.sync(() => log.push(s))
    const tracked = <I>(layer: Layer.Layer<I>, name: string) =>
      Layer.provideMerge(
        layer,
        Layer.effectDiscard(
          Effect.acquireRelease(append(`start-${name}`), () => append(`stop-${name}`)),
        ),
      )
    return { log, tracked }
  }

  it.live("layers build in declaration order and release in reverse at scope teardown", () =>
    Effect.gen(function* () {
      const { log, tracked } = lifecycleLog()
      const ext = makeStubExtension("ext", [
        defineResource({
          id: "test/resource-host/lifecycle/order-1",
          scope: "process",
          layer: tracked(layerA, "1"),
        }),
        defineResource({
          id: "test/resource-host/lifecycle/order-2",
          scope: "process",
          layer: tracked(layerB, "2"),
        }),
      ])
      yield* Effect.scoped(buildProcessResources([ext]))
      expect(log).toEqual(["start-1", "start-2", "stop-2", "stop-1"])
    }),
  )

  it.live("a failed layer fails its extension and releases what it built before", () =>
    Effect.gen(function* () {
      const { log, tracked } = lifecycleLog()
      const ext = makeStubExtension("ext", [
        defineResource({
          id: "test/resource-host/lifecycle/failure/good",
          scope: "process",
          layer: tracked(layerA, "good"),
        }),
        defineResource({
          id: "test/resource-host/lifecycle/failure/bad",
          scope: "process",
          layer: Layer.effect(TestServiceB, Effect.die(new Error("boom"))),
        }),
      ])
      const started = yield* Effect.scoped(buildProcessResources([ext]))
      expect(started.active).toEqual([])
      expect(started.failed.map(({ failure }) => failure.phase)).toEqual(["startup"])
      expect(log).toEqual(["start-good", "stop-good"])
    }),
  )
})

// ── runtime hooks ────────────────────────────────────────────────────────────

const stubCtx = testExtensionHostContext()

const stubEvent: Omit<TurnAfterInput, "readNotices"> = {
  sessionId: SessionId.make("019da5c0-0000-7000-0000-000000000001"),
  branchId: BranchId.make("019da5c0-0000-7001-0000-000000000001"),
  durationMs: 100,
  joinedMessageIds: new Set(),
  startedAtMs: 0,
  agentName: AgentName.make("cowork"),
  interrupted: false,
  streamFailed: false,
  unanswered: false,

  messageId: MessageId.make("turn-message"),
  usage: {
    known: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: Option.none(),
    },
    complete: true,
  },
}

const extRuntimeHooks = (
  id: string,
  scope: "builtin" | "user" | "project",
  contributions: ExtensionContributions,
): LoadedExtension => ({
  manifest: { id: ExtensionId.make(id) },
  scope,
  sourcePath: `/test/${id}`,
  contributions,
})

const turnAfterHooks = (handler: () => Effect.Effect<void, BoomError>) => [
  hook("turnAfter", (_input: TurnAfterInput) => handler()),
]

describe("runtime hooks", () => {
  const test = it.live.layer(BunServices.layer)

  test("failure is isolated; later hooks still fire", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const compiled = compileExtensionHooks([
        extRuntimeHooks("a", "builtin", {
          hooks: turnAfterHooks(() => {
            calls.push("failing")
            return Effect.fail(new BoomError({ reason: "intentional" }))
          }),
        }),
        extRuntimeHooks("b", "builtin", {
          hooks: turnAfterHooks(() =>
            Effect.sync(() => {
              calls.push("after")
            }),
          ),
        }),
      ])

      const exit = yield* Effect.exit(
        compiled
          .emitTurnAfter(stubEvent, new Map())
          .pipe(Effect.provideService(CurrentExtensionHostContext, stubCtx)),
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(calls).toEqual(["failing", "after"])
    }))

  test("happy path: all hooks fire in scope order", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const make = (label: string) =>
        turnAfterHooks(() =>
          Effect.sync(() => {
            calls.push(label)
          }),
        )

      const compiled = compileExtensionHooks([
        extRuntimeHooks("z-project", "project", { hooks: make("project") }),
        extRuntimeHooks("a-builtin", "builtin", { hooks: make("builtin") }),
        extRuntimeHooks("m-user", "user", { hooks: make("user") }),
      ])

      yield* compiled
        .emitTurnAfter(stubEvent, new Map())
        .pipe(Effect.provideService(CurrentExtensionHostContext, stubCtx))
      expect(calls).toEqual(["builtin", "user", "project"])
    }))

  test("each extension's turnAfter reads back only the notices its own projection showed", () =>
    Effect.gen(function* () {
      const read = new Map<string, ReadonlyArray<string>>()
      const recordRead = (id: string) => [
        hook("turnAfter", (input: TurnAfterInput) =>
          Effect.sync(() => {
            read.set(id, [...input.readNotices])
          }),
        ),
      ]
      const compiled = compileExtensionHooks([
        extRuntimeHooks("shows", "builtin", { hooks: recordRead("shows") }),
        extRuntimeHooks("quiet", "builtin", { hooks: recordRead("quiet") }),
      ])
      yield* compiled
        .emitTurnAfter(stubEvent, new Map([[ExtensionId.make("shows"), new Set(["a", "b"])]]))
        .pipe(Effect.provideService(CurrentExtensionHostContext, stubCtx))
      expect(read.get("shows")).toEqual(["a", "b"])
      expect(read.get("quiet")).toEqual([])
    }))

  test("a notice with no text is not shown, so no turn reads its keys", () =>
    Effect.gen(function* () {
      const compiled = compileExtensionHooks([
        extRuntimeHooks("blank", "builtin", {
          hooks: [
            hook("turnProjection", () =>
              Effect.succeed({
                notices: [
                  { id: "blank", content: "", keys: ["unseen"] },
                  { id: "spaces", content: "  \n", keys: ["also-unseen"] },
                  { id: "real", content: "# Real", keys: ["seen"] },
                ],
              }),
            ),
          ],
        }),
      ])
      const projection = yield* compiled
        .resolveTurnProjection({ agent: AgentDefinition.make({ name: AgentName.make("cowork") }) })
        .pipe(Effect.provideService(CurrentExtensionHostContext, stubCtx))
      expect(projection.notices.map(({ notice }) => notice.keys)).toEqual([["seen"]])
    }))

  test("a turn's notices keep their extension, and a later notice with the same id replaces one", () =>
    Effect.gen(function* () {
      const notices = (keys: ReadonlyArray<string>, content: string) => [
        hook("turnProjection", () =>
          Effect.succeed({ notices: [{ id: "shared", content, keys }] }),
        ),
      ]
      const compiled = compileExtensionHooks([
        extRuntimeHooks("first", "builtin", { hooks: notices(["x"], "from first") }),
        extRuntimeHooks("second", "user", { hooks: notices(["y"], "from second") }),
        extRuntimeHooks("own", "project", {
          hooks: [
            hook("turnProjection", () =>
              Effect.succeed({ notices: [{ id: "own", content: "own", keys: ["z"] }] }),
            ),
          ],
        }),
      ])
      const projection = yield* compiled
        .resolveTurnProjection({ agent: AgentDefinition.make({ name: AgentName.make("cowork") }) })
        .pipe(Effect.provideService(CurrentExtensionHostContext, stubCtx))
      expect(projection.notices).toEqual([
        {
          extensionId: ExtensionId.make("second"),
          notice: { id: "shared", content: "from second", keys: ["y"] },
        },
        {
          extensionId: ExtensionId.make("own"),
          notice: { id: "own", content: "own", keys: ["z"] },
        },
      ])
      expect(projection.promptSections).toEqual([])
    }))
})

// ── scope precedence ─────────────────────────────────────────────────────────

/**
 * Scope precedence regression locks.
 *
 * Locks the rule that builtin < user < project across:
 *  - keyed contributions (tools, agents, prompt sections) — later scope wins
 *  - explicit prompt slots (later scope applies after earlier scope)
 *  - alphabetical tie-break on extension id within the same scope
 *
 * Providers and turn executors share the keyed-contribution code path
 * (`compileContributions` in registry.ts) — the tools test exercises that path.
 */

const toolReturning = (name: string, label: string): ToolCapability<{}, string, never> =>
  tool({
    id: name,
    description: label,
    params: Schema.Struct({}),
    output: Schema.String,
    execute: () => Effect.succeed(label),
  })

const extScopePrecedence = (
  id: string,
  scope: "builtin" | "user" | "project",
  contributions: ExtensionContributions,
): LoadedExtension => ({
  manifest: { id: ExtensionId.make(id) },
  scope,
  sourcePath: `/test/${id}`,
  contributions,
})

describe("scope precedence", () => {
  describe("keyed contributions — later scope wins", () => {
    const test = it.live.layer(BunServices.layer)

    test("tool with same name: project shadows user shadows builtin", () => {
      const builtinTool = toolReturning("greet", "from-builtin")
      const userTool = toolReturning("greet", "from-user")
      const projectTool = toolReturning("greet", "from-project")

      const resolved = resolveExtensions([
        extScopePrecedence("a", "builtin", { tools: [builtinTool] }),
        extScopePrecedence("b", "user", { tools: [userTool] }),
        extScopePrecedence("c", "project", { tools: [projectTool] }),
      ])

      const resolvedTool = resolved.modelCapabilities.get("greet")?.capability
      expect(resolvedTool).toBeDefined()
      if (!isToolCapability(resolvedTool)) return Effect.void
      expect(resolvedTool).toBe(projectTool)
      return runToolWithCtx(projectTool, {}, testToolContext()).pipe(
        Effect.orDie,
        Effect.tap((r) => Effect.sync(() => expect(r).toBe("from-project"))),
      )
    })

    test("agent with same name: project shadows builtin", () => {
      const projectAgent = AgentDefinition.make({
        name: testAgent.name,
        description: "shadowed",
      })

      const resolved = resolveExtensions([
        extScopePrecedence("a", "builtin", { agents: [testAgent] }),
        extScopePrecedence("b", "project", { agents: [projectAgent] }),
      ])
      return Effect.sync(() =>
        expect(resolved.agents.get(testAgent.name)?.description).toBe("shadowed"),
      )
    })

    test("same scope ties broken by extension id alphabetically", () => {
      const toolFromZ = toolReturning("greet", "from-z")
      const toolFromA = toolReturning("greet", "from-a")

      // Pass in reverse order to prove the registry sorts, not just respects insertion
      const resolved = resolveExtensions([
        extScopePrecedence("z-ext", "builtin", { tools: [toolFromZ] }),
        extScopePrecedence("a-ext", "builtin", { tools: [toolFromA] }),
      ])

      // Sorted [a-ext, z-ext] — z-ext registered last, so wins
      const resolvedTool = resolved.modelCapabilities.get("greet")?.capability
      expect(resolvedTool).toBeDefined()
      if (!isToolCapability(resolvedTool)) return Effect.void
      expect(resolvedTool).toBe(toolFromZ)
      return runToolWithCtx(toolFromZ, {}, testToolContext()).pipe(
        Effect.orDie,
        Effect.tap((r) => Effect.sync(() => expect(r).toBe("from-z"))),
      )
    })
  })

  describe("explicit prompt slots — project applies after user after builtin", () => {
    const test = it.live.layer(BunServices.layer)

    test("systemPrompt rewrite order follows scope precedence", () => {
      const make = (id: string, scope: "builtin" | "user" | "project") =>
        extScopePrecedence(id, scope, {
          hooks: [hook("systemPrompt", (input) => Effect.succeed(`${input.basePrompt}[${scope}]`))],
        })

      // Pass out of order to prove sorting, not insertion
      const compiled = compileExtensionHooks([
        make("p", "project"),
        make("a", "builtin"),
        make("u", "user"),
      ])

      return compiled.resolveSystemPrompt({ basePrompt: "x", agent: testAgent }).pipe(
        Effect.provideService(CurrentExtensionHostContext, stubCtx),
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("x[builtin][user][project]"))),
      )
    })
  })
})

// ── session agent ────────────────────────────────────────────────────────────

const makeTestExtensions = () => {
  const mainAgent = AgentDefinition.make({
    name: DEFAULT_AGENT_NAME,
    model: ModelId.make("test/default"),
  })
  const reflect = AgentDefinition.make({
    name: AgentName.make("memory:reflect"),
    model: ModelId.make("test/override"),
  })
  return resolveExtensions([
    {
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin",
      sourcePath: "test",
      contributions: { agents: [mainAgent, reflect] } satisfies ExtensionContributions,
    },
  ])
}
const makeMutationsLayer = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) => {
  const resolvedExtensions = makeTestExtensions()
  const recorderLayer = SequenceRecorder.Live
  const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
  const storageLayer = testSqliteStorage(noBranchTools.storage, noBranchTools.migrations)
  const clusterRunnerLayer = Layer.provide(
    SingleRunner.layer({ runnerStorage: "memory" }),
    Layer.merge(storageLayer, BunCrypto.layer),
  )
  const baseDeps = Layer.mergeAll(
    storageLayer,
    clusterRunnerLayer,
    providerLayer,
    LanguageModelLayers.resolver(providerLayer),
    eventStoreLayer,
    recorderLayer,
    ExtensionRegistry.fromResolved(resolvedExtensions),
    ToolRunner.Test(),
    ApprovalService.Test(),
    RuntimeEnvironment.Live({ cwd: "/tmp", home: "/nonexistent/gent-test-home" }),
    ConfigService.Test(),
    BunServices.layer,
    ModelRegistry.Test(),
    GentPlatform.Test(),
    SessionProfileCache.Test(),
    AgentLoopSessionGovernance.Live,
  )
  const sessionRuntimeLayer = Layer.provide(
    Layer.provideMerge(AgentLoopLiveActor({ baseSections: [] }), SessionRuntime.Client),
    baseDeps,
  )
  const sessionMutationsLayer = Layer.provide(
    SessionMutationsLive,
    Layer.mergeAll(baseDeps, sessionRuntimeLayer),
  )
  return Layer.mergeAll(baseDeps, sessionRuntimeLayer, sessionMutationsLayer)
}
const eventTags = (calls: ReadonlyArray<CallRecord>) =>
  calls
    .filter((call) => call.service === "EventStore" && call.method === "append")
    .map((call) => Schema.decodeUnknownSync(AgentEvent)(call.args)._tag)
describe("session agent", () => {
  it.scopedLive("every turn of a session runs as the agent it was created with", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        {
          ...textStep("first reply"),
          assertRequest: (request) => {
            expect(request.model).toBe("test/override")
          },
        },
        {
          ...textStep("second reply"),
          assertRequest: (request) => {
            expect(request.model).toBe("test/override")
          },
        },
      ])
      yield* Effect.gen(function* () {
        const mutations = yield* SessionMutations
        const sessionRuntime = yield* SessionRuntime
        const messageStorage = yield* MessageStorage
        const recorder = yield* SequenceRecorder
        const session = yield* mutations.createSession({
          name: "Session Agent Test",
          admission: { agent: AgentName.make("memory:reflect") },
        })
        yield* sessionRuntime.sendUserMessage({
          sessionId: session.sessionId,
          branchId: session.branchId,
          content: "first",
        })
        yield* sessionRuntime.sendUserMessage({
          sessionId: session.sessionId,
          branchId: session.branchId,
          content: "second",
        })
        const messages = yield* waitFor(
          messageStorage.listMessages(session.branchId),
          (current) => current.filter((message) => message.role === "assistant").length === 2,
          5000,
          "two assistant replies",
        )
        const calls = yield* recorder.getCalls
        expect(messages.map((message) => message.role)).toEqual([
          "user",
          "assistant",
          "user",
          "assistant",
        ])
        expect(eventTags(calls)).not.toContain("AgentSwitched")
        yield* controls.assertDone
      }).pipe(Effect.provide(makeMutationsLayer(providerLayer)), Effect.scoped)
    }).pipe(Effect.provide(BunCrypto.layer)),
  )
  it.scopedLive("createSession skips dispatch when initialPrompt is missing or empty", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([])
      yield* Effect.gen(function* () {
        const mutations = yield* SessionMutations
        const messageStorage = yield* MessageStorage
        const noPrompt = yield* mutations.createSession({ name: "No Prompt Test" })
        const emptyPrompt = yield* mutations.createSession({
          name: "Empty Prompt Test",
          initialPrompt: "",
        })
        expect(yield* messageStorage.listMessages(noPrompt.branchId)).toEqual([])
        expect(yield* messageStorage.listMessages(emptyPrompt.branchId)).toEqual([])
        yield* controls.assertDone
      }).pipe(Effect.provide(makeMutationsLayer(providerLayer)), Effect.scoped)
    }).pipe(Effect.provide(BunCrypto.layer)),
  )
})

// ── addressed session verbs ─────────────────────────────────────────────────
//
// Every extension gets the same facade, so a child runner is buildable
// outside core. Each verb is exercised through the RPC path with real
// per-request scopes: create a child, prompt it with a turn, read its
// receipt, queue a follow-up on it, steer a message into it, stop it, delete it.

describe("addressed session verbs via RPC", () => {
  const extensionId = ExtensionId.make("@gent/test-addressed")
  const Target = Schema.Struct({ sessionId: SessionId, branchId: BranchId })

  const Verbs = defineRequests(extensionId, {
    Spawn: request({
      id: "spawn",
      input: Schema.Struct({ requestId: RequestId, prompt: Schema.String }),
      output: Schema.Struct({
        ...Target.fields,
        completed: Schema.Boolean,
        answer: Schema.String,
        historyMessages: Schema.Finite,
      }),
      execute: Effect.fn("Spawn.execute")(function* (input) {
        const ctx = yield* ExtensionContext
        const child = yield* ctx.Session.create({
          name: "child",
          parentSessionId: ctx.sessionId,
          parentBranchId: ctx.branchId,
          historyBranchId: ctx.branchId,
          requestId: input.requestId,
        })
        const detailBefore = yield* ctx.Session.getDetail(child.sessionId)
        const historyMessages =
          detailBefore.branches.find((b) => b.branch.id === child.branchId)?.messages.length ?? 0
        // A commandId waits for the child's turn to end.
        yield* ctx.Session.send({
          delivery: "turn",
          ...child,
          content: input.prompt,
          commandId: ActorCommandId.make(`spawn:${input.requestId}`),
        })
        // The durable history ends at the marker; a bounded read takes until it.
        const history = yield* ctx.Session.events(child).pipe(
          Stream.takeUntil((event) => event._tag === "StreamSynchronized"),
          Stream.runCollect,
        )
        const completed = history.some(
          (event) =>
            event._tag === "TurnCompleted" && event.messageId === `spawn:${input.requestId}`,
        )
        const detail = yield* ctx.Session.getDetail(child.sessionId)
        const answer = messagePartsDisplayText(
          detail.branches
            .flatMap((b) => b.messages)
            .filter((m) => m.role === "assistant")
            .at(-1)?.parts ?? [],
        )
        return { ...child, completed, answer, historyMessages }
      }),
    }),
    QueueOn: request({
      id: "queue-on",
      input: Target,
      output: Schema.Struct({ queued: Schema.Boolean }),
      execute: Effect.fn("QueueOn.execute")(function* (target) {
        const ctx = yield* ExtensionContext
        yield* ctx.Session.send({
          delivery: "queue",
          ...target,
          sourceId: "addressed-test",
          content: "follow-up for the child",
        })
        return { queued: true }
      }),
    }),
    SendToSelf: request({
      id: "send-to-self",
      input: Schema.Struct({}),
      output: Schema.Struct({ refused: Schema.Boolean }),
      execute: Effect.fn("SendToSelf.execute")(function* () {
        const ctx = yield* ExtensionContext
        const result = yield* ctx.Session.send({
          delivery: "turn",
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          content: "loop on myself",
        }).pipe(Effect.exit)
        return { refused: Exit.isFailure(result) }
      }),
    }),
    SteerWithQueueField: request({
      id: "steer-with-queue-field",
      input: Target,
      output: Schema.Struct({ refused: Schema.Boolean }),
      execute: Effect.fn("SteerWithQueueField.execute")(function* (target) {
        const ctx = yield* ExtensionContext
        // A spread skips the literal's excess-property check, as untyped code does.
        const queueOnly = { sourceId: "wrong-mode" }
        const result = yield* ctx.Session.send({
          delivery: "steer",
          ...target,
          content: "carries a queue field",
          ...queueOnly,
        }).pipe(Effect.exit)
        return { refused: Exit.isFailure(result) }
      }),
    }),
    SteerInto: request({
      id: "steer-into",
      input: Target,
      output: Schema.Struct({ steered: Schema.Boolean }),
      execute: Effect.fn("SteerInto.execute")(function* (target) {
        const ctx = yield* ExtensionContext
        // The child is idle; without `wake` the message would park in its queue.
        yield* ctx.Session.send({
          delivery: "steer",
          ...target,
          content: "steered into the child",
          wake: true,
        })
        return { steered: true }
      }),
    }),
    Stop: request({
      id: "stop",
      input: Target,
      output: Schema.Struct({ stopped: Schema.Boolean }),
      execute: Effect.fn("Stop.execute")(function* (target) {
        const ctx = yield* ExtensionContext
        yield* ctx.Session.stop({ ...target, requestId: RequestId.make("addressed-stop") })
        return { stopped: true }
      }),
    }),
    Delete: request({
      id: "delete",
      input: Schema.Struct({ sessionId: SessionId }),
      output: Schema.Struct({ gone: Schema.Boolean }),
      execute: Effect.fn("Delete.execute")(function* (input) {
        const ctx = yield* ExtensionContext
        yield* ctx.Session.delete(input.sessionId)
        const after = yield* ctx.Session.getSession(input.sessionId)
        return { gone: Predicate.isUndefined(after) }
      }),
    }),
  })

  const extension = defineExtension({
    id: extensionId,
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* host.register("request", ...Object.values(Verbs))
    }),
  })

  type Harness = Effect.Success<ReturnType<typeof createRpcHarness>>
  const call = <I, A>(
    harness: Harness,
    capability: {
      readonly id: string
      readonly input: Schema.Codec<I, unknown>
      readonly output: Schema.Codec<A, unknown>
    },
    input: I,
  ) =>
    harness.client.extension
      .request({
        sessionId: harness.sessionId,
        branchId: harness.branchId,
        extensionId,
        capabilityId: capability.id,
        input,
      })
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(capability.output)))

  it.scopedLive(
    "a request creates, prompts, reads, queues on, steers into, stops, and deletes a child",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          textStep("parent answer"),
          textStep("child answer"),
          textStep("follow-up answer"),
          textStep("steered answer"),
        ])
        const harness = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          extensionInputs: [...e2ePreset.extensionInputs, extension],
        })
        // One parent turn, so the child has history to inherit.
        yield* harness.client.message.send({
          sessionId: harness.sessionId,
          branchId: harness.branchId,
          content: "hello parent",
        })

        const spawned = yield* call(harness, Verbs.Spawn, {
          requestId: "req-1",
          prompt: "do the thing",
        })
        expect(spawned.sessionId).not.toBe(harness.sessionId)
        // The parent's two visible rows were copied in before the child's prompt.
        expect(spawned.historyMessages).toBe(2)
        expect(spawned.completed).toBe(true)
        expect(spawned.answer).toBe("child answer")

        // The same requestId returns the same child: create is durable-once.
        const again = yield* call(harness, Verbs.Spawn, {
          requestId: "req-1",
          prompt: "do the thing",
        })
        expect(again.sessionId).toBe(spawned.sessionId)

        const child = { sessionId: spawned.sessionId, branchId: spawned.branchId }
        const queued = yield* call(harness, Verbs.QueueOn, child)
        expect(queued.queued).toBe(true)
        // The child is idle with history, so the follow-up runs as its next turn.
        const childMessages = yield* waitFor(
          harness.client.message.list(child),
          (messages) => messages.some((m) => m.id.includes("addressed-test")),
          5_000,
          "follow-up landed on the child",
        )
        // Inherited "hello parent", the prompt, and the follow-up.
        expect(childMessages.filter((m) => m.role === "user")).toHaveLength(3)

        const self = yield* call(harness, Verbs.SendToSelf, {})
        expect(self.refused).toBe(true)
        const mixed = yield* call(harness, Verbs.SteerWithQueueField, child)
        expect(mixed.refused).toBe(true)

        // Let the follow-up turn end, so the steered message wakes an idle child.
        yield* waitFor(
          harness.client.message.list(child),
          (messages) =>
            messages.some(
              (m) =>
                m.role === "assistant" && messagePartsDisplayText(m.parts) === "follow-up answer",
            ),
          5_000,
          "follow-up answered",
        )
        const steered = yield* call(harness, Verbs.SteerInto, child)
        expect(steered.steered).toBe(true)
        yield* waitFor(
          harness.client.message.list(child),
          (messages) =>
            messages.some(
              (m) =>
                m.role === "assistant" && messagePartsDisplayText(m.parts) === "steered answer",
            ),
          5_000,
          "steered message woke the child into a turn",
        )

        const stopped = yield* call(harness, Verbs.Stop, child)
        expect(stopped.stopped).toBe(true)
        // A target that does not exist is refused before any loop is opened for it.
        const phantom = yield* call(harness, Verbs.Stop, {
          sessionId: SessionId.make("no-such-session"),
          branchId: BranchId.make("no-such-branch"),
        }).pipe(Effect.exit)
        expect(Exit.isFailure(phantom)).toBe(true)
        if (Exit.isFailure(phantom)) {
          expect(Cause.pretty(phantom.cause)).toContain("Session not found: no-such-session")
        }

        const deleted = yield* call(harness, Verbs.Delete, { sessionId: child.sessionId })
        expect(deleted.gone).toBe(true)
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )
})

// ── turn projection hooks ────────────────────────────────────────────────────

/**
 * Explicit turn-projection hook regression locks.
 *
 * Locks the explicit turn-projection contract:
 *  - `hook("turnProjection", handler)` contributes prompt sections + tool policy
 *  - failures/defects are isolated so later extensions still run
 */

const hookCtx = {
  projection: { agent: testAgent },
  host: testExtensionHostContext({
    sessionId: SessionId.make("s"),
    branchId: BranchId.make("b"),
    cwd: "/tmp",
    home: "/nonexistent/gent-test-home",
  }),
}

const compile = (extensions: ReadonlyArray<LoadedExtension>) => compileExtensionHooks(extensions)

const hookExt = <E, R>(
  id: string,
  scope: "builtin" | "user" | "project",
  contribution: ExtensionHookHandler<"turnProjection", E, R>,
): LoadedExtension => ({
  manifest: { id: ExtensionId.make(id) },
  scope,
  sourcePath: `/test/${id}`,
  contributions: {
    hooks: [hook("turnProjection", contribution)],
  },
})

class HookBoom extends Data.TaggedError("@gent/core/tests/runtime/extension-host.test/HookBoom") {}

describe("turn projection hooks", () => {
  const test = it.live.layer(BunServices.layer)

  test("contribute prompt sections and tool policy in scope order", () =>
    Effect.gen(function* () {
      const compiled = compile([
        hookExt("builtin-hook", "builtin", () =>
          Effect.succeed({
            promptSections: [{ id: "shared", content: "builtin", priority: 50 }],
            toolPolicy: { include: ["builtin-tool"] },
          }),
        ),
        hookExt("project-hook", "project", () =>
          Effect.succeed({
            promptSections: [
              { id: "shared", content: "project", priority: 50 },
              { id: "project-only", content: "project-only", priority: 60 },
            ],
            toolPolicy: { modelSet: ["project-visible"] },
          }),
        ),
      ])

      const result = yield* compiled
        .resolveTurnProjection(hookCtx.projection)
        .pipe(Effect.provideService(CurrentExtensionHostContext, hookCtx.host))
      expect(result.promptSections).toEqual([
        { id: "shared", content: "project", priority: 50 },
        { id: "project-only", content: "project-only", priority: 60 },
      ])
      expect(result.policyFragments).toEqual([
        { include: ["builtin-tool"] },
        { modelSet: ["project-visible"] },
      ])
    }))

  test("failing hook is logged + skipped while later hooks continue", () =>
    Effect.gen(function* () {
      const compiled = compile([
        hookExt("bad-hook", "builtin", () => Effect.fail(new HookBoom())),
        hookExt("good-hook", "project", () =>
          Effect.succeed({
            promptSections: [{ id: "good", content: "still-runs", priority: 50 }],
            toolPolicy: { include: ["still-runs"] },
          }),
        ),
      ])

      const result = yield* compiled
        .resolveTurnProjection(hookCtx.projection)
        .pipe(Effect.provideService(CurrentExtensionHostContext, hookCtx.host))
      expect(result.promptSections).toEqual([{ id: "good", content: "still-runs", priority: 50 }])
      expect(result.policyFragments).toEqual([{ include: ["still-runs"] }])
    }))

  test("defecting hook is logged + skipped", () =>
    Effect.gen(function* () {
      const compiled = compile([
        hookExt("defect-hook", "builtin", () => Effect.die(new Error("defect"))),
        hookExt("good-hook", "project", () =>
          Effect.succeed({
            promptSections: [{ id: "good", content: "after-defect", priority: 50 }],
          }),
        ),
      ])

      const result = yield* compiled
        .resolveTurnProjection(hookCtx.projection)
        .pipe(Effect.provideService(CurrentExtensionHostContext, hookCtx.host))
      expect(result.promptSections).toEqual([{ id: "good", content: "after-defect", priority: 50 }])
      expect(result.policyFragments).toEqual([])
    }))

  test("empty hook result does not affect prompt sections or policy", () =>
    Effect.gen(function* () {
      const compiled = compile([hookExt("empty-hook", "builtin", () => Effect.succeed({}))])

      const result = yield* compiled
        .resolveTurnProjection(hookCtx.projection)
        .pipe(Effect.provideService(CurrentExtensionHostContext, hookCtx.host))
      expect(result.promptSections).toEqual([])
      expect(result.policyFragments).toEqual([])
    }))
})

// ── live session profiles ────────────────────────────────────────────────────

/** Profile behavior through the production live cache and child adapter. */

const sharedLayer = Layer.mergeAll(
  fsLayer,
  ConfigService.Test(),
  testSqliteStorage(() => Layer.empty, {}),
)

// Build a fresh production cache in the test's owning scope.
const openProfile = Effect.fn("RuntimeProfileTest.openProfile")(function* (
  inputs: RuntimeProfileInputs,
  // Only a test about a failing extension turns this off.
  failOnExtensionFailure = true,
) {
  const context = yield* Layer.build(
    SessionProfileCache.Live({ ...inputs, failOnExtensionFailure }),
  )
  const cache = Context.get(context, SessionProfileCache)
  const profile = yield* cache.resolve(inputs.cwd)
  return { ...profile, profile }
})

// Dynamic prompt section: the hook Effect yields a service from the
// extension's Resource layer. The service Tag is `ReadOnly`-branded so the
// prompt hook only receives a read surface.
interface FakeProviderApi {
  readonly text: () => string
}
class FakeProvider extends Context.Service<FakeProvider, FakeProviderApi>()(
  "@gent/core/tests/runtime/extension-host.test/FakeProvider",
) {}

interface ScopedProbeApi {
  readonly instance: number
}
class ScopedProbe extends Context.Service<ScopedProbe, ScopedProbeApi>()(
  "@gent/core/tests/runtime/extension-host.test/ScopedProbe",
) {}

interface PureProbeApi {
  readonly value: string
}
class PureProbe extends Context.Service<PureProbe, PureProbeApi>()(
  "@gent/core/tests/runtime/extension-host.test/PureProbe",
) {}

interface PrecedenceProbeApi {
  readonly value: string
}
class PrecedenceProbe extends Context.Service<PrecedenceProbe, PrecedenceProbeApi>()(
  "@gent/core/tests/runtime/extension-host.test/PrecedenceProbe",
) {}

const fakeProviderLive = Layer.succeed(FakeProvider, {
  text: () => "dynamic-from-service",
} satisfies FakeProviderApi)

const dynamicExtension = defineExtension({
  id: "@gent/test-runtime-profile-dynamic",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register(
      "resource",
      defineResource({
        id: "test/runtime-profile/fake-provider",
        scope: "process",
        layer: fakeProviderLive,
      }),
    )
    yield* host.on("turnProjection", () =>
      Effect.gen(function* () {
        const fp = yield* FakeProvider
        return {
          promptSections: [{ id: "rp-dynamic-section", priority: 60, content: fp.text() }],
        }
      }),
    )
  }),
})

describe("live Profile", () => {
  const test = it.live.layer(BunServices.layer)

  test("loads declarations without building resource layers before boot activation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.makeTempDirectoryScoped()
        let nextInstance = 0
        const events: Array<readonly [string, number]> = []

        const resourceExtension = defineExtension({
          id: "@gent/test-runtime-profile/declaration-resource",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register(
              "resource",
              // oxlint-disable-next-line effect/noAs -- The contribution array intentionally erases a resource's private service and scope types.
              defineResource({
                id: "test/runtime-profile/declaration-resource",
                scope: "process",
                layer: Layer.effect(
                  ScopedProbe,
                  Effect.acquireRelease(
                    Effect.sync(() => {
                      const instance = ++nextInstance
                      events.push(["acquire", instance])
                      return ScopedProbe.of({ instance })
                    }),
                    (probe) => Effect.sync(() => events.push(["release", probe.instance])),
                  ),
                ),
              }) as never,
            )
          }),
        })
        const validTool = tool({
          id: "rp-declaration-collision",
          description: "valid collision fixture",
          params: S.Struct({}),
          output: S.String,
          execute: () => Effect.succeed("ok"),
        })
        const invalidTool = tool({
          id: "rp-declaration-collision",
          description: "invalid collision fixture",
          params: S.Struct({}),
          output: S.String,
          execute: () => Effect.succeed("ok"),
        })
        const validExtension = defineExtension({
          id: "@gent/test-runtime-profile/declaration-valid",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("tool", validTool)
          }),
        })
        const invalidExtension = defineExtension({
          id: "@gent/test-runtime-profile/declaration-invalid",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("tool", invalidTool)
          }),
        })
        const inputs = {
          cwd: home,
          home,
          platform: "darwin",
          extensions: [resourceExtension, validExtension, invalidExtension],
        }
        const declarations = yield* loadRuntimeProfileDeclarations(
          inputs,
          yield* scanRuntimeProfileExtensions(inputs),
        )
        expect(events).toEqual([])
        expect(declarations.extensionDeclarations.failed).toContainEqual(
          expect.objectContaining({
            manifest: { id: "@gent/test-runtime-profile/declaration-invalid" },
            phase: "validation",
          }),
        )

        // The collision is the subject, so the build keeps going past it.
        const runtimeExit = yield* Effect.exit(Effect.scoped(openProfile(inputs, false)))
        expect(runtimeExit._tag).toBe("Success")
        if (runtimeExit._tag === "Success") {
          expect(runtimeExit.value.profile.resolved.failedExtensions).toContainEqual(
            expect.objectContaining({
              manifest: { id: "@gent/test-runtime-profile/declaration-invalid" },
              phase: "validation",
            }),
          )
        }
        expect(events).toEqual([
          ["acquire", 1],
          ["release", 1],
        ])
      }),
    ).pipe(Effect.provide(sharedLayer)))

  test("a user extension that fails to import reaches extension health", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* fs.makeTempDirectoryScoped()
        const dir = path.join(home, ".gent", "extensions")
        yield* fs.makeDirectory(path.join(dir, "folder-broken"), { recursive: true })
        yield* fs.writeFileString(path.join(dir, "broken.ts"), "export const = ;\n")
        yield* fs.writeFileString(
          path.join(dir, "folder-broken", "index.ts"),
          "export const notAnExtension = 1\n",
        )
        // An untrusted project directory fails its files the same way.
        const cwd = path.join(home, "project")
        const projectDir = path.join(cwd, ".gent", "extensions")
        yield* fs.makeDirectory(projectDir, { recursive: true })
        yield* fs.writeFileString(path.join(projectDir, "local.ts"), "export default 1\n")
        const inputs = { cwd, home, platform: "darwin", extensions: [] }

        const declarations = yield* loadRuntimeProfileDeclarations(
          inputs,
          yield* scanRuntimeProfileExtensions(inputs),
        )
        expect(declarations.extensionDeclarations.failed).toEqual([
          expect.objectContaining({
            manifest: { id: "broken" },
            scope: "user",
            sourcePath: path.join(dir, "broken.ts"),
            phase: "load",
          }),
          expect.objectContaining({
            manifest: { id: "folder-broken" },
            scope: "user",
            phase: "load",
          }),
          expect.objectContaining({
            manifest: { id: "local" },
            scope: "project",
            phase: "load",
            error: expect.stringContaining("not trusted"),
          }),
        ])

        // A disabled id silences its file.
        const quiet = yield* loadRuntimeProfileDeclarations(
          { ...inputs, disabledExtensions: ["broken", "folder-broken", "local"] },
          yield* scanRuntimeProfileExtensions(inputs),
        )
        expect(quiet.extensionDeclarations.failed).toEqual([])

        // A test root that fails on a failed extension sees the import failure too.
        const strict = yield* Effect.exit(Effect.scoped(openProfile(inputs)))
        expect(strict._tag).toBe("Failure")
      }),
    ).pipe(Effect.provide(sharedLayer)))

  test("live Profile builds a process resource layer once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let starts = 0
        const extension = defineExtension({
          id: "@gent/test-runtime-profile-start-once",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register(
              "resource",
              // oxlint-disable-next-line effect/noAs -- The contribution array intentionally erases a resource's private service and scope types.
              defineResource({
                id: "test/runtime-profile/start-once",
                scope: "process",
                layer: Layer.effectDiscard(
                  Effect.sync(() => {
                    starts += 1
                  }),
                ),
              }) as never,
            )
          }),
        })

        yield* openProfile({
          cwd: "/tmp",
          home: "/nonexistent/gent-test-home",
          platform: "darwin",
          extensions: [extension],
        })

        expect(starts).toBe(1)
      }),
    ).pipe(Effect.provide(sharedLayer)))

  test("live Profile preserves one scoped resource instance for hooks and shutdown", () =>
    Effect.gen(function* () {
      let nextInstance = 0
      const events: Array<readonly [string, number]> = []
      const extension = defineExtension({
        id: "@gent/test-runtime-profile-resource-identity",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            // oxlint-disable-next-line effect/noAs -- The contribution array intentionally erases a resource's private service and scope types.
            defineResource({
              id: "test/runtime-profile/resource-identity",
              scope: "process",
              layer: Layer.effect(
                ScopedProbe,
                Effect.acquireRelease(
                  Effect.sync(() => {
                    const instance = ++nextInstance
                    events.push(["acquire", instance])
                    return ScopedProbe.of({ instance })
                  }),
                  (probe) => Effect.sync(() => events.push(["release", probe.instance])),
                ),
              ),
            }) as never,
            // oxlint-disable-next-line effect/noAs -- The contribution array intentionally erases a resource's private service and scope types.
            defineResource({
              id: "test/runtime-profile/resource-identity/pure",
              scope: "process",
              layer: Layer.succeed(PureProbe, { value: "pure" } satisfies PureProbeApi),
            }) as never,
          )
          yield* host.on("turnProjection", () =>
            Effect.gen(function* () {
              const probe = yield* ScopedProbe
              const pureProbe = yield* PureProbe
              events.push(["capability", probe.instance])
              return {
                promptSections: [{ id: "pure-probe", priority: 1, content: pureProbe.value }],
              }
            }),
          )
        }),
      })

      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* openProfile({
              cwd: "/tmp",
              home: "/nonexistent/gent-test-home",
              platform: "darwin",
              extensions: [extension],
            })

            const hookCtx = {
              projection: {
                sessionId: SessionId.make("s"),
                branchId: BranchId.make("b"),
                agent: testAgent,
                agentName: AgentName.make("cowork"),
                allTools: [],
              },
              host: testExtensionHostContext({
                sessionId: SessionId.make("s"),
                branchId: BranchId.make("b"),
                cwd: "/tmp",
                home: "/nonexistent/gent-test-home",
              }),
            }

            // The turn provides the profile's layer context, which carries the
            // built process resources, exactly as the agent loop does.
            const result = yield* runtime.registryService
              .getResolved()
              .extensionHooks.resolveTurnProjection(hookCtx.projection)
              .pipe(
                Effect.provideService(CurrentExtensionHostContext, hookCtx.host),
                Effect.provideContext(runtime.layerContext),
              )
            expect(result.promptSections).toEqual([
              { id: "pure-probe", priority: 1, content: "pure" },
            ])
            expect(events).toEqual([
              ["acquire", 1],
              ["capability", 1],
            ])
          }),
        ),
      )

      expect(exit._tag).toBe("Success")
      expect(events).toEqual([
        ["acquire", 1],
        ["capability", 1],
        ["release", 1],
      ])
    }).pipe(Effect.provide(sharedLayer)))

  test("resource assembly follows resolved extension order for acquired and pure services", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let starts = 0
        const activatedExtension = defineExtension({
          id: "@gent/test-runtime-profile-precedence/activated",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register(
              "resource",
              // oxlint-disable-next-line effect/noAs -- The contribution array intentionally erases a resource's private service and scope types.
              defineResource({
                id: "test/runtime-profile/precedence/activated",
                scope: "process",
                layer: Layer.effect(
                  PrecedenceProbe,
                  Effect.sync(() => {
                    starts += 1
                    return { value: "activated" } satisfies PrecedenceProbeApi
                  }),
                ),
              }) as never,
            )
          }),
        })
        const pureExtension = defineExtension({
          id: "@gent/test-runtime-profile-precedence/pure",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register(
              "resource",
              // oxlint-disable-next-line effect/noAs -- The contribution array intentionally erases a resource's private service and scope types.
              defineResource({
                id: "test/runtime-profile/precedence/pure",
                scope: "process",
                layer: Layer.succeed(PrecedenceProbe, {
                  value: "pure",
                } satisfies PrecedenceProbeApi),
              }) as never,
            )
          }),
        })

        for (const { extensions, expected } of [
          { extensions: [activatedExtension, pureExtension], expected: "pure" },
          { extensions: [pureExtension, activatedExtension], expected: "pure" },
        ]) {
          const runtime = yield* openProfile({
            cwd: "/tmp",
            home: "/nonexistent/gent-test-home",
            platform: "darwin",
            extensions,
          })
          expect(Context.get(runtime.layerContext, PrecedenceProbe).value).toBe(expected)
        }

        expect(starts).toBe(2)
      }),
    ).pipe(Effect.provide(sharedLayer)))

  test("resource-backed turnProjection resolves through the profile registry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layerContext } = yield* openProfile({
          cwd: "/tmp",
          home: "/nonexistent/gent-test-home",
          platform: "darwin",
          extensions: [dynamicExtension],
        })
        const registryService = Context.get(layerContext, ExtensionRegistry)

        const hookCtx = {
          projection: {
            sessionId: SessionId.make("s"),
            branchId: BranchId.make("b"),
            agent: testAgent,
            agentName: AgentName.make("cowork"),
            allTools: [],
          },
          host: testExtensionHostContext({
            sessionId: SessionId.make("s"),
            branchId: BranchId.make("b"),
            cwd: "/tmp",
            home: "/nonexistent/gent-test-home",
          }),
        }
        const result = yield* registryService
          .getResolved()
          .extensionHooks.resolveTurnProjection(hookCtx.projection)
          .pipe(
            Effect.provideService(CurrentExtensionHostContext, hookCtx.host),
            Effect.provideContext(layerContext),
          )

        expect(result.promptSections).toContainEqual({
          id: "rp-dynamic-section",
          priority: 60,
          content: "dynamic-from-service",
        })
      }),
    ).pipe(Effect.provide(sharedLayer)))
})
