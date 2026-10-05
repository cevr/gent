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
import * as EffectAiEntry from "effect/ai"
import * as EffectAiErrorEntry from "effect/ai/AiError"
import * as EffectResponseEntry from "effect/ai/Response"
import * as EffectEncodingEntry from "effect/encoding"
import * as EffectHttpEntry from "effect/http"
import * as EffectHttpClientErrorEntry from "effect/http/HttpClientError"
import * as EffectProcessEntry from "effect/process"
import * as EffectChildProcessSpawnerEntry from "effect/process/ChildProcessSpawner"
import * as EffectSqlEntry from "effect/sql"
import { describe, expect, it, test } from "effect-bun-test"
import * as ExtensionApiEntry from "../../src/extensions/api"
import * as BranchToolsEntry from "../../src/extensions/branch-tools"
import {
  createE2ELayer,
  createRpcClient,
  createRpcHarness,
  registerContributions,
  runToolWithCtx,
  recordingEventStore,
  testExtensionHostContext,
  testHostFacts,
  testToolContext,
  ensureStorageParents,
  fixedSessionProfiles,
  fixtureModelCatalog,
  fixtureModelCatalogSource,
  testSqliteStorage,
  testTurnExtension,
} from "../../src/test-utils/harness"
import { BunChildProcessSpawner, BunCrypto, BunFileSystem, BunServices } from "@effect/platform-bun"
import { BunGentPlatformLive, BunPlatformLive } from "../../src/runtime/gent-platform-bun"
import {
  defineExtension,
  defineRequests,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  ExtensionStatus,
  type GentExtension,
  getToolId,
  request,
  tool,
  type ToolCapability,
} from "@gent/core/extensions/api"
import { TestClock } from "effect/testing"
import {
  ApprovalService,
  buildScopeResources,
  compileExtensionHooks,
  configHealthStatuses,
  CurrentExtensionHostContext,
  type DiscoveredExtension,
  ExtensionRegistry,
  makeExtensionHostContextProvider,
  provideCurrentCapabilityContext,
  provideCurrentHostCtx,
  resolveExtensions,
  resolveTurnProfile,
  RunOpener,
  sessionWorkingDirectory,
  SESSION_DELETED_HOOK_TIMEOUT,
  type SessionProfile,
  SessionProfileCache,
  type SessionProfileCacheService,
  setupExtension,
  setupExtensions,
  validateLoadedExtensions,
  loadRuntimeProfileDeclarations,
  makeModuleGraphs,
  scanRuntimeProfileExtensions,
  type RuntimeProfileInputs,
  extensionEntryModules,
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
  BranchStorage,
} from "../../src/storage/storage"
import { StorageError } from "../../src/domain/errors"
import { workspaceIdForCwd } from "../../src/server/workspace-rpc"
import {
  CurrentWorkspaceId,
  WorkspaceId,
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
  type Message,
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
import { Decision, DecisionModel, Model as AiModel, type LanguageModel } from "effect/ai"
import {
  Auth,
  DecisionModelResolver,
  listModelCatalog,
  finishPart,
  ModelRegistry,
  textDeltaPart,
  textStep,
  toolCallStep,
} from "../../src/runtime/provider"
import { LanguageModelLayers, turnRequestText, waitFor } from "../../src/test-utils/language-model"
import {
  AgentDefinition,
  AgentName,
  DEFAULT_AGENT_NAME,
  Model,
  ModelId,
  ProviderId,
} from "../../src/domain/agent"
import * as AiTool from "effect/ai/Tool"
import * as Prompt from "effect/ai/Prompt"
import {
  bindRequestCapabilityExtension,
  CapabilityError,
  type RequestCapability,
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
  type SystemPromptInput,
  sortExtensionsByScope,
  type TurnAfterInput,
  type ExtensionHookHandler,
} from "../../src/domain/extension"
import { attachToolBindingIdentity, ToolRunner } from "../../src/runtime/tools"
import { SingleRunner } from "effect/cluster"
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
    models: testExtensionHostContext().Models,
  })
  return provider.forRun({ sessionId, branchId, interactive: true, clientRequest: Option.none() })
}).pipe(
  Effect.provide(
    RuntimeEnvironment.Live({
      cwd: "/nonexistent/gent-test-cwd",
      home: "/nonexistent/gent-test-home",
    }),
  ),
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
    }).pipe(Effect.provide(Layer.mergeAll(testSqliteStorage, EventStore.Memory))),
  )

  it.live("a session read lands in the workspace the run was built under, not the caller's", () =>
    Effect.gen(function* () {
      const runWorkspace = workspaceIdForCwd("/nonexistent/run-workspace")
      const otherWorkspace = workspaceIdForCwd("/nonexistent/other-workspace")
      const storage = yield* SessionStorage
      // The session exists only in the workspace the run was opened under.
      yield* storage
        .createSession(
          new Session({
            id: sessionId,
            name: "pinned",
            cwd: "/nonexistent/run-workspace",
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
    }).pipe(Effect.provide(testSqliteStorage)),
  )

  it.scopedLive(
    "an event replay lands in the workspace the run was built under, not the puller's",
    () =>
      Effect.gen(function* () {
        const runWorkspace = workspaceIdForCwd("/nonexistent/run-workspace")
        const otherWorkspace = workspaceIdForCwd("/nonexistent/other-workspace")
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
        Effect.provide(Layer.provideMerge(EventStoreLive, testSqliteStorage)),
      ),
  )

  it.scopedLive("a subscription from now replays no history, then delivers new events", () =>
    Effect.gen(function* () {
      const workspace = workspaceIdForCwd("/nonexistent/run-workspace")
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
    }).pipe(Effect.provide(Layer.provideMerge(EventStoreLive, testSqliteStorage))),
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
  /** Wraps the file system the cache reads, for a test that counts its reads. */
  readonly wrapFileSystem?: (live: FileSystem.FileSystem) => FileSystem.FileSystem
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
      Layer.mergeAll(
        BunServices.layer,
        SqliteStorage.MemoryWithSql.pipe(Layer.provide(BunPlatformLive)),
        // A later layer's service wins: the wrapped file system, when given.
        Option.match(Option.fromUndefinedOr(params.wrapFileSystem), {
          onNone: () => Layer.empty,
          onSome: (wrap) =>
            Layer.effect(
              FileSystem.FileSystem,
              Effect.map(Effect.service(FileSystem.FileSystem), wrap),
            ).pipe(Layer.provide(BunServices.layer)),
        }),
      ),
    ),
    Layer.provideMerge(configLive),
  )
}

/**
 * A user directory extension whose process Resource serves the `value` a
 * relative module exports, and a writer for that module.
 */
const graphExtensionFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-profile-graph-" })
  const home = path.join(directory, "home")
  const launch = path.join(directory, "launch")
  const extensionDir = path.join(home, ".gent", "extensions", "graph")
  const index = path.join(extensionDir, "index.ts")
  const valueModule = path.join(extensionDir, "value.ts")
  yield* fs.makeDirectory(extensionDir, { recursive: true })
  yield* fs.makeDirectory(launch, { recursive: true })
  yield* writeFileAtomic(
    index,
    `import { Context, Effect, Layer } from "effect";
import { defineExtension, defineResource, ExtensionHost } from "@gent/core/extensions/api";
import { value } from "./value.ts";
class Marker extends Context.Service<Marker, { readonly value: string }>()(
  "@gent/core/tests/runtime/extension-host.test/SessionProfileResourceMarker",
) {}
export default defineExtension({
  id: "profile-graph",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost;
    yield* host.register("resource", defineResource({
      id: "profile-graph/marker",
      scope: "process",
      layer: Layer.succeed(Marker, Marker.of({ value })),
    }));
  }),
});
`,
  )
  return {
    home,
    launch,
    extensionDir,
    index,
    // Replaced, as gent and most editors save: a new inode and mtime.
    writeValue: (value: string) =>
      writeFileAtomic(valueModule, `export const value = "${value}";\n`).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      ),
    marker: (profile: SessionProfile) =>
      Context.get(profile.layerContext, SessionProfileResourceMarker).value,
  }
})

/** A user extensions directory for `chainSource` files, and what their Resources serve. */
const chainFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-profile-chain-" })
  const home = path.join(directory, "home")
  const launch = path.join(directory, "launch")
  const extensionsDir = path.join(home, ".gent", "extensions")
  yield* fs.makeDirectory(extensionsDir, { recursive: true })
  yield* fs.makeDirectory(launch, { recursive: true })
  const file = (name: string) => path.join(extensionsDir, `${name}.ts`)
  return {
    home,
    launch,
    write: (name: string, source: string) => writeFileAtomic(file(name), source),
    remove: (name: string) => fs.remove(file(name), { force: true }),
    seen: (profile: SessionProfile) => Context.get(profile.layerContext, ChainDependent).seen(),
  }
})

/** The service `chainSource.a` serves: its label, and whether its scope closed. */
class ChainService extends Context.Service<
  ChainService,
  { readonly value: string; readonly closed: () => boolean }
>()("@gent/core/tests/runtime/extension-host.test/ChainService") {}

/** The service B serves: what it read from A's service when it was built. */
class ChainDependent extends Context.Service<
  ChainDependent,
  { readonly seen: () => { readonly value: string; readonly closed: boolean } }
>()("@gent/core/tests/runtime/extension-host.test/ChainDependent") {}

/**
 * User extension files for a chain of process Resources. `a` serves
 * `ChainService` labelled `value`, or dies at setup or startup when `value`
 * is `setup` or `startup`, and may register a tool. `b` serves `ChainDependent` over `a`'s
 * service. `c` registers only a tool.
 */
const chainSource = {
  a: (value: string, toolId = "") =>
    `import { Context, Effect, Layer, Schema } from "effect";
import { defineExtension, defineResource, ExtensionHost, tool } from "@gent/core/extensions/api";
class ChainService extends Context.Service<ChainService, { readonly value: string; readonly closed: () => boolean }>()(
  "@gent/core/tests/runtime/extension-host.test/ChainService",
) {}
export default defineExtension({
  id: "chain-a",
  setup: Effect.gen(function* () {
    ${chainSetupFailure(value)}
    const host = yield* ExtensionHost;
    ${chainToolRegistration(toolId)}
    yield* host.register("resource", defineResource({
      id: "chain-a/service",
      scope: "process",
      layer: ${chainServiceLayer(value)},
    }));
  }),
});
`,
  b: `import { Context, Effect, Layer } from "effect";
import { defineExtension, defineResource, ExtensionHost } from "@gent/core/extensions/api";
class ChainService extends Context.Service<ChainService, { readonly value: string; readonly closed: () => boolean }>()(
  "@gent/core/tests/runtime/extension-host.test/ChainService",
) {}
class ChainDependent extends Context.Service<ChainDependent, { readonly seen: () => { readonly value: string; readonly closed: boolean } }>()(
  "@gent/core/tests/runtime/extension-host.test/ChainDependent",
) {}
export default defineExtension({
  id: "chain-b",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost;
    yield* host.register("resource", defineResource({
      id: "chain-b/dependent",
      scope: "process",
      layer: Layer.effect(ChainDependent, Effect.gen(function* () {
        const a = yield* ChainService;
        return ChainDependent.of({ seen: () => ({ value: a.value, closed: a.closed() }) });
      })),
    }));
  }),
});
`,
  c: (toolId: string) => `import { Effect, Schema } from "effect";
import { defineExtension, ExtensionHost, tool } from "@gent/core/extensions/api";
export default defineExtension({
  id: "chain-c",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost;
    ${chainToolRegistration(toolId)}
  }),
});
`,
}

/**
 * One extension file for the user and the project scope alike: id `swap`, a
 * process Resource that keeps one file in `marks` while it lives, or that
 * dies at startup when `value` is `startup`. The same value is the same code,
 * so the same version, in either scope.
 */
function swapSource(value: string, marks: string): string {
  let layer = `Layer.effect(Swap, Effect.gen(function* () {
        const mark = join(${encodeJson(marks)}, randomUUID());
        writeFileSync(mark, "");
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(mark)));
        return Swap.of({ value: "${value}" });
      }))`
  if (value === "startup") layer = 'Layer.effect(Swap, Effect.die("startup broke"))'
  return `import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { defineExtension, defineResource, ExtensionHost } from "@gent/core/extensions/api";
class Swap extends Context.Service<Swap, { readonly value: string }>()(
  "@gent/core/tests/runtime/extension-host.test/Swap",
) {}
export default defineExtension({
  id: "swap",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost;
    yield* host.register("resource", defineResource({
      id: "swap/service",
      scope: "process",
      layer: ${layer},
    }));
  }),
});
`
}

function chainSetupFailure(value: string): string {
  if (value === "setup") return 'yield* Effect.die("setup broke");'
  return ""
}

function chainServiceLayer(value: string): string {
  if (value === "startup") return 'Layer.effect(ChainService, Effect.die("startup broke"))'
  return `Layer.effect(ChainService, Effect.gen(function* () {
        const state = { closed: false };
        yield* Effect.addFinalizer(() => Effect.sync(() => { state.closed = true; }));
        return ChainService.of({ value: "${value}", closed: () => state.closed });
      }))`
}

function chainToolRegistration(toolId: string): string {
  if (toolId.length === 0) return ""
  return `yield* host.register("tool", tool({
      id: "${toolId}",
      description: "A chain tool",
      params: Schema.Struct({}),
      output: Schema.String,
      execute: () => Effect.succeed("${toolId}"),
    }));`
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

/** A user extension file that registers `ids` as tools; `reply` is their body. */
const probeSource = (
  reply: string,
  ids: ReadonlyArray<string>,
  surface: { readonly output?: string; readonly guideline?: string } = {},
) =>
  [
    'import { Effect, Schema } from "effect";',
    'import { defineExtension, ExtensionHost, tool } from "@gent/core/extensions/api";',
    "const probe = (id) =>",
    "  tool({",
    "    id,",
    "    description: `Probe ${id}`,",
    "    params: Schema.Struct({ text: Schema.String }),",
    `    output: ${Option.getOrElse(Option.fromUndefinedOr(surface.output), () => "Schema.String")},`,
    ...Option.match(Option.fromUndefinedOr(surface.guideline), {
      onNone: () => [],
      onSome: (guideline) => [`    promptGuidelines: [${encodeJson(guideline)}],`],
    }),
    `    execute: () => Effect.succeed(${encodeJson(reply)}),`,
    "  });",
    "export default defineExtension({",
    '  id: "@test/probe",',
    "  setup: Effect.gen(function* () {",
    "    const host = yield* ExtensionHost;",
    ...ids.map((id) => `    yield* host.register("tool", probe(${encodeJson(id)}));`),
    "  }),",
    "});",
    "",
  ].join("\n")

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

  it.scopedLive("a user tool's binding names its file version: an edit changes it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-binding-version-" })
      const home = path.join(directory, "home")
      const launch = path.join(directory, "launch")
      const entry = path.join(home, ".gent", "extensions", "probe.ts")
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true })
      yield* fs.makeDirectory(launch, { recursive: true })
      const bindingOf = Effect.fn("test.bindingOf")(function* () {
        const profile = yield* Effect.scoped((yield* SessionProfileCache).resolve(launch))
        const tool = profile.registryService.getResolved().modelCapabilities.get("probe_one")
        if (Predicate.isUndefined(tool)) return yield* Effect.die("probe_one is not registered")
        const attached = yield* attachToolBindingIdentity(tool)
        if (Predicate.isUndefined(attached.binding)) return yield* Effect.die("no binding")
        return attached.binding
      })

      yield* Effect.gen(function* () {
        yield* writeFileAtomic(entry, probeSource("v1", ["probe_one"]))
        const first = yield* bindingOf()
        expect(first.source._tag).toBe("Static")
        expect(yield* bindingOf()).toEqual(first)

        yield* writeFileAtomic(entry, probeSource("v2", ["probe_one"]))
        const edited = yield* bindingOf()
        expect(edited.source._tag).toBe("Static")
        expect(edited.source.sourceRevision).not.toBe(first.source.sourceRevision)
        expect(edited.schemaRevision).toBe(first.schemaRevision)
      }).pipe(
        Effect.provide(makeCacheLayer({ cwd: launch, home, extensions: [] })),
        Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("7".repeat(64))),
      )
    }).pipe(Effect.provide(Layer.merge(BunPlatformLive, BunGentPlatformLive))),
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

  // An extension's version is the content of every file it builds from: an
  // edit to a module it imports by a relative path is a new version, and a
  // save of the same bytes is not.
  it.scopedLive(
    "an edit to a relative module reaches the next resolve and a save of the same bytes builds nothing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const fixture = yield* graphExtensionFixture
        const bundles = yield* Ref.make(0)
        const reads = yield* Ref.make(0)

        yield* Effect.gen(function* () {
          const cache = yield* SessionProfileCache
          const resolve = Effect.scoped(cache.resolve(fixture.launch))
          yield* fixture.writeValue("first")
          const first = yield* resolve
          expect(fixture.marker(first)).toBe("first")

          const beforeEdit = yield* Ref.get(bundles)
          yield* fixture.writeValue("second")
          const second = yield* resolve
          expect(fixture.marker(second)).toBe("second")
          expect(yield* Ref.get(bundles)).toBeGreaterThan(beforeEdit)

          // The same bytes, saved again: the same version, so the same
          // profile, and no build.
          const built = yield* Ref.get(bundles)
          yield* fixture.writeValue("second")
          expect(yield* resolve).toBe(second)
          const indexText = yield* fs.readFileString(fixture.index)
          yield* writeFileAtomic(fixture.index, indexText)
          expect(yield* resolve).toBe(second)
          expect(yield* Ref.get(bundles)).toBe(built)

          // Nothing touched: a stat of each input, no read and no build.
          const readsBefore = yield* Ref.get(reads)
          expect(yield* resolve).toBe(second)
          expect(yield* Ref.get(reads)).toBe(readsBefore)
          expect(yield* Ref.get(bundles)).toBe(built)
        }).pipe(
          Effect.timeout("15 seconds"),
          Effect.provide(
            makeCacheLayer({
              cwd: fixture.launch,
              home: fixture.home,
              extensions: [],
              // Counts the reads of the extension's own files.
              wrapFileSystem: (live) => ({
                ...live,
                readFile: (file) => {
                  const counted = file.startsWith(fixture.extensionDir)
                  return Effect.andThen(
                    Ref.update(reads, (n) => n + Number(counted)),
                    live.readFile(file),
                  )
                },
              }),
            }),
          ),
          Effect.updateService(GentPlatform, (live) =>
            GentPlatform.of({
              ...live,
              bundleModule: (entry) =>
                live.bundleModule(entry).pipe(Effect.tap(() => Ref.update(bundles, (n) => n + 1))),
            }),
          ),
          Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("7".repeat(64))),
        )
      }).pipe(Effect.provide(BunPlatformLive)),
  )

  // An editor can save while a build reads the files. The build then holds
  // other bytes than the files; the next resolve must not keep it as the new
  // version, also when the save is undone before the build ends.
  it.scopedLive("a save during a build reaches the next resolve", () =>
    Effect.gen(function* () {
      const fixture = yield* graphExtensionFixture
      // Saves that land as a build starts and as it ends.
      const duringBuild = yield* Ref.make(
        Option.none<{ readonly start: Effect.Effect<void>; readonly end: Effect.Effect<void> }>(),
      )
      const save = (value: string) => fixture.writeValue(value).pipe(Effect.orDie)

      yield* Effect.gen(function* () {
        const cache = yield* SessionProfileCache
        const resolve = Effect.scoped(cache.resolve(fixture.launch))
        yield* fixture.writeValue("first")
        expect(fixture.marker(yield* resolve)).toBe("first")

        // The build reads "second"; the save of "third" lands before the
        // build ends.
        yield* Ref.set(duringBuild, Option.some({ start: Effect.void, end: save("third") }))
        yield* fixture.writeValue("second")
        yield* resolve
        expect(Option.isNone(yield* Ref.get(duringBuild))).toBe(true)
        expect(fixture.marker(yield* resolve)).toBe("third")
        expect(fixture.marker(yield* resolve)).toBe("third")

        // A save that comes and goes: the build reads "passing", and
        // "fourth" is back before it ends, with the bytes it had before.
        yield* fixture.writeValue("fourth")
        yield* Ref.set(duringBuild, Option.some({ start: save("passing"), end: save("fourth") }))
        yield* resolve
        expect(Option.isNone(yield* Ref.get(duringBuild))).toBe(true)
        expect(fixture.marker(yield* resolve)).toBe("fourth")
        expect(fixture.marker(yield* resolve)).toBe("fourth")
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.provide(makeCacheLayer({ cwd: fixture.launch, home: fixture.home, extensions: [] })),
        Effect.updateService(GentPlatform, (live) =>
          GentPlatform.of({
            ...live,
            bundleModule: (entry) =>
              Effect.gen(function* () {
                const saves = yield* Ref.getAndSet(duringBuild, Option.none())
                yield* Option.match(saves, { onNone: () => Effect.void, onSome: (s) => s.start })
                const built = yield* live.bundleModule(entry)
                yield* Option.match(saves, { onNone: () => Effect.void, onSome: (s) => s.end })
                return built
              }),
          }),
        ),
        Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("7".repeat(64))),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )

  // A new version that fails to load, set up or start keeps the last good
  // version running, reported with why the new one failed. A deleted file
  // and a disabled id are removals: nothing is kept after them.
  it.scopedLive(
    "a broken edit keeps the last good version, and a delete or a disable removes it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-profile-last-good-" })
        const home = path.join(directory, "home")
        const launch = path.join(directory, "launch")
        const entry = path.join(home, ".gent", "extensions", "probe.ts")
        const userConfig = path.join(home, ".gent", "config.json")
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true })
        yield* fs.makeDirectory(launch, { recursive: true })
        const write = (version: "good" | "load" | "setup" | "startup", value: string) => {
          if (version === "load") return writeFileAtomic(entry, "export const = ;\n")
          let setup = "Effect.void"
          let layer = `Layer.succeed(Marker, Marker.of({ value: "${value}" }))`
          if (version === "setup") setup = `Effect.die("setup broke")`
          if (version === "startup") layer = `Layer.effect(Marker, Effect.die("startup broke"))`
          return writeFileAtomic(
            entry,
            `import { Context, Effect, Layer } from "effect";
import { defineExtension, defineResource, ExtensionHost } from "@gent/core/extensions/api";
class Marker extends Context.Service<Marker, { readonly value: string }>()(
  "@gent/core/tests/runtime/extension-host.test/SessionProfileResourceMarker",
) {}
export default defineExtension({
  id: "profile-last-good",
  setup: Effect.gen(function* () {
    yield* ${setup};
    const host = yield* ExtensionHost;
    yield* host.register("resource", defineResource({
      id: "profile-last-good/marker",
      scope: "process",
      layer: ${layer},
    }));
  }),
});
`,
          )
        }
        const marker = (profile: SessionProfile) =>
          Context.getOption(profile.layerContext, SessionProfileResourceMarker).pipe(
            Option.map((service) => service.value),
          )
        const status = (profile: SessionProfile) =>
          profile.resolved.extensionStatuses.find(
            (info) => info.manifest.id === "profile-last-good" || info.sourcePath === entry,
          )

        yield* Effect.gen(function* () {
          const cache = yield* SessionProfileCache
          const resolve = Effect.scoped(cache.resolve(launch))
          yield* write("good", "first")
          const first = yield* resolve
          expect(marker(first)).toEqual(Option.some("first"))
          const firstStatus = status(first)
          if (firstStatus?.status !== "active") return expect.unreachable()
          expect(firstStatus.reloadFailed).toBeUndefined()

          for (const phase of ["load", "setup", "startup"] as const) {
            yield* write(phase, "never runs")
            const kept = yield* resolve
            expect(marker(kept)).toEqual(Option.some("first"))
            expect(kept.resolved.failedExtensions).toEqual([])
            expect(status(kept)).toMatchObject({
              status: "active",
              version: firstStatus.version,
              reloadFailed: { phase, error: expect.stringContaining("") },
            })
          }

          yield* write("good", "fixed")
          const fixed = yield* resolve
          expect(marker(fixed)).toEqual(Option.some("fixed"))
          const fixedStatus = status(fixed)
          if (fixedStatus?.status !== "active") return expect.unreachable()
          expect(fixedStatus.reloadFailed).toBeUndefined()

          // A delete removes it: a broken file written later has nothing to keep.
          yield* fs.remove(entry)
          expect(marker(yield* resolve)).toEqual(Option.none())
          yield* write("load", "")
          expect(status(yield* resolve)).toMatchObject({ status: "failed", phase: "load" })

          // A disable removes it the same way.
          yield* write("good", "again")
          expect(marker(yield* resolve)).toEqual(Option.some("again"))
          yield* writeFileAtomic(
            userConfig,
            encodeJson({ disabledExtensions: ["profile-last-good"] }),
          )
          expect(status(yield* resolve)).toMatchObject({ status: "disabled" })
          yield* writeFileAtomic(userConfig, encodeJson({ disabledExtensions: [] }))
          yield* write("setup", "")
          expect(status(yield* resolve)).toMatchObject({ status: "failed", phase: "setup" })
        }).pipe(
          Effect.timeout("20 seconds"),
          Effect.provide(
            makeCacheLayer({ cwd: launch, home, extensions: [], allowFailedExtensions: true }),
          ),
          Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("9".repeat(64))),
        )
      }).pipe(Effect.provide(BunPlatformLive)),
  )

  // A Resource built over a last good version depends on that version. A
  // later profile that runs another version of the extension it depends on
  // must not share it: its service would read a version that is gone.
  it.scopedLive(
    "a Resource built over a last good version is not shared by a profile that runs a newer one",
    () =>
      Effect.gen(function* () {
        const chain = yield* chainFixture
        yield* Effect.gen(function* () {
          const cache = yield* SessionProfileCache
          const resolve = Effect.scoped(cache.resolve(chain.launch))
          yield* chain.write("a", chainSource.a("first"))
          yield* chain.write("b", chainSource.b)
          expect(chain.seen(yield* resolve)).toEqual({ value: "first", closed: false })

          // A new version fails to start: b builds over the last good one.
          // A running turn holds this profile.
          const runningTurn = yield* Scope.make()
          yield* chain.write("a", chainSource.a("startup"))
          const kept = yield* cache.resolve(chain.launch).pipe(Scope.provide(runningTurn))
          expect(chain.seen(kept)).toEqual({ value: "first", closed: false })

          yield* chain.write("a", chainSource.a("third"))
          expect(chain.seen(yield* resolve)).toEqual({ value: "third", closed: false })

          // The broken version again, beside a new extension: its last good
          // version is now the third.
          yield* chain.write("a", chainSource.a("startup"))
          yield* chain.write("c", chainSource.c("chain.c"))
          const later = yield* Effect.scoped(
            Effect.gen(function* () {
              const profile = yield* cache.resolve(chain.launch)
              expect(chain.seen(profile)).toEqual({ value: "third", closed: false })
              yield* Scope.close(runningTurn, Exit.void)
              return chain.seen(profile)
            }),
          )
          expect(later).toEqual({ value: "third", closed: false })
        }).pipe(
          Effect.timeout("20 seconds"),
          Effect.provide(
            makeCacheLayer({
              cwd: chain.launch,
              home: chain.home,
              extensions: [],
              allowFailedExtensions: true,
            }),
          ),
          Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("1".repeat(64))),
        )
      }).pipe(Effect.provide(BunPlatformLive)),
  )

  // A profile a turn still holds may run an older last good version. A
  // resolve after a newer good version must run the newer one, though the
  // files match that older profile's.
  it.scopedLive(
    "a version that fails to start runs the newest good version, though a profile with an older one is held",
    () =>
      Effect.gen(function* () {
        const chain = yield* chainFixture
        yield* Effect.gen(function* () {
          const cache = yield* SessionProfileCache
          const resolve = Effect.scoped(cache.resolve(chain.launch))
          const value = (profile: SessionProfile) =>
            Context.get(profile.layerContext, ChainService).value
          yield* chain.write("a", chainSource.a("first"))
          expect(value(yield* resolve)).toBe("first")

          const runningTurn = yield* Scope.make()
          yield* chain.write("a", chainSource.a("startup"))
          expect(value(yield* cache.resolve(chain.launch).pipe(Scope.provide(runningTurn)))).toBe(
            "first",
          )

          yield* chain.write("a", chainSource.a("third"))
          const third = yield* resolve
          expect(value(third)).toBe("third")

          yield* chain.write("a", chainSource.a("startup"))
          const again = yield* resolve
          expect(value(again)).toBe("third")
          const status = again.resolved.extensionStatuses.find(
            (info) => info.manifest.id === "chain-a",
          )
          expect(status).toMatchObject({
            status: "active",
            reloadFailed: { phase: "startup" },
          })
          yield* Scope.close(runningTurn, Exit.void)
        }).pipe(
          Effect.timeout("20 seconds"),
          Effect.provide(
            makeCacheLayer({
              cwd: chain.launch,
              home: chain.home,
              extensions: [],
              allowFailedExtensions: true,
            }),
          ),
          Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("2".repeat(64))),
        )
      }).pipe(Effect.provide(BunPlatformLive)),
  )

  // A last good version runs only in a set it is valid in. Its tool may
  // collide with an extension added since: then the extension whose new
  // version failed is failed, and the other one runs.
  it.scopedLive(
    "a last good version that collides with another extension does not run, and the other one does",
    () =>
      Effect.gen(function* () {
        const chain = yield* chainFixture
        yield* Effect.gen(function* () {
          const cache = yield* SessionProfileCache
          const resolve = Effect.scoped(cache.resolve(chain.launch))
          const statusOf = (profile: SessionProfile, id: string) =>
            profile.resolved.extensionStatuses.find((info) => info.manifest.id === id)
          for (const phase of ["setup", "startup"] as const) {
            yield* chain.remove("c")
            yield* chain.write("a", chainSource.a(`good before ${phase}`, "chain.common"))
            expect(statusOf(yield* resolve, "chain-a")).toMatchObject({ status: "active" })

            yield* chain.write("a", chainSource.a(phase, "chain.fresh"))
            yield* chain.write("c", chainSource.c("chain.common"))
            const profile = yield* resolve
            expect(statusOf(profile, "chain-a")).toMatchObject({ status: "failed", phase })
            expect(statusOf(profile, "chain-c")).toMatchObject({ status: "active" })
            expect(Option.isNone(Context.getOption(profile.layerContext, ChainService))).toBe(true)
          }
        }).pipe(
          Effect.timeout("20 seconds"),
          Effect.provide(
            makeCacheLayer({
              cwd: chain.launch,
              home: chain.home,
              extensions: [],
              allowFailedExtensions: true,
            }),
          ),
          Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("3".repeat(64))),
        )
      }).pipe(Effect.provide(BunPlatformLive)),
  )

  // A version that failed to start, whose last good version was rejected,
  // decided by that last good version. When a newer good version runs, the
  // same failure decides again, though a turn still holds the failed profile.
  it.scopedLive(
    "a version that failed with no usable last good version runs a newer good one when it fails again",
    () =>
      Effect.gen(function* () {
        const chain = yield* chainFixture
        yield* Effect.gen(function* () {
          const cache = yield* SessionProfileCache
          const resolve = Effect.scoped(cache.resolve(chain.launch))
          const statusOf = (profile: SessionProfile) =>
            profile.resolved.extensionStatuses.find((info) => info.manifest.id === "chain-a")
          yield* chain.write("a", chainSource.a("first", "chain.common"))
          expect(statusOf(yield* resolve)).toMatchObject({ status: "active" })

          // The last good version collides with c, so a fails; a turn holds it.
          const runningTurn = yield* Scope.make()
          yield* chain.write("a", chainSource.a("startup", "chain.fresh"))
          yield* chain.write("c", chainSource.c("chain.common"))
          const failed = yield* cache.resolve(chain.launch).pipe(Scope.provide(runningTurn))
          expect(statusOf(failed)).toMatchObject({ status: "failed", phase: "startup" })

          yield* chain.write("a", chainSource.a("third", "chain.fresh"))
          expect(statusOf(yield* resolve)).toMatchObject({ status: "active" })

          // The same broken bytes again: the third version runs in their place.
          yield* chain.write("a", chainSource.a("startup", "chain.fresh"))
          const again = yield* resolve
          expect(statusOf(again)).toMatchObject({
            status: "active",
            reloadFailed: { phase: "startup" },
          })
          expect(Context.get(again.layerContext, ChainService).value).toBe("third")
          yield* Scope.close(runningTurn, Exit.void)
        }).pipe(
          Effect.timeout("20 seconds"),
          Effect.provide(
            makeCacheLayer({
              cwd: chain.launch,
              home: chain.home,
              extensions: [],
              allowFailedExtensions: true,
            }),
          ),
          Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("4".repeat(64))),
        )
      }).pipe(Effect.provide(BunPlatformLive)),
  )

  // A user and a project extension may share an id and their code. Two
  // profiles that run their last good versions swapped are two profiles:
  // each closes its own Resources when it retires.
  it.scopedLive(
    "profiles that run swapped last good versions of a user and a project extension each close their Resources",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-profile-swap-" })
        const home = path.join(directory, "home")
        const project = path.join(directory, "project")
        const userFile = path.join(home, ".gent", "extensions", "dup.ts")
        const projectFile = path.join(project, ".gent", "extensions", "dup.ts")
        yield* fs.makeDirectory(path.dirname(userFile), { recursive: true })
        yield* fs.makeDirectory(path.dirname(projectFile), { recursive: true })
        yield* fs.writeFileString(
          path.join(home, ".gent", "config.json"),
          encodeJson({ trustedProjects: [yield* fs.realPath(project)] }),
        )
        // Each open swap Resource keeps one file here.
        const marks = path.join(directory, "marks")
        yield* fs.makeDirectory(marks)
        const write = (user: string, projectValue: string) =>
          Effect.all([
            writeFileAtomic(userFile, swapSource(user, marks)),
            writeFileAtomic(projectFile, swapSource(projectValue, marks)),
          ])
        const open = Effect.map(fs.readDirectory(marks), (files) => files.length)

        yield* Effect.gen(function* () {
          const cache = yield* SessionProfileCache
          const resolve = Effect.scoped(cache.resolve(project))
          yield* write("one", "one")
          yield* resolve
          yield* write("one", "two")
          yield* resolve
          // Both fail to start: user runs one, project two. A turn holds it.
          const runningTurn = yield* Scope.make()
          yield* write("startup", "startup")
          yield* cache.resolve(project).pipe(Scope.provide(runningTurn))
          yield* write("two", "one")
          yield* resolve
          // Both fail again: user runs two, project one.
          yield* write("startup", "startup")
          yield* resolve
          yield* Scope.close(runningTurn, Exit.void)
          yield* write("one", "one")
          yield* resolve
          // Only the current profile's two Resources are open.
          expect(yield* open).toBe(2)
        }).pipe(
          Effect.timeout("20 seconds"),
          Effect.provide(
            makeCacheLayer({ cwd: project, home, extensions: [], allowFailedExtensions: true }),
          ),
          // Bun names each source path in a comment, so the same code at two
          // paths is two versions. A build without the comments, as another
          // bundler may emit, gives one version: the key must not lean on it.
          Effect.updateService(GentPlatform, (live) =>
            GentPlatform.of({
              ...live,
              bundleModule: (entry) =>
                live.bundleModule(entry).pipe(
                  Effect.map((bundle) => ({
                    ...bundle,
                    code: bundle.code.replace(/^\/\/ .*$/gm, ""),
                  })),
                ),
            }),
          ),
          Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("5".repeat(64))),
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

  // Interrupting registration must preserve both the new lease and cleanup
  // of any unused profile it supersedes.
  for (const scenario of [
    {
      name: "a resolve interrupted after its build still retires the profile it built",
      interruptBuild: 1,
    },
    {
      name: "an interrupted replacement closes the unused profile it supersedes",
      interruptBuild: 2,
    },
  ]) {
    it.scopedLive(scenario.name, () =>
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
        // The initialization log is the existing registration boundary,
        // while the pending interrupt is still held by the mask.
        const builds = MutableRef.make(0)
        const interruptAfterBuild = Logger.make(({ message, fiber }) => {
          let rendered = String(message)
          if (Array.isArray(message)) rendered = message.join(" ")
          if (!rendered.includes("session-profile.initialized")) return
          MutableRef.update(builds, (count) => count + 1)
          if (MutableRef.get(builds) === scenario.interruptBuild) fiber.interruptUnsafe()
        })

        yield* Effect.gen(function* () {
          const cache = yield* SessionProfileCache
          yield* disable(["@gent/test-session-profile/held-a"])
          if (scenario.interruptBuild === 2) {
            yield* Effect.scoped(cache.resolve(launch))
            expect(yield* Ref.get(open)).toEqual(["b"])
            yield* disable(["@gent/test-session-profile/held-b"])
          }
          const interruptedResolve = yield* Effect.scoped(cache.resolve(launch)).pipe(
            Effect.forkChild,
          )
          expect(Exit.hasInterrupts(yield* Fiber.await(interruptedResolve))).toBe(true)
          if (scenario.interruptBuild === 1) {
            expect(yield* Ref.get(open)).toEqual(["b"])
            yield* disable(["@gent/test-session-profile/held-b"])
            yield* Effect.scoped(cache.resolve(launch))
          }
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
  }

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
  it.scopedLive("a broken, fixed or edited extension file reaches the next resolve", () =>
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

        // Broken from its first save: no good version to keep, so it fails.
        yield* fs.writeFileString(extensionFile, "export const = ;\n")
        const broken = yield* resolve
        expect(ids(broken)).toEqual(["@gent/test-session-profile/files-kept"])
        expect(failedPaths(broken)).toEqual([extensionFile])

        yield* writeExtension("@gent/test-file-added")
        expect(ids(yield* resolve)).toContain("@gent/test-file-added")
        expect(failedPaths(yield* resolve)).toEqual([])

        // The same path again, with new content: imported afresh, not from
        // the module cache.
        yield* writeExtension("@gent/test-file-fixed-and-renamed")
        const fixed = yield* resolve
        expect(ids(fixed)).toContain("@gent/test-file-fixed-and-renamed")
        expect(ids(fixed)).not.toContain("@gent/test-file-added")
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
            SqliteStorage.MemoryWithSql.pipe(Layer.provide(BunPlatformLive)),
          ),
        ),
      )
      const testLayer = Layer.mergeAll(
        BunServices.layer,
        SqliteStorage.MemoryWithSql.pipe(Layer.provide(BunPlatformLive)),
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
          models: testExtensionHostContext().Models,
        })
        const resolved = yield* resolveTurnProfile({
          sessionId: SessionId.make("session-runtime-context-profile"),
          branchId: BranchId.make("branch-runtime-context-profile"),
          opener: RunOpener.cases.Turn.make({ openedByClient: true }),
          profileCache,
          hostProvider,
        })
        expect(resolved.turnHostCtx.cwd).toBe(secondary)
      }).pipe(Effect.provide(testLayer), Effect.scoped)
    }).pipe(Effect.provide(BunPlatformLive)),
  )
  it.scopedLive("a session with no stored cwd runs in the host cwd's profile", () =>
    Effect.gen(function* () {
      const runtimeEnvironmentLayer = RuntimeEnvironment.Live({
        cwd: "/nonexistent/runtime-context-default",
        home: "/nonexistent/runtime-context-home",
      })
      const testLayer = Layer.mergeAll(
        testSqliteStorage,
        fixedSessionProfiles(),
        runtimeEnvironmentLayer,
      )
      yield* Effect.gen(function* () {
        const profiles = yield* SessionProfileCache
        const asked: Array<string> = []
        const hostProvider = yield* makeExtensionHostContextProvider({
          host: testHostFacts().host,
          models: testExtensionHostContext().Models,
        })
        const resolved = yield* resolveTurnProfile({
          sessionId: SessionId.make("missing-session"),
          branchId: BranchId.make("missing-branch"),
          opener: RunOpener.cases.Turn.make({ openedByClient: true }),
          profileCache: {
            resolve: (cwd) =>
              Effect.sync(() => asked.push(cwd)).pipe(Effect.andThen(profiles.resolve(cwd))),
          },
          hostProvider,
        })
        expect(asked).toEqual(["/nonexistent/runtime-context-default"])
        expect(resolved.turnHostCtx.cwd).toBe("/nonexistent/runtime-context-default")
        expect(resolved.turnGenerationId).toBe(ProcessGenerationId.make("test"))
      }).pipe(Effect.provide(testLayer))
    }),
  )
  // A failed read is not a missing session: the launch profile and the host
  // cwd would run the turn in another project.
  it.scopedLive("a failed session read fails the turn profile and the working directory", () =>
    Effect.gen(function* () {
      const runtimeEnvironmentLayer = RuntimeEnvironment.Live({
        cwd: "/nonexistent/runtime-context-fail",
        home: "/nonexistent/runtime-context-home",
      })
      const testLayer = Layer.mergeAll(
        testSqliteStorage,
        fixedSessionProfiles(),
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
          models: testExtensionHostContext().Models,
        })
        const sessionId = SessionId.make("session-runtime-context-storage-failure")
        const profileFailure = yield* Effect.flip(
          resolveTurnProfile({
            sessionId,
            branchId: BranchId.make("branch-runtime-context-storage-failure"),
            opener: RunOpener.cases.Turn.make({ openedByClient: true }),
            profileCache: yield* SessionProfileCache,
            hostProvider,
          }).pipe(Effect.provideService(SessionStorage, failingSessionStorage)),
        )
        const cwdFailure = yield* Effect.flip(
          sessionWorkingDirectory(sessionId).pipe(
            Effect.provideService(SessionStorage, failingSessionStorage),
          ),
        )
        expect([profileFailure._tag, cwdFailure._tag]).toEqual(["StorageError", "StorageError"])
      }).pipe(Effect.provide(testLayer))
    }),
  )
  it.scopedLive("the turn runs with its profile's registry and drivers, not the launch cwd's", () =>
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
        cwd: "/nonexistent/runtime-context-default",
        home: "/nonexistent/runtime-context-home",
      })
      const testLayer = Layer.mergeAll(
        testSqliteStorage,
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
            cwd: "/nonexistent/profile-driver-scope",
            createdAt: now,
            updatedAt: now,
          }),
        )
        // A built profile's services hold its registry, as `Layer.build` makes them.
        const profileRegistry = ExtensionRegistry.of({
          getResolved: () => profileResolved,
          providerConfig: Effect.succeed({}),
        })
        const fakeProfile: SessionProfile = {
          cwd: "/nonexistent/profile-driver-scope",
          resolved: profileResolved,
          layerContext: Context.make(ExtensionRegistry, profileRegistry),
          registryService: profileRegistry,
          baseSections: [],
          resourceBuilds: { host: Context.makeUnsafe(new Map()), process: new Map() },
          generationId: ProcessGenerationId.make("test"),
        }
        const fakeProfileCache: Pick<SessionProfileCacheService, "resolve"> = {
          resolve: () => Effect.succeed(fakeProfile),
        }
        const hostProvider = yield* makeExtensionHostContextProvider({
          host: testHostFacts().host,
          models: testExtensionHostContext().Models,
        })
        const resolved = yield* resolveTurnProfile({
          sessionId: SessionId.make("session-runtime-context-driver"),
          branchId: BranchId.make("branch-runtime-context-driver"),
          opener: RunOpener.cases.Turn.make({ openedByClient: true }),
          profileCache: fakeProfileCache,
          hostProvider,
        })
        const drivers = Context.get(resolved.turnCapabilityContext, ExtensionRegistry).getResolved()
          .modelDrivers
        expect(resolved.turnHostCtx.cwd).toBe("/nonexistent/profile-driver-scope")
        expect(drivers.get("profile-driver")?.id).toBe("profile-driver")
        expect(extensionRegistry.getResolved().modelDrivers.has("profile-driver")).toBe(false)
      }).pipe(Effect.provide(testLayer))
    }),
  )
})

// ── turn services ────────────────────────────────────────────────────────────

/**
 * What a turn's tool sees of a process resource, through the full RPC path.
 * The launch cwd enables the marker extension; the project's config disables it.
 */
const markerSeenByTurn = (
  sessionCwd: (dirs: { readonly project: string }) => Option.Option<string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-turn-services-home-" })
    const launch = yield* fs.makeTempDirectoryScoped({ prefix: "gent-turn-services-launch-" })
    const project = yield* fs.makeTempDirectoryScoped({ prefix: "gent-turn-services-project-" })
    yield* fs.makeDirectory(path.join(project, ".gent"), { recursive: true })
    yield* fs.writeFileString(
      path.join(project, ".gent", "config.json"),
      encodeJson({ disabledExtensions: ["@gent/test-turn-services/marker"] }),
    )
    const seen = yield* Deferred.make<string>()
    const probeExtension = defineExtension({
      id: "@gent/test-turn-services/probe",
      setup: Effect.gen(function* () {
        const host = yield* ExtensionHost
        yield* host.register(
          "tool",
          tool({
            id: "marker-probe",
            description: "reports whether the marker resource is in scope",
            params: S.Struct({}),
            output: S.String,
            execute: () =>
              Effect.gen(function* () {
                const marker = yield* Effect.serviceOption(SessionProfileResourceMarker)
                const answer = Option.match(marker, {
                  onNone: () => "absent",
                  onSome: (value) => value.value,
                })
                yield* Deferred.succeed(seen, answer)
                return answer
              }),
          }),
        )
      }),
    })
    const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
      toolCallStep("marker-probe", {}),
      textStep("done"),
    ])
    const configServiceLayer = ConfigService.Live.pipe(
      Layer.provide(Layer.merge(BunServices.layer, RuntimeEnvironment.Live({ cwd: launch, home }))),
    )
    const { client } = yield* createRpcClient(
      createE2ELayer({
        providerLayer,
        agents: [testAgent],
        extensionInputs: [
          markerExtension("@gent/test-turn-services/marker", "launch"),
          probeExtension,
        ],
        cwd: launch,
        home,
        configServiceLayer,
      }),
    )
    const created = yield* client.session.create(
      omitUndefined({ cwd: Option.getOrUndefined(sessionCwd({ project })) }),
    )
    yield* client.message.send({
      sessionId: created.sessionId,
      branchId: created.branchId,
      content: "probe",
    })
    return yield* Deferred.await(seen)
  }).pipe(Effect.timeout("10 seconds"))

describe("turn services", () => {
  // The session's profile is the one owner of a turn's extension services:
  // the launch profile's resources never reach another project's turn.
  it.scopedLive("a turn in a project that disables an extension does not see its resource", () =>
    markerSeenByTurn(({ project }) => Option.some(project)).pipe(
      Effect.map((seen) => expect(seen).toBe("absent")),
      Effect.provide(BunServices.layer),
    ),
  )

  // A session with no stored cwd runs in the host's cwd, so its turn reads
  // the launch profile.
  it.scopedLive("a turn of a session with no stored cwd sees the launch profile's resource", () =>
    markerSeenByTurn(() => Option.none()).pipe(
      Effect.map((seen) => expect(seen).toBe("launch")),
      Effect.provide(BunServices.layer),
    ),
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
  Effect.succeed(AiModel.make("test", "model", LanguageModelLayers.failing))
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
  test("project scope shadows builtin for same model driver id", () => {
    const resolved = resolveExtensions([
      makeExt("ext-builtin", "builtin", { modelDrivers: [makeModel("openai", "Builtin")] }),
      makeExt("ext-project", "project", { modelDrivers: [makeModel("openai", "Project")] }),
    ])
    const result = resolved.modelDrivers.get("openai")
    expect(result?.id).toBe("openai")
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
      const result = yield* listModelCatalog(resolved, fixtureModelCatalog())
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
      const result = yield* listModelCatalog(resolved, fixtureModelCatalog())
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
        listModels: (_catalog, auth) =>
          Effect.sync(() => {
            seenAuth.push({ driverId: "auth-a", auth: Option.fromUndefinedOr(auth) })
            return [makeCatalogModel("auth-a/one")]
          }),
      }
      const driverB: ModelDriverContribution = {
        id: "auth-b",
        name: "AuthB",
        resolveModel: stubResolution,
        listModels: (_catalog, auth) =>
          Effect.sync(() => {
            seenAuth.push({ driverId: "auth-b", auth: Option.fromUndefinedOr(auth) })
            return [makeCatalogModel("auth-b/one")]
          }),
      }
      const resolved = resolveExtensions([
        makeExt("auth-ext", "builtin", { modelDrivers: [driverA, driverB] }),
      ])
      yield* listModelCatalog(resolved, fixtureModelCatalog(), (driverId) => {
        if (driverId === "auth-a") {
          return Effect.succeedSome(ProviderAuthInfo.cases.Api.make({ key: "secret-a" }))
        }
        return Effect.succeedNone
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
      const result = yield* listModelCatalog(resolved, fixtureModelCatalog())
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
  Layer.mergeAll(
    BunFileSystem.layer,
    Path.layer,
    BunCrypto.layer,
    EffectHttpEntry.FetchHttpClient.layer,
    BunGentPlatformLive,
  ),
  childProcessSpawnerLive,
)

/** The session database every Resource build reads, in memory. */
const profileStorageLayer = SqliteStorage.MemoryWithSql.pipe(Layer.provide(BunPlatformLive))

/**
 * The extensions a profile for `home` and `cwd` activates: the scan, load,
 * setup and validation `SessionProfileCache` runs, with no builtins. User
 * extension files live in `<home>/.gent/extensions`, project files in
 * `<cwd>/.gent/extensions`.
 */
const discoverProfileExtensions = (dirs: { readonly home: string; readonly cwd: string }) =>
  Effect.gen(function* () {
    const scan = yield* scanRuntimeProfileExtensions(dirs, makeModuleGraphs())
    const declarations = yield* loadRuntimeProfileDeclarations(
      { ...dirs, platform: "test", extensions: [] },
      scan,
    )
    return declarations.extensionDeclarations
  })

/** A fresh home with an empty user extension directory. */
const makeExtensionHome = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix }))
    const userDir = path.join(home, ".gent", "extensions")
    yield* fs.makeDirectory(userDir, { recursive: true })
    return { home, userDir }
  })

/** A cwd with no project extensions. */
const noProjectCwd = "/nonexistent/gent-loader-project"

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
        cwd: "/nonexistent/gent-test-cwd",
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
        cwd: "/nonexistent/gent-test-cwd",
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
        cwd: "/nonexistent/gent-test-cwd",
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

  test("validation collisions fail the conflicting extensions instead of crashing host activation", () => {
    const result = validateLoadedExtensions([
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

    expect(result.active.map((ext) => ext.manifest.id)).toEqual([ExtensionId.make("healthy-ext")])
    expect(result.failed).toHaveLength(2)
    expect(result.failed.map((ext) => ext.manifest.id).sort()).toEqual([
      ExtensionId.make("collider-a"),
      ExtensionId.make("collider-b"),
    ])
    expect(result.failed.every((ext) => ext.phase === "validation")).toBe(true)
    expect(result.failed.every((ext) => ext.error.includes("shared_tool"))).toBe(true)
  })

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

  test("validation fails a tool and a request that share an id in one scope", () => {
    // Tools and requests share one id namespace: resolution keeps one
    // winner per id, so a passing pair would silently drop the tool.
    const result = validateLoadedExtensions([
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
    expect(result.failed.every((ext) => ext.error.includes('capability "shared_name"'))).toBe(true)
  })

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
        cwd: "/nonexistent/gent-test-cwd",
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
        cwd: "/nonexistent/gent-test-cwd",
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
        cwd: "/nonexistent/gent-test-cwd",
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
        cwd: "/nonexistent/gent-test-cwd",
        home: "/nonexistent/gent-test-home",
        disabled: new Set(),
      })

      expect(result.active.map((ext) => ext.manifest.id)).toEqual([ExtensionId.make("rpc-no-desc")])
      expect(result.failed).toEqual([])
    }).pipe(Effect.provide(fsLayer)),
  )

  it.scopedLive("live Profile isolates setup failures", () =>
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
    }).pipe(Effect.provide(Layer.mergeAll(fsLayer, ConfigService.Test(), profileStorageLayer))),
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
    }).pipe(Effect.provide(Layer.mergeAll(fsLayer, ConfigService.Test(), profileStorageLayer))),
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
    }).pipe(Effect.provide(Layer.mergeAll(fsLayer, ConfigService.Test(), profileStorageLayer))),
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
        cwd: "/nonexistent/gent-test-cwd",
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

  test("a project request shadows the builtin request of the same id", () =>
    Effect.forEach(
      Array.of<{
        readonly builtin: RequestCapability
        readonly project: RequestCapability
        readonly input: Readonly<Record<string, string>>
        readonly expected: unknown
      }>(
        {
          builtin: pingRequest({ id: "thing", value: "builtin" }),
          project: pingRequest({ id: "thing" }),
          input: { value: "hi" },
          expected: { value: "hi" },
        },
        {
          builtin: echoRequest({ id: "thing", value: "builtin" }),
          project: echoRequest({ id: "thing", value: "project" }),
          input: { value: "x" },
          expected: { value: "project" },
        },
        {
          builtin: request({
            id: "thing",
            input: Schema.Unknown,
            output: Schema.Unknown,
            execute: () => Effect.succeed("builtin-write"),
          }),
          project: request({
            id: "thing",
            input: Schema.Unknown,
            output: Schema.Unknown,
            execute: () => Effect.succeed("project-read"),
          }),
          input: {},
          expected: "project-read",
        },
      ),
      ({ builtin, project, input, expected }) =>
        Effect.gen(function* () {
          const resolved = resolveExtensions([
            extWith("builtin", [builtin]),
            extWith("project", [project]),
          ])
          const result = yield* runRpc(resolved.rpcRegistry, project.id, input)
          expect(result).toEqual(expected)
        }),
      { discard: true },
    ))

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

  test("a sessionDeleted handler that never returns is cut at its bound; the others run", () =>
    Effect.gen(function* () {
      const heard: Array<SessionId> = []
      const slots = compileExtensionHooks([
        makeExtExtensionHooks("stuck", "project", {
          hooks: [hook("sessionDeleted", () => Effect.never)],
        }),
        makeExtExtensionHooks("listener", "user", {
          hooks: [
            hook("sessionDeleted", ({ sessionId }) =>
              Effect.sync(() => {
                heard.push(sessionId)
              }),
            ),
          ],
        }),
      ])
      const emit = yield* slots
        .emitSessionDeleted({ sessionId: SessionId.make("deleted-session"), branchIds: [] })
        .pipe(Effect.provideService(CurrentExtensionHostContext, stubHostCtx), Effect.forkChild)
      yield* TestClock.adjust(SESSION_DELETED_HOOK_TIMEOUT)
      // The emit returns: the stuck handler no longer holds the delete.
      yield* Fiber.join(emit)
      expect(heard).toEqual([SessionId.make("deleted-session")])
    }).pipe(Effect.provide(TestClock.layer()), Effect.timeout("3 seconds")))

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
      const slots = compileExtensionHooks([
        makeExtExtensionHooks("readonly", "project", {
          hooks: [
            hook("systemPrompt", () =>
              Effect.gen(function* () {
                yield* ExtensionContext
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
              agentName: AgentName.make("primary"),
              interrupted: false,
              streamFailed: false,
              retryAt: Option.none(),
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
      const yieldedContext = yield* Ref.make(false)
      const slots = compileExtensionHooks([
        makeExtExtensionHooks("readonly-lifecycle", "project", {
          hooks: [
            hook("turnAfter", () =>
              Effect.gen(function* () {
                yield* ExtensionContext
                yield* Ref.set(yieldedContext, true)
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
            agentName: AgentName.make("primary"),
            interrupted: false,
            streamFailed: false,
            retryAt: Option.none(),
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

      expect(yield* Ref.get(yieldedContext)).toBe(true)
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
            agentName: AgentName.make("primary"),
            interrupted: false,
            streamFailed: false,
            retryAt: Option.none(),
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
          cwd: "/nonexistent/gent-test-cwd",
          createdAt: FIXTURE_DATE,
          updatedAt: FIXTURE_DATE,
        }),
      )
      yield* branches.createBranch(
        new Branch({ id: BRANCH_ID, sessionId: SESSION_ID, createdAt: FIXTURE_DATE }),
      )
      const provider = yield* makeExtensionHostContextProvider({
        host: testHostFacts().host,
        models: testExtensionHostContext().Models,
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
          testSqliteStorage,
          RuntimeEnvironment.Live({
            cwd: "/nonexistent/gent-test-cwd",
            home: "/nonexistent/gent-test-home",
          }),
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
          cwd: "/nonexistent/gent-test-cwd",
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
        models: testExtensionHostContext().Models,
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
          testSqliteStorage,
          RuntimeEnvironment.Live({
            cwd: "/nonexistent/gent-test-cwd",
            home: "/nonexistent/gent-test-home",
          }),
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
  "effect/ai": EffectAiEntry,
  "effect/ai/AiError": EffectAiErrorEntry,
  "effect/ai/Prompt": Prompt,
  "effect/ai/Response": EffectResponseEntry,
  "effect/ai/Tool": AiTool,
  "effect/encoding": EffectEncodingEntry,
  "effect/http": EffectHttpEntry,
  "effect/http/HttpClientError": EffectHttpClientErrorEntry,
  "effect/process": EffectProcessEntry,
  "effect/process/ChildProcessSpawner": EffectChildProcessSpawnerEntry,
  "effect/sql": EffectSqlEntry,
}

// oxlint-disable-next-line effect/noDynamicImports -- the test reads the exports of an extension file it wrote
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
        // The table names exactly what the loader binds.
        expect(specifiers.toSorted()).toEqual([...extensionEntryModules.keys()].toSorted())
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

        const discovered = yield* discoverProfileExtensions({ home, cwd: noProjectCwd })
        expect(discovered.failed).toEqual([])
        expect(
          discovered.active.map((extension) => ({
            id: String(extension.manifest.id),
            tools: extension.contributions.tools?.map((tool) => String(getToolId(tool))),
          })),
        ).toEqual([{ id: "@user/entries", tools: ["entries_probe"] }])

        const { bound } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            bound: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
          }),
        )(yield* importFile(extensionFile))
        for (const [specifier, entryModule] of Object.entries(boundEntries)) {
          const imported = Option.fromNullishOr(bound[specifier])
          expect(Option.map(imported, (names) => Object.keys(names).sort())).toEqual(
            Option.some(Object.keys(entryModule).sort()),
          )
          for (const [name, value] of Object.entries(entryModule)) {
            const same = Option.exists(imported, (names) => names[name] === value)
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
      const discovered = yield* discoverProfileExtensions({ home, cwd: noProjectCwd })
      expect(discovered.active).toEqual([])
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
      const dirs = { home: path.join(directory, "home"), cwd: path.join(directory, "project") }
      const denied = yield* discoverProfileExtensions(dirs)
      expect(denied.active).toHaveLength(0)
      expect(denied.failed[0]?.error).toContain("not trusted")
      expect(yield* fs.exists(marker)).toBe(false)
      yield* fs.writeFileString(path.join(userDir, "../config.json"), grant)
      const allowed = yield* discoverProfileExtensions(dirs)
      expect(allowed.active.map((extension) => extension.manifest.id)).toEqual([
        ExtensionId.make("trusted-project"),
      ])
      expect(yield* fs.readFileString(marker)).toBe("ran")
      yield* fs.writeFileString(path.join(userDir, "../config.json"), "invalid JSON")
      const revoked = yield* discoverProfileExtensions(dirs)
      expect(revoked.active).toHaveLength(0)
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
      const loadedAs = (result: Effect.Success<ReturnType<typeof discoverProfileExtensions>>) =>
        result.active.map((extension) => `${extension.scope}:${extension.manifest.id}`)
      // Untrusted (the default): no "not trusted" failure for the user's own files.
      const untrusted = yield* discoverProfileExtensions({ home, cwd: home })
      expect(loadedAs(untrusted)).toEqual(["user:home-user"])
      expect(untrusted.failed).toEqual([])
      // Trusted: still one copy, as user.
      yield* fs.writeFileString(
        path.join(userDir, "../config.json"),
        encodeJson({ trustedProjects: [home] }),
      )
      const trusted = yield* discoverProfileExtensions({ home, cwd: home })
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

  it.scopedLive("does not infer identity from mutable package metadata or cached modules", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { home, userDir: packageDir } = yield* makeExtensionHome("gent-loader-package-")
      yield* fs.writeFileString(
        path.join(packageDir, "package.json"),
        encodeJson({ name: "@gent/test-pinned", version: "1.2.3" }),
      )
      const extensionPath = path.join(packageDir, "extension.ts")
      yield* fs.writeFileString(
        extensionPath,
        'import { Effect } from "effect"\nexport default { manifest: { id: "@gent/test-pinned-v1" }, setup: Effect.void }\n',
      )

      const first = yield* discoverProfileExtensions({ home, cwd: noProjectCwd })
      expect(first.active).toHaveLength(1)
      expect(first.active[0]?.artifactIdentity).toBeUndefined()

      // An edited file is imported again under its new version. The loader
      // still attaches no identity to what it imported.
      yield* fs.writeFileString(
        extensionPath,
        'import { Effect } from "effect"\nexport default { manifest: { id: "@gent/test-pinned-v2" }, setup: Effect.void }\n',
      )
      const second = yield* discoverProfileExtensions({ home, cwd: noProjectCwd })
      expect(second.active[0]?.artifactIdentity).toBeUndefined()

      // A changed manifest is also not a proof that the already imported
      // module changed. Replay remains explicitly unsupported.
      yield* fs.writeFileString(
        path.join(packageDir, "package.json"),
        encodeJson({ name: "@gent/test-pinned", version: "2.0.0" }),
      )
      const third = yield* discoverProfileExtensions({ home, cwd: noProjectCwd })
      expect(third.active[0]?.artifactIdentity).toBeUndefined()
    }).pipe(Effect.provide(fsLayer)),
  )

  // Raw hand-rolled `{ manifest, setup }` (no `defineExtension`) must yield
  // the `ExtensionHost` Tag to read setup facts. There is no ctx-as-param escape.
  it.live("setup sees cwd, home and host facts, with no process facade or file authority", () =>
    Effect.gen(function* () {
      const captured = yield* Effect.sync(() => ({
        cwd: "",
        home: "",
        hasHostFacts: false,
        hasProcessFacade: true,
        hasReadAuthority: false,
      }))
      const extension: GentExtension = {
        manifest: { id: ExtensionId.make("@gent/test-raw-setup") },
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          captured.cwd = host.cwd
          captured.home = host.home
          captured.hasHostFacts = "osInfo" in host.host
          captured.hasProcessFacade = "Process" in host
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
      expect(captured.hasHostFacts).toBe(true)
      expect(captured.hasProcessFacade).toBe(false)
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
      const { home, userDir: dir } = yield* makeExtensionHome("gent-loader-test-")

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

      const result = yield* discoverProfileExtensions({ home, cwd: noProjectCwd })

      // None of the malformed files load: the `isGentExtension` guard finds
      // no extension in them.
      expect(result.active).toHaveLength(0)
      expect(result.failed.length).toBeGreaterThanOrEqual(4)
      for (const target of [fnSetupPath, objectSetupPath, nullSetupPath, validPath]) {
        const entry = result.failed.find((s) => s.sourcePath === target)
        expect(entry).toBeDefined()
        expect(entry?.error).toContain("No GentExtension found")
      }
    }).pipe(Effect.provide(fsLayer)),
  )

  it.scopedLive("one extension exported under two names loads once; two extensions fail", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { home, userDir: dir } = yield* makeExtensionHome("gent-loader-test-")
      const aliasedPath = path.join(dir, "aliased.ts")
      const twoPath = path.join(dir, "two.ts")
      yield* fs.writeFileString(
        aliasedPath,
        `import { Effect } from "effect"\nexport const ext = { manifest: { id: "@user/aliased" }, setup: Effect.void }\nexport default ext\n`,
      )
      yield* fs.writeFileString(
        twoPath,
        `import { Effect } from "effect"\nexport const a = { manifest: { id: "@user/two-a" }, setup: Effect.void }\nexport const b = { manifest: { id: "@user/two-b" }, setup: Effect.void }\n`,
      )

      const result = yield* discoverProfileExtensions({ home, cwd: noProjectCwd })

      expect(result.active.map((ext) => ext.manifest.id)).toEqual([
        ExtensionId.make("@user/aliased"),
      ])
      expect(result.failed.find((s) => s.sourcePath === twoPath)?.error).toContain(
        "Multiple GentExtension exports",
      )
    }).pipe(Effect.timeout("20 seconds"), Effect.provide(fsLayer)),
  )

  // Load order decides which of two same-named services wins, so it must not
  // follow the locale: `Zeta.ts` sorts before `alpha.ts` by code unit.
  it.scopedLive("extension files load in code-unit order of their paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { home, userDir: dir } = yield* makeExtensionHome("gent-loader-order-")
      for (const id of ["alpha", "Zeta"]) {
        yield* fs.writeFileString(
          path.join(dir, `${id}.ts`),
          `import { Effect } from "effect"\nexport default { manifest: { id: "${id}" }, setup: Effect.void }\n`,
        )
      }

      const result = yield* discoverProfileExtensions({ home, cwd: noProjectCwd })

      expect(result.active.map((extension) => extension.manifest.id)).toEqual([
        ExtensionId.make("Zeta"),
        ExtensionId.make("alpha"),
      ])
    }).pipe(Effect.provide(fsLayer)),
  )

  it.scopedLive("a dangling symlink fails alone; its siblings still load", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { home, userDir: dir } = yield* makeExtensionHome("gent-loader-dangling-")
      yield* fs.writeFileString(
        path.join(dir, "good.ts"),
        'import { Effect } from "effect"\nexport default { manifest: { id: "good" }, setup: Effect.void }\n',
      )
      const danglingPath = path.join(dir, "zz-dangling.ts")
      yield* fs.symlink(path.join(dir, "nowhere.ts"), danglingPath)

      const result = yield* discoverProfileExtensions({ home, cwd: noProjectCwd })

      expect(result.active.map((extension) => extension.manifest.id)).toEqual([
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
const makeProvider = (providerId: string, name?: string): ModelDriverContribution => ({
  id: providerId,
  name: name ?? providerId,
  resolveModel: (modelName) =>
    Effect.succeed(AiModel.make(providerId, modelName, LanguageModelLayers.failing)),
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
describe("contribution resolution", () => {
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

/** One scope's Resources built into the caller's scope, over no other services. */
const buildProcessResources = (extensions: ReadonlyArray<LoadedExtension>) =>
  Effect.gen(function* () {
    return yield* buildScopeResources({
      extensions,
      scope: "process",
      context: Context.makeUnsafe<unknown>(new Map()),
      buildContext: (_extension, before) => before,
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
  agentName: AgentName.make("primary"),
  interrupted: false,
  streamFailed: false,
  retryAt: Option.none(),
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
        .resolveTurnProjection({ agent: AgentDefinition.make({ name: AgentName.make("primary") }) })
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
        .resolveTurnProjection({ agent: AgentDefinition.make({ name: AgentName.make("primary") }) })
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
 * Agents and model drivers resolve through the keyed bucket compiler
 * (`compileBucket` in `runtime/extension-host.ts`); tools and requests through
 * the capability compiler beside it.
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
const makeMutationsLayer = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  events: Ref.Ref<AgentEvent[]>,
) => {
  const resolvedExtensions = makeTestExtensions()
  const cwd = "/nonexistent/gent-test-cwd"
  // The launch profile is the cache's profile of the host cwd, as in a server
  // root: a session with no stored cwd runs under it.
  const launchRegistry = ExtensionRegistry.of({
    getResolved: () => resolvedExtensions,
    providerConfig: Effect.succeed({}),
  })
  const launchProfile: SessionProfile = {
    cwd,
    resolved: resolvedExtensions,
    layerContext: Context.make(ExtensionRegistry, launchRegistry),
    registryService: launchRegistry,
    baseSections: [],
    resourceBuilds: { host: Context.makeUnsafe(new Map()), process: new Map() },
    generationId: ProcessGenerationId.make("test"),
  }
  const eventStoreLayer = recordingEventStore(events)
  const storageLayer = testSqliteStorage
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
    ToolRunner.Test(),
    ApprovalService.Test(),
    RuntimeEnvironment.Live({ cwd, home: "/nonexistent/gent-test-home" }),
    ConfigService.Test(),
    BunServices.layer,
    ModelRegistry.Test(),
    DecisionModelResolver.Live.pipe(
      Layer.provide(Auth.Test()),
      Layer.provide(fixtureModelCatalogSource),
    ),
    GentPlatform.Test(),
    fixedSessionProfiles(new Map([[cwd, launchProfile]])),
    AgentLoopSessionGovernance.Live,
  )
  const sessionRuntimeLayer = Layer.provide(
    Layer.provideMerge(AgentLoopLiveActor, SessionRuntime.Client),
    baseDeps,
  )
  const sessionMutationsLayer = Layer.provide(
    SessionMutationsLive,
    Layer.mergeAll(baseDeps, sessionRuntimeLayer),
  )
  return Layer.mergeAll(baseDeps, sessionRuntimeLayer, sessionMutationsLayer)
}
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
      const events = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const mutations = yield* SessionMutations
        const sessionRuntime = yield* SessionRuntime
        const messageStorage = yield* MessageStorage
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
        const tags = (yield* Ref.get(events)).map((event) => event._tag)
        expect(messages.map((message) => message.role)).toEqual([
          "user",
          "assistant",
          "user",
          "assistant",
        ])
        expect(tags).not.toContain("AgentSwitched")
        yield* controls.assertDone
      }).pipe(Effect.provide(makeMutationsLayer(providerLayer, events)), Effect.scoped)
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
      }).pipe(
        Effect.provide(makeMutationsLayer(providerLayer, yield* Ref.make<AgentEvent[]>([]))),
        Effect.scoped,
      )
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

describe("a queue sent on a condition", () => {
  const extensionId = ExtensionId.make("@gent/test-conditional-queue")
  const branchOf = (harness: { readonly sessionId: SessionId; readonly branchId: BranchId }) => ({
    sessionId: harness.sessionId,
    branchId: harness.branchId,
  })

  /**
   * A request that decides to send, waits at `release`, then queues a line
   * that only the branch's newest message may take. It stands for an alarm
   * that read the branch some time before its fire queues.
   */
  const conditionalQueue = (gate: {
    readonly reached: Deferred.Deferred<void>
    readonly release: Deferred.Deferred<void>
  }) =>
    defineExtension({
      id: extensionId,
      setup: Effect.gen(function* () {
        const host = yield* ExtensionHost
        yield* host.register(
          "request",
          request({
            id: "queue-if-latest",
            input: Schema.Struct({ ifLatest: MessageId, sourceId: Schema.String }),
            output: Schema.Struct({ sent: Schema.Boolean }),
            answersDuringTurn: true,
            execute: Effect.fn("QueueIfLatest.execute")(function* (input) {
              const ctx = yield* ExtensionContext
              yield* Deferred.succeed(gate.reached, void 0)
              yield* Deferred.await(gate.release)
              yield* ctx.Session.send({
                delivery: "queue",
                sourceId: input.sourceId,
                content: "continue where it stopped",
                ifLatest: input.ifLatest,
                wake: true,
              })
              return { sent: true }
            }),
          }),
        )
      }),
    })

  const queueIfLatest = (
    harness: Effect.Success<ReturnType<typeof createRpcHarness>>,
    input: { readonly ifLatest: MessageId; readonly sourceId: string },
  ) =>
    harness.client.extension.request({
      ...branchOf(harness),
      extensionId,
      capabilityId: "queue-if-latest",
      input,
    })

  const userIds = (messages: ReadonlyArray<{ readonly id: MessageId; readonly role: string }>) =>
    messages
      .values()
      .filter((message) => message.role === "user")
      .map((message) => message.id)
      .toArray()

  const answered = (
    messages: ReadonlyArray<{ readonly role: string; readonly parts: Message["parts"] }>,
    text: string,
  ) =>
    messages.some(
      (message) => message.role === "assistant" && messagePartsDisplayText(message.parts) === text,
    )

  it.scopedLive("the branch's newest message takes the queued line and starts its turn", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        textStep("first answer"),
        textStep("continued"),
      ])
      const released = yield* Deferred.make<void>()
      yield* Deferred.succeed(released, void 0)
      const harness = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer,
        extensionInputs: [
          ...e2ePreset.extensionInputs,
          conditionalQueue({ reached: yield* Deferred.make<void>(), release: released }),
        ],
      })
      const ids = branchOf(harness)
      yield* harness.client.message.send({ ...ids, content: "start the task" })
      const [first] = userIds(
        yield* waitFor(
          harness.client.message.list(ids),
          (messages) => answered(messages, "first answer"),
          5_000,
          "the first turn answered",
        ),
      )
      yield* queueIfLatest(harness, {
        ifLatest: Option.getOrThrow(Option.fromUndefinedOr(first)),
        sourceId: "go-on",
      })
      yield* waitFor(
        harness.client.message.list(ids),
        (messages) => answered(messages, "continued"),
        5_000,
        "the queued line's turn answered",
      )
      yield* controls.assertDone
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("a message sent while the line waits keeps it out of the branch", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        textStep("first answer"),
        textStep("second answer"),
      ])
      const gate = { reached: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
      const harness = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer,
        extensionInputs: [...e2ePreset.extensionInputs, conditionalQueue(gate)],
      })
      const ids = branchOf(harness)
      yield* harness.client.message.send({ ...ids, content: "start the task" })
      const [first] = userIds(
        yield* waitFor(
          harness.client.message.list(ids),
          (messages) => answered(messages, "first answer"),
          5_000,
          "the first turn answered",
        ),
      )
      const queued = yield* queueIfLatest(harness, {
        ifLatest: Option.getOrThrow(Option.fromUndefinedOr(first)),
        sourceId: "go-on",
      }).pipe(Effect.forkScoped)
      // The line decided to send; before it queues, the user sends and is answered.
      yield* Deferred.await(gate.reached)
      yield* harness.client.message.send({ ...ids, content: "do something else" })
      yield* waitFor(
        Effect.all([harness.client.message.list(ids), harness.client.session.getSnapshot(ids)]),
        ([messages, snapshot]) =>
          answered(messages, "second answer") && snapshot.runtime._tag === "Idle",
        5_000,
        "the user's turn answered",
      )
      yield* Deferred.succeed(gate.release, void 0)
      yield* Fiber.join(queued)
      // The send returned after its admission was decided: nothing was admitted.
      const messages = yield* harness.client.message.list(ids)
      expect(userIds(messages)).toHaveLength(2)
      expect(yield* harness.client.queue.get(ids)).toEqual({ steering: [], followUp: [] })
      expect((yield* harness.client.session.getSnapshot(ids)).runtime._tag).toBe("Idle")
      yield* controls.assertDone
    }).pipe(Effect.timeout("10 seconds")),
  )

  /**
   * A mutation request that queues a line on a condition and then keeps the
   * side-mutation permit. The admitted line cannot start while it holds the
   * permit; `sent` says the admission is decided.
   */
  const queueThenHold = (sent: Deferred.Deferred<void>) =>
    defineExtension({
      id: extensionId,
      setup: Effect.gen(function* () {
        const host = yield* ExtensionHost
        yield* host.register(
          "request",
          request({
            id: "queue-then-hold",
            input: Schema.Struct({ ifLatest: MessageId, sourceId: Schema.String }),
            output: Schema.Struct({ sent: Schema.Boolean }),
            execute: Effect.fn("QueueThenHold.execute")(function* (input) {
              const ctx = yield* ExtensionContext
              yield* ctx.Session.send({
                delivery: "queue",
                sourceId: input.sourceId,
                content: "continue where it stopped",
                ifLatest: input.ifLatest,
                wake: true,
              })
              yield* Deferred.succeed(sent, void 0)
              return yield* Effect.never
            }),
          }),
        )
      }),
    })

  // An accepted line is a promise. The server closes after the admission and
  // before the turn starts; the next server runs the line once, without a
  // check of its condition against the branch it finds.
  it.scopedLive(
    "a line accepted before a restart runs once after it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-conditional-restart-" })
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "gent-test-cwd-" })
        const layerFor = (
          providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
          sent: Deferred.Deferred<void>,
        ) =>
          createE2ELayer({
            ...e2ePreset,
            providerLayer,
            storagePath: `${directory}/gent.db`,
            cwd,
            extensionInputs: [...e2ePreset.extensionInputs, queueThenHold(sent)],
          })

        const { layer: firstProvider, controls: firstControls } =
          yield* LanguageModelLayers.sequence([textStep("first answer")])
        const sent = yield* Deferred.make<void>()
        const ids = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(layerFor(firstProvider, sent))
            const created = yield* client.session.create({ cwd })
            const ids = { sessionId: created.sessionId, branchId: created.branchId }
            yield* client.message.send({ ...ids, content: "start the task" })
            const [first] = userIds(
              yield* waitFor(
                Effect.all([client.message.list(ids), client.session.getSnapshot(ids)]),
                ([messages, snapshot]) =>
                  answered(messages, "first answer") && snapshot.runtime._tag === "Idle",
                5_000,
                "the first turn answered",
              ).pipe(Effect.map(([messages]) => messages)),
            )
            yield* client.extension
              .request({
                ...ids,
                extensionId,
                capabilityId: "queue-then-hold",
                input: {
                  ifLatest: Option.getOrThrow(Option.fromUndefinedOr(first)),
                  sourceId: "go-on",
                },
              })
              .pipe(Effect.ignore, Effect.forkScoped)
            // The line is accepted; its turn waits for the permit the request holds.
            yield* Deferred.await(sent)
            expect(userIds(yield* client.message.list(ids))).toHaveLength(1)
            return ids
          }),
        )
        yield* firstControls.assertDone

        const { layer: secondProvider, controls } = yield* LanguageModelLayers.sequence([
          textStep("continued"),
        ])
        const { client } = yield* createRpcClient(
          layerFor(secondProvider, yield* Deferred.make<void>()),
        )
        const [messages] = yield* waitFor(
          Effect.all([client.message.list(ids), client.session.getSnapshot(ids)]),
          ([listed, snapshot]) => answered(listed, "continued") && snapshot.runtime._tag === "Idle",
          5_000,
          "the accepted line ran after the restart",
        )
        const lines = messages.filter(
          (message) =>
            message.role === "user" &&
            messagePartsDisplayText(message.parts) === "continue where it stopped",
        )
        expect(lines).toHaveLength(1)
        expect(yield* client.queue.get(ids)).toEqual({ steering: [], followUp: [] })
        yield* controls.assertDone
      }).pipe(Effect.provide(BunPlatformLive), Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive("a steer parked on the idle branch keeps the line out", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        textStep("first answer"),
      ])
      const released = yield* Deferred.make<void>()
      yield* Deferred.succeed(released, void 0)
      const harness = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer,
        extensionInputs: [
          ...e2ePreset.extensionInputs,
          conditionalQueue({ reached: yield* Deferred.make<void>(), release: released }),
        ],
      })
      const ids = branchOf(harness)
      yield* harness.client.message.send({ ...ids, content: "start the task" })
      const [first] = userIds(
        yield* waitFor(
          Effect.all([harness.client.message.list(ids), harness.client.session.getSnapshot(ids)]),
          ([messages, snapshot]) =>
            answered(messages, "first answer") && snapshot.runtime._tag === "Idle",
          5_000,
          "the first turn answered",
        ).pipe(Effect.map(([messages]) => messages)),
      )
      // Without `wake`, a steer on an idle branch waits for the next turn.
      yield* harness.client.steer.command({
        command: {
          _tag: "Interject",
          ...ids,
          requestId: RequestId.make("parked"),
          message: "look at the loader first",
        },
      })
      yield* queueIfLatest(harness, {
        ifLatest: Option.getOrThrow(Option.fromUndefinedOr(first)),
        sourceId: "go-on",
      })
      const queue = yield* harness.client.queue.get(ids)
      expect(queue.steering).toHaveLength(1)
      expect(queue.followUp).toEqual([])
      expect((yield* harness.client.session.getSnapshot(ids)).runtime._tag).toBe("Idle")
      expect(userIds(yield* harness.client.message.list(ids))).toHaveLength(1)
      yield* controls.assertDone
    }).pipe(Effect.timeout("10 seconds")),
  )
})

// ── models facet ─────────────────────────────────────────────────────────────

describe("models facet via RPC", () => {
  const extensionId = ExtensionId.make("@gent/test-models")
  /** A variable no test run sets: the judge has a credential only when the test stores one. */
  const JUDGE_ENV = "GENT_TEST_MODELS_JUDGE_KEY_NEVER_SET"

  const classifierModel = (name: string, price: Option.Option<number>) =>
    Model.make({
      id: ModelId.make(`judge/${name}`),
      name,
      provider: ProviderId.make("judge"),
      kind: "classifier",
      ...Option.match(price, {
        onNone: () => ({}),
        onSome: (perMillion) => ({ pricing: { input: perMillion, output: perMillion } }),
      }),
    })

  /**
   * The usage the judge reports for an input: an input that names a missing
   * count leaves that count out, as a provider that does not report it does.
   */
  const judgeCounts = (input: string): readonly [Option.Option<number>, Option.Option<number>] => {
    if (input === "no counts") return [Option.none(), Option.none()]
    if (input === "input only") return [Option.some(21), Option.none()]
    if (input === "output only") return [Option.none(), Option.some(21)]
    if (input === "fractional") return [Option.some(21.5), Option.some(0)]
    return [Option.some(21), Option.some(0)]
  }
  const judgeUsage = (input: string) => {
    const [inputTokens, outputTokens] = judgeCounts(input)
    return {
      inputTokens: Option.getOrUndefined(inputTokens),
      outputTokens: Option.getOrUndefined(outputTokens),
    }
  }

  /** Three classifiers, listed dearest first; each answers the first label with 21 input tokens. */
  const judgeDriver: ModelDriverContribution = {
    id: "judge",
    name: "Judge",
    envCredential: JUDGE_ENV,
    resolveModel: () => Effect.die("judge serves classifier models only"),
    listModels: () =>
      Effect.succeed([
        classifierModel("jev-dear", Option.some(2)),
        classifierModel("jev-free", Option.none()),
        classifierModel("jev-cheap", Option.some(0.1)),
      ]),
    resolveDecisionModel: () =>
      Effect.succeed(
        Layer.effect(
          DecisionModel.DecisionModel,
          DecisionModel.make({
            decide: (options) =>
              Effect.succeed({
                answers: Object.fromEntries(
                  Object.entries(options.decisions).map(([name, decision]) => {
                    let labels: ReadonlyArray<string> = []
                    if (decision._tag === "Classify") labels = Object.keys(decision.criteria)
                    return [
                      name,
                      {
                        _tag: "Classify" as const,
                        label: labels[0] ?? "",
                        probabilities: Object.fromEntries(
                          labels.map((label, index) => [label, Number(index === 0)]),
                        ),
                        confidence: 0.9,
                      },
                    ]
                  }),
                ),
                usage: judgeUsage(
                  Option.getOrElse(
                    Schema.decodeUnknownOption(Schema.String)(options.state),
                    () => "",
                  ),
                ),
              }),
          }),
        ),
      ),
  }

  const Ask = request({
    id: "ask",
    input: Schema.Struct({
      model: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
    }),
    output: Schema.Struct({
      available: Schema.Boolean,
      classifiers: Schema.Array(Schema.String),
      decided: Schema.String,
    }),
    execute: Effect.fn("Ask.execute")(function* (input) {
      const ctx = yield* ExtensionContext
      const available = yield* ctx.Models.available
      const classifiers = yield* ctx.Models.classifiers
      const decided = yield* ctx.Models.decide({
        definition: Decision.make({
          input: Schema.String,
          decisions: {
            team: Decision.classify({
              instructions: "Which team",
              criteria: { billing: "payments", technical: "bugs" },
            }),
          },
        }),
        input: input.text ?? "charged twice",
        ...omitUndefined({ model: input.model }),
      }).pipe(
        Effect.map(
          (reply) => `${reply.model} ${reply.answers.team.label} ${String(reply.costUsd)}`,
        ),
        Effect.catch((error) => Effect.succeed(`error: ${error.message}`)),
      )
      return { available, classifiers: classifiers.map((model) => model.id), decided }
    }),
  })

  const extension = defineExtension({
    id: extensionId,
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* host.register("modelDriver", judgeDriver)
      yield* host.register("request", Ask)
    }),
  })

  it.scopedLive(
    "an extension asks the classifiers through ExtensionContext.Models: none without a credential, the cheapest first with one",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
        const harness = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          extensionInputs: [...e2ePreset.extensionInputs, extension],
        })
        const ask = (model: Option.Option<string>, text?: string) =>
          harness.client.extension
            .request({
              sessionId: harness.sessionId,
              branchId: harness.branchId,
              extensionId,
              capabilityId: Ask.id,
              input: {
                ...Option.match(model, { onNone: () => ({}), onSome: (id) => ({ model: id }) }),
                ...omitUndefined({ text }),
              },
            })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Ask.output)))

        const before = yield* ask(Option.none())
        expect(before.available).toBe(false)
        expect(before.classifiers).toEqual([])
        expect(before.decided).toContain(
          "error: models.decide: No classifier model has a credential",
        )

        yield* harness.client.auth.setKey({
          provider: "judge",
          key: "judge-key",
          sessionId: harness.sessionId,
        })
        const named = yield* ask(Option.some("judge/jev-dear"))
        expect(named.available).toBe(true)
        expect(named.classifiers).toEqual(["judge/jev-cheap", "judge/jev-dear", "judge/jev-free"])
        // 21 input tokens at $2/M.
        expect(named.decided).toBe(`judge/jev-dear billing ${String((21 * 2) / 1_000_000)}`)
        const unpriced = yield* ask(Option.some("judge/jev-free"))
        expect(unpriced.decided).toBe("judge/jev-free billing undefined")
        // A priced classifier whose reply leaves a billable count out, or
        // reports one no provider bills, has no known price: never a partial sum.
        for (const text of ["no counts", "input only", "output only", "fractional"]) {
          const partial = yield* ask(Option.some("judge/jev-dear"), text)
          expect([text, partial.decided]).toEqual([text, "judge/jev-dear billing undefined"])
        }
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
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
            toolPolicy: { modelSet: ["builtin-tool"] },
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
        { modelSet: ["builtin-tool"] },
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
            toolPolicy: { modelSet: ["still-runs"] },
          }),
        ),
      ])

      const result = yield* compiled
        .resolveTurnProjection(hookCtx.projection)
        .pipe(Effect.provideService(CurrentExtensionHostContext, hookCtx.host))
      expect(result.promptSections).toEqual([{ id: "good", content: "still-runs", priority: 50 }])
      expect(result.policyFragments).toEqual([{ modelSet: ["still-runs"] }])
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

const sharedLayer = Layer.mergeAll(fsLayer, ConfigService.Test(), testSqliteStorage)

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
          yield* scanRuntimeProfileExtensions(inputs, makeModuleGraphs()),
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
          yield* scanRuntimeProfileExtensions(inputs, makeModuleGraphs()),
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
          yield* scanRuntimeProfileExtensions(inputs, makeModuleGraphs()),
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
          cwd: "/nonexistent/gent-test-cwd",
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
              cwd: "/nonexistent/gent-test-cwd",
              home: "/nonexistent/gent-test-home",
              platform: "darwin",
              extensions: [extension],
            })

            const hookCtx = {
              projection: {
                sessionId: SessionId.make("s"),
                branchId: BranchId.make("b"),
                agent: testAgent,
                agentName: AgentName.make("primary"),
                allTools: [],
              },
              host: testExtensionHostContext({
                sessionId: SessionId.make("s"),
                branchId: BranchId.make("b"),
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
            cwd: "/nonexistent/gent-test-cwd",
            home: "/nonexistent/gent-test-home",
            platform: "darwin",
            extensions,
          })
          expect(Context.get(runtime.layerContext, PrecedenceProbe).value).toBe(expected)
        }

        expect(starts).toBe(2)
      }),
    ).pipe(Effect.provide(sharedLayer)))
})

describe("extensions facet via RPC", () => {
  const ExtensionStatuses = Schema.Array(ExtensionStatus)
  const statusTool = defineExtension({
    id: "@test/extensions-status",
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* host.register(
        "tool",
        tool({
          id: "extension_status",
          description: "List the session's extensions",
          params: Schema.Struct({}),
          output: ExtensionStatuses,
          execute: () =>
            Effect.gen(function* () {
              const ctx = yield* ExtensionContext
              return yield* ctx.Extensions.status
            }),
        }),
      )
    }),
  })

  it.live(
    "a tool reads an extension added while gent runs as failed, at the phase that stopped it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-extensions-facet-home-" })
        const project = yield* fs.makeTempDirectoryScoped({ prefix: "gent-extensions-facet-cwd-" })
        const extensionsDir = path.join(home, ".gent", "extensions")
        yield* fs.makeDirectory(extensionsDir, { recursive: true })
        yield* fs.makeDirectory(path.join(project, ".gent"), { recursive: true })
        yield* fs.writeFileString(
          path.join(project, ".gent", "config.json"),
          encodeJson({ disabledExtensions: ["@test/switched-off"] }),
        )
        const switchedOff = defineExtension({ id: "@test/switched-off", setup: Effect.void })
        yield* Effect.gen(function* () {
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
            toolCallStep("extension_status", {}),
            textStep("listed"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            agents: [testAgent],
            extensionInputs: [testTurnExtension, statusTool, switchedOff],
            providerLayer,
            home,
            cwd: project,
            configServiceLayer: ConfigService.Live.pipe(
              Layer.provide(RuntimeEnvironment.Live({ cwd: project, home })),
              Layer.provide(BunPlatformLive),
            ),
            // This test is about the failure report, so the turn must survive it.
            allowFailedExtensions: true,
          })
          // Written after the server started: one fails its setup, one never imports.
          yield* fs.writeFileString(
            path.join(extensionsDir, "broken.ts"),
            [
              'import { Effect } from "effect";',
              'import { defineExtension } from "@gent/core/extensions/api";',
              'export default defineExtension({ id: "@test/broken", setup: Effect.die("setup boom") });',
              "",
            ].join("\n"),
          )
          yield* fs.writeFileString(path.join(extensionsDir, "half.ts"), "export default {\n")
          const turn = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.takeUntil(({ event }) => event._tag === "TurnCompleted"),
            Stream.runCollect,
            Effect.forkScoped,
          )
          yield* client.message.send({ sessionId, branchId, content: "list extensions" })
          const events = Array.from(yield* Fiber.join(turn)).map(({ event }) => event)
          yield* controls.assertDone
          const succeeded = events.find((event) => event._tag === "ToolCallSucceeded")
          if (succeeded?._tag !== "ToolCallSucceeded") return expect.unreachable()
          // The model reads a tool's output as JSON text.
          const statuses = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(ExtensionStatuses),
          )(succeeded.output)
          const byId = new Map(statuses.map((status) => [status.id, status]))
          expect(byId.get("@test/broken")).toMatchObject({ _tag: "Failed", phase: "setup" })
          expect(byId.get("half")).toMatchObject({ _tag: "Failed", phase: "load" })
          expect(byId.get("@test/switched-off")).toMatchObject({
            _tag: "Disabled",
            scope: "builtin",
          })
          expect(byId.get("@test/extensions-status")).toMatchObject({ _tag: "Active" })

          // Health lists the disabled extension apart from the others.
          const health = yield* client.extension.listStatus({
            scope: { _tag: "Session", id: sessionId },
          })
          expect(health.disabledExtensions?.map((entry) => entry.manifest.id)).toEqual([
            "@test/switched-off",
          ])
        }).pipe(Effect.scoped, Effect.timeout("12 seconds"))
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    15_000,
  )

  it.live(
    "a reload sets an extension up again and keeps its process Resource",
    () =>
      Effect.gen(function* () {
        const setups = yield* Ref.make(0)
        const acquired = yield* Ref.make(0)
        const released = yield* Ref.make(0)
        class Counter extends Context.Service<Counter, { readonly id: string }>()(
          "@gent/core/tests/runtime/extension-host.test/Counter",
        ) {}
        const Reload = request({
          id: "reload",
          input: Schema.String,
          output: Schema.String,
          execute: (id) =>
            Effect.gen(function* () {
              const ctx = yield* ExtensionContext
              const statuses = yield* ctx.Extensions.reload(id)
              return statuses.map((status) => `${status._tag}:${status.id}`).join(",")
            }).pipe(Effect.catchEager((error) => Effect.succeed(error.message))),
        })
        const reloadable = defineExtension({
          id: "@test/reloadable",
          setup: Effect.gen(function* () {
            yield* Ref.update(setups, (count) => count + 1)
            const host = yield* ExtensionHost
            yield* host.register(
              "resource",
              defineResource({
                id: "@test/reloadable/counter",
                scope: "process",
                layer: Layer.effect(
                  Counter,
                  Effect.acquireRelease(
                    Ref.update(acquired, (count) => count + 1).pipe(
                      Effect.as(Counter.of({ id: "counter" })),
                    ),
                    () => Ref.update(released, (count) => count + 1),
                  ),
                ),
              }),
            )
            yield* host.register("request", Reload)
          }),
        })
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: [testAgent],
          extensionInputs: [testTurnExtension, reloadable],
          providerLayer,
        })
        const reload = (id: string) =>
          client.extension.request({
            sessionId,
            branchId,
            extensionId: ExtensionId.make("@test/reloadable"),
            capabilityId: "reload",
            input: id,
          })

        // The first request resolves the session's profile.
        yield* reload("@test/nope")
        const setupsBefore = yield* Ref.get(setups)
        expect(yield* Ref.get(acquired)).toBe(1)

        const statuses = yield* reload("@test/reloadable")
        expect(statuses).toContain("Active:@test/reloadable")
        expect(yield* Ref.get(setups)).toBe(setupsBefore + 1)
        expect(yield* Ref.get(acquired)).toBe(1)
        expect(yield* Ref.get(released)).toBe(0)

        // An id the profile does not name fails, and sets nothing up.
        expect(yield* reload("@test/nope")).toContain('No extension "@test/nope"')
        expect(yield* Ref.get(setups)).toBe(setupsBefore + 1)
      }).pipe(Effect.scoped, Effect.timeout("8 seconds")),
    10_000,
  )
})

describe("profile revision via RPC", () => {
  const switchable = defineExtension({
    id: "@test/switchable",
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* host.register(
        "tool",
        tool({
          id: "switchable_tool",
          description: "A tool a config can turn off",
          params: Schema.Struct({ text: Schema.String }),
          output: Schema.String,
          execute: () => Effect.succeed("on"),
        }),
      )
      yield* host.register(
        "request",
        request({
          id: "reload",
          input: Schema.String,
          output: Schema.String,
          execute: (id) =>
            Effect.gen(function* () {
              const ctx = yield* ExtensionContext
              yield* ctx.Extensions.reload(id)
              return id
            }).pipe(Effect.catchEager((error) => Effect.succeed(error.message))),
        }),
      )
    }),
  })

  interface Captured {
    readonly system: string
    readonly tools: string
    readonly toolNames: ReadonlyArray<string>
  }

  it.live(
    "each request names what its extensions show the model: a body edit or a reload keeps it; an added, reordered or retyped tool, a changed prompt line or a disabled extension changes it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-revision-home-" })
        const project = yield* fs.makeTempDirectoryScoped({ prefix: "gent-revision-cwd-" })
        const extensionsDir = path.join(home, ".gent", "extensions")
        yield* fs.makeDirectory(extensionsDir, { recursive: true })
        const probeFile = path.join(extensionsDir, "probe.ts")
        yield* fs.writeFileString(probeFile, probeSource("v1", ["probe_one"]))
        const captured = yield* Ref.make<ReadonlyArray<Captured>>([])
        const providerLayer = LanguageModelLayers.testStream((options) =>
          Effect.gen(function* () {
            const tools = options.tools.map((entry) => ({
              name: entry.name,
              description: entry.description,
              parameters: AiTool.getJsonSchema(entry),
            }))
            yield* Ref.update(captured, (all) => [
              ...all,
              {
                system: turnRequestText(Prompt.make(options.prompt)).systemPrompt,
                tools: encodeJson(tools),
                toolNames: tools.map((entry) => entry.name),
              },
            ])
            return Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })])
          }),
        )
        yield* Effect.gen(function* () {
          const { client, sessionId, branchId } = yield* createRpcHarness({
            agents: [testAgent],
            extensionInputs: [testTurnExtension, switchable],
            providerLayer,
            home,
            cwd: project,
            configServiceLayer: ConfigService.Live.pipe(
              Layer.provide(RuntimeEnvironment.Live({ cwd: project, home })),
              Layer.provide(BunPlatformLive),
            ),
          })
          const turn = (content: string) =>
            Effect.gen(function* () {
              const events = yield* client.session.events({ sessionId, branchId }).pipe(
                Stream.filter(({ event }) => event._tag !== "StreamSynchronized"),
                Stream.dropWhile(
                  ({ event }) =>
                    !(
                      event._tag === "MessageReceived" &&
                      messagePartsDisplayText(event.message.parts) === content
                    ),
                ),
                Stream.takeUntil(({ event }) => event._tag === "TurnCompleted"),
                Stream.runCollect,
                Effect.forkScoped,
              )
              yield* client.message.send({ sessionId, branchId, content })
              const started = Array.from(yield* Fiber.join(events))
                .map(({ event }) => event)
                .filter((event) => event._tag === "StreamStarted")
              expect(started).toHaveLength(1)
              return started[0]?.profileRevision
            })

          const first = yield* turn("first")
          const unchanged = yield* turn("unchanged")
          yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: ExtensionId.make("@test/switchable"),
            capabilityId: "reload",
            input: "@test/switchable",
          })
          const reloaded = yield* turn("reloaded")
          yield* fs.writeFileString(probeFile, probeSource("v2", ["probe_one"]))
          const bodyEdit = yield* turn("body edit")
          yield* fs.writeFileString(probeFile, probeSource("v2", ["probe_one", "probe_two"]))
          const added = yield* turn("added tool")
          yield* fs.writeFileString(probeFile, probeSource("v2", ["probe_two", "probe_one"]))
          const reordered = yield* turn("reordered tools")
          yield* fs.writeFileString(
            probeFile,
            probeSource("v2", ["probe_two", "probe_one"], { guideline: "Probe with care." }),
          )
          const guided = yield* turn("prompt line")
          yield* fs.writeFileString(
            probeFile,
            probeSource(`2`, ["probe_two", "probe_one"], {
              guideline: "Probe with care.",
              output: "Schema.Number",
            }),
          )
          const retyped = yield* turn("output schema")
          yield* fs.writeFileString(
            path.join(home, ".gent", "config.json"),
            encodeJson({ disabledExtensions: ["@test/switchable"] }),
          )
          const disabled = yield* turn("disabled")

          const requests = yield* Ref.get(captured)
          expect(requests).toHaveLength(9)
          const [a, b, , c, d, r, , , e] = requests
          if (
            Predicate.isUndefined(a) ||
            Predicate.isUndefined(b) ||
            Predicate.isUndefined(c) ||
            Predicate.isUndefined(d) ||
            Predicate.isUndefined(r) ||
            Predicate.isUndefined(e)
          ) {
            return expect.unreachable()
          }
          // No change: the same profile, the same bytes.
          expect(first).toBeDefined()
          expect(unchanged).toBe(first)
          expect(b).toEqual(a)
          // A reload sets the same code up again: the model reads the same.
          expect(reloaded).toBe(unchanged)
          // A tool body edit is a new version and costs nothing: the bytes
          // stay, and the request names the same surface.
          expect(bodyEdit).toBe(unchanged)
          expect(c).toEqual(b)
          // An added tool and a disabled extension change what the model reads.
          expect(added).not.toBe(bodyEdit)
          expect(d.toolNames).toContain("probe_two")
          expect(d.tools).not.toBe(c.tools)
          // The request keeps the registration order, so an order change is
          // a change the model reads; so are a prompt line and a result type.
          expect(r.toolNames.indexOf("probe_two")).toBeLessThan(r.toolNames.indexOf("probe_one"))
          expect(reordered).not.toBe(added)
          expect(guided).not.toBe(reordered)
          expect(retyped).not.toBe(guided)
          expect(disabled).not.toBe(retyped)
          expect(e.toolNames).not.toContain("switchable_tool")
          expect(e.tools).not.toBe(d.tools)
        }).pipe(Effect.scoped, Effect.timeout("20 seconds"))
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    25_000,
  )
})
