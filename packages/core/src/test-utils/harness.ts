import {
  Clock,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Predicate,
  PubSub,
  Random,
  Ref,
  Schema,
  Stream,
} from "effect"
import {
  defineResource,
  ExtensionContext,
  type ExtensionContextService,
  type ExtensionContributions,
  type ExtensionFileLockServiceApi,
  ExtensionHost,
  type ExtensionHostContext,
  type ExtensionHostPlatform,
  type ExtensionInteractionService,
  type ExtensionSessionService,
  type ExtensionSetupServices,
  type ExtensionStateFacet,
  type GentExtension,
  type LoadedExtension,
  makeCollectingExtensionHost,
  provideExtensionServices,
  registerContributions,
} from "../domain/extension.js"
import {
  BranchId,
  ExtensionId,
  type InteractionRequestId,
  type MessageId,
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
import { Branch, type Message, Session, SessionAdmission } from "../domain/message.js"
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
import {
  EventEnvelope,
  EventId,
  EventStore,
  type EventStoreService,
  getEventSessionId,
  matchesEventFilter,
} from "../domain/event.js"
import { type LanguageModel, Model as AiModel } from "effect/unstable/ai"
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

/**
 * What the test composition root shares with its presets: a working
 * directory and a home of its own (see `createE2ELayer`), a deterministic
 * server identity, and an agents extension. `createE2ELayer` is the one root;
 * the in-process layer and the RPC harness are presets over it. The stub
 * contexts above (`testExtensionHostContext`, `testToolContext`,
 * `testHostFacts`) have no scope to make a directory in, so their default cwd
 * is a path no test can create; a test that touches files passes its own.
 */

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
 * Test-only adapter for invoking a tool's effect with a wired
 * `ExtensionContext`. Production wraps tool execution in
 * `provideExtensionServices`; tests provide the service directly so mocks
 * stay observable. Keep this helper test-only — production code never wires
 * `ExtensionContext` at the tool boundary.
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
  Effect.runSync(provideExtensionServices(ctx, Effect.service(ExtensionContext)))

// ── index ───────────────────────────────────────────────────────────────────

// Call Record

export interface CallRecord {
  service: string
  method: string
  args?: unknown
  result?: unknown
  timestamp: number
}

// Sequence Recorder Service

interface SequenceRecorderService {
  readonly record: (call: Omit<CallRecord, "timestamp">) => Effect.Effect<void>
  readonly getCalls: Effect.Effect<ReadonlyArray<CallRecord>>
  readonly clear: Effect.Effect<void>
}

export class SequenceRecorder extends Context.Service<SequenceRecorder, SequenceRecorderService>()(
  "@gent/core/src/test-utils/harness/SequenceRecorder",
) {
  static Live: Layer.Layer<SequenceRecorder> = Layer.effect(
    SequenceRecorder,
    Effect.gen(function* () {
      const ref = yield* Ref.make<CallRecord[]>([])
      return SequenceRecorder.of({
        record: (call) =>
          Effect.gen(function* () {
            const timestamp = yield* Clock.currentTimeMillis
            yield* Ref.update(ref, (calls) => [...calls, { ...call, timestamp }])
          }),
        getCalls: Ref.get(ref),
        clear: Ref.set(ref, []),
      })
    }),
  )
}

// Recording EventStore

export const RecordingEventStore: Layer.Layer<EventStore, never, SequenceRecorder> = Layer.unwrap(
  Effect.gen(function* () {
    const recorder = yield* SequenceRecorder
    const events: EventEnvelope[] = []
    const sessions = new Map<SessionId, PubSub.PubSub<EventEnvelope>>()
    let nextId = 0
    const getOrCreateSessionPubSub = (sessionId: SessionId) =>
      Effect.gen(function* () {
        const existing = sessions.get(sessionId)
        if (!Predicate.isUndefined(existing)) return existing
        const ps = yield* PubSub.unbounded<EventEnvelope>()
        sessions.set(sessionId, ps)
        return ps
      })

    const service: EventStoreService = {
      append: Effect.fn("RecordingEventStore.append")(function* (event) {
        nextId += 1
        const createdAt = yield* Clock.currentTimeMillis
        const envelope = EventEnvelope.make({
          id: EventId.make(nextId),
          event,
          createdAt,
        })
        events.push(envelope)
        yield* recorder.record({
          service: "EventStore",
          method: "append",
          args: event,
        })
        return envelope
      }),
      deliver: (envelope) =>
        Effect.gen(function* () {
          const sessionId = getEventSessionId(envelope.event)
          if (Predicate.isUndefined(sessionId)) return
          const ps = yield* getOrCreateSessionPubSub(sessionId)
          yield* PubSub.publish(ps, envelope)
        }),
      publish: Effect.fn("RecordingEventStore.publish")(function* (event) {
        const envelope = yield* service.append(event)
        yield* service.deliver(envelope)
        yield* recorder.record({
          service: "EventStore",
          method: "publish",
          args: event,
        })
      }),
      subscribe: ({ sessionId, branchId, after }) =>
        Stream.scoped(
          Stream.unwrap(
            Effect.gen(function* () {
              const ps = yield* getOrCreateSessionPubSub(sessionId)
              const subscription = yield* PubSub.subscribe(ps)
              const latestId = nextId
              let afterId = 0
              if (after === "latest") afterId = latestId
              else if (Predicate.isNotUndefined(after)) afterId = after
              const buffered = events.filter(
                (env) => matchesEventFilter(env, sessionId, branchId) && env.id > afterId,
              )
              const live = Stream.fromSubscription(subscription).pipe(
                Stream.filter(
                  (env) => matchesEventFilter(env, sessionId, branchId) && env.id > latestId,
                ),
              )
              return Stream.concat(Stream.fromIterable(buffered), live)
            }),
          ),
        ),
      removeSession: (sessionId) =>
        Effect.gen(function* () {
          const ps = sessions.get(sessionId)
          if (!Predicate.isUndefined(ps)) {
            sessions.delete(sessionId)
            yield* PubSub.shutdown(ps)
          }
        }),
    }

    return Layer.succeed(EventStore, service)
  }),
)

// ── Test Extension Host ──

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

/**
 * In-memory SQLite storage with its platform closed: deterministic ids from
 * `GentPlatform.Test()` and the Bun `Crypto` the host would provide. Storage
 * tests yield it without wiring a platform layer; product callers use
 * `SqliteStorage.LiveWithSql` / `MemoryWithSql` under the host's platform.
 */
export const testSqliteStorage = <A>(
  extra: ExtraRepositories<A, StorageError, never>,
  featureMigrations: FeatureMigrations,
) =>
  SqliteStorage.MemoryWithSql(extra, featureMigrations).pipe(
    Layer.provide(Layer.merge(GentPlatform.Test(), BunCrypto.layer)),
  )

// Mock Helpers

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
    turnExtensionRegistry: profile.registryService,
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

// ── e2e-layer ───────────────────────────────────────────────────────────────

export interface E2ELayerConfig {
  /**
   * The branch-tool feature this harness installs. Defaults to
   * `noBranchTools`; a test exercising a real feature names it.
   */
  readonly branchTools?: BranchToolFeature<never>
  /** Language model layer — typically from `LanguageModelLayers.sequence` */
  readonly providerLayer: Layer.Layer<LanguageModel.LanguageModel>
  /** Agents to register in the extension registry */
  readonly agents: ReadonlyArray<AgentDefinition>
  /** Extension inputs for setup */
  readonly extensionInputs: ReadonlyArray<GentExtension<ExtensionSetupServices>>
  /** Keep running when an extension fails to load. Only for tests about that failure path. */
  readonly allowFailedExtensions?: boolean
  /** Pre-loaded extensions to wire directly (bypasses setup). Mutually exclusive with extensionInputs. */
  readonly extensions?: ReadonlyArray<LoadedExtension>
  /** Approval service override. Default auto-approves for E2E tests. */
  readonly approvalLayer?: Layer.Layer<
    ApprovalService,
    never,
    EventStore | GentPlatform | InteractionStorage
  >
  /** Use the production cold-interaction service with durable pending rows. */
  readonly durableApproval?: boolean
  /** File-backed SQLite path for restart/recovery tests. Defaults to in-memory SQLite. */
  readonly storagePath?: string
  /**
   * The runtime's working directory. Defaults to a temp directory of the
   * layer's own, made beside its home and removed with it.
   */
  readonly cwd?: string
  /** Optional per-cwd profile cache for per-workspace routing tests. */
  readonly sessionProfileCacheLayer?: Layer.Layer<SessionProfileCache>
  /** Extra layers to merge (e.g., additional service overrides) */
  readonly extraLayers?: ReadonlyArray<Layer.Layer<never>>
  /** `"test"` installs the stub tool runner; default runs the live one. */
  readonly toolRunner?: "test" | "live"
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
  /** Per-extension layer overrides (e.g., memory vault test layer) */
  readonly layerOverrides?: Record<string, () => Layer.Layer<never>>
}

const applyLayerOverride = (
  contributions: ExtensionContributions,
  extensionId: ExtensionId,
  override: Option.Option<() => Layer.Layer<never>>,
): ExtensionContributions => {
  if (Option.isNone(override)) return contributions
  const processResources = (contributions.resources ?? []).filter((r) => r.scope === "process")
  if (processResources.length > 1) {
    return Effect.runSync(
      Effect.die(
        new Error(
          `e2e-layer.layerOverrides: extension "${extensionId}" has ${processResources.length} process-scope Resources; the override path replaces all of them with one merged layer. Provide a complete merged layer in the override factory, or extend layerOverrides to address Resources individually.`,
        ),
      ),
    )
  }
  // oxlint-disable-next-line effect/noAs, effect/noChainedTypeAssertions, typescript/no-unsafe-type-assertion -- The test override erases resource output types at this heterogeneous layer boundary.
  const overrideLayer = override.value() as unknown as Layer.Layer<unknown, never, never>
  const layerOverride = defineResource({
    id: "test/e2e-layer/process-override",
    scope: "process",
    layer: overrideLayer,
  })
  const otherResources = (contributions.resources ?? []).filter((r) => r.scope !== "process")
  return {
    ...contributions,
    resources: [...otherResources, layerOverride],
  }
}

const fromLoadedExtension = (
  extension: LoadedExtension,
): GentExtension<ExtensionSetupServices> => ({
  manifest: extension.manifest,
  artifactIdentity: extension.artifactIdentity,
  setup: registerContributions(extension.contributions),
})

const wrapExtensionInput = (
  extension: GentExtension<ExtensionSetupServices>,
  layerOverrides: E2ELayerConfig["layerOverrides"],
): GentExtension<ExtensionSetupServices> => ({
  manifest: extension.manifest,
  artifactIdentity: extension.artifactIdentity,
  setup: Effect.gen(function* () {
    const loader = yield* ExtensionHost
    const collector = makeCollectingExtensionHost(
      testHostFacts({ cwd: loader.cwd, home: loader.home }),
    )
    yield* extension.setup.pipe(Effect.provideService(ExtensionHost, collector.service))
    const contributions = yield* collector.seal
    yield* registerContributions(
      applyLayerOverride(
        contributions,
        extension.manifest.id,
        Option.fromUndefinedOr(layerOverrides?.[extension.manifest.id]),
      ),
    )
  }),
})

const extensionInputsForConfig = (
  config: E2ELayerConfig,
): ReadonlyArray<GentExtension<ExtensionSetupServices>> => {
  // No agents, no extension: a health or registry listing sees only what the test loads.
  const agents = [config.agents]
    .filter((list) => list.length > 0)
    .map((list) => testAgentsExtension(list))
  if (Predicate.isUndefined(config.extensions)) {
    return [
      ...agents,
      ...config.extensionInputs.map((extension) =>
        wrapExtensionInput(extension, config.layerOverrides),
      ),
    ]
  }
  return [...agents, ...config.extensions.map(fromLoadedExtension)]
}

const approvalOverrideForConfig = (config: E2ELayerConfig) => {
  if (!Predicate.isUndefined(config.approvalLayer)) return Option.some(config.approvalLayer)
  if (config.durableApproval === true) return Option.none()
  return Option.some(ApprovalService.Test())
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
export const createE2ELayer = (config: E2ELayerConfig) => {
  let toolRunnerLayer = Option.none<Layer.Layer<ToolRunner>>()
  if (config.toolRunner === "test") toolRunnerLayer = Option.some(ToolRunner.Test())

  return Layer.unwrap(
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("gent-test-home-")
      const cwd = yield* Option.match(Option.fromUndefinedOr(config.cwd), {
        onNone: () => makeTempDirectoryScoped("gent-test-cwd-"),
        onSome: Effect.succeed,
      })
      return e2eDependencies(config, { cwd, home }, toolRunnerLayer)
    }),
  ).pipe(Layer.provide(BunPlatformLive))
}

const e2eDependencies = (
  config: E2ELayerConfig,
  directories: { readonly cwd: string; readonly home: string },
  toolRunnerLayer: Option.Option<Layer.Layer<ToolRunner>>,
) =>
  createDependencies({
    ...directories,
    platform: "test",
    state: Option.match(Option.fromUndefinedOr(config.storagePath), {
      onNone: () => StateLocation.cases.Memory.make({}),
      onSome: (dbPath) => StateLocation.cases.Disk.make({ dbPath }),
    }),
    modelResolverOverride: Option.getOrUndefined(
      Option.map(Option.fromUndefinedOr(config.providerLayer), LanguageModelLayers.resolver),
    ),
    extensions: extensionInputsForConfig(config),
    // A broken extension fails the test with its reason, not a later timeout.
    failOnExtensionFailure: config.allowFailedExtensions !== true,
    branchTools: config.branchTools ?? noBranchTools,
    overrides: {
      modelRegistryLayer: ModelRegistry.Test([], Option.fromUndefinedOr(config.modelPricing)),
      authLayer: config.authLayer ?? Auth.Test(),
      approvalLayer: Option.getOrUndefined(approvalOverrideForConfig(config)),
      configServiceLayer: config.configServiceLayer ?? ConfigService.Test(),
      sessionProfileCacheLayer: config.sessionProfileCacheLayer,
      toolRunnerLayer: Option.getOrUndefined(toolRunnerLayer),
      extraLayers: config.extraLayers,
    },
  })

// ── in-process-layer ────────────────────────────────────────────────────────

/**
 * In-process integration layer: the E2E root with the stub tool runner and
 * the scripted debug model. Use with `createRpcClient()`.
 */

interface InProcessLayerConfig {
  readonly agents: ReadonlyArray<AgentDefinition>
  readonly extraLayers?: ReadonlyArray<Layer.Layer<never>>
}

/** Build a complete in-process test layer with a custom language model layer. */
export const baseLocalLayerWithProvider = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel, never, never>,
  config: InProcessLayerConfig,
) =>
  createE2ELayer({
    providerLayer,
    agents: config.agents,
    extensions: [],
    extensionInputs: [],
    extraLayers: config.extraLayers,
    toolRunner: "test",
  })

/** Build a complete in-process test layer with the scripted debug model. */
export const baseLocalLayer = (config: InProcessLayerConfig) =>
  baseLocalLayerWithProvider(LanguageModelLayers.debug(), config)

// ── rpc-harness ─────────────────────────────────────────────────────────────

/**
 * RPC acceptance harness — exercises the full per-request scope path that
 * production uses (`createRpcClient → RpcServer → registry dispatch → handler`).
 *
 * Use this for new extension RPC tests instead of hand-composing
 * `createRpcClient(createE2ELayer({...}))` + a session-create call. Direct-runtime
 * tests via `baseLocalLayer` bypass the per-request scope boundary
 * production uses; this harness asserts that boundary.
 *
 * The harness is intentionally thin: it folds the four lines every RPC test
 * already writes (build E2E layer → createRpcClient → session.create → return
 * client + ids) into a single yield. The seeded session runs in the layer's
 * own temp working directory; pass `cwd` to seed it elsewhere.
 *
 * The harness is exposed as `@gent/core/test-utils` so it can be imported from
 * any test file. Because `core` cannot reach into `@gent/extensions`, the
 * caller passes pre-loaded extensions and an agents bucket — the same
 * fragments callers already pass to `createE2ELayer`.
 */

interface RpcHarnessConfig extends Omit<E2ELayerConfig, "toolRunner" | "cwd"> {
  /**
   * Working directory passed to the seeded session.create call. Defaults to
   * the layer's own temp working directory.
   */
  readonly cwd?: string
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
    const { cwd, admission, ...layerConfig } = config
    const layerCwd = yield* makeTempDirectoryScoped("gent-test-cwd-")
    const { client } = yield* createRpcClient(createE2ELayer({ ...layerConfig, cwd: layerCwd }))
    const { sessionId, branchId } = yield* client.session.create({
      cwd: cwd ?? layerCwd,
      ...omitUndefined({ admission }),
    })
    return { client, sessionId, branchId }
  })

/**
 * An in-process RPC client over `handlersLayer`: the production handlers, the
 * workspace middleware, and a namespaced client, with no socket. The SDK's
 * `Gent.test` is the same path for callers outside core.
 */
export const createRpcClient = <E, R>(
  handlersLayer: Layer.Layer<Layer.Services<typeof RpcHandlersLive>, E, R>,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(Layer.provide(RpcHandlersLive, handlersLayer))
    const client = yield* makeInProcessClient(context, workspaceHeadersForCwd(process.cwd()))
    return { client }
  })
