/**
 * SubscriptionContribution — legacy ordered observer migration shim.
 *
 * Historical three-hook shape where the runtime fans out an event to all subscribers and
 * doesn't care about return values: `turn.before`, `turn.after`,
 * `message.output`. Authoring shape is `(event, ctx) => Effect<void>` — no
 * `next`, no return value.
 *
 * New runtime code should prefer explicit slots:
 * - `Resource.runtime.turnBefore`
 * - `Resource.runtime.turnAfter`
 * - `Resource.runtime.messageOutput`
 *
 * This file remains only as a migration bridge until builtin callers move off
 * the generic keyed observer registry and the host can be deleted.
 *
 * Sister primitive: `PipelineContribution` for transformers that genuinely
 * use `next` and return a meaningful output. The codex C6 correction was
 * that `Interceptor<I, void>` was a deceptive shape — `next` did nothing in
 * the void variants. Subscription is the honest split.
 *
 * Failure policy is per-subscription:
 *   - `"continue"` — log and skip this subscription; remaining subscriptions
 *     still fire. Default for safe-to-skip side effects.
 *   - `"isolate"` — same as `"continue"` but with a structured warning
 *     including the subscription's extension id for diagnostics.
 *   - `"halt"` — surface the failure to the runtime; subsequent
 *     subscriptions don't fire. Use for state-machine-critical observers
 *     where partial fan-out leaves the system in a bad state.
 *
 * Composition: scope-ordered fan-out (builtin → user → project, then
 * id-stable). Order within a scope is registration order.
 *
 * @module
 */
import type { Effect } from "effect"
import type { MessageOutputInput, TurnAfterInput, TurnBeforeInput } from "./extension.js"
import type { ExtensionHostContext } from "./extension-host-context.js"

/** Map of subscription-key to event payload type. */
export interface SubscriptionMap {
  readonly "turn.before": TurnBeforeInput
  readonly "turn.after": TurnAfterInput
  readonly "message.output": MessageOutputInput
}

export type SubscriptionKey = keyof SubscriptionMap
export type SubscriptionEvent<K extends SubscriptionKey> = SubscriptionMap[K]

/** Failure policy per subscription. */
export type SubscriptionFailureMode = "continue" | "isolate" | "halt"

/** Handler for a single subscription registration. */
export type SubscriptionHandler<K extends SubscriptionKey, E = never, R = never> = (
  event: SubscriptionEvent<K>,
  ctx: ExtensionHostContext,
) => Effect.Effect<void, E, R>

export interface SubscriptionContribution<
  K extends SubscriptionKey = SubscriptionKey,
  E = never,
  R = never,
> {
  readonly event: K
  readonly handler: SubscriptionHandler<K, E, R>
  readonly failureMode: SubscriptionFailureMode
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySubscriptionContribution = SubscriptionContribution<SubscriptionKey, any, any>
