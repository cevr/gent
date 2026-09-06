import { Context, Effect, Predicate, Schema } from "effect"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import { Permission, type PermissionService } from "../../domain/permission.js"
import type { PromptSection } from "../../domain/prompt.js"
import { AgentLoopError } from "./agent-loop.state.js"
import {
  ResourceLeaseClosedError,
  ResourceLeaseStaleGenerationError,
} from "../extensions/resource-host/resource-leases.js"
import type { ResourceGraphPublication } from "../extensions/resource-host/resource-graph-host.js"
import type { RuntimeProfileCatalog } from "../profile.js"
import { DriverRegistry, type DriverRegistryService } from "../extensions/driver-registry.js"
import { provideCurrentCapabilityContext } from "../extensions/extension-capability-context.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "../extensions/registry.js"
import { provideCurrentHostCtx } from "./current-extension-host-context.js"

type AgentLoopTurnProfileFields = {
  readonly turnExtensionRegistry: ExtensionRegistryService
  readonly turnDriverRegistry: DriverRegistryService
  readonly turnPermission: PermissionService
  readonly turnBaseSections: ReadonlyArray<PromptSection>
  readonly turnHostCtx: ExtensionHostContext
  readonly turnCapabilityContext?: Context.Context<never>
}

export type LegacyAgentLoopTurnProfile = AgentLoopTurnProfileFields & {
  /** Direct actor tests and the legacy runtime do not own a graph host. */
  readonly turnPublication?: never
}

export type LiveAgentLoopTurnProfile = AgentLoopTurnProfileFields & {
  readonly turnPublication: ResourceGraphPublication<RuntimeProfileCatalog>
}

export type AgentLoopTurnProfile = LiveAgentLoopTurnProfile | LegacyAgentLoopTurnProfile

export class CurrentAgentLoopTurnProfile extends Context.Service<
  CurrentAgentLoopTurnProfile,
  AgentLoopTurnProfile
>()("@gent/core/src/runtime/agent/agent-loop.turn-profile/CurrentAgentLoopTurnProfile") {}

export const provideAgentLoopTurnProfile =
  (profile: AgentLoopTurnProfile) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const { turnCapabilityContext = Context.empty() } = profile
    return effect.pipe(
      Effect.provideContext(turnCapabilityContext),
      Effect.provideService(CurrentAgentLoopTurnProfile, profile),
      Effect.provideService(ExtensionRegistry, profile.turnExtensionRegistry),
      Effect.provideService(DriverRegistry, profile.turnDriverRegistry),
      Effect.provideService(Permission, profile.turnPermission),
      provideCurrentCapabilityContext(profile.turnCapabilityContext),
      provideCurrentHostCtx(profile.turnHostCtx),
    )
  }

/**
 * Legacy/test-only context provision for runtimes without a live graph host.
 * The live SessionProfileCache path uses `runAgentLoopTurnProfileOrLegacy`.
 * Its `LiveSessionProfile` result always enters the live branch. Direct actor
 * tests and the legacy runtime use the explicit legacy branch.
 */
export const provideLegacyAgentLoopTurnProfile =
  (profile: LegacyAgentLoopTurnProfile) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    provideAgentLoopTurnProfile(profile)(effect)

const isLiveAgentLoopTurnProfile = (
  profile: AgentLoopTurnProfile,
): profile is LiveAgentLoopTurnProfile => Predicate.isNotUndefined(profile.turnPublication)

const mapPublicationAdmissionError = <E>(
  error: E | ResourceLeaseClosedError | ResourceLeaseStaleGenerationError,
): E | AgentLoopError => {
  if (Schema.is(ResourceLeaseClosedError)(error)) {
    return new AgentLoopError({
      message: `Resource publication closed before turn admission (${error.generationId})`,
      cause: error,
    })
  }
  if (Schema.is(ResourceLeaseStaleGenerationError)(error)) {
    return new AgentLoopError({
      message: `Resource publication is stale before turn admission (${error.generationId})`,
      cause: error,
    })
  }
  return error
}

/**
 * Provides one resolved turn profile and admits the complete effect against
 * that profile's publication generation. The admission lease covers all
 * finalizers registered by the effect.
 */
export const runAgentLoopTurnProfile =
  (profile: LiveAgentLoopTurnProfile) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const provided = provideAgentLoopTurnProfile(profile)(effect)
    return profile.turnPublication
      .run(provided)
      .pipe(Effect.mapError((error) => mapPublicationAdmissionError<E>(error)))
  }

/**
 * Compatibility entry point for direct actor tests and the legacy runtime.
 * SessionProfileCache.Live returns a LiveSessionProfile, so production turns
 * always use the publication branch. The legacy branch is for direct actor
 * tests and runtimes without a live profile cache.
 */
export const runAgentLoopTurnProfileOrLegacy =
  (profile: AgentLoopTurnProfile) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    if (!isLiveAgentLoopTurnProfile(profile)) {
      return provideLegacyAgentLoopTurnProfile(profile)(effect)
    }
    return runAgentLoopTurnProfile(profile)(effect)
  }
