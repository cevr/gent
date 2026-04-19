/**
 * SubscriptionHost — compile `SubscriptionContribution[]` into per-event
 * fan-out handlers with declared per-subscription failure policy.
 *
 * Sister host: `pipeline-host.ts` for transformers with `next`.
 *
 * Composition: scope-ordered fan-out (builtin → user → project, then
 * id-stable). Each subscription's `failureMode` controls what happens when
 * its handler fails:
 *   - `"continue"` — log debug, swallow, move to next subscription
 *   - `"isolate"` — log warning with extension id + cause, swallow, move on
 *   - `"halt"` — surface the failure; subsequent subscriptions don't fire
 *
 * @module
 */
import { Cause, Effect } from "effect"
import type { LoadedExtension, ExtensionKind } from "../../domain/extension.js"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import type {
  AnySubscriptionContribution,
  SubscriptionEvent,
  SubscriptionFailureMode,
  SubscriptionHandler,
  SubscriptionKey,
} from "../../domain/subscription.js"

interface RegisteredSubscription<K extends SubscriptionKey> {
  readonly extensionId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly handler: SubscriptionHandler<K, any, any>
  readonly failureMode: SubscriptionFailureMode
}

export interface CompiledSubscriptions {
  readonly emit: <K extends SubscriptionKey>(
    event: K,
    payload: SubscriptionEvent<K>,
    ctx: ExtensionHostContext,
  ) => Effect.Effect<void>
}

const SCOPE_ORDER: Record<ExtensionKind, number> = { builtin: 0, user: 1, project: 2 }

type SubscriptionRegistry = {
  [K in SubscriptionKey]: Array<RegisteredSubscription<K>>
}

const emptyRegistry = (): SubscriptionRegistry => ({
  "turn.before": [],
  "turn.after": [],
  "message.output": [],
})

export const compileSubscriptions = (
  extensions: ReadonlyArray<LoadedExtension>,
): CompiledSubscriptions => {
  const sorted = [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_ORDER[a.kind] - SCOPE_ORDER[b.kind]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

  const registry = emptyRegistry()
  for (const ext of sorted) {
    for (const contribution of ext.contributions.subscriptions ?? []) {
      const c = contribution as AnySubscriptionContribution
      registry[c.event].push({
        extensionId: ext.manifest.id,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        handler: c.handler as RegisteredSubscription<typeof c.event>["handler"],
        failureMode: c.failureMode,
      } as RegisteredSubscription<typeof c.event>)
    }
  }

  const emit = <K extends SubscriptionKey>(
    event: K,
    payload: SubscriptionEvent<K>,
    ctx: ExtensionHostContext,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const subs = registry[event]
      for (const sub of subs) {
        // Subscription handlers' R channel is provided by the extension's
        // Resource layer at composition time — already provided when this
        // emit runs, so we erase R at the boundary.
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off — subscription R/E erased at host boundary
        const result = yield* Effect.suspend(
          () =>
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            sub.handler(payload, ctx) as Effect.Effect<void>,
        ).pipe(Effect.exit)
        if (result._tag === "Success") continue
        const cause = result.cause
        switch (sub.failureMode) {
          case "continue":
            yield* Effect.logDebug("extension.subscription.failed").pipe(
              Effect.annotateLogs({
                event,
                extensionId: sub.extensionId,
                cause: Cause.pretty(cause),
              }),
            )
            continue
          case "isolate":
            yield* Effect.logWarning("extension.subscription.failed").pipe(
              Effect.annotateLogs({
                event,
                extensionId: sub.extensionId,
                cause: Cause.pretty(cause),
              }),
            )
            continue
          case "halt":
            // `halt` surfaces the failure as a defect on the caller. The
            // caller's error channel is `never` (subscriptions are observers
            // — the runtime does not type them); a defect is the only way to
            // signal "this is critical, do not continue." Use sparingly.
            yield* Effect.logError("extension.subscription.halt").pipe(
              Effect.annotateLogs({
                event,
                extensionId: sub.extensionId,
                cause: Cause.pretty(cause),
              }),
            )
            return yield* Effect.die(Cause.squash(cause))
        }
      }
    })

  return { emit }
}
