/**
 * Test harness for extension state machines.
 *
 * Pure synchronous utilities — no Effect runtime needed.
 * Import from @gent/core/test-utils/extension-harness
 */

import { expect } from "bun:test"
import { AgentDefinition } from "../domain/agent.js"
import {
  StreamStarted,
  TurnCompleted,
  ToolCallSucceeded,
  ToolCallFailed,
  WorkflowPhaseStarted,
  WorkflowCompleted,
} from "../domain/event.js"
import type {
  ExtensionDeriveContext,
  ExtensionIntentResult,
  ExtensionProjection,
  ExtensionReduceContext,
  ExtensionStateMachine,
} from "../domain/extension.js"
import type { BranchId, SessionId, ToolCallId } from "../domain/ids.js"
import type { AnyToolDefinition } from "../domain/tool.js"

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

  workflowPhaseStarted: (
    overrides?: Partial<ConstructorParameters<typeof WorkflowPhaseStarted>[0]>,
  ) =>
    new WorkflowPhaseStarted({
      sessionId: ctx.sessionId,
      branchId: ctx.branchId,
      workflowName: "test",
      phase: "idle",
      ...overrides,
    }),

  workflowCompleted: (overrides?: Partial<ConstructorParameters<typeof WorkflowCompleted>[0]>) =>
    new WorkflowCompleted({
      sessionId: ctx.sessionId,
      branchId: ctx.branchId,
      workflowName: "test",
      result: "success",
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
