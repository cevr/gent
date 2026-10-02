import {
  Context,
  DateTime,
  Effect,
  HashMap,
  Layer,
  Option,
  Path,
  Predicate,
  Random,
  Ref,
  Schema,
  Stream,
  TxRef,
} from "effect"
import {
  type AnyExtensionHook,
  ExtensionContext,
  type ExtensionContextService,
  type ExtensionContributions,
  extensionServicesFromHostContext,
  type ExtensionFileLockServiceApi,
  ExtensionHost,
  type ExtensionHostContext,
  type ExtensionHostPlatform,
  type ExtensionHostService,
  type ExtensionInteractionService,
  type ExtensionSessionService,
  type ExtensionSetupServices,
  type ExtensionStateFacet,
  FileLockService,
  type GentExtension,
  type LoadedExtension,
  makeCollectingExtensionHost,
  makeFileLockTable,
  provideExtensionServices,
} from "../domain/extension.js"
import {
  BranchId,
  ExtensionId,
  type InteractionRequestId,
  type MessageId,
  ProcessGenerationId,
  SessionId,
  ToolCallId,
  ToolId,
} from "../domain/ids.js"
import {
  AgentDefinition,
  DEFAULT_AGENT_NAME,
  DEFAULT_MODEL_ID,
  Model,
  type ModelPricing,
  parseModelId,
} from "../domain/agent.js"
import { Auth, ModelRegistry } from "../runtime/provider.js"
import {
  getToolMetadata,
  type ToolCapability,
  ToolBindingIdentity,
  ToolBindingSource,
  ToolSchemaRevision,
  ToolSourceRevision,
} from "../domain/capability.js"
import { defineExtension } from "../extensions/api.js"
import {
  ApprovalService,
  ExtensionRegistry,
  makeExtensionHostContextProvider,
  provideCurrentHostCtx,
  resolveExtensions,
  type SessionProfile,
  SessionProfileCache,
} from "../runtime/extension-host.js"
import { ConfigService, RuntimeEnvironment } from "../runtime/config.js"
import { omitUndefined } from "../domain/guards.js"
import {
  type BranchToolFeature,
  captureCurrentToolBinding,
  noBranchTools,
  type ResolvedToolCapability,
  ToolRunner,
} from "../runtime/tools.js"
import { type AgentLoopTurnProfile, runAgentLoopTurnProfile } from "../runtime/turn.js"
import { SessionRuntime } from "../runtime/session.js"
import {
  type AgentLoopClientServices,
  dequeueFollowUpOn,
  stopMessageOn,
  queueFollowUpOn,
} from "../domain/agent-loop.js"
import { type ApprovalDecision, encodeInteractionDecision } from "../domain/interaction.js"
import { LanguageModelLayers, makeTempDirectoryScoped } from "./language-model.js"
import {
  createDependencies,
  makeInProcessClient,
  RpcHandlersLive,
  StateLocation,
} from "../server/server.js"
import { workspaceHeadersForCwd } from "../server/workspace-rpc.js"
import {
  Branch,
  type Message,
  QueueSnapshot,
  Session,
  SessionAdmission,
} from "../domain/message.js"
import type { StorageError } from "../domain/errors.js"
import {
  AgentLoopQueueStorage,
  BranchStorage,
  EventStorage,
  type ExtraRepositories,
  InteractionStorage,
  SessionStorage,
  SqliteStorage,
  ToolCallBindingStorage,
} from "../storage/storage.js"
import { type AgentEvent, EventStore, type EventStoreService } from "../domain/event.js"
import { type LanguageModel, Model as AiModel } from "effect/ai"
import { GentPlatform } from "../runtime/gent-platform.js"
import { BunCrypto } from "@effect/platform-bun"
import type { FeatureMigrations } from "../storage/schema.js"
import { BunPlatformLive } from "../runtime/gent-platform-bun.js"

// ── extension-host-context ──────────────────────────────────────────────────

type TestExtensionHostContextOverrides = Omit<
  Partial<ExtensionHostContext>,
  "Session" | "Interaction"
> & {
  readonly Session?: Partial<ExtensionSessionService>
  readonly Interaction?: Partial<ExtensionInteractionService>
}

const die = (operation: string) =>
  Effect.die(new Error(`unconfigured test ExtensionHostContext.${operation}`))

const defaultSession = (): ExtensionSessionService => ({
  getSession: () => die("Session.getSession"),
  getDetail: () => die("Session.getDetail"),
  renameCurrent: () => die("Session.renameCurrent"),
  create: () => die("Session.create"),
  delete: () => die("Session.delete"),
  send: () => die("Session.send"),
  stop: () => die("Session.stop"),
  stopMessage: () => die("Session.stopMessage"),
  events: () => Stream.die("Session.events"),
  dequeueFollowUp: () => die("Session.dequeueFollowUp"),
  // A test context runs outside a loop: there is no entity to hold.
  holdResident: Effect.void,
  listBranches: die("Session.listBranches"),
  listSessions: () => die("Session.listSessions"),
  listActiveLoops: die("Session.listActiveLoops"),
})

const defaultInteraction = (): ExtensionInteractionService => ({
  approve: () => die("Interaction.approve"),
  present: () => die("Interaction.present"),
})

/** The one host platform stub: a darwin box. */
const testExtensionHostPlatform = (
  home: string = "/nonexistent/gent-test-home",
): ExtensionHostPlatform => ({
  osInfo: {
    platform: "darwin",
    arch: "arm64",
    release: "test",
    hostname: "test-host",
    type: "Darwin",
  },
  homeDirectory: home,
  randomId: Random.nextInt.pipe(Effect.map((value) => `test-${value}`)),
})

/**
 * The file-lock service over a lock table the test can count: `lockedPaths`
 * is how many paths a caller holds or waits on. The product never reads the
 * table's size; a test reads it to prove that the last release evicts.
 */
export const fileLockProbe = Effect.map(makeFileLockTable, (locks) => ({
  layer: FileLockService.over(locks),
  lockedPaths: Effect.map(TxRef.get(locks), HashMap.size),
}))

const testExtensionFileLock = (): ExtensionFileLockServiceApi => ({
  withLock: (_path, effect) => effect,
})

const testExtensionState = (): ReturnType<ExtensionStateFacet> => ({
  changed: () => Effect.void,
})

export const testExtensionHostContext = (
  overrides: TestExtensionHostContextOverrides = {},
): ExtensionHostContext => ({
  sessionId: overrides.sessionId ?? SessionId.make("test-session"),
  branchId: overrides.branchId ?? BranchId.make("test-branch"),
  cwd: overrides.cwd ?? "/nonexistent/gent-test-cwd",
  home: overrides.home ?? "/nonexistent/gent-test-home",
  host: overrides.host ?? testExtensionHostPlatform(overrides.home),
  agentName: overrides.agentName,
  Session: { ...defaultSession(), ...overrides.Session },
  Interaction: { ...defaultInteraction(), ...overrides.Interaction },
  FileLock: overrides.FileLock ?? testExtensionFileLock(),
  State: overrides.State ?? (() => testExtensionState()),
})

// ── test-root ───────────────────────────────────────────────────────────────

// What the test composition root shares with its presets: a working
// directory and a home of its own (see `createE2ELayer`), a deterministic
// server identity, and an agents extension. `createE2ELayer` is the one root;
// the in-process layer and the RPC harness are presets over it. The stub
// contexts above (`testExtensionHostContext`, `testToolContext`,
// `testHostFacts`) have no scope to make a directory in, so their default cwd
// is a path no test can create; a test that touches files passes its own.

const testAgentsExtension = (agents: ReadonlyArray<AgentDefinition>) =>
  defineExtension({
    id: "test-agents",
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* host.register("agent", ...agents)
    }),
  })

/** The agent a test runs when it names none: `main`, on the default model. */
export const testAgent = AgentDefinition.make({
  name: DEFAULT_AGENT_NAME,
  description: "Test agent",
})

/** A queue with no steering and no follow-up entries. */
export const emptyQueueSnapshot = (): QueueSnapshot =>
  new QueueSnapshot({ steering: [], followUp: [] })

const [defaultProviderId, defaultModelName] = Option.getOrThrow(parseModelId(DEFAULT_MODEL_ID))

/**
 * What an `extensionInputs` preset needs for a turn to run beside `agents:
 * [testAgent]`: a driver that lists the default model. The driver's model is never called; the test
 * hands the runtime its own language model through `providerLayer`.
 */
export const testTurnExtension = defineExtension({
  id: "test-turn",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("modelDriver", {
      id: defaultProviderId,
      name: "Test driver",
      listModels: () =>
        Effect.succeed([
          new Model({
            id: DEFAULT_MODEL_ID,
            name: "Test model",
            provider: defaultProviderId,
            contextLength: 128_000,
          }),
        ]),
      resolveModel: () =>
        Effect.succeed(
          AiModel.make(defaultProviderId, defaultModelName, LanguageModelLayers.failing),
        ),
    })
  }),
})

/**
 * One stub that serves both halves of the boundary: a host context a runtime
 * test can provide as `CurrentExtensionHostContext`, and, through
 * `runToolWithCtx`, the leaf view a tool sees. `State` keeps the host's
 * extension-id form; `runToolWithCtx` applies the leaf id the same way
 * production does.
 */
export type TestToolContext = ExtensionHostContext &
  Omit<ExtensionContextService, "State"> & {
    readonly toolCallId: ToolCallId
  }

type TestToolContextOverrides = Omit<Partial<TestToolContext>, "State"> & {
  /** Accepts the flat leaf facet; it is lifted to the host's id-taking form. */
  readonly State?: ReturnType<ExtensionStateFacet>
}

/** Default ToolCapabilityContext for tests — overridable via spread */
export const testToolContext = (overrides?: TestToolContextOverrides): TestToolContext => {
  const host = testExtensionHostContext().host
  const resolvedSession = overrides?.Session ?? defaultSession()
  const resolvedInteraction = overrides?.Interaction ?? defaultInteraction()
  const resolvedFileLock = overrides?.FileLock ?? testExtensionFileLock()
  const resolvedState = overrides?.State ?? testExtensionState()
  const resolvedExtensionId = overrides?.extensionId ?? ExtensionId.make("test-extension")

  return {
    extensionId: resolvedExtensionId,
    sessionId: SessionId.make("test-session"),
    branchId: BranchId.make("test-branch"),
    toolCallId: ToolCallId.make("test-call"),
    cwd: "/nonexistent/gent-test-cwd",
    home: "/nonexistent/gent-test-home",
    host,
    Session: resolvedSession,
    Interaction: resolvedInteraction,
    FileLock: resolvedFileLock,
    ...overrides,
    State: () => resolvedState,
  }
}

/**
 * Runs a tool's effect over a stub host context, wired through
 * `provideExtensionServices` as production wires a tool call, so a test
 * reads the stub's recorded calls.
 */
export const runToolWithCtx = <Input, Output, Error>(
  tool: ToolCapability<Input, Output, Error>,
  input: Input,
  ctx: Omit<TestToolContext, "toolCallId"> & { readonly toolCallId?: ToolCallId },
): Effect.Effect<Output, Error, never> =>
  provideExtensionServices(ctx, getToolMetadata(tool).effect(input))

/**
 * The leaf view of a test host context, derived the way production derives it.
 * Use it where a test provides `ExtensionContext` directly instead of running
 * a tool.
 */
export const testLeafContext = (ctx: TestToolContext): ExtensionContextService =>
  Context.get(extensionServicesFromHostContext(ctx), ExtensionContext)

// ── event recording ─────────────────────────────────────────────────────────

/**
 * The in-memory event store that also keeps each event it appends, in order,
 * in `events`, so a test asserts event order against the store semantics
 * production runs (sliding delivery, the synchronize marker). A publish
 * appends through the recording `append`.
 */
export const recordingEventStore = (events: Ref.Ref<AgentEvent[]>): Layer.Layer<EventStore> =>
  Layer.effect(
    EventStore,
    Effect.gen(function* () {
      const inner = yield* EventStore
      const append: EventStoreService["append"] = Effect.fn("RecordingEventStore.append")(
        function* (event) {
          const envelope = yield* inner.append(event)
          yield* Ref.update(events, (all) => [...all, event])
          return envelope
        },
      )
      return EventStore.of({
        ...inner,
        append,
        publish: Effect.fn("RecordingEventStore.publish")(function* (event) {
          yield* inner.deliver(yield* append(event))
        }),
      })
    }),
  ).pipe(Layer.provide(EventStore.Memory))

// ── test extension host ─────────────────────────────────────────────────────

/** Facts the test extension host reports to `setup` Effects. */
interface TestExtensionHostFacts {
  readonly cwd: string
  readonly home: string
  readonly host: ExtensionHostPlatform
}

export const testHostFacts = (
  overrides?: Partial<Pick<TestExtensionHostFacts, "cwd" | "home">>,
): TestExtensionHostFacts => ({
  cwd: overrides?.cwd ?? "/nonexistent/gent-test-cwd",
  home: overrides?.home ?? "/nonexistent/gent-test-home",
  host: testExtensionHostPlatform(overrides?.home),
})

/**
 * Run a `GentExtension.setup` Effect against a collecting test host and
 * return the sealed contributions, mirroring the production loader.
 */
export const collectTestContributions = <E, R>(
  setup: Effect.Effect<void, E, R>,
  overrides?: Parameters<typeof testHostFacts>[0],
): Effect.Effect<ExtensionContributions, E, Exclude<R, ExtensionHost>> =>
  Effect.gen(function* () {
    const collector = makeCollectingExtensionHost(testHostFacts(overrides))
    yield* setup.pipe(Effect.provideService(ExtensionHost, collector.service))
    return yield* collector.seal
  })

// ── storage fixtures ────────────────────────────────────────────────────────

/**
 * In-memory SQLite storage with its platform closed: deterministic ids from
 * `GentPlatform.Test()` and the Bun `Crypto` the host would provide. Storage
 * tests yield it without wiring a platform layer; product callers use
 * `SqliteStorage.LiveWithSql` / `MemoryWithSql` under the host's platform.
 */
export const testSqliteStorage = <A>(
  extra: ExtraRepositories<A>,
  featureMigrations: FeatureMigrations,
) =>
  SqliteStorage.MemoryWithSql(extra, featureMigrations).pipe(
    Layer.provide(Layer.merge(GentPlatform.Test(), BunCrypto.layer)),
  )

const sameAdmission = Schema.toEquivalence(SessionAdmission)

export function ensureStorageParents(input: {
  readonly sessionId: SessionId | string
  readonly branchId?: never
  readonly admission?: SessionAdmission
}): Effect.Effect<void, StorageError, SessionStorage>
export function ensureStorageParents(input: {
  readonly sessionId: SessionId | string
  readonly branchId: BranchId | string
  readonly admission?: SessionAdmission
}): Effect.Effect<void, StorageError, SessionStorage | BranchStorage>
/**
 * Creates the session and branch a test writes under when they are missing.
 * `admission` is the agent the new session runs as; a session that already
 * exists under another admission is a test fault, since an agent is fixed at
 * creation.
 */
export function ensureStorageParents(input: {
  readonly sessionId: SessionId | string
  readonly branchId?: BranchId | string
  readonly admission?: SessionAdmission
}): Effect.Effect<void, StorageError, SessionStorage | BranchStorage> {
  return Effect.gen(function* () {
    const sessionStorage = yield* SessionStorage
    const sessionId = SessionId.make(input.sessionId)
    const branchId = Option.fromUndefinedOr(input.branchId).pipe(
      Option.map((id) => BranchId.make(id)),
    )
    const now = yield* DateTime.nowAsDate

    const session = yield* sessionStorage.getSession(sessionId)
    if (Predicate.isUndefined(session)) {
      yield* sessionStorage.createSession(
        new Session({
          id: sessionId,
          createdAt: now,
          updatedAt: now,
          ...omitUndefined({ admission: input.admission }),
        }),
      )
    } else if (
      Predicate.isNotUndefined(input.admission) &&
      !sameAdmission(session.admission ?? {}, input.admission)
    ) {
      return yield* Effect.die(
        new Error(`session ${sessionId} already runs under another admission`),
      )
    }

    if (Option.isSome(branchId)) {
      const branchStorage = yield* BranchStorage
      const branch = yield* branchStorage.getBranch(branchId.value)
      if (Predicate.isUndefined(branch)) {
        yield* branchStorage.createBranch(
          new Branch({
            id: branchId.value,
            sessionId,
            createdAt: now,
          }),
        )
      }
    }
  })
}

// ── branch-tool-arrangement ─────────────────────────────────────────────────
//
// A branch tool outside core (the cell) is tested against the host it runs
// in: a turn's profile and captured bindings, a leaf's host context, and the
// durable rows a crash leaves behind. These operations build that state the
// way the loop does, so such a test never reads core's own Tags.

/**
 * Where a turn or leaf runs: its session, its branch, and optionally its cwd.
 * `interactive: false` runs it as a turn no user watches; absent, a user
 * can answer.
 */
interface HarnessRun {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly sessionCwd?: string
  readonly interactive?: boolean
}

const hostRun = (run: HarnessRun) => ({
  ...run,
  interactive: run.interactive ?? true,
  clientRequest: Option.none(),
})

/**
 * One turn's profile and every model tool binding it captures, as the loop
 * builds them before it dispatches a tool.
 */
export const captureTurnTools = Effect.fn("test.captureTurnTools")(function* (run: HarnessRun) {
  const environment = yield* RuntimeEnvironment
  const profile = yield* (yield* SessionProfileCache).resolve(run.sessionCwd ?? environment.cwd)
  const hostProvider = yield* makeExtensionHostContextProvider({
    host: testHostFacts({ cwd: environment.cwd, home: environment.home }).host,
  })
  const turnProfile: AgentLoopTurnProfile = {
    turnGenerationId: profile.generationId,
    turnCapabilityContext: profile.layerContext,
    turnBaseSections: profile.baseSections,
    turnHostCtx: hostProvider.forRun(hostRun(run)),
    turnInteractive: hostRun(run).interactive,
  }
  const toolBindings = yield* Effect.gen(function* () {
    const bindings = new Map<string, ResolvedToolCapability>()
    for (const name of profile.registryService.getResolved().modelCapabilities.keys()) {
      const binding = yield* captureCurrentToolBinding(name)
      if (Option.isSome(binding)) bindings.set(name, binding.value)
    }
    return bindings
  }).pipe(runAgentLoopTurnProfile(turnProfile))
  return { profile: turnProfile, toolBindings }
})

/**
 * The host context a leaf sees on a branch whose session runtime is live: its
 * session facade sends and steers through that runtime, and queues through the
 * branch's actor, as a loop's facade does for another branch.
 */
export const runtimeHostContext = Effect.fn("test.runtimeHostContext")(function* (run: HarnessRun) {
  const runtime = yield* SessionRuntime
  const loopClient = yield* Effect.context<AgentLoopClientServices>()
  const environment = yield* RuntimeEnvironment
  const provider = yield* makeExtensionHostContextProvider({
    host: testHostFacts({ cwd: environment.cwd, home: environment.home }).host,
    sessionControl: {
      queueFollowUp: (input) => queueFollowUpOn(input).pipe(Effect.provideContext(loopClient)),
      dequeueFollowUp: (input) => dequeueFollowUpOn(input).pipe(Effect.provideContext(loopClient)),
      send: (input) => runtime.sendUserMessage(input),
      steer: (command) => runtime.steer(command),
      stopMessage: (input) => stopMessageOn(input).pipe(Effect.provideContext(loopClient)),
      // This leaf runs outside the branch loop: there is no entity to hold.
      holdResident: Effect.void,
    },
  })
  return provider.forRun(hostRun(run))
})

/**
 * Run a leaf's dispatch outside a turn: the registry holds exactly these
 * extensions, and `host` is the host context the leaf reads.
 */
export const provideToolDispatch = (input: {
  readonly extensions: ReadonlyArray<LoadedExtension>
  readonly host: ExtensionHostContext
}) => {
  const resolved = resolveExtensions(input.extensions)
  const registry = ExtensionRegistry.of({ getResolved: () => resolved })
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      provideCurrentHostCtx(input.host),
      Effect.provideService(ExtensionRegistry, registry),
    )
}

/** A build-owned binding identity: it replays across processes. */
export const staticToolBinding = (input: {
  readonly toolId: string
  readonly extensionId: string
  readonly sourceRevision: string
  readonly schemaRevision: string
}): ToolBindingIdentity =>
  ToolBindingIdentity.make({
    toolId: ToolId.make(input.toolId),
    extensionId: ExtensionId.make(input.extensionId),
    source: ToolBindingSource.cases.Static.make({
      sourceRevision: ToolSourceRevision.make(input.sourceRevision),
    }),
    schemaRevision: ToolSchemaRevision.make(input.schemaRevision),
  })

/** Save the binding a tool call's receipt names, as a turn does before it runs the call. */
export const plantToolCallBinding = Effect.fn("test.plantToolCallBinding")(function* (input: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly assistantMessageId: MessageId
  readonly toolCallId: ToolCallId
  readonly binding: ToolBindingIdentity
}) {
  return yield* (yield* ToolCallBindingStorage).save(input)
})

/** Leave a user turn in flight on a branch, as a crash before the turn completes does. */
export const plantInFlightTurn = Effect.fn("test.plantInFlightTurn")(function* (input: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly message: Message
}) {
  yield* (yield* AgentLoopQueueStorage).putQueueState(input.sessionId, input.branchId, {
    steering: [],
    followUp: [],
    inFlight: { message: input.message },
  })
})

/** Write a decision to the durable interaction row only, as a reopened database sees it. */
export const recordInteractionDecision = Effect.fn("test.recordInteractionDecision")(function* (
  branch: { readonly sessionId: SessionId; readonly branchId: BranchId },
  requestId: InteractionRequestId,
  decision: ApprovalDecision,
) {
  const decisionJson = yield* encodeInteractionDecision(decision)
  yield* (yield* InteractionStorage).decide(branch, requestId, decisionJson)
})

/** The durable events one branch has published. */
export const storedEvents = Effect.fn("test.storedEvents")(function* (run: HarnessRun) {
  return yield* (yield* EventStorage).listEvents(run)
})

// ── e2e layer ───────────────────────────────────────────────────────────────

/**
 * A session profile cache over fixed profiles, for per-cwd routing tests and
 * the actor test roots. A cwd with no profile gets one over the `fallback`
 * registry (default: no extensions), with no base sections; the registry is
 * built once, in the layer's scope.
 */
export const fixedSessionProfiles = (
  profiles: ReadonlyMap<string, SessionProfile> = new Map(),
  fallback: Layer.Layer<ExtensionRegistry> = ExtensionRegistry.Test(),
): Layer.Layer<SessionProfileCache> =>
  Layer.effect(
    SessionProfileCache,
    Effect.gen(function* () {
      const layerContext = yield* Layer.build(fallback)
      const resolved = Context.get(layerContext, ExtensionRegistry).getResolved()
      const cache = new Map(profiles)
      return SessionProfileCache.of({
        resolve: (cwd) =>
          Effect.sync(() => {
            const existing = Option.fromUndefinedOr(cache.get(cwd))
            if (Option.isSome(existing)) return existing.value
            const profile: SessionProfile = {
              cwd,
              resolved,
              layerContext,
              registryService: Context.get(layerContext, ExtensionRegistry),
              baseSections: [],
              generationId: ProcessGenerationId.make("test"),
            }
            cache.set(cwd, profile)
            return profile
          }),
      })
    }),
  )

/**
 * Where a test root's extensions come from: inputs the root sets up, or
 * extensions a test already loaded (their setup bypassed). One or the other.
 */
type E2EExtensionSource =
  | {
      readonly extensionInputs: ReadonlyArray<GentExtension<ExtensionSetupServices>>
      readonly extensions?: never
    }
  | {
      readonly extensions: ReadonlyArray<LoadedExtension>
      readonly extensionInputs?: never
    }

interface E2ELayerOptions {
  /** Language model layer — typically from `LanguageModelLayers.sequence` */
  readonly providerLayer: Layer.Layer<LanguageModel.LanguageModel>
  /** Agents to register in the extension registry */
  readonly agents: ReadonlyArray<AgentDefinition>
  /** Keep running when an extension fails to load. Only for tests about that failure path. */
  readonly allowFailedExtensions?: boolean
  /**
   * The approval service. Default `ApprovalService.Test()` approves every
   * ask; `ApprovalService.Live` is the production service with durable
   * pending rows.
   */
  readonly approvalLayer?: Layer.Layer<
    ApprovalService,
    never,
    EventStore | GentPlatform | InteractionStorage
  >
  /** File-backed SQLite path for restart/recovery tests. Defaults to in-memory SQLite. */
  readonly storagePath?: string
  /**
   * The runtime's working directory: the launch workspace and the client's
   * workspace, as a host's launch directory is. Defaults to a temp directory
   * of the layer's own, removed with it.
   */
  readonly cwd?: string
  /**
   * The runtime's home: auth, extension files and the data directory live
   * under it, as a host's home does. Defaults to a temp directory of the
   * layer's own, removed with it. A test that restarts a layer passes the
   * same home to both.
   */
  readonly home?: string
  /** Optional per-cwd profile cache for per-workspace routing tests. */
  readonly sessionProfileCacheLayer?: Layer.Layer<SessionProfileCache>
  /**
   * Services core does not own, merged above the launch profile (a compactor,
   * a log capture). Core's own services have their own option.
   */
  readonly extraLayers?: ReadonlyArray<Layer.Layer<never>>
  /** `"test"` installs the stub tool runner; default runs the live one. */
  readonly toolRunner?: "test" | "live"
  /**
   * The models the registry knows, and no others. Absent, the registry makes
   * up a model for every id it is asked for.
   */
  readonly models?: ReadonlyArray<Model>
  /** The price of every model the test registry makes up. Default: free. */
  readonly modelPricing?: ModelPricing
  /** Auth override. Use for public RPC auth failure-path tests. */
  readonly authLayer?: Layer.Layer<Auth>
  /**
   * ConfigService override. Default is `ConfigService.Test()`.
   * Provide `ConfigService.Live` (or a custom layer) to exercise per-cwd
   * config resolution — e.g., for driver-override-from-session-cwd tests.
   */
  readonly configServiceLayer?: Layer.Layer<ConfigService>
}

/** Storage services are provided only when the test installs their feature. */
type E2ELayerWithFeature<A> = E2ELayerOptions &
  E2EExtensionSource & { readonly branchTools: BranchToolFeature<A> }

export type E2ELayerConfig<A = never> =
  | E2ELayerWithFeature<A>
  | ([A] extends [never]
      ? E2ELayerOptions & E2EExtensionSource & { readonly branchTools?: never }
      : never)

/** Re-registers one compiled slot; the switch restores the kind/handler correlation. */
const replayHook = (host: ExtensionHostService, slot: AnyExtensionHook): Effect.Effect<void> => {
  switch (slot.kind) {
    case "systemPrompt":
      return host.on(slot.kind, slot.hook.handler)
    case "turnProjection":
      return host.on(slot.kind, slot.hook.handler)
    case "turnAfter":
      return host.on(slot.kind, slot.hook.handler)
    case "loopOpen":
      return host.on(slot.kind, slot.hook.handler)
    case "sessionDeleted":
      return host.on(slot.kind, slot.hook.handler)
  }
}

/** Re-registers an already compiled record, so a test can wrap a loaded extension. */
export const registerContributions = (contributions: ExtensionContributions) =>
  Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("resource", ...(contributions.resources ?? []))
    yield* host.register("tool", ...(contributions.tools ?? []))
    yield* host.register("request", ...(contributions.requests ?? []))
    yield* host.register("agent", ...(contributions.agents ?? []))
    yield* host.register("modelDriver", ...(contributions.modelDrivers ?? []))
    for (const slot of contributions.hooks ?? []) yield* replayHook(host, slot)
  })

const fromLoadedExtension = (
  extension: LoadedExtension,
): GentExtension<ExtensionSetupServices> => ({
  manifest: extension.manifest,
  artifactIdentity: extension.artifactIdentity,
  setup: registerContributions(extension.contributions),
})

const extensionInputsForConfig = (
  config: E2ELayerConfig,
): ReadonlyArray<GentExtension<ExtensionSetupServices>> => {
  // No agents, no extension: a health or registry listing sees only what the test loads.
  const agents = [config.agents]
    .values()
    .filter((list) => list.length > 0)
    .map((list) => testAgentsExtension(list))
    .toArray()
  if (Predicate.isUndefined(config.extensions)) {
    return [...agents, ...(config.extensionInputs ?? [])]
  }
  return [...agents, ...config.extensions.map(fromLoadedExtension)]
}

/**
 * Build a complete E2E test layer with queued event publishing.
 *
 * The harness is a production-root preset: extension setup, resource startup,
 * event publishing, interaction recovery, and session runtime wiring flow
 * through `createDependencies`, the root the SDK builds.
 *
 * Each layer gets its own temp home and temp working directory, removed when
 * the layer's scope closes: the extensions write goal, wake and delegate
 * files under the home and prompt files under `<cwd>/.gent`, and a session
 * reads project extensions, skills and `AGENTS.md` from its cwd. A shared
 * directory would hand one test's files to the next.
 */
export function createE2ELayer<A>(config: E2ELayerWithFeature<A>): ReturnType<typeof e2eLayer<A>>
export function createE2ELayer(config: E2ELayerConfig): ReturnType<typeof e2eLayer<never>>
export function createE2ELayer(config: E2ELayerConfig) {
  return e2eLayer({ ...config, branchTools: config.branchTools ?? noBranchTools })
}

const e2eLayer = <A>(config: E2ELayerWithFeature<A>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const home = yield* Option.match(Option.fromUndefinedOr(config.home), {
        onNone: () => makeTempDirectoryScoped("gent-test-home-"),
        onSome: Effect.succeed,
      })
      const path = yield* Path.Path
      // A file-backed layer is a server a test restarts: by default it runs in
      // the database's directory, so the restarted layer is in the same place
      // (and workspace) as the first.
      const placeOf = Option.orElse(Option.fromUndefinedOr(config.cwd), () =>
        Option.map(Option.fromUndefinedOr(config.storagePath), (file) => path.dirname(file)),
      )
      const cwd = yield* Option.match(placeOf, {
        onNone: () => makeTempDirectoryScoped("gent-test-cwd-"),
        onSome: Effect.succeed,
      })
      return e2eDependencies(config, { cwd, home })
    }),
  ).pipe(Layer.provide(BunPlatformLive))

const e2eDependencies = <A>(
  config: E2ELayerWithFeature<A>,
  directories: { readonly cwd: string; readonly home: string },
) => {
  const options = {
    ...directories,
    platform: "test",
    state: Option.match(Option.fromUndefinedOr(config.storagePath), {
      onNone: () => StateLocation.cases.Memory.make({}),
      onSome: (dbPath) => StateLocation.cases.Disk.make({ dbPath }),
    }),
    extensions: extensionInputsForConfig(config),
    // A broken extension fails the test with its reason, not a later timeout.
    failOnExtensionFailure: config.allowFailedExtensions !== true,
    overrides: {
      modelRegistryLayer: ModelRegistry.Test(
        config.models ?? [],
        Option.fromUndefinedOr(config.modelPricing),
      ),
      modelResolverLayer: LanguageModelLayers.resolver(config.providerLayer),
      authLayer: config.authLayer ?? Auth.Test(),
      approvalLayer: config.approvalLayer ?? ApprovalService.Test(),
      configServiceLayer: config.configServiceLayer ?? ConfigService.Test(),
      sessionProfileCacheLayer: config.sessionProfileCacheLayer,
      // `"test"` stubs the tool runner; otherwise the production runner runs.
      toolRunnerLayer: Option.getOrUndefined(
        Option.map(
          Option.liftPredicate(config.toolRunner, (runner) => runner === "test"),
          () => ToolRunner.Test(),
        ),
      ),
      extraLayers: config.extraLayers,
    },
  }
  return createDependencies<A>({ ...options, branchTools: config.branchTools })
}

// ── in-process-layer ────────────────────────────────────────────────────────

// In-process integration layer: the E2E root with the stub tool runner and
// the scripted debug model. Use with `createRpcClient()`.

type InProcessLayerConfig = Pick<E2ELayerOptions, "agents" | "extraLayers" | "models">

/** Build a complete in-process test layer with a custom language model layer. */
export const baseLocalLayerWithProvider = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel, never, never>,
  config: InProcessLayerConfig,
) =>
  createE2ELayer({
    providerLayer,
    agents: config.agents,
    extensions: [],
    extraLayers: config.extraLayers,
    models: config.models,
    toolRunner: "test",
  })

/** Build a complete in-process test layer with the scripted debug model. */
export const baseLocalLayer = (config: InProcessLayerConfig) =>
  baseLocalLayerWithProvider(LanguageModelLayers.debug(), config)

// ── rpc-harness ─────────────────────────────────────────────────────────────

// RPC acceptance harness — exercises the full per-request scope path that
// production uses (`createRpcClient → RpcServer → registry dispatch → handler`).
//
// Use this for new extension RPC tests instead of hand-composing
// `createRpcClient(createE2ELayer({...}))` + a session-create call. Direct-runtime
// tests via `baseLocalLayer` bypass the per-request scope boundary
// production uses; this harness asserts that boundary.
//
// The harness is intentionally thin: it folds the four lines every RPC test
// already writes (build E2E layer → createRpcClient → session.create → return
// client + ids) into a single yield. The layer launches in `cwd` and the
// seeded session runs there, as a host and its first session do.
//
// The harness is exposed as `@gent/core/test-utils` so it can be imported from
// any test file. Because `core` cannot reach into `@gent/extensions`, the
// caller passes pre-loaded extensions and an agents bucket — the same
// fragments callers already pass to `createE2ELayer`.

type RpcHarnessConfig = Omit<E2ELayerOptions, "toolRunner"> & {
  readonly branchTools?: BranchToolFeature<never>
} & E2EExtensionSource & {
    /** The seeded session's agent, run spec and interactivity; its turns all run under it. */
    readonly admission?: SessionAdmission
  }

/**
 * Build an in-process RPC client + seeded session in one yield.
 *
 * ```typescript
 * const { client, sessionId, branchId } = yield* createRpcHarness({
 *   providerLayer,
 *   agents: [testAgent],
 *   extensionInputs: [testTurnExtension, myExtension],
 * })
 * yield* client.extension.request({ sessionId, branchId, ... })
 * ```
 */
export const createRpcHarness = (config: RpcHarnessConfig) =>
  Effect.gen(function* () {
    const { admission, ...layerConfig } = config
    // One working directory: the layer launches in it and the seeded session runs in it.
    const cwd = yield* Option.match(Option.fromUndefinedOr(config.cwd), {
      onNone: () => makeTempDirectoryScoped("gent-test-cwd-"),
      onSome: Effect.succeed,
    })
    const { client } = yield* createRpcClient(createE2ELayer({ ...layerConfig, cwd }))
    const { sessionId, branchId } = yield* client.session.create({
      cwd,
      ...omitUndefined({ admission }),
    })
    return { client, sessionId, branchId }
  })

/**
 * An in-process RPC client over `handlersLayer`: the production handlers, the
 * workspace middleware, and a namespaced client, with no socket. The SDK's
 * `Gent.test` is the same path for callers outside core. The client works in
 * the workspace of the layer's cwd, as a production client of that cwd does,
 * so its sessions there share the launch profile.
 */
export const createRpcClient = <E, R>(
  handlersLayer: Layer.Layer<Layer.Services<typeof RpcHandlersLive>, E, R>,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(Layer.provideMerge(RpcHandlersLive, handlersLayer))
    const { cwd } = Context.get(context, RuntimeEnvironment)
    const client = yield* makeInProcessClient(context, workspaceHeadersForCwd(cwd))
    return { client }
  })
