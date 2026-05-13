import { Context, Effect } from "effect"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import { Permission, type PermissionService } from "../../domain/permission.js"
import type { PromptSection } from "../../domain/prompt.js"
import { DriverRegistry, type DriverRegistryService } from "../extensions/driver-registry.js"
import { provideCurrentCapabilityContext } from "../extensions/extension-capability-context.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "../extensions/registry.js"
import { provideCurrentHostCtx } from "./current-extension-host-context.js"

export type AgentLoopTurnProfile = {
  readonly turnExtensionRegistry: ExtensionRegistryService
  readonly turnDriverRegistry: DriverRegistryService
  readonly turnPermission: PermissionService
  readonly turnBaseSections: ReadonlyArray<PromptSection>
  readonly turnHostCtx: ExtensionHostContext
  readonly turnCapabilityContext?: Context.Context<never>
}

export class CurrentAgentLoopTurnProfile extends Context.Service<
  CurrentAgentLoopTurnProfile,
  AgentLoopTurnProfile
>()("@gent/core/src/runtime/agent/agent-loop.turn-profile/CurrentAgentLoopTurnProfile") {}

export const provideAgentLoopTurnProfile =
  (profile: AgentLoopTurnProfile) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(CurrentAgentLoopTurnProfile, profile),
      Effect.provideService(ExtensionRegistry, profile.turnExtensionRegistry),
      Effect.provideService(DriverRegistry, profile.turnDriverRegistry),
      Effect.provideService(Permission, profile.turnPermission),
      provideCurrentCapabilityContext(profile.turnCapabilityContext),
      provideCurrentHostCtx(profile.turnHostCtx),
    )
