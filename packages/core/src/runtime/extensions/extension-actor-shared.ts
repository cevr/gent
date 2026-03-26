/**
 * Shared logic for fromMachine and fromReducer extension actors.
 *
 * Extracts the projection config builder — the largest pure duplicate
 * between the two files (~30 identical lines). Effect-based helpers
 * (persist, load, interpretEffects) stay inline because they close
 * over service instances whose types don't compose cleanly across
 * standalone function boundaries in Effect v4.
 */

import type { Schema } from "effect"
import type {
  ExtensionDeriveContext,
  ExtensionProjection,
  ExtensionProjectionConfig,
} from "../../domain/extension.js"
import { AgentDefinition, type AgentName as AgentNameType } from "../../domain/agent.js"

/**
 * Build ExtensionProjectionConfig from derive/deriveUi config.
 * Identical between fromMachine and fromReducer — extracted to avoid
 * maintaining two copies of the sentinel + fallback logic.
 */
export const buildProjectionConfig = <State>(config: {
  derive?: (state: State, ctx: ExtensionDeriveContext) => ExtensionProjection
  deriveUi?: (state: State) => unknown
  uiModelSchema?: Schema.Any
}): ExtensionProjectionConfig | undefined => {
  const deriveFn = config.derive
  const deriveUiFn = config.deriveUi
  if (deriveFn === undefined && deriveUiFn === undefined) return undefined

  let deriveTurn: ExtensionProjectionConfig["deriveTurn"]
  if (deriveFn !== undefined) {
    deriveTurn = (state: unknown, deriveCtx: ExtensionDeriveContext) => {
      const { uiModel: _, ...turn } = deriveFn(state as State, deriveCtx)
      return turn
    }
  }

  let deriveUi: ExtensionProjectionConfig["deriveUi"]
  if (deriveUiFn !== undefined) {
    deriveUi = (state: unknown) => deriveUiFn(state as State)
  } else if (deriveFn !== undefined) {
    const sentinel = new AgentDefinition({
      name: "__derive_ui__" as AgentNameType,
      kind: "system",
    })
    deriveUi = (state: unknown) =>
      deriveFn(state as State, { agent: sentinel, allTools: [] }).uiModel
  }

  return { deriveTurn, deriveUi, uiModelSchema: config.uiModelSchema }
}
