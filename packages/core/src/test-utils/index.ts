import {
  Clock,
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
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
  type ExtensionFilesService,
  ExtensionHost,
  type ExtensionHostAgentService,
  type ExtensionHostContext,
  type ExtensionHostPlatform,
  ExtensionHostProcessError,
  type ExtensionInteractionService,
  type ExtensionProcessService,
  ExtensionServiceError,
  type ExtensionSessionService,
  type ExtensionSetupServices,
  type ExtensionStateFacet,
  type GentExtension,
  type LoadedExtension,
  makeCollectingExtensionHost,
  makeFileWriter,
  provideExtensionServices,
  registerContributions,
} from "../domain/extension.js"
import { BranchId, ExtensionId, SessionId, ToolCallId } from "../domain/ids.js"
import {
  type AgentDefinition,
  type AgentRunner,
  AgentRunnerService,
  AgentRunResult,
  DEFAULT_AGENT_NAME,
} from "../domain/agent.js"
import { Auth, ModelRegistry } from "../runtime/provider.js"
import { getToolMetadata, type ToolCapability } from "../domain/capability.js"
import { defineExtension } from "../extensions/api.js"
import { ApprovalService, type SessionProfileCache } from "../runtime/extension-host.js"
import { ConfigService } from "../runtime/config.js"
import { type BranchToolFeature, noBranchTools, ToolRunner } from "../runtime/tools.js"
import { BunPlatformLive } from "../runtime/gent-platform-bun.js"
import { LanguageModelLayers } from "./language-model.js"
import { createDependencies, StateLocation } from "../server/server.js"
import { Branch, Session } from "../domain/message.js"
import type { StorageError } from "../domain/errors.js"
import { BranchStorage, type InteractionStorage, SessionStorage } from "../storage/storage.js"
import {
  EventEnvelope,
  EventId,
  type EventPublisher,
  EventStore,
  type EventStoreService,
  getEventSessionId,
  matchesEventFilter,
} from "../domain/event.js"
import type { LanguageModel } from "effect/unstable/ai"
import { BunServices } from "@effect/platform-bun"
import type { GentPlatform } from "../runtime/gent-platform.js"
import { buildServerRoot } from "../server/server-root.js"
import { Gent } from "@gent/sdk"

// ── extension-host-context ──────────────────────────────────────────────────

type TestExtensionHostContextOverrides = Omit<
  Partial<ExtensionHostContext>,
  "Agent" | "Session" | "Interaction"
> & {
  readonly Agent?: Partial<ExtensionHostAgentService>
  readonly Session?: Partial<ExtensionSessionService>
  readonly Interaction?: Partial<ExtensionInteractionService>
}

const die = (operation: string) =>
  Effect.die(new Error(`unconfigured test ExtensionHostContext.${operation}`))

const defaultAgent = (): ExtensionHostAgentService => ({
  listAgents: die("Agent.listAgents"),
  start: () => die("Agent.start"),
  inspect: () => die("Agent.inspect"),
  list: () => die("Agent.list"),
  cancel: () => die("Agent.cancel"),
  send: () => die("Agent.send"),
  run: () => die("Agent.run"),
})

const defaultSession = (): ExtensionSessionService => ({
  getSession: () => die("Session.getSession"),
  getDetail: () => die("Session.getDetail"),
  renameCurrent: () => die("Session.renameCurrent"),
  create: () => die("Session.create"),
  delete: () => die("Session.delete"),
  send: () => die("Session.send"),
  steer: () => die("Session.steer"),
  events: () => Stream.die("Session.events"),
  queueFollowUp: () => die("Session.queueFollowUp"),
  dequeueFollowUp: () => die("Session.dequeueFollowUp"),
  listBranches: die("Session.listBranches"),
  listSessions: die("Session.listSessions"),
  listActiveLoops: die("Session.listActiveLoops"),
})

const defaultInteraction = (): ExtensionInteractionService => ({
  approve: () => die("Interaction.approve"),
  present: () => die("Interaction.present"),
})

/** The one host platform stub: a darwin box whose `runProcess` is unavailable. */
export const testExtensionHostPlatform = (home: string = "/tmp"): ExtensionHostPlatform => ({
  osInfo: {
    platform: "darwin",
    arch: "arm64",
    release: "test",
    hostname: "test-host",
    type: "Darwin",
  },
  execPath: "/usr/bin/node",
  homeDirectory: home,
  parentEnv: {},
  randomId: Random.nextInt.pipe(Effect.map((value) => `test-${value}`)),
  pathListSeparator: ":",
  runProcess: (command) =>
    Effect.fail(
      new ExtensionHostProcessError({
        command,
        message: "test host runProcess unavailable",
      }),
    ),
})

const filesError = (operation: string) => (cause: unknown) => {
  let message = String(cause)
  if (cause instanceof Error) message = cause.message
  return new ExtensionServiceError({ service: "ExtensionFiles", operation, message, cause })
}

/**
 * The same `Path` service the production facet uses. The stub used to spell
 * posix rules out by hand, which resolved a relative path from `/` instead of
 * the process cwd and silently dropped a leading `..`; a test that passed
 * against those rules could still fail in production. Effect's own posix
 * implementation is a plain value, so the stub reads it once and shares it.
 */
const testPath: Path.Path = Effect.runSync(
  Effect.scoped(Layer.build(Path.layer).pipe(Effect.map((ctx) => Context.get(ctx, Path.Path)))),
)

/** Runs against the ambient file system, or reports its absence. */
const onFileSystem = <A, E>(
  operation: string,
  use: (fs: FileSystem.FileSystem) => Effect.Effect<A, E>,
): Effect.Effect<A, ExtensionServiceError> =>
  Effect.serviceOption(FileSystem.FileSystem).pipe(
    Effect.flatMap((service) =>
      Option.match(service, {
        onNone: () => Effect.fail(filesError(operation)("FileSystem service unavailable in test")),
        onSome: (fs) => use(fs).pipe(Effect.mapError(filesError(operation))),
      }),
    ),
  )

export const testExtensionFiles = (): ExtensionFilesService => ({
  read: (path) => onFileSystem("read", (fs) => fs.readFileString(path)),
  write: (path, content, options) =>
    onFileSystem("write", (fs) => makeFileWriter(fs, testPath.dirname)(path, content, options)),
  exists: (path) => onFileSystem("exists", (fs) => fs.exists(path)),
  stat: (path) =>
    onFileSystem("stat", (fs) =>
      fs.stat(path).pipe(
        Effect.map((info) => ({
          type: info.type,
          size: info.size,
          mtime: Option.getOrUndefined(info.mtime),
        })),
      ),
    ),
  makeDirectory: (path, options) =>
    onFileSystem("makeDirectory", (fs) => fs.makeDirectory(path, options)),
  resolve: (...paths) => testPath.resolve(...paths),
  join: (...paths) => testPath.join(...paths),
  dirname: (path) => testPath.dirname(path),
})

export const testExtensionProcess = (host: ExtensionHostPlatform): ExtensionProcessService => ({
  randomId: host.randomId,
  run: (command, args, options) =>
    host.runProcess(command, args, options).pipe(
      Effect.mapError(
        (cause) =>
          new ExtensionServiceError({
            service: "ExtensionProcess",
            operation: "run",
            message: cause.message,
            cause,
          }),
      ),
    ),
  parentEnv: host.parentEnv,
})

export const testExtensionFileLock = (): ExtensionFileLockServiceApi => ({
  withLock: (_path, effect) => effect,
})

export const testExtensionState = (): ReturnType<ExtensionStateFacet> => ({
  changed: () => Effect.void,
})

export const testExtensionHostContext = (
  overrides: TestExtensionHostContextOverrides = {},
): ExtensionHostContext => ({
  sessionId: overrides.sessionId ?? SessionId.make("test-session"),
  branchId: overrides.branchId ?? BranchId.make("test-branch"),
  cwd: overrides.cwd ?? "/tmp",
  home: overrides.home ?? "/tmp",
  host: overrides.host ?? testExtensionHostPlatform(overrides.home),
  agentName: overrides.agentName,
  Agent: { ...defaultAgent(), ...overrides.Agent },
  Session: { ...defaultSession(), ...overrides.Session },
  Interaction: { ...defaultInteraction(), ...overrides.Interaction },
  Process:
    overrides.Process ??
    testExtensionProcess(overrides.host ?? testExtensionHostPlatform(overrides.home)),
  Files: overrides.Files ?? testExtensionFiles(),
  FileLock: overrides.FileLock ?? testExtensionFileLock(),
  State: overrides.State ?? (() => testExtensionState()),
})

// ── test-root ───────────────────────────────────────────────────────────────

/**
 * What every test composition root shares: a `/tmp` environment, the stub
 * service layers, a deterministic server identity, an agents/tools
 * extension, and a stub agent runner. The roots in `in-process-layer`,
 * `e2e-layer`, and `extension-harness` are deltas over these.
 */

export const testEnvironment = { cwd: "/tmp", home: "/tmp", platform: "test" }

export const testIdentity = (dbPath: string = ":memory:") => ({
  serverId: "test-server",
  pid: 0,
  hostname: "test-host",
  dbPath,
  buildFingerprint: "test-fingerprint",
  startedAt: 0,
})

/** Fresh stub layers per call: `ApprovalService.Test()` carries a decision queue. */
export const testOverrides = () => ({
  authLayer: Auth.Test(),
  approvalLayer: ApprovalService.Test(),
  configServiceLayer: ConfigService.Test(),
  modelRegistryLayer: ModelRegistry.Test(),
})

export const testAgentsExtension = (
  agents: ReadonlyArray<AgentDefinition>,
  tools: ReadonlyArray<ToolCapability> = [],
) =>
  defineExtension({
    id: "test-agents",
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* host.register("agent", ...agents)
      yield* host.register("tool", ...tools)
    }),
  })

const defaultRun: Pick<AgentRunner, "run"> = {
  run: () =>
    Effect.succeed(
      AgentRunResult.cases.Success.make({
        text: "",
        sessionId: SessionId.make("test-subagent-session"),
        agentName: DEFAULT_AGENT_NAME,
      }),
    ),
}

/** An agent runner whose `run` answers (empty success by default) and whose other methods die. */
export const stubAgentRunnerLayer = (
  runner: Pick<AgentRunner, "run"> = defaultRun,
): Layer.Layer<AgentRunnerService> =>
  Layer.succeed(
    AgentRunnerService,
    AgentRunnerService.of({
      start: () => Effect.die("AgentRunner.start not configured in test"),
      inspect: () => Effect.die("AgentRunner.inspect not configured in test"),
      list: () => Effect.die("AgentRunner.list not configured in test"),
      cancel: () => Effect.die("AgentRunner.cancel not configured in test"),
      send: () => Effect.die("AgentRunner.send not configured in test"),
      ...runner,
    }),
  )

// ── extension-harness ───────────────────────────────────────────────────────

/** Test helpers for extension tool execution. */

export interface ToolTestLayerConfig {
  /**
   * The branch-tool feature this harness installs. Defaults to
   * `noBranchTools`; a test exercising a real feature names it.
   */
  readonly branchTools?: BranchToolFeature<never>
  /** Agents to register */
  readonly agents: ReadonlyArray<AgentDefinition>
  /** Extensions to load */
  readonly extensions?: ReadonlyArray<GentExtension<ExtensionSetupServices>>
  /** Extra tools to register (authored via `tool({...})`). */
  readonly tools?: ReadonlyArray<ToolCapability>
  /** AgentRunner mock — default returns success with empty text */
  readonly subagentRunner?: Pick<AgentRunner, "run">
  /** Extra layers to merge (e.g., additional service overrides) */
  readonly extraLayers?: ReadonlyArray<Layer.Layer<never>>
}

/**
 * Create a test layer for extension tool execution.
 *
 * Provides core services needed by most tools. Tools that need platform
 * services (FileSystem, Path) should compose with BunServices.layer.
 */
export const createToolTestLayer = (config: ToolTestLayerConfig) =>
  createDependencies({
    ...testEnvironment,
    state: StateLocation.cases.Memory.make({}),
    languageModelLayerOverride: LanguageModelLayers.debug(),
    extensions: [testAgentsExtension(config.agents, config.tools), ...(config.extensions ?? [])],
    branchTools: config.branchTools ?? noBranchTools,
    overrides: {
      ...testOverrides(),
      toolRunnerLayer: ToolRunner.Test(),
      agentRunnerLayer: stubAgentRunnerLayer(config.subagentRunner),
      extraLayers: config.extraLayers,
    },
  }).pipe(Layer.provide(BunPlatformLive), Layer.orDie)

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)
const dieEffect = (label: string) => Effect.die(`${label} not wired in test`)

/**
 * One stub that serves both halves of the boundary: a host context a runtime
 * test can provide as `CurrentExtensionHostContext`, and, through
 * `runToolWithCtx`, the leaf view a tool sees. `State` keeps the host's
 * extension-id form; `runToolWithCtx` applies the leaf id the same way
 * production does.
 */
export type TestToolContext = ExtensionHostContext &
  Omit<ExtensionContextService, "State" | "Agent"> & {
    readonly toolCallId: ToolCallId
    readonly Agent: ExtensionContextService["Agent"] & ExtensionHostContext["Agent"]
  }

type TestToolContextOverrides = Omit<Partial<TestToolContext>, "Agent" | "State"> & {
  readonly Agent?: Partial<TestToolContext["Agent"]>
  /** Accepts the flat leaf facet; it is lifted to the host's id-taking form. */
  readonly State?: ReturnType<ExtensionStateFacet>
}

/** Default ToolCapabilityContext for tests — overridable via spread */
export const testToolContext = (overrides?: TestToolContextOverrides): TestToolContext => {
  const host = testExtensionHostContext().host
  const Agent: ExtensionContextService["Agent"] = {
    listAgents: dieEffect("agent.listAgents"),
    start: dieStub("agent.start"),
    inspect: dieStub("agent.inspect"),
    list: dieStub("agent.list"),
    cancel: dieStub("agent.cancel"),
    send: dieStub("agent.send"),
    run: dieStub("agent.run"),
  }
  const Session: ExtensionContextService["Session"] = {
    getSession: dieStub("session.getSession"),
    getDetail: dieStub("session.getDetail"),
    renameCurrent: dieStub("session.renameCurrent"),
    create: dieStub("session.create"),
    delete: dieStub("session.delete"),
    send: dieStub("session.send"),
    steer: dieStub("session.steer"),
    events: () => Stream.die("session.events"),
    queueFollowUp: dieStub("session.queueFollowUp"),
    dequeueFollowUp: dieStub("session.dequeueFollowUp"),
    listBranches: dieEffect("session.listBranches"),
    listSessions: dieEffect("session.listSessions"),
    listActiveLoops: dieEffect("session.listActiveLoops"),
  }
  const Interaction: ExtensionContextService["Interaction"] = {
    approve: dieStub("Interaction.approve"),
    present: dieStub("Interaction.present"),
  }
  const resolvedAgent = { ...Agent, ...overrides?.Agent }
  const resolvedSession = overrides?.Session ?? Session
  const resolvedInteraction = overrides?.Interaction ?? Interaction
  const resolvedProcess = overrides?.Process ?? testExtensionProcess(host)
  const resolvedFiles = overrides?.Files ?? testExtensionFiles()
  const resolvedFileLock = overrides?.FileLock ?? testExtensionFileLock()
  const resolvedState = overrides?.State ?? testExtensionState()
  const resolvedExtensionId = overrides?.extensionId ?? ExtensionId.make("test-extension")

  return {
    extensionId: resolvedExtensionId,
    sessionId: SessionId.make("test-session"),
    branchId: BranchId.make("test-branch"),
    toolCallId: ToolCallId.make("test-call"),
    cwd: "/tmp",
    home: "/tmp",
    host,
    Session: resolvedSession,
    Interaction: resolvedInteraction,
    Process: resolvedProcess,
    Files: resolvedFiles,
    FileLock: resolvedFileLock,
    ...overrides,
    State: () => resolvedState,
    Agent: resolvedAgent,
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
  "@gent/core/src/test-utils/SequenceRecorder",
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
              const afterId = after ?? 0
              const ps = yield* getOrCreateSessionPubSub(sessionId)
              const subscription = yield* PubSub.subscribe(ps)
              const latestId = nextId
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

// Sequence Assertions

const CallMatch = Schema.Record(Schema.String, Schema.Unknown)
type CallMatch = typeof CallMatch.Type
const encodeCallMatch = Schema.encodeSync(Schema.fromJsonString(CallMatch))

const callMatches = (
  call: CallRecord,
  expected: { service: string; method: string; match?: CallMatch },
) => {
  if (call.service !== expected.service || call.method !== expected.method) return false
  if (Predicate.isUndefined(expected.match)) return true
  if (!Schema.is(CallMatch)(call.args)) return false
  const args = call.args
  return Object.entries(expected.match).every(([key, value]) => args[key] === value)
}

export const assertSequence = (
  actual: ReadonlyArray<CallRecord>,
  expected: ReadonlyArray<{
    service: string
    method: string
    match?: CallMatch
  }>,
) => {
  let actualIdx = 0

  for (const exp of expected) {
    let found = false
    while (actualIdx < actual.length) {
      const call = actual[actualIdx]
      if (!Predicate.isUndefined(call) && callMatches(call, exp)) {
        found = true
        actualIdx++
        break
      }
      actualIdx++
    }

    if (!found) {
      const matchDescription = Option.fromUndefinedOr(exp.match).pipe(
        Option.match({ onNone: () => "", onSome: (match) => ` with ${encodeCallMatch(match)}` }),
      )
      return Effect.runSync(
        Effect.die(
          new Error(`Expected call not found: ${exp.service}.${exp.method}${matchDescription}`),
        ),
      )
    }
  }
}

// ── Test Extension Host ──

/** Facts the test extension host reports to `setup` Effects. */
interface TestExtensionHostFacts {
  readonly cwd: string
  readonly source: string
  readonly home: string
  readonly host: ExtensionHostPlatform
}

export const testHostFacts = (
  overrides?: Partial<Pick<TestExtensionHostFacts, "cwd" | "source" | "home">>,
): TestExtensionHostFacts => ({
  cwd: overrides?.cwd ?? "/tmp",
  source: overrides?.source ?? "test",
  home: overrides?.home ?? "/tmp",
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

// Mock Helpers

export function ensureStorageParents(input: {
  readonly sessionId: SessionId | string
  readonly branchId?: never
}): Effect.Effect<void, StorageError, SessionStorage>
export function ensureStorageParents(input: {
  readonly sessionId: SessionId | string
  readonly branchId: BranchId | string
}): Effect.Effect<void, StorageError, SessionStorage | BranchStorage>
export function ensureStorageParents(input: {
  readonly sessionId: SessionId | string
  readonly branchId?: BranchId | string
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
        }),
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

// Extension tool test helpers

// ── e2e-layer ───────────────────────────────────────────────────────────────

/**
 * E2E test layer with queued event publishing and tool execution.
 *
 * Unlike baseLocalLayerWithProvider (which stubs everything), this layer wires the
 * prod-shaped event publisher, real ToolRunner.Live, and direct session-loop
 * follow-ups — so QueueFollowUp actually drives multi-turn loops.
 *
 * Import from @gent/core-internal/test-utils/e2e-layer
 */

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
  /** Pre-loaded extensions to wire directly (bypasses setup). Mutually exclusive with extensionInputs. */
  readonly extensions?: ReadonlyArray<LoadedExtension>
  /** Use "live" for real child sessions. Default mocks blocking run only. */
  readonly subagentRunner?: "live" | Pick<AgentRunner, "run">
  /** Approval service override. Default auto-approves for E2E tests. */
  readonly approvalLayer?: Layer.Layer<
    ApprovalService,
    never,
    EventPublisher | GentPlatform | InteractionStorage
  >
  /** Use the production cold-interaction service with durable pending rows. */
  readonly durableApproval?: boolean
  /** File-backed SQLite path for restart/recovery tests. Defaults to in-memory SQLite. */
  readonly storagePath?: string
  /** Optional per-cwd profile cache for shared-server routing tests. */
  readonly sessionProfileCacheLayer?: Layer.Layer<SessionProfileCache>
  /** Extra layers to merge (e.g., additional service overrides) */
  readonly extraLayers?: ReadonlyArray<Layer.Layer<never>>
  /** `"test"` installs the stub tool runner; default runs the live one. */
  readonly toolRunner?: "test" | "live"
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
    const collector = makeCollectingExtensionHost(testHostFacts())
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
  if (Predicate.isUndefined(config.extensions)) {
    return config.extensionInputs.map((extension) =>
      wrapExtensionInput(extension, config.layerOverrides),
    )
  }
  return [testAgentsExtension(config.agents), ...config.extensions.map(fromLoadedExtension)]
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
 * through `createDependencies`/`buildServerRoot`.
 */
export const createE2ELayer = (config: E2ELayerConfig) => {
  let subagentRunnerLayer = Option.none<Layer.Layer<AgentRunnerService>>()
  if (config.subagentRunner !== "live") {
    subagentRunnerLayer = Option.some(stubAgentRunnerLayer(config.subagentRunner))
  }
  let toolRunnerLayer = Option.none<Layer.Layer<ToolRunner>>()
  if (config.toolRunner === "test") toolRunnerLayer = Option.some(ToolRunner.Test())

  const root = buildServerRoot({
    observability: Layer.empty,
    dependencies: {
      ...testEnvironment,
      state: Option.match(Option.fromUndefinedOr(config.storagePath), {
        onNone: () => StateLocation.cases.Memory.make({}),
        onSome: (dbPath) => StateLocation.cases.Disk.make({ dbPath }),
      }),
      languageModelLayerOverride: config.providerLayer,
      extensions: extensionInputsForConfig(config),
      branchTools: config.branchTools ?? noBranchTools,
      overrides: {
        modelRegistryLayer: ModelRegistry.Test(),
        authLayer: config.authLayer ?? Auth.Test(),
        approvalLayer: Option.getOrUndefined(approvalOverrideForConfig(config)),
        configServiceLayer: config.configServiceLayer ?? ConfigService.Test(),
        sessionProfileCacheLayer: config.sessionProfileCacheLayer,
        agentRunnerLayer: Option.getOrUndefined(subagentRunnerLayer),
        toolRunnerLayer: Option.getOrUndefined(toolRunnerLayer),
        extraLayers: config.extraLayers,
      },
    },
    identity: testIdentity(config.storagePath),
  })
  return Layer.unwrap(root.pipe(Effect.map((built) => built.coreServicesLive))).pipe(
    Layer.provide(BunServices.layer),
  )
}

// ── in-process-layer ────────────────────────────────────────────────────────

/**
 * In-process integration layer: the E2E root with the stub tool runner and
 * the scripted debug model. Use with `Gent.test()`.
 *
 * Import from @gent/core-internal/test-utils/in-process-layer.js
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
 * production uses (`Gent.test → RpcServer → registry dispatch → handler`).
 *
 * Use this for new extension RPC tests instead of hand-composing
 * `Gent.test(createE2ELayer({...}))` + a session-create call. Direct-runtime
 * tests via `makeActorRuntimeLayer` bypass the per-request scope boundary
 * production uses; this harness asserts that boundary.
 *
 * The harness is intentionally thin: it folds the four lines every RPC test
 * already writes (build E2E layer → Gent.test → session.create → return
 * client + ids) into a single yield. Pass `cwd` to override the default
 * `/tmp` working directory.
 *
 * The harness lives in `@gent/core-internal/test-utils` so it can be imported from
 * any test file. Because `core` cannot reach into `@gent/extensions`, the
 * caller passes pre-loaded extensions and an agents bucket — the same
 * fragments callers already pass to `createE2ELayer`.
 *
 * @module
 */

interface RpcHarnessConfig extends Omit<E2ELayerConfig, "toolRunner"> {
  /** Working directory passed to the seeded session.create call. Defaults to `/tmp`. */
  readonly cwd?: string
}

/**
 * Build an in-process RPC client + seeded session in one yield.
 *
 * ```typescript
 * const { client, sessionId, branchId } = yield* createRpcHarness({
 *   ...e2ePreset,
 *   providerLayer,
 *   extensions: [taskExt],
 * })
 * yield* client.extension.request({ sessionId, branchId, ... })
 * ```
 */
export const createRpcHarness = (config: RpcHarnessConfig) =>
  Effect.gen(function* () {
    const { cwd, ...layerConfig } = config
    const layer = createE2ELayer(layerConfig)
    const { client, runtime } = yield* Gent.test(layer)
    const { sessionId, branchId } = yield* client.session.create({
      cwd: cwd ?? "/tmp",
    })
    return { client, runtime, sessionId, branchId }
  })
