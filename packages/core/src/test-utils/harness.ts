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
  type Scope,
  Stream,
  TxRef,
} from "effect"
import type { SqlClient } from "effect/sql"
import {
  type AnyExtensionHook,
  ExtensionContext,
  type ExtensionContextService,
  type ExtensionContributions,
  extensionServicesFromHostContext,
  type ExtensionFileLockServiceApi,
  type ExtensionExtensionsService,
  type ExtensionModelsService,
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
  bindSessionAgent,
  DEFAULT_AGENT_NAME,
  Model,
  ModelId,
  type ModelPricing,
  noRunBound,
  parseModelId,
} from "../domain/agent.js"
import {
  Auth,
  type LoadedModelCatalog,
  makeExtensionModels,
  modelCatalogFromBodies,
  ModelCatalogSource,
  ModelRegistry,
} from "../runtime/provider.js"
import {
  HttpClient,
  HttpClientResponse,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http"
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
import { ConfigService, RuntimeEnvironment, UserConfig } from "../runtime/config.js"
import { omitUndefined } from "../domain/guards.js"
import {
  captureCurrentToolBinding,
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
  InteractionStorage,
  SessionStorage,
  SqliteStorage,
  ToolCallBindingStorage,
} from "../storage/storage.js"
import { type AgentEvent, EventStore, type EventStoreService } from "../domain/event.js"
import { type LanguageModel, Model as AiModel } from "effect/ai"
import { extensionPlatformServicesLive, GentPlatform } from "../runtime/gent-platform.js"
import { BunCrypto, BunHttpServer } from "@effect/platform-bun"
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
  // An unconfined `main`: a stub context bounds no file call.
  getAgent: () =>
    Effect.succeed(
      bindSessionAgent(testAgent, {
        overrides: Option.none(),
        cwd: "/nonexistent/gent-test-cwd",
        parent: noRunBound,
      }),
    ),
  renameCurrent: () => die("Session.renameCurrent"),
  forkBranch: () => die("Session.forkBranch"),
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

/** A stub with no profile behind it: each verb dies. */
const testExtensionExtensions = (): ExtensionExtensionsService => ({
  status: die("Extensions.status"),
  reload: () => die("Extensions.reload"),
})

/** A stub runtime with no classifier: none is available, and a decide dies. */
const testExtensionModels = (): ExtensionModelsService => ({
  decide: () => die("Models.decide"),
  available: Effect.succeed(false),
  classifiers: Effect.succeed([]),
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
  Models: overrides.Models ?? testExtensionModels(),
  Extensions: overrides.Extensions ?? testExtensionExtensions(),
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

/**
 * The model the test agent runs. Gent ships no default model; a test names
 * this one, as a user names theirs.
 */
export const TEST_MODEL_ID = ModelId.make("anthropic/claude-sonnet-5")

/** The agent a test runs when it names none: `main`, on `TEST_MODEL_ID`. */
export const testAgent = AgentDefinition.make({
  name: DEFAULT_AGENT_NAME,
  description: "Test agent",
  model: TEST_MODEL_ID,
})

/**
 * The user config a test root reads when the test names none: the user's
 * model is `TEST_MODEL_ID`, as a user's first `/model` pick writes theirs,
 * so a shipped agent that names no model runs it.
 */
const testUserConfig = new UserConfig({ model: TEST_MODEL_ID })

/** A queue with no steering and no follow-up entries. */
export const emptyQueueSnapshot = (): QueueSnapshot =>
  new QueueSnapshot({ steering: [], followUp: [] })

const [defaultProviderId, defaultModelName] = Option.getOrThrow(parseModelId(TEST_MODEL_ID))

/**
 * What an `extensionInputs` preset needs for a turn to run beside `agents:
 * [testAgent]`: a driver that lists the test agent's model. The driver's model is never called; the test
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
            id: TEST_MODEL_ID,
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
    Models: overrides?.Models ?? testExtensionModels(),
    Extensions: overrides?.Extensions ?? testExtensionExtensions(),
    ...overrides,
    State: () => resolvedState,
  }
}

/** The platform a tool body yields in production, built on the Bun platform the roots run. */
const toolTestPlatform = extensionPlatformServicesLive.pipe(Layer.provide(BunPlatformLive))

/**
 * Runs a tool's effect over a stub host context, wired through
 * `provideExtensionServices` as production wires a tool call, so a test
 * reads the stub's recorded calls. The body also gets the platform services
 * production gives it (`ExtensionPlatformServices`); a service the caller
 * provides replaces the harness one, so a test can swap in a fake.
 */
export const runToolWithCtx = <Input, Output, Error>(
  tool: ToolCapability<Input, Output, Error>,
  input: Input,
  ctx: Omit<TestToolContext, "toolCallId"> & { readonly toolCallId?: ToolCallId },
): Effect.Effect<Output, Error, never> =>
  Effect.flatMap(Effect.context<never>(), (caller) =>
    Effect.scoped(
      Effect.flatMap(Layer.build(toolTestPlatform), (platform) =>
        provideExtensionServices(ctx, getToolMetadata(tool).effect(input)).pipe(
          // The caller's services sit over the harness platform.
          Effect.provideContext(Context.merge(platform, caller)),
        ),
      ),
    ),
  )

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
export const testSqliteStorage = SqliteStorage.MemoryWithSql.pipe(
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
 * The registry of the host cwd's profile, the one a session with no stored
 * cwd reads. The caller's scope holds the profile's lease.
 */
export const hostProfileRegistry = Effect.gen(function* () {
  const environment = yield* RuntimeEnvironment
  const profile = yield* (yield* SessionProfileCache).resolve(environment.cwd)
  return profile.registryService
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
    models: yield* makeExtensionModels,
  })
  const turnProfile: AgentLoopTurnProfile = {
    turnGenerationId: profile.generationId,
    turnCapabilityContext: profile.layerContext,
    turnResourceBuilds: profile.resourceBuilds,
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
    models: yield* makeExtensionModels,
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
  const registry = ExtensionRegistry.of({
    getResolved: () => resolved,
    providerConfig: Effect.succeed({}),
  })
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

// ── model catalog fixture ───────────────────────────────────────────────────

/*
 * The one models.dev snapshot tests read: a trim of `api.json` and
 * `api.json?type=decision` as fetched on 2026-10-02, with only the fields the
 * catalog reads. Its providers: `anthropic`, `openai`, `opencode` (a model
 * per AI SDK package), `opencode-go`, `cloudflare-workers-ai` (with
 * `${CLOUDFLARE_ACCOUNT_ID}` in its URL), `deepseek` (no adapter), `google`
 * (a package gent does not speak), and the decision models. No test reaches
 * models.dev: every test root fetches through `modelCatalogFixture`.
 */

// oxlint-disable-next-line effect/noNullish -- models.dev writes some values as null (the "no reasoning" effort), and the fixture carries them as served
const MODELS_DEV_NULL = null
const encodeFixtureJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const MODEL_CATALOG_FIXTURE_CHAT = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    models: {
      "claude-haiku-4-5": {
        name: "Claude Haiku 4.5 (latest)",
        cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
        limit: { context: 200000, output: 64000 },
        release_date: "2025-10-15",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [{ type: "budget_tokens", min: 1024 }],
      },
      "claude-opus-4-5": {
        name: "Claude Opus 4.5 (latest)",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        limit: { context: 200000, output: 64000 },
        release_date: "2025-11-24",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high"] },
          { type: "budget_tokens", min: 1024 },
        ],
      },
      "claude-sonnet-4-5": {
        name: "Claude Sonnet 4.5 (latest)",
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        limit: { context: 1000000, output: 64000 },
        release_date: "2025-09-29",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [{ type: "budget_tokens", min: 1024 }],
      },
      "claude-opus-5": {
        name: "Claude Opus 5",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        limit: { context: 1000000, output: 128000 },
        release_date: "2026-07-24",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
      },
      "claude-fable-5": {
        name: "Claude Fable 5",
        cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
        limit: { context: 1000000, output: 128000 },
        release_date: "2026-06-07",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
      },
      "claude-sonnet-5": {
        name: "Claude Sonnet 5",
        cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
        limit: { context: 1000000, output: 128000 },
        release_date: "2026-06-29",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [
          { type: "toggle" },
          { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
        ],
      },
      "claude-sonnet-5-5": {
        name: "Claude Sonnet 5.5",
        cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
        limit: { context: 1000000, output: 128000 },
        release_date: "2026-09-28",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
      },
      "claude-opus-4-6": {
        name: "Claude Opus 4.6",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        limit: { context: 1000000, output: 128000 },
        release_date: "2026-02-04",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high", "max"] },
          { type: "budget_tokens", min: 1024 },
        ],
      },
      "claude-haiku-4-5-20251001": {
        name: "Claude Haiku 4.5",
        cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
        limit: { context: 200000, output: 64000 },
        release_date: "2025-10-15",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [{ type: "budget_tokens", min: 1024 }],
      },
      "claude-sonnet-4-6": {
        name: "Claude Sonnet 4.6",
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        limit: { context: 1000000, output: 128000 },
        release_date: "2026-02-17",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high", "max"] },
          { type: "budget_tokens", min: 1024 },
        ],
      },
      "claude-opus-4-7": {
        name: "Claude Opus 4.7",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        limit: { context: 1000000, output: 128000 },
        release_date: "2026-04-14",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
      },
      "claude-opus-4-8": {
        name: "Claude Opus 4.8",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        limit: { context: 1000000, output: 128000 },
        release_date: "2026-05-28",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
      },
      "claude-opus-5-5": {
        name: "Claude Opus 5.5",
        cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
        limit: { context: 1000000, output: 128000 },
        release_date: "2026-09-22",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
      },
      "claude-fable-5-1": {
        name: "Claude Fable 5.1",
        cost: { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
        limit: { context: 1000000, output: 128000 },
        release_date: "2026-09-01",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
      },
      "claude-opus-4-5-20251101": {
        name: "Claude Opus 4.5",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        limit: { context: 200000, output: 64000 },
        release_date: "2025-11-24",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high"] },
          { type: "budget_tokens", min: 1024 },
        ],
      },
      "claude-sonnet-4-5-20250929": {
        name: "Claude Sonnet 4.5",
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        limit: { context: 1000000, output: 64000 },
        release_date: "2025-09-29",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [{ type: "budget_tokens", min: 1024 }],
      },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai",
    models: {
      "gpt-5.4": {
        name: "GPT-5.4",
        cost: { input: 2.5, output: 15, cache_read: 0.25 },
        limit: { context: 1050000, input: 922000, output: 128000 },
        release_date: "2026-03-05",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [
          { type: "effort", values: [MODELS_DEV_NULL, "low", "medium", "high", "xhigh"] },
        ],
      },
      "gpt-5.5-pro": {
        name: "GPT-5.5 Pro",
        cost: { input: 30, output: 180 },
        limit: { context: 1050000, input: 922000, output: 128000 },
        release_date: "2026-04-23",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["medium", "high", "xhigh"] }],
      },
      "text-embedding-3-small": {
        name: "text-embedding-3-small",
        cost: { input: 0.02, output: 0 },
        limit: { context: 8191, output: 1536 },
        release_date: "2024-01-25",
        tool_call: false,
        reasoning: false,
        temperature: false,
      },
      "gpt-5.2-chat-latest": {
        name: "GPT-5.2 Chat",
        cost: { input: 1.75, output: 14, cache_read: 0.175 },
        limit: { context: 128000, output: 16384 },
        release_date: "2025-12-11",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["medium"] }],
      },
      "gpt-6.1-sol": {
        name: "GPT-6.1 Sol",
        cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
        limit: { context: 1050000, input: 922000, output: 128000 },
        release_date: "2026-09-29",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
      },
      "gpt-5.1": {
        name: "GPT-5.1",
        cost: { input: 1.25, output: 10, cache_read: 0.125 },
        limit: { context: 400000, input: 272000, output: 128000 },
        release_date: "2025-11-13",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [{ type: "effort", values: [MODELS_DEV_NULL, "low", "medium", "high"] }],
      },
      "gpt-5.6-luna": {
        name: "GPT-5.6 Luna",
        cost: { input: 0.2, output: 1.2, cache_read: 0.02, cache_write: 0.25 },
        limit: { context: 1050000, input: 922000, output: 128000 },
        release_date: "2026-07-09",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [
          { type: "effort", values: [MODELS_DEV_NULL, "low", "medium", "high", "xhigh", "max"] },
        ],
      },
      "gpt-4.1": {
        name: "GPT-4.1",
        cost: { input: 2, output: 8, cache_read: 0.5 },
        limit: { context: 1047576, output: 32768 },
        release_date: "2025-04-14",
        tool_call: true,
        reasoning: false,
        temperature: true,
      },
      o3: {
        name: "o3",
        cost: { input: 2, output: 8, cache_read: 0.5 },
        limit: { context: 200000, output: 100000 },
        release_date: "2025-04-16",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
      },
      "gpt-5": {
        name: "GPT-5",
        cost: { input: 1.25, output: 10, cache_read: 0.125 },
        limit: { context: 400000, input: 272000, output: 128000 },
        release_date: "2025-08-07",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
      },
      "gpt-5.6-sol": {
        name: "GPT-5.6 Sol",
        cost: { input: 4, output: 20, cache_read: 0.4, cache_write: 5 },
        limit: { context: 1050000, input: 922000, output: 128000 },
        release_date: "2026-07-09",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [
          { type: "effort", values: [MODELS_DEV_NULL, "low", "medium", "high", "xhigh", "max"] },
        ],
      },
      "gpt-6-sol": {
        name: "GPT-6 Sol",
        cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
        limit: { context: 1050000, input: 922000, output: 128000 },
        release_date: "2026-09-22",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [
          { type: "effort", values: [MODELS_DEV_NULL, "low", "medium", "high", "xhigh", "max"] },
        ],
      },
      "gpt-6-luna": {
        name: "GPT-6 Luna",
        cost: { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
        limit: { context: 1050000, input: 922000, output: 128000 },
        release_date: "2026-09-22",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [
          { type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] },
        ],
      },
      "gpt-6-astra": {
        name: "GPT-6 Astra",
        cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
        limit: { context: 1050000, input: 922000, output: 128000 },
        release_date: "2026-09-04",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
      },
      "gpt-5-mini": {
        name: "GPT-5 Mini",
        cost: { input: 0.25, output: 2, cache_read: 0.025 },
        limit: { context: 400000, input: 272000, output: 128000 },
        release_date: "2025-08-07",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
      },
      "gpt-5-pro": {
        name: "GPT-5 Pro",
        cost: { input: 15, output: 120 },
        limit: { context: 400000, input: 272000, output: 272000 },
        release_date: "2025-10-06",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["high"] }],
      },
      "gpt-5.2-pro": {
        name: "GPT-5.2 Pro",
        cost: { input: 21, output: 168 },
        limit: { context: 400000, input: 272000, output: 128000 },
        release_date: "2025-12-11",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["medium", "high", "xhigh"] }],
      },
      "gpt-5.4-pro": {
        name: "GPT-5.4 Pro",
        cost: { input: 30, output: 180 },
        limit: { context: 1050000, input: 922000, output: 128000 },
        release_date: "2026-03-05",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["medium", "high", "xhigh"] }],
      },
      "o3-pro": {
        name: "o3-pro",
        cost: { input: 20, output: 80 },
        limit: { context: 200000, output: 100000 },
        release_date: "2025-06-10",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
      },
      "o1-pro": {
        name: "o1-pro",
        cost: { input: 150, output: 600 },
        limit: { context: 200000, output: 100000 },
        release_date: "2025-03-19",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
      },
      "o4-mini": {
        name: "o4-mini",
        cost: { input: 1.1, output: 4.4, cache_read: 0.275 },
        limit: { context: 200000, output: 100000 },
        release_date: "2025-04-16",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
      },
    },
  },
  opencode: {
    id: "opencode",
    name: "OpenCode Zen",
    env: ["OPENCODE_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://opencode.ai/zen/v1",
    models: {
      "gpt-5.4": {
        name: "GPT-5.4",
        cost: { input: 2.5, output: 15, cache_read: 0.25 },
        limit: { context: 1050000, input: 922000, output: 128000 },
        release_date: "2026-03-05",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [
          { type: "effort", values: [MODELS_DEV_NULL, "low", "medium", "high", "xhigh"] },
        ],
        provider: { npm: "@ai-sdk/openai" },
      },
      "claude-opus-4-5": {
        name: "Claude Opus 4.5",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        limit: { context: 200000, output: 64000 },
        release_date: "2025-11-24",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high"] },
          { type: "budget_tokens", min: 1024 },
        ],
        provider: { npm: "@ai-sdk/anthropic" },
      },
      "kimi-k2.6": {
        name: "Kimi K2.6",
        cost: { input: 0.95, output: 4, cache_read: 0.16 },
        limit: { context: 262144, output: 65536 },
        release_date: "2026-04-21",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [{ type: "toggle" }],
        interleaved: { field: "reasoning_content" },
      },
      "gemini-3.6-flash": {
        name: "Gemini 3.6 Flash",
        cost: { input: 1.5, output: 7.5, cache_read: 0.15 },
        limit: { context: 1048576, output: 65536 },
        release_date: "2026-07-21",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
        provider: { npm: "@ai-sdk/google" },
      },
      "gpt-6.1-sol": {
        name: "GPT-6.1 Sol",
        cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
        limit: { context: 1050000, input: 922000, output: 128000 },
        release_date: "2026-09-29",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        provider: { npm: "@ai-sdk/openai" },
      },
      "claude-opus-5": {
        name: "Claude Opus 5",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        limit: { context: 1000000, output: 128000 },
        release_date: "2026-07-24",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        provider: { npm: "@ai-sdk/anthropic" },
      },
      "claude-sonnet-5": {
        name: "Claude Sonnet 5",
        cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
        limit: { context: 1000000, output: 128000 },
        release_date: "2026-06-30",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        provider: { npm: "@ai-sdk/anthropic" },
      },
      "claude-opus-4-6": {
        name: "Claude Opus 4.6",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        limit: { context: 1000000, output: 128000 },
        release_date: "2026-02-05",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high", "max"] },
          { type: "budget_tokens", min: 1024 },
        ],
        provider: { npm: "@ai-sdk/anthropic" },
      },
      "qwen3.6-plus": {
        name: "Qwen3.6 Plus",
        cost: { input: 0.5, output: 3, cache_read: 0.05, cache_write: 0.625 },
        limit: { context: 262144, output: 65536 },
        release_date: "2026-04-02",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", max: 81920 }],
        provider: { npm: "@ai-sdk/anthropic" },
      },
      "glm-5.3": {
        name: "GLM-5.3",
        cost: { input: 1.4, output: 4.4, cache_read: 0.26 },
        limit: { context: 1000000, output: 131072 },
        release_date: "2026-08-14",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
        interleaved: { field: "reasoning_content" },
      },
    },
  },
  "opencode-go": {
    id: "opencode-go",
    name: "OpenCode Go",
    env: ["OPENCODE_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://opencode.ai/zen/go/v1",
    models: {
      "kimi-k2.6": {
        name: "Kimi K2.6",
        cost: { input: 0.95, output: 4, cache_read: 0.16 },
        limit: { context: 262144, output: 65536 },
        release_date: "2026-04-21",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [],
        interleaved: { field: "reasoning_content" },
      },
      "minimax-m3": {
        name: "MiniMax-M3",
        cost: { input: 0.3, output: 1.2, cache_read: 0.06 },
        limit: { context: 1000000, output: 131072 },
        release_date: "2026-05-31",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [{ type: "toggle" }],
        provider: { npm: "@ai-sdk/anthropic" },
      },
      "gpt-5.6-luna": {
        name: "GPT-5.6 Luna",
        cost: { input: 0.2, output: 1.2, cache_read: 0.02, cache_write: 0.25 },
        limit: { context: 1050000, input: 922000, output: 128000 },
        release_date: "2026-07-09",
        tool_call: true,
        reasoning: true,
        temperature: false,
        reasoning_options: [
          { type: "effort", values: [MODELS_DEV_NULL, "low", "medium", "high", "xhigh", "max"] },
        ],
        provider: { npm: "@ai-sdk/openai" },
      },
      "glm-5.3": {
        name: "GLM-5.3",
        cost: { input: 1.4, output: 4.4, cache_read: 0.26 },
        limit: { context: 1000000, output: 131072 },
        release_date: "2026-08-14",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
        interleaved: { field: "reasoning_content" },
      },
    },
  },
  "cloudflare-workers-ai": {
    id: "cloudflare-workers-ai",
    name: "Cloudflare Workers AI",
    env: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    models: {
      "@cf/meta/llama-guard-3-8b": {
        name: "Llama Guard 3 8B",
        cost: { input: 0.484, output: 0.03 },
        limit: { context: 131072, output: 131072 },
        release_date: "2024-07-23",
        tool_call: false,
        reasoning: false,
        temperature: true,
      },
      "@cf/moonshotai/kimi-k2.6": {
        name: "Kimi K2.6",
        cost: { input: 0.95, output: 4, cache_read: 0.16 },
        limit: { context: 262144, output: 256000 },
        release_date: "2026-04-21",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [{ type: "effort", values: [MODELS_DEV_NULL, "high"] }],
        interleaved: { field: "reasoning_content" },
      },
      "@cf/zai-org/glm-5.3": {
        name: "Glm 5.3",
        cost: { input: 1.4, output: 4.4, cache_read: 0.26 },
        limit: { context: 1048576, output: 1048576 },
        release_date: "2026-08-14",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
      },
    },
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    env: ["DEEPSEEK_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.deepseek.com",
    models: {
      "deepseek-v4-pro": {
        name: "DeepSeek V4 Pro",
        cost: { input: 0.66, output: 1.98, cache_read: 0.022 },
        limit: { context: 1000000, output: 393216 },
        release_date: "2026-08-12",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
        interleaved: { field: "reasoning_content" },
      },
      "deepseek-v4-flash": {
        name: "DeepSeek V4 Flash",
        cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
        limit: { context: 1000000, output: 393216 },
        release_date: "2026-09-10",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
        interleaved: { field: "reasoning_content" },
      },
    },
  },
  google: {
    id: "google",
    name: "Google",
    env: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
    npm: "@ai-sdk/google",
    models: {
      "gemini-3.6-flash": {
        name: "Gemini 3.6 Flash",
        cost: { input: 0.75, output: 3.75, cache_read: 0.075 },
        limit: { context: 1048576, output: 65536 },
        release_date: "2026-07-21",
        tool_call: true,
        reasoning: true,
        temperature: true,
        reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
      },
    },
  },
}

const MODEL_CATALOG_FIXTURE_DECISION = {
  "cloudflare-workers-ai": {
    id: "cloudflare-workers-ai",
    name: "Cloudflare Workers AI",
    env: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    models: {
      "@cf/cloudflare/clef-flash": {
        name: "Clef Flash",
        cost: { input: 0.09, output: 0 },
        limit: { context: 65536, output: 65536 },
        release_date: "2026-09-29",
        tool_call: false,
        reasoning: false,
        temperature: true,
        type: "decision",
      },
      "@cf/cloudflare/clef": {
        name: "Clef",
        cost: { input: 0.24, output: 0 },
        limit: { context: 65536, output: 65536 },
        release_date: "2026-09-29",
        tool_call: false,
        reasoning: false,
        temperature: true,
        type: "decision",
      },
    },
  },
  "nano-gpt": {
    id: "nano-gpt",
    name: "NanoGPT",
    env: ["NANO_GPT_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://nano-gpt.com/api/v1",
    models: {
      "liquid/d1": {
        name: "Liquid D1",
        cost: { input: 0.04, output: 0, cache_read: 0.04 },
        limit: { context: 65536, input: 65536, output: 0 },
        release_date: "2026-09-29",
        tool_call: false,
        reasoning: false,
        temperature: MODELS_DEV_NULL,
        type: "decision",
      },
    },
  },
  vercel: {
    id: "vercel",
    name: "Vercel AI Gateway",
    env: ["AI_GATEWAY_API_KEY"],
    npm: "@ai-sdk/gateway",
    models: {
      "typesafe-ai/jev": {
        name: "Jev",
        cost: { input: 0.042, output: 0 },
        limit: { context: 32000, output: 0 },
        release_date: "2026-09-15",
        tool_call: false,
        reasoning: false,
        temperature: false,
        type: "decision",
      },
    },
  },
  opencode: {
    id: "opencode",
    name: "OpenCode Zen",
    env: ["OPENCODE_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://opencode.ai/zen/v1",
    models: {
      "jev-1.13": {
        name: "Jev 1.13",
        cost: { input: 0.042, output: 0 },
        limit: { context: 64000, output: 0 },
        release_date: "2026-09-15",
        tool_call: false,
        reasoning: false,
        temperature: false,
        type: "decision",
      },
      "jev-1.13-free": {
        name: "Jev 1.13 Free",
        cost: { input: 0, output: 0 },
        limit: { context: 64000, output: 0 },
        release_date: "2026-09-15",
        tool_call: false,
        reasoning: false,
        temperature: false,
        type: "decision",
      },
    },
  },
}

/** The fixture's two bodies as served, and the strong ETag each carries. */
export const MODEL_CATALOG_FIXTURE: Readonly<
  Record<"api.json" | "api.json?type=decision", { readonly body: string; readonly etag: string }>
> = {
  "api.json": { body: encodeFixtureJson(MODEL_CATALOG_FIXTURE_CHAT), etag: '"fixture-chat-1"' },
  "api.json?type=decision": {
    body: encodeFixtureJson(MODEL_CATALOG_FIXTURE_DECISION),
    etag: '"fixture-decision-1"',
  },
}

/** The fixture as the catalog a driver reads, for a driver test with no server. */
export const fixtureModelCatalog = (): LoadedModelCatalog =>
  modelCatalogFromBodies({
    chat: MODEL_CATALOG_FIXTURE["api.json"].body,
    decision: MODEL_CATALOG_FIXTURE["api.json?type=decision"].body,
  })

/** The fixture as a catalog source that fetches nothing, for a test that builds the resolvers alone. */
export const fixtureModelCatalogSource: Layer.Layer<ModelCatalogSource> = Layer.unwrap(
  Effect.sync(() => ModelCatalogSource.fixed(fixtureModelCatalog())),
)

/** One catalog request the fixture client answered: its source and the ETag it sent. */
export interface ModelCatalogFixtureRequest {
  readonly source: string
  readonly ifNoneMatch: Option.Option<string>
}

/** What a body request gets: the stored fixture, a body a test set, or a 503 (offline). */
interface ModelCatalogFixtureServed {
  readonly offline: boolean
  readonly bodies: Readonly<Record<string, { readonly body: string; readonly etag: string }>>
}

/**
 * A counting HTTP client that serves the fixture for both models.dev
 * sources, under any origin. A request that sends the current ETag gets a
 * 304 with no body. `serve` changes what a source answers next; `offline`
 * answers every request with a 503.
 */
export const modelCatalogFixture = Effect.gen(function* () {
  const requests = yield* Ref.make<ReadonlyArray<ModelCatalogFixtureRequest>>([])
  const served = yield* Ref.make<ModelCatalogFixtureServed>({
    offline: false,
    bodies: MODEL_CATALOG_FIXTURE,
  })
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const url = new URL(request.url)
      const source = `${url.pathname.replace(/^\/+/, "")}${url.search}`
      const ifNoneMatch = Option.fromUndefinedOr(request.headers["if-none-match"])
      yield* Ref.update(requests, (list) => [...list, { source, ifNoneMatch }])
      const current = yield* Ref.get(served)
      const answer = Option.fromUndefinedOr(current.bodies[source])
      if (current.offline || Option.isNone(answer)) {
        return HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 }))
      }
      if (Option.contains(ifNoneMatch, answer.value.etag)) {
        // oxlint-disable-next-line effect/noNullish -- a 304 carries no body, and `Response` takes null for none
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 304 }))
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(answer.value.body, { status: 200, headers: { etag: answer.value.etag } }),
      )
    }),
  )
  return {
    layer: Layer.succeed(HttpClient.HttpClient, client),
    requests: Ref.get(requests),
    serve: (source: string, body: string, etag: string) =>
      Ref.update(served, (current) => ({
        ...current,
        bodies: { ...current.bodies, [source]: { body, etag } },
      })),
    offline: (offline: boolean) => Ref.update(served, (current) => ({ ...current, offline })),
  }
})

/**
 * The fixture over a loopback listener on a free port, for a spawned gent:
 * the child sets `GENT_MODEL_CATALOG_URL` to the origin this returns and
 * reads the fixture with no network. A request that sends the current ETag
 * gets a 304. The listener closes with the scope.
 */
export const serveModelCatalogFixture: Effect.Effect<string, never, Scope.Scope> = Effect.gen(
  function* () {
    const app = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, "http://127.0.0.1")
      const source = `${url.pathname.replace(/^\/+/, "")}${url.search}`
      const answer = Option.fromUndefinedOr(
        Object.entries(MODEL_CATALOG_FIXTURE).find(([name]) => name === source)?.[1],
      )
      if (Option.isNone(answer)) return HttpServerResponse.text("not found", { status: 404 })
      const ifNoneMatch = Option.fromUndefinedOr(request.headers["if-none-match"])
      if (Option.contains(ifNoneMatch, answer.value.etag)) {
        return HttpServerResponse.empty({ status: 304 })
      }
      return HttpServerResponse.text(answer.value.body, {
        headers: { etag: answer.value.etag },
        contentType: "application/json",
      })
    })
    const context = yield* Layer.build(
      HttpServer.serve(app).pipe(
        Layer.provideMerge(BunHttpServer.layerServer({ port: 0, hostname: "127.0.0.1" })),
      ),
    )
    const address = Context.get(context, HttpServer.HttpServer).address
    if (address._tag === "UnixPathAddress") return yield* Effect.die("a TCP listener has no path")
    return `http://127.0.0.1:${address.port}`
  },
).pipe(Effect.orDie)

/** The fixture client alone, for a test root that does not count its requests. */
const modelCatalogFixtureLayer: Layer.Layer<HttpClient.HttpClient> = Layer.unwrap(
  Effect.map(modelCatalogFixture, (fixture) => fixture.layer),
)

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
              resourceBuilds: {
                host: Context.merge(Context.makeUnsafe<unknown>(new Map()), layerContext),
                process: new Map(),
              },
              generationId: ProcessGenerationId.make("test"),
            }
            cache.set(cwd, profile)
            return profile
          }),
        reload: () => Effect.void,
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

/**
 * Where a test root keeps its state: in-memory SQLite (neither), a SQLite file
 * for restart and recovery tests (`storagePath`), or a host's own SQLite client
 * (`hostedSql`, `StateLocation.Hosted`). One or neither.
 */
type E2EStateSource =
  | {
      readonly storagePath?: string
      readonly hostedSql?: never
    }
  | {
      readonly hostedSql: Layer.Layer<SqlClient.SqlClient>
      readonly storagePath?: never
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
   * up a model for every id it is asked for. `"catalog"`: the production
   * registry, over the profile's drivers and the models.dev fixture.
   */
  readonly models?: ReadonlyArray<Model> | "catalog"
  /** The price of every model the test registry makes up. Default: free. */
  readonly modelPricing?: ModelPricing
  /**
   * `"checked"`: a turn reads each driver's sign-in as production does, so a
   * route skips a model whose driver has none. Default: every driver counts
   * as signed in, as a scripted model needs no sign-in.
   */
  readonly signIn?: "checked"
  /** Auth override. Use for public RPC auth failure-path tests. */
  readonly authLayer?: Layer.Layer<Auth>
  /**
   * The HTTP client the models.dev catalog fetches through. Default: the
   * fixture client (`modelCatalogFixtureLayer`); a test that counts requests
   * passes its own `modelCatalogFixture`.
   */
  readonly modelCatalogHttpLayer?: Layer.Layer<HttpClient.HttpClient>
  /**
   * ConfigService override. Default is `ConfigService.Test` with the user's
   * model set to `TEST_MODEL_ID`.
   * Provide `ConfigService.Live` (or a custom layer) to exercise per-cwd
   * config resolution — e.g., for driver-override-from-session-cwd tests.
   */
  readonly configServiceLayer?: Layer.Layer<ConfigService>
}

export type E2ELayerConfig = E2ELayerOptions & E2EExtensionSource & E2EStateSource

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
    case "toolCall":
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
    yield* host.register("modelRouter", ...(contributions.modelRouters ?? []))
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
export const createE2ELayer = (config: E2ELayerConfig) =>
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

/** The test registry `config` asks for; none for `"catalog"`, which keeps the production one. */
const testModelRegistry = (
  config: Pick<E2ELayerOptions, "models" | "modelPricing">,
): Option.Option<Layer.Layer<ModelRegistry>> => {
  const models = config.models ?? []
  if (models === "catalog") return Option.none()
  return Option.some(ModelRegistry.Test(models, Option.fromUndefinedOr(config.modelPricing)))
}

/** The resolver of the test's model; `signIn: "checked"` reads sign-ins as production does. */
const testModelResolver = (config: Pick<E2ELayerOptions, "providerLayer" | "signIn">) => {
  if (config.signIn === "checked")
    return LanguageModelLayers.signInCheckedResolver(config.providerLayer)
  return LanguageModelLayers.resolver(config.providerLayer)
}

const stateLocationOf = (config: E2EStateSource): StateLocation => {
  if (!Predicate.isUndefined(config.hostedSql))
    return StateLocation.cases.Hosted.make({ sql: config.hostedSql })
  if (!Predicate.isUndefined(config.storagePath))
    return StateLocation.cases.Disk.make({ dbPath: config.storagePath })
  return StateLocation.cases.Memory.make({})
}

const e2eDependencies = (
  config: E2ELayerConfig,
  directories: { readonly cwd: string; readonly home: string },
) => {
  const options = {
    ...directories,
    platform: "test",
    state: stateLocationOf(config),
    extensions: extensionInputsForConfig(config),
    // A broken extension fails the test with its reason, not a later timeout.
    failOnExtensionFailure: config.allowFailedExtensions !== true,
    overrides: {
      modelRegistryLayer: Option.getOrUndefined(testModelRegistry(config)),
      modelResolverLayer: testModelResolver(config),
      authLayer: config.authLayer ?? Auth.Test(),
      modelCatalogHttpLayer: config.modelCatalogHttpLayer ?? modelCatalogFixtureLayer,
      approvalLayer: config.approvalLayer ?? ApprovalService.Test(),
      configServiceLayer: config.configServiceLayer ?? ConfigService.Test(testUserConfig),
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
  return createDependencies(options)
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

type RpcHarnessConfig = Omit<E2ELayerOptions, "toolRunner"> &
  E2EExtensionSource &
  E2EStateSource & {
    /** The seeded session's agent, run spec and interactivity; its turns all run under it. */
    readonly admission?: SessionAdmission
    /**
     * The seeded session's own model, as `/model` sets it. A root whose
     * config names no user model (a `ConfigService.Live` over a test home)
     * names it here.
     */
    readonly modelId?: ModelId
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
    const { admission, modelId, ...layerConfig } = config
    // One working directory: the layer launches in it and the seeded session runs in it.
    const cwd = yield* Option.match(Option.fromUndefinedOr(config.cwd), {
      onNone: () => makeTempDirectoryScoped("gent-test-cwd-"),
      onSome: Effect.succeed,
    })
    const { client } = yield* createRpcClient(createE2ELayer({ ...layerConfig, cwd }))
    const { sessionId, branchId } = yield* client.session.create({
      cwd,
      ...omitUndefined({ admission, modelId }),
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
