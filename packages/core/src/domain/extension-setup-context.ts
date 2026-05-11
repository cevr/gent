/**
 * `ExtensionSetupContext` — yieldable setup-time facts for extension authoring.
 *
 * The runtime loader builds a `PublicExtensionSetupContext` from the host
 * platform and provides it as a service around `GentExtension.setup`.
 * Author code (and `defineExtension` bucket factories) reads facts via
 * `yield* ExtensionSetupContext` — there is no ctx-as-param escape hatch.
 *
 * @module
 */

import { Context } from "effect"
import type { ExtensionHostPlatform } from "./extension.js"

/**
 * Narrowed view of the runtime host surface exposed to extension authors at
 * setup time. The loader strips read/write authority and only forwards the
 * facts + process-helpers that authoring needs.
 */
export interface PublicExtensionSetupContext {
  readonly cwd: string
  readonly source: string
  readonly home: string
  readonly host: Pick<
    ExtensionHostPlatform,
    "osInfo" | "execPath" | "homeDirectory" | "pathListSeparator"
  >
  readonly Process: Pick<
    ExtensionHostPlatform,
    "parentEnv" | "runProcess" | "signalPid" | "isPortFree" | "isPidAlive" | "commandCandidates"
  >
}

/**
 * Service Tag carrying `PublicExtensionSetupContext`. Loader provides it
 * around the `GentExtension.setup` Effect; authors yield it.
 */
export class ExtensionSetupContext extends Context.Service<
  ExtensionSetupContext,
  PublicExtensionSetupContext
>()("@gent/core/src/domain/extension-setup-context/ExtensionSetupContext") {}

/**
 * Build the narrowed public setup context from a runtime host platform and
 * loader-resolved cwd/source/home. Loader-owned narrowing boundary.
 */
export const publicSetupContext = (input: {
  readonly cwd: string
  readonly source: string
  readonly home: string
  readonly host: ExtensionHostPlatform
}): PublicExtensionSetupContext => ({
  cwd: input.cwd,
  source: input.source,
  home: input.home,
  host: {
    osInfo: input.host.osInfo,
    execPath: input.host.execPath,
    homeDirectory: input.host.homeDirectory,
    pathListSeparator: input.host.pathListSeparator,
  },
  Process: {
    parentEnv: input.host.parentEnv,
    runProcess: input.host.runProcess,
    signalPid: input.host.signalPid,
    isPortFree: input.host.isPortFree,
    isPidAlive: input.host.isPidAlive,
    commandCandidates: input.host.commandCandidates,
  },
})
