/**
 * Workflow primitive — declarative state machines with declared effects.
 *
 * `WorkflowContribution<S, E>` is the first-class shape for genuine state
 * machines that produce effects (queueFollowUp, interject, busEmit) on
 * transitions: auto loop, handoff cooldown, ACP per-session managers.
 *
 * Distinct from `ProjectionContribution` (which is read-only UI/prompt/policy
 * derivation from storage). Per `composability-not-flags` — workflows declare
 * effects, projections derive views, and the two never own the same state.
 *
 * Hosted by `WorkflowRuntime` (file: `runtime/extensions/workflow-runtime.ts`).
 * `WorkflowContribution` is structurally identical to the runtime-internal
 * `ExtensionActorDefinition` shape — they share field names so the lowering
 * is a no-op cast rather than a field-by-field copy.
 *
 * @module
 */

import type { Effect, Schema } from "effect"
import type { Machine, ProvideSlots, SlotCalls, SlotsDef } from "effect-machine"
import type { AgentEvent } from "./event.js"
import type { ExtensionEffect } from "./extension.js"
import type {
  AnyExtensionCommandMessage,
  AnyExtensionRequestMessage,
} from "./extension-protocol.js"
import type { BranchId, SessionId } from "./ids.js"

// ── Workflow effect surface ──

/** Effects a workflow may declare in `afterTransition`. Same shape as
 *  `ExtensionEffect` so today's runtime can dispatch them unchanged. */
export type WorkflowEffect = ExtensionEffect

// ── Lifecycle context ──

export interface WorkflowInitContext<State, Event, SD extends SlotsDef> {
  readonly sessionId: SessionId
  readonly snapshot: Effect.Effect<State>
  readonly send: (event: Event) => Effect.Effect<boolean>
  readonly sessionCwd?: string
  readonly parentSessionId?: SessionId
  readonly getSessionAncestors: () => Effect.Effect<ReadonlyArray<{ readonly id: string }>>
  readonly slots?: SlotCalls<SD>
}

// ── Workflow contribution ──

/**
 * Declarative workflow contribution. Holds a state machine plus mappers from
 * agent events / extension messages into machine events, plus declared
 * effects that fire after every transition.
 *
 * Type parameters mirror `effect-machine`'s machine: State, Event, optional
 * slot-providing services, optional slot definitions.
 */
export interface WorkflowContribution<
  State extends { readonly _tag: string } = { readonly _tag: string },
  Event extends { readonly _tag: string } = { readonly _tag: string },
  SlotsR = never,
  SD extends SlotsDef = Record<string, never>,
> {
  /** The state machine definition — built with `effect-machine`'s `Machine.make`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly machine: Machine.Machine<State, Event, never, any, any, SD>

  /** Provide concrete implementations for the machine's slot calls. */
  readonly slots?: (ctx: {
    readonly sessionId: SessionId
    readonly branchId?: BranchId
  }) => Effect.Effect<ProvideSlots<SD>, never, SlotsR>

  /** Map an `AgentEvent` into a machine event (or undefined to ignore). */
  readonly mapEvent?: (event: AgentEvent) => Event | undefined

  /** Map an extension command message (`ctx.extension.send`) into an event. */
  readonly mapCommand?: (message: AnyExtensionCommandMessage, state: State) => Event | undefined

  /** Map an extension request message (`ctx.extension.ask`) into an event. */
  readonly mapRequest?: (message: AnyExtensionRequestMessage, state: State) => Event | undefined

  /** Effects to dispatch after every state transition. */
  readonly afterTransition?: (before: State, after: State) => ReadonlyArray<WorkflowEffect>

  /** State schema enables persistence via effect-machine's Recovery + Durability. */
  readonly stateSchema?: Schema.Schema<State>

  /** Protocol definitions used for `ctx.extension.send`/`.ask` over this workflow. */
  readonly protocols?: Readonly<Record<string, unknown>>

  /** Lifecycle hook fired once per session after the machine is spawned. */
  readonly onInit?: (ctx: WorkflowInitContext<State, Event, SD>) => Effect.Effect<void>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyWorkflowContribution = WorkflowContribution<any, any, any, any>
