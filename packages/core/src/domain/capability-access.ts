import { Context, Effect, Layer } from "effect"
import { CapabilityError } from "./capability.js"
import type { ExtensionId } from "./ids.js"

export interface CapabilityAccessNeed {
  readonly tag: string
  readonly access: "read" | "write"
}

const CurrentCapabilityAccessNeeds = Context.Reference<ReadonlyArray<CapabilityAccessNeed>>(
  "@gent/core/src/domain/capability-access/CurrentCapabilityAccessNeeds",
  { defaultValue: () => [] },
)

const canWrite = (needs: ReadonlyArray<CapabilityAccessNeed>, tag: string): boolean =>
  needs.some((need) => (need.tag === tag || need.tag === "*") && need.access === "write")

export const requireCapabilityWrite = (params: {
  readonly tag: string
  readonly extensionId: ExtensionId
  readonly capabilityId: string
  readonly operation: string
}): Effect.Effect<void, CapabilityError> =>
  Effect.gen(function* () {
    const needs = yield* CurrentCapabilityAccessNeeds
    if (canWrite(needs, params.tag)) return
    return yield* new CapabilityError({
      extensionId: params.extensionId,
      capabilityId: params.capabilityId,
      reason: `${params.operation} requires write access to ${params.tag}`,
    })
  })

export const provideCapabilityAccessNeeds =
  (needs: ReadonlyArray<CapabilityAccessNeed> | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(Effect.provideService(CurrentCapabilityAccessNeeds, needs ?? []))

export const capabilityAccessNeedsLayer = (
  needs: ReadonlyArray<CapabilityAccessNeed> | undefined,
) => Layer.succeed(CurrentCapabilityAccessNeeds, needs ?? [])
