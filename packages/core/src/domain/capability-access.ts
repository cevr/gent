import { Context, Effect } from "effect"
import { CapabilityError } from "./capability.js"
import type { ExtensionId } from "./ids.js"

export interface CapabilityAccessNeed {
  readonly tag: string
  readonly access: "read" | "write"
}

export interface CapabilityAccessService {
  readonly needs: ReadonlyArray<CapabilityAccessNeed>
  readonly canWrite: (tag: string) => boolean
  readonly requireWrite: (params: {
    readonly tag: string
    readonly extensionId: ExtensionId
    readonly capabilityId: string
    readonly operation: string
  }) => Effect.Effect<void, CapabilityError>
}

const canWrite = (needs: ReadonlyArray<CapabilityAccessNeed>, tag: string): boolean =>
  needs.some((need) => (need.tag === tag || need.tag === "*") && need.access === "write")

export class CapabilityAccess extends Context.Service<CapabilityAccess, CapabilityAccessService>()(
  "@gent/core/src/domain/capability-access/CapabilityAccess",
) {
  static readonly fromNeeds = (
    needs: ReadonlyArray<CapabilityAccessNeed> | undefined,
  ): CapabilityAccessService => {
    const resolved = needs ?? []
    return {
      needs: resolved,
      canWrite: (tag) => canWrite(resolved, tag),
      requireWrite: ({ tag, extensionId, capabilityId, operation }) =>
        canWrite(resolved, tag)
          ? Effect.void
          : Effect.fail(
              new CapabilityError({
                extensionId,
                capabilityId,
                reason: `${operation} requires write access to ${tag}`,
              }),
            ),
    }
  }

  static readonly provideNeeds =
    (needs: ReadonlyArray<CapabilityAccessNeed> | undefined) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, CapabilityAccess>> =>
      effect.pipe(Effect.provideService(CapabilityAccess, CapabilityAccess.fromNeeds(needs)))
}
