/**
 * Test harness for extension state machines and lifecycle.
 *
 * Pure synchronous utilities — no Effect runtime needed.
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
} from "../domain/event.js"
import type {
  ExtensionDeriveContext,
  ExtensionIntentResult,
  ExtensionProjection,
  ExtensionReduceContext,
  ExtensionSetup,
  ExtensionStateMachine,
  GentExtension,
} from "../domain/extension.js"
import type { BranchId, SessionId, ToolCallId } from "../domain/ids.js"
import { Permission } from "../domain/permission.js"
import { PromptPresenter } from "../domain/prompt-presenter.js"
import { PermissionHandler, PromptHandler, HandoffHandler } from "../domain/interaction-handlers.js"
import type { AnyToolDefinition } from "../domain/tool.js"
import { AgentLoop } from "../runtime/agent/agent-loop.js"
import { ExtensionEventBus } from "../runtime/extensions/event-bus.js"
import { ExtensionRegistry, resolveExtensions } from "../runtime/extensions/registry.js"
import { ExtensionStateRuntime } from "../runtime/extensions/state-runtime.js"
import { ExtensionTurnControl } from "../runtime/extensions/turn-control.js"
import { Storage } from "../storage/sqlite-storage.js"
import { AskUserHandler } from "../tools/ask-user.js"

// ── Options ──

export interface StateMachineHarnessOptions {
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

// ── State Machine Harness ──

/** Harness return type — `intent` only present when the machine defines `handleIntent` */
interface StateMachineHarnessBase<State> {
  readonly machine: ExtensionStateMachine<State>
  readonly reduce: (
    state: State,
    event: Parameters<ExtensionStateMachine<State>["reduce"]>[1],
  ) => State
  readonly derive: (state: State) => ExtensionProjection
  readonly ctx: ExtensionReduceContext
  readonly deriveCtx: ExtensionDeriveContext
  readonly events: EventFactories
}

interface StateMachineHarnessWithIntent<State, Intent> extends StateMachineHarnessBase<State> {
  readonly intent: (state: State, i: Intent) => ExtensionIntentResult<State>
}

/** Machine with handleIntent defined */
interface MachineWithIntent<State, Intent> extends ExtensionStateMachine<State, Intent> {
  readonly handleIntent: (state: State, intent: Intent) => ExtensionIntentResult<State>
}

export function createStateMachineHarness<State, Intent>(
  machine: MachineWithIntent<State, Intent>,
  options?: StateMachineHarnessOptions,
): StateMachineHarnessWithIntent<State, Intent>
export function createStateMachineHarness<State>(
  machine: ExtensionStateMachine<State>,
  options?: StateMachineHarnessOptions,
): StateMachineHarnessBase<State>
export function createStateMachineHarness<State, Intent>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  machine: ExtensionStateMachine<State, any>,
  options?: StateMachineHarnessOptions,
): StateMachineHarnessBase<State> | StateMachineHarnessWithIntent<State, Intent> {
  const ctx: ExtensionReduceContext = {
    sessionId: (options?.sessionId ?? "test-session") as SessionId,
    branchId: (options?.branchId ?? "test-branch") as BranchId,
  }

  const deriveCtx: ExtensionDeriveContext = {
    agent:
      options?.agent ?? new AgentDefinition({ name: "test" as never, kind: "primary" as const }),
    allTools: options?.allTools ?? [],
  }

  const events = createEventFactories(ctx)

  const reduce = (state: State, event: Parameters<typeof machine.reduce>[1]): State =>
    machine.reduce(state, event, ctx)

  const derive = (state: State): ExtensionProjection => machine.derive(state, deriveCtx)

  const base = { machine, reduce, derive, ctx, deriveCtx, events }

  if (machine.handleIntent !== undefined) {
    const handler = machine.handleIntent
    return {
      ...base,
      intent: (state: State, i: Intent): ExtensionIntentResult<State> => handler(state, i),
    }
  }

  return base
}

// ── Extension Lifecycle Harness ──

export interface ExtensionHarnessResult {
  readonly setup: ExtensionSetup
  readonly tools: Map<string, AnyToolDefinition>
  readonly agents: Map<string, AgentDefinition>
  readonly stateMachine:
    | {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        readonly machine: ExtensionStateMachine<any, any>
        readonly id: string
      }
    | undefined
  readonly tagInjections: ExtensionSetup["tagInjections"]
  readonly hooks: ExtensionSetup["hooks"]
}

/**
 * Load an extension through the full lifecycle and return its resolved setup.
 *
 * Runs setup() via Effect.runSync, extracts tools/agents/state machine/tag injections/hooks.
 */
export const createExtensionHarness = (
  extension: GentExtension,
  options?: { cwd?: string },
): ExtensionHarnessResult => {
  const setup = Effect.runSync(
    extension.setup({ cwd: options?.cwd ?? "/tmp", config: undefined as never, source: "test" }),
  )

  const tools = new Map<string, AnyToolDefinition>()
  for (const tool of setup.tools ?? []) {
    tools.set(tool.name, tool)
  }

  const agents = new Map<string, AgentDefinition>()
  for (const agent of setup.agents ?? []) {
    agents.set(agent.name, agent)
  }

  const stateMachine =
    setup.stateMachine !== undefined
      ? { machine: setup.stateMachine, id: setup.stateMachine.id }
      : undefined

  return {
    setup,
    tools,
    agents,
    stateMachine,
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
 * Create a test layer suitable for testing tool execute functions.
 *
 * Provides: Storage, EventStore, ExtensionRegistry, ExtensionStateRuntime,
 * ExtensionEventBus, ExtensionTurnControl, SubagentRunnerService,
 * PromptPresenter, Permission, PermissionHandler, PromptHandler,
 * HandoffHandler, AskUserHandler, AgentLoop.
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
    setup: Effect.runSync(ext.setup({ cwd: "/tmp", config: undefined as never, source: "test" })),
  }))

  const allExtensions = [
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

  return Layer.mergeAll(
    Storage.Test(),
    EventStore.Test(),
    ExtensionRegistry.fromResolved(resolveExtensions(allExtensions)),
    ExtensionStateRuntime.fromExtensions(allExtensions),
    ExtensionEventBus.Test(),
    ExtensionTurnControl.Test(),
    subagentRunnerLayer,
    PromptPresenter.Test(),
    Permission.Test(),
    PermissionHandler.Test(["allow"]),
    PromptHandler.Test(["yes"]),
    HandoffHandler.Test(["confirm"]),
    AskUserHandler.Test([["yes"]]),
    AgentLoop.Test(),
  )
}
