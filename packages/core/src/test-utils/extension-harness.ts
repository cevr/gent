/**
 * Test harness for extension actors and lifecycle.
 *
 * Import from @gent/core/test-utils/extension-harness
 */

import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import {
  Agents,
  AgentDefinition,
  SubagentRunnerService,
  type AgentName,
  type SubagentRunner,
} from "../domain/agent.js"
import {
  EventStore,
  StreamStarted,
  TurnCompleted,
  ToolCallSucceeded,
  ToolCallFailed,
  type AgentEvent,
} from "../domain/event.js"
import type {
  ExtensionDeriveContext,
  ExtensionProjection,
  ExtensionProjectionConfig,
  ExtensionReduceContext,
  ExtensionSetup,
  GentExtension,
  LoadedExtension,
  ReduceResult,
  SpawnActor,
} from "../domain/extension.js"
import type { BranchId, SessionId, ToolCallId } from "../domain/ids.js"
import { Permission } from "../domain/permission.js"
import { PromptPresenter } from "../domain/prompt-presenter.js"
import { PermissionHandler, PromptHandler, HandoffHandler } from "../domain/interaction-handlers.js"
import type { AnyToolDefinition } from "../domain/tool.js"
import { AgentLoop } from "../runtime/agent/agent-loop.js"
import { ExtensionRegistry, resolveExtensions } from "../runtime/extensions/registry.js"
import { ExtensionStateRuntime } from "../runtime/extensions/state-runtime.js"
import { ExtensionTurnControl } from "../runtime/extensions/turn-control.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"
import { TaskService } from "../runtime/task-service.js"
import { Skills } from "../domain/skills.js"
import { Storage } from "../storage/sqlite-storage.js"
import { AskUserHandler } from "../tools/ask-user.js"

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
      toolCallId: "tc-test" as ToolCallId,
      toolName: "test",
      ...overrides,
    }),

  toolCallFailed: (overrides?: Partial<ConstructorParameters<typeof ToolCallFailed>[0]>) =>
    new ToolCallFailed({
      sessionId: ctx.sessionId,
      branchId: ctx.branchId,
      toolCallId: "tc-test" as ToolCallId,
      toolName: "test",
      ...overrides,
    }),
})

export type EventFactories = ReturnType<typeof createEventFactories>

// ── Reference Equality Assertion ──

/** Assert that a reduce call produced no state change (reference equality) */
export const expectNoChange = <T>(before: T, after: T): void => {
  expect(after).toBe(before)
}

// ── Actor Harness ──

/**
 * Create a pure synchronous harness for testing fromReducer-based actors.
 *
 * Wraps the reduce/derive/handleIntent functions so tests can call them
 * without Effect runtime — useful for pure state transition testing.
 */
export interface ActorHarnessResult<State, Intent = void> {
  readonly reduce: (
    state: State,
    event: AgentEvent,
    ctx?: ExtensionReduceContext,
  ) => ReduceResult<State>
  readonly derive: (state: State) => ExtensionProjection
  readonly intent: Intent extends void
    ? undefined
    : (state: State, i: Intent) => ReduceResult<State>
  readonly ctx: ExtensionReduceContext
  readonly deriveCtx: ExtensionDeriveContext
  readonly events: EventFactories
  readonly initial: State
}

export interface ActorHarnessConfig<State, Intent = void> {
  readonly id: string
  readonly initial: State
  readonly reduce: (
    state: State,
    event: AgentEvent,
    ctx: ExtensionReduceContext,
  ) => ReduceResult<State>
  readonly derive?: (state: State, ctx: ExtensionDeriveContext) => ExtensionProjection
  readonly handleIntent?: (state: State, intent: Intent) => ReduceResult<State>
}

export function createActorHarness<State, Intent>(
  config: ActorHarnessConfig<State, Intent> & {
    handleIntent: (state: State, intent: Intent) => ReduceResult<State>
  },
  options?: ActorHarnessOptions,
): ActorHarnessResult<State, Intent>
export function createActorHarness<State>(
  config: ActorHarnessConfig<State>,
  options?: ActorHarnessOptions,
): ActorHarnessResult<State>
export function createActorHarness<State, Intent = void>(
  config: ActorHarnessConfig<State, Intent>,
  options?: ActorHarnessOptions,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): ActorHarnessResult<State, any> {
  const ctx: ExtensionReduceContext = {
    sessionId: (options?.sessionId ?? "test-session") as SessionId,
    branchId: (options?.branchId ?? "test-branch") as BranchId,
  }

  const deriveCtx: ExtensionDeriveContext = {
    agent:
      options?.agent ?? new AgentDefinition({ name: "test" as never, kind: "primary" as const }),
    allTools: options?.allTools ?? [],
  }

  const branchId = (options?.branchId ?? "test-branch") as BranchId
  const events = createEventFactories({ sessionId: ctx.sessionId, branchId })

  const reduce = (
    state: State,
    event: AgentEvent,
    reduceCtx?: ExtensionReduceContext,
  ): ReduceResult<State> => config.reduce(state, event, reduceCtx ?? ctx)

  const derive = (state: State): ExtensionProjection =>
    config.derive !== undefined ? config.derive(state, deriveCtx) : {}

  const handler = config.handleIntent
  const intent =
    handler !== undefined
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (state: State, i: any): ReduceResult<State> => handler(state, i)
      : undefined

  return {
    reduce,
    derive,
    intent,
    ctx,
    deriveCtx,
    events,
    initial: config.initial,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

// ── Extension Lifecycle Harness ──

export interface ExtensionHarnessResult {
  readonly setup: ExtensionSetup
  readonly tools: Map<string, AnyToolDefinition>
  readonly agents: Map<string, AgentDefinition>
  readonly spawnActor: SpawnActor | undefined
  readonly projection: ExtensionProjectionConfig | undefined
  readonly tagInjections: ExtensionSetup["tagInjections"]
  readonly hooks: ExtensionSetup["hooks"]
}

/**
 * Load an extension through the full lifecycle and return its resolved setup.
 *
 * Runs setup() via Effect.runSync, extracts tools/agents/spawnActor/tag injections/hooks.
 */
export const createExtensionHarness = (
  extension: GentExtension,
  options?: { cwd?: string },
): ExtensionHarnessResult => {
  const setup = Effect.runSync(extension.setup({ cwd: options?.cwd ?? "/tmp", source: "test" }))

  const tools = new Map<string, AnyToolDefinition>()
  for (const tool of setup.tools ?? []) {
    tools.set(tool.name, tool)
  }

  const agents = new Map<string, AgentDefinition>()
  for (const agent of setup.agents ?? []) {
    agents.set(agent.name, agent)
  }

  return {
    setup,
    tools,
    agents,
    spawnActor: setup.spawnActor,
    projection: setup.projection,
    tagInjections: setup.tagInjections,
    hooks: setup.hooks,
  }
}

// ── Tool Test Layer ──

export interface ToolTestLayerConfig {
  /** Extensions to load (defaults to builtin agents only) */
  readonly extensions?: ReadonlyArray<GentExtension>
  /** Extra tools to register */
  readonly tools?: ReadonlyArray<AnyToolDefinition>
  /** SubagentRunner mock — default returns success with empty text */
  readonly subagentRunner?: SubagentRunner
}

/**
 * Create a test layer for extension tool execution.
 *
 * Provides core services needed by most tools. Tools that need platform
 * services (FileSystem, Path) should compose with BunServices.layer.
 */
export const createToolTestLayer = (config: ToolTestLayerConfig = {}) => {
  const builtinSetup: ExtensionSetup = {
    agents: Object.values(Agents),
    tools: [...(config.tools ?? [])],
  }

  const extensionSetups = (config.extensions ?? []).map((ext) => ({
    manifest: ext.manifest,
    kind: "builtin" as const,
    sourcePath: "test",
    setup: Effect.runSync(ext.setup({ cwd: "/tmp", source: "test" })),
  }))

  const allExtensions: LoadedExtension[] = [
    {
      manifest: { id: "test-agents" },
      kind: "builtin" as const,
      sourcePath: "test",
      setup: builtinSetup,
    },
    ...extensionSetups,
  ]

  const defaultRunner: SubagentRunner = {
    run: () =>
      Effect.succeed({
        _tag: "success" as const,
        text: "",
        sessionId: "test-subagent-session" as SessionId,
        agentName: "cowork" as AgentName,
      }),
  }
  const subagentRunnerLayer = Layer.succeed(
    SubagentRunnerService,
    config.subagentRunner ?? defaultRunner,
  )

  // @effect-diagnostics effectSucceedWithVoid:off
  const taskServiceLayer = Layer.succeed(TaskService, {
    create: () => Effect.die("TaskService.create not implemented in test"),
    get: () => Effect.succeed(undefined),
    list: () => Effect.succeed([]),
    update: () => Effect.succeed(undefined),
    remove: () => Effect.void,
    run: () => Effect.succeed({ taskId: "t-0" as never, status: "pending" }),
    addDep: () => Effect.void,
    removeDep: () => Effect.void,
    getDeps: () => Effect.succeed([]),
  })

  return Layer.mergeAll(
    Storage.Test(),
    EventStore.Test(),
    ExtensionRegistry.fromResolved(resolveExtensions(allExtensions)),
    ExtensionStateRuntime.fromExtensions(allExtensions),
    ExtensionTurnControl.Test(),
    subagentRunnerLayer,
    PromptPresenter.Test(),
    Permission.Test(),
    PermissionHandler.Test(["allow"]),
    PromptHandler.Test(["yes"]),
    HandoffHandler.Test(["confirm"]),
    AskUserHandler.Test([["yes"]]),
    AgentLoop.Test(),
    taskServiceLayer,
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    Skills.Test(),
  )
}
