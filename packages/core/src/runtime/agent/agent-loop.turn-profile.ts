import { Context, Effect } from "effect"
import type { ExtensionHostContext } from "../../domain/extension-services.js"
import type { ProcessGenerationId } from "../../domain/ids.js"
import type { PromptSection } from "../../domain/prompt.js"
import { DriverRegistry, type DriverRegistryService } from "../extensions/driver-registry.js"
import { provideCurrentCapabilityContext } from "../extensions/extension-capability-context.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "../extensions/registry.js"
import { provideCurrentHostCtx } from "./tools.js"

export interface AgentLoopTurnProfile {
  readonly turnExtensionRegistry: ExtensionRegistryService
  readonly turnDriverRegistry: DriverRegistryService
  readonly turnBaseSections: ReadonlyArray<PromptSection>
  readonly turnHostCtx: ExtensionHostContext
  readonly turnCapabilityContext?: Context.Context<never>
  /**
   * Identity of the process that built the profile. Absent for direct actor
   * tests and runtimes without a profile cache, where no process-local tool
   * binding can be recorded or resumed.
   */
  readonly turnGenerationId?: ProcessGenerationId
}

export class CurrentAgentLoopTurnProfile extends Context.Service<
  CurrentAgentLoopTurnProfile,
  AgentLoopTurnProfile
>()("@gent/core/src/runtime/agent/agent-loop.turn-profile/CurrentAgentLoopTurnProfile") {}

/** Provide one resolved turn profile to the complete effect. */
export const runAgentLoopTurnProfile =
  (profile: AgentLoopTurnProfile) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const { turnCapabilityContext = Context.empty() } = profile
    return effect.pipe(
      Effect.provideContext(turnCapabilityContext),
      Effect.provideService(CurrentAgentLoopTurnProfile, profile),
      Effect.provideService(ExtensionRegistry, profile.turnExtensionRegistry),
      Effect.provideService(DriverRegistry, profile.turnDriverRegistry),
      provideCurrentCapabilityContext(profile.turnCapabilityContext),
      provideCurrentHostCtx(profile.turnHostCtx),
    )
  }
