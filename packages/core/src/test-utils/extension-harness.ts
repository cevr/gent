/**
 * Test harness for extension actors and lifecycle.
 *
 * Import from @gent/core/test-utils/extension-harness
 */

import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import {
  AgentDefinition,
  AgentRunnerService,
  type AgentName,
  type AgentRunner,
} from "../domain/agent.js"
import { AllBuiltinAgents } from "../extensions/all-agents.js"
import { GitReader } from "../extensions/librarian/git-reader.js"
import {
  EventStore,
  StreamStarted,
  TurnCompleted,
  ToolCallSucceeded,
  ToolCallFailed,
  type AgentEvent,
} from "../domain/event.js"
import type {
  ExtensionTurnContext,
  ExtensionReduceContext,
  ExtensionSetup,
  LoadedExtension,
  ReduceResult,
  TurnProjection,
} from "../domain/extension.js"
import type { ExtensionInput } from "../domain/extension-package.js"
import { BranchId, SessionId, ToolCallId } from "../domain/ids.js"
import { Permission } from "../domain/permission.js"
import { PromptPresenter } from "../domain/prompt-presenter.js"
import type { AnyToolDefinition, ToolContext } from "../domain/tool.js"
import { AgentLoop } from "../runtime/agent/agent-loop.js"
import {
  reconcileLoadedExtensions,
  setupBuiltinExtensions,
} from "../runtime/extensions/activation.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { ExtensionStateRuntime } from "../runtime/extensions/state-runtime.js"
import { ExtensionTurnControl } from "../runtime/extensions/turn-control.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"
import { EventPublisherLive } from "../server/event-publisher.js"
import { Storage } from "../storage/sqlite-storage.js"

// ── Options ──

export interface ActorHarnessOptions {
  readonly sessionId?: SessionId
  readonly branchId?: BranchId
  readonly agent?: AgentDefinition
  readonly allTools?: ReadonlyArray<AnyToolDefinition>
}

// ── Event Factories ──

export interface EventFactoryContext {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

export const createEventFactories = (ctx: EventFactoryContext) => ({
  streamStarted: (overrides?: Partial<ConstructorParameters<typeof StreamStarted>[0]>) =>
    new StreamStarted({ sessionId: ctx.sessionId, branchId: ctx.branchId, ...overrides }),

  turnCompleted: (overrides?: Partial<ConstructorParameters<typeof TurnCompleted>[0]>) =>
    new TurnCompleted({
      sessionId: ctx.sessionId,
      branchId: ctx.branchId,
      durationMs: 0,
      ...overrides,
    }),

  toolCallSucceeded: (overrides?: Partial<ConstructorParameters<typeof ToolCallSucceeded>[0]>) =>
    new ToolCallSucceeded({
      sessionId: ctx.sessionId,
      branchId: ctx.branchId,
      toolCallId: ToolCallId.of("tc-test"),
      toolName: "test",
      ...overrides,
    }),

  toolCallFailed: (overrides?: Partial<ConstructorParameters<typeof ToolCallFailed>[0]>) =>
    new ToolCallFailed({
      sessionId: ctx.sessionId,
      branchId: ctx.branchId,
      toolCallId: ToolCallId.of("tc-test"),
      toolName: "test",
      ...overrides,
    }),
})

export type EventFactories = ReturnType<typeof createEventFactories>

// ── Actor Harness ──

/**
 * Create a pure synchronous harness for testing extension actor projections.
 *
 * Wraps the reduce/derive/receive functions so tests can call them
 * without Effect runtime — useful for pure state transition testing.
 */
export interface ActorHarnessResult<State, Message = void> {
  readonly reduce: (
    state: State,
    event: AgentEvent,
    ctx?: ExtensionReduceContext,
  ) => ReduceResult<State>
  readonly derive: (state: State) => TurnProjection & { readonly uiModel?: unknown }
  readonly receive: Message extends void
    ? undefined
    : (state: State, message: Message) => ReduceResult<State>
  readonly ctx: ExtensionReduceContext
  readonly deriveCtx: ExtensionTurnContext
  readonly events: EventFactories
  readonly initial: State
}

export interface ActorHarnessConfig<State, Message = void> {
  readonly id: string
  readonly initial: NoInfer<State>
  readonly reduce: (
    state: State,
    event: AgentEvent,
    ctx: ExtensionReduceContext,
  ) => ReduceResult<State>
  readonly derive?: (
    state: State,
    ctx: ExtensionTurnContext,
  ) => TurnProjection & { readonly uiModel?: unknown }
  readonly receive?: (state: State, message: Message) => ReduceResult<State>
}

export function createActorHarness<State, Message>(
  config: ActorHarnessConfig<State, Message>,
  options?: ActorHarnessOptions,
): ActorHarnessResult<State, Message>
export function createActorHarness<State>(
  config: ActorHarnessConfig<State>,
  options?: ActorHarnessOptions,
): ActorHarnessResult<State>
export function createActorHarness<State, Message = void>(
  config: ActorHarnessConfig<State, Message>,
  options?: ActorHarnessOptions,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): ActorHarnessResult<State, any> {
  const ctx: ExtensionReduceContext = {
    sessionId: SessionId.of(options?.sessionId ?? "test-session"),
    branchId: BranchId.of(options?.branchId ?? "test-branch"),
  }

  const deriveCtx: ExtensionTurnContext = {
    sessionId: ctx.sessionId,
    branchId: BranchId.of(ctx.branchId ?? "test-branch"),
    agent: options?.agent ?? new AgentDefinition({ name: "test" as never }),
    allTools: options?.allTools ?? [],
    interactive: true,
  }

  const branchId = BranchId.of(options?.branchId ?? "test-branch")
  const events = createEventFactories({ sessionId: ctx.sessionId, branchId })

  const reduce = (
    state: State,
    event: AgentEvent,
    reduceCtx?: ExtensionReduceContext,
  ): ReduceResult<State> => config.reduce(state, event, reduceCtx ?? ctx)

  const derive = (state: State): TurnProjection & { readonly uiModel?: unknown } =>
    config.derive !== undefined ? config.derive(state, deriveCtx) : {}

  const receiveHandler = config.receive
  const receive =
    receiveHandler !== undefined
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (state: State, message: any): ReduceResult<State> => receiveHandler(state, message)
      : undefined

  return {
    reduce,
    derive,
    receive,
    ctx,
    deriveCtx,
    events,
    initial: config.initial,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

// ── Tool Test Layer ──

export interface ToolTestLayerConfig {
  /** Extensions to load (defaults to builtin agents only) */
  readonly extensions?: ReadonlyArray<ExtensionInput>
  /** Extra tools to register */
  readonly tools?: ReadonlyArray<AnyToolDefinition>
  /** AgentRunner mock — default returns success with empty text */
  readonly subagentRunner?: AgentRunner
}

/**
 * Create a test layer for extension tool execution.
 *
 * Provides core services needed by most tools. Tools that need platform
 * services (FileSystem, Path) should compose with BunServices.layer.
 */
export const createToolTestLayer = (config: ToolTestLayerConfig = {}) => {
  const builtinSetup: ExtensionSetup = {
    agents: [...AllBuiltinAgents],
    tools: [...(config.tools ?? [])],
  }

  const defaultRunner: AgentRunner = {
    run: () =>
      Effect.succeed({
        _tag: "success" as const,
        text: "",
        sessionId: SessionId.of("test-subagent-session"),
        agentName: "cowork" as AgentName,
      }),
  }
  const subagentRunnerLayer = Layer.succeed(
    AgentRunnerService,
    config.subagentRunner ?? defaultRunner,
  )

  const turnControlLayer = ExtensionTurnControl.Test()
  return Layer.unwrap(
    Effect.gen(function* () {
      const setupResult = yield* setupBuiltinExtensions({
        extensions: config.extensions ?? [],
        cwd: "/tmp",
        home: "/tmp",
        disabled: new Set(),
      })

      const allExtensions: LoadedExtension[] = [
        {
          manifest: { id: "test-agents" },
          kind: "builtin" as const,
          sourcePath: "test",
          setup: builtinSetup,
        },
        ...setupResult.active,
      ]

      const reconciled = yield* reconcileLoadedExtensions({
        extensions: allExtensions,
        failedExtensions: setupResult.failed,
        home: "/tmp",
        command: undefined,
      })

      const activeExtensions = reconciled.resolved.extensions
      const baseLayer = Layer.mergeAll(
        Storage.TestWithSql(),
        EventStore.Memory,
        ExtensionRegistry.fromResolved(reconciled.resolved),
        turnControlLayer,
        subagentRunnerLayer,
        PromptPresenter.Test(),
        Permission.Test(),
        AgentLoop.Test(),
        RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        GitReader.Test,
      )
      const stateRuntimeLayer = ExtensionStateRuntime.fromExtensions(activeExtensions).pipe(
        Layer.provideMerge(turnControlLayer),
      )
      const runtimeDeps = Layer.merge(baseLayer, stateRuntimeLayer)
      const eventPublisherLayer = Layer.provide(EventPublisherLive, runtimeDeps)
      const baseLayerAny: Layer.Layer<never, never, object> = Layer.merge(
        runtimeDeps,
        eventPublisherLayer,
      )

      const contributedLayers: Array<Layer.Layer<never, never, object>> = activeExtensions.flatMap(
        (ext) =>
          ext.setup.layer === undefined ? [] : [Layer.provideMerge(ext.setup.layer, baseLayerAny)],
      )

      let extensionLayer: Layer.Layer<never, never, object> | undefined
      for (const layer of contributedLayers) {
        extensionLayer = extensionLayer === undefined ? layer : Layer.merge(extensionLayer, layer)
      }

      return extensionLayer === undefined ? baseLayerAny : Layer.merge(baseLayerAny, extensionLayer)
    }),
  ).pipe(Layer.provide(BunServices.layer))
}

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)

/** Default ToolContext for tests — overridable via spread */
export const testToolContext = (overrides?: Partial<ToolContext>): ToolContext => ({
  sessionId: SessionId.of("test-session"),
  branchId: BranchId.of("test-branch"),
  toolCallId: ToolCallId.of("test-call"),
  cwd: "/tmp",
  home: "/tmp",
  extension: {
    send: dieStub("extension.send"),
    ask: dieStub("extension.ask"),
    getUiSnapshots: dieStub("extension.getUiSnapshots"),
    getUiSnapshot: dieStub("extension.getUiSnapshot"),
  },
  agent: {
    get: dieStub("agent.get"),
    require: dieStub("agent.require"),
    run: dieStub("agent.run"),
    resolveDualModelPair: dieStub("agent.resolveDualModelPair"),
  },
  session: {
    listMessages: dieStub("session.listMessages"),
    getSession: dieStub("session.getSession"),
    getDetail: dieStub("session.getDetail"),
    renameCurrent: dieStub("session.renameCurrent"),
    estimateContextPercent: dieStub("session.estimateContextPercent"),
    search: dieStub("session.search"),
    listBranches: dieStub("session.listBranches"),
    createBranch: dieStub("session.createBranch"),
    forkBranch: dieStub("session.forkBranch"),
    switchBranch: dieStub("session.switchBranch"),
    createChildSession: dieStub("session.createChildSession"),
    getChildSessions: dieStub("session.getChildSessions"),
    getSessionAncestors: dieStub("session.getSessionAncestors"),
    deleteSession: dieStub("session.deleteSession"),
    deleteBranch: dieStub("session.deleteBranch"),
    deleteMessages: dieStub("session.deleteMessages"),
  },
  interaction: {
    approve: dieStub("interaction.approve"),
    present: dieStub("interaction.present"),
    confirm: dieStub("interaction.confirm"),
    review: dieStub("interaction.review"),
  },
  turn: {
    queueFollowUp: dieStub("turn.queueFollowUp"),
    interject: dieStub("turn.interject"),
  },
  ...overrides,
})
