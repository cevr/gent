import { Effect, type Context } from "effect"
import type { PermissionService } from "../domain/permission.js"
import type { PromptSection } from "../domain/prompt.js"
import type { Session } from "../domain/message.js"
import type { AgentName } from "../domain/agent.js"
import type { BranchId, SessionId } from "../domain/ids.js"
import type { ExtensionHostContext } from "../domain/extension-host-context.js"
import type { StorageService } from "../storage/sqlite-storage.js"
import type { DriverRegistryService } from "./extensions/driver-registry.js"
import type { ExtensionRegistryService } from "./extensions/registry.js"
import type { MachineEngineService } from "./extensions/resource-host/machine-engine.js"
import {
  makeExtensionHostContext,
  type MakeExtensionHostContextDeps,
} from "./make-extension-host-context.js"
import type { SessionProfile, SessionProfileCacheService } from "./session-profile.js"

export interface SessionEnvironmentDefaults {
  readonly driverRegistry: DriverRegistryService
  readonly permission: PermissionService
  readonly baseSections: ReadonlyArray<PromptSection>
}

export interface SessionEnvironment {
  readonly cwd: string
  readonly extensionRegistry: ExtensionRegistryService
  readonly extensionStateRuntime: MachineEngineService
  readonly capabilityContext?: Context.Context<never>
  readonly driverRegistry: DriverRegistryService
  readonly permission: PermissionService
  readonly baseSections: ReadonlyArray<PromptSection>
  readonly hostCtx: ExtensionHostContext
}

export interface SessionFound {
  readonly _tag: "SessionFound"
  readonly session: Session
  readonly environment: SessionEnvironment
}

export interface SessionMissing {
  readonly _tag: "SessionMissing"
  readonly environment: SessionEnvironment
}

export type ResolvedSessionEnvironment = SessionFound | SessionMissing

interface ActiveRuntimeBindings {
  readonly extensionRegistry: ExtensionRegistryService
  readonly extensionStateRuntime: MachineEngineService
  readonly capabilityContext?: Context.Context<never>
  readonly driverRegistry: DriverRegistryService
  readonly permission: PermissionService
  readonly baseSections: ReadonlyArray<PromptSection>
}

const resolveSessionProfile = (params: {
  readonly session: Session | undefined
  readonly profileCache?: SessionProfileCacheService
}): Effect.Effect<SessionProfile | undefined> =>
  params.profileCache !== undefined && params.session?.cwd !== undefined
    ? params.profileCache.resolve(params.session.cwd)
    : Effect.succeed(undefined)

const resolveActiveRuntimeBindings = (params: {
  readonly profile?: SessionProfile
  readonly hostDeps: MakeExtensionHostContextDeps
  readonly defaults: SessionEnvironmentDefaults
}): ActiveRuntimeBindings => ({
  extensionRegistry: params.profile?.registryService ?? params.hostDeps.extensionRegistry,
  extensionStateRuntime:
    params.profile?.extensionStateRuntime ?? params.hostDeps.extensionStateRuntime,
  capabilityContext: params.profile?.layerContext ?? params.hostDeps.capabilityContext,
  driverRegistry: params.profile?.driverRegistryService ?? params.defaults.driverRegistry,
  permission: params.profile?.permissionService ?? params.defaults.permission,
  baseSections: params.profile?.baseSections ?? params.defaults.baseSections,
})

const buildSessionEnvironment = (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName?: AgentName
  readonly session?: Session
  readonly bindings: ActiveRuntimeBindings
  readonly hostDeps: MakeExtensionHostContextDeps
}): SessionEnvironment => {
  const hostCtx = makeExtensionHostContext(
    {
      sessionId: params.sessionId,
      branchId: params.branchId,
      agentName: params.agentName,
      ...(params.session?.cwd !== undefined ? { sessionCwd: params.session.cwd } : {}),
    },
    {
      ...params.hostDeps,
      extensionRegistry: params.bindings.extensionRegistry,
      extensionStateRuntime: params.bindings.extensionStateRuntime,
      ...(params.bindings.capabilityContext !== undefined
        ? { capabilityContext: params.bindings.capabilityContext }
        : {}),
    },
  )

  return {
    cwd: hostCtx.cwd,
    extensionRegistry: params.bindings.extensionRegistry,
    extensionStateRuntime: params.bindings.extensionStateRuntime,
    ...(params.bindings.capabilityContext !== undefined
      ? { capabilityContext: params.bindings.capabilityContext }
      : {}),
    driverRegistry: params.bindings.driverRegistry,
    permission: params.bindings.permission,
    baseSections: params.bindings.baseSections,
    hostCtx,
  }
}

export const AllowAllPermission: PermissionService = {
  check: () => Effect.succeed("allowed"),
  addRule: () => Effect.void,
  removeRule: () => Effect.void,
  getRules: () => Effect.succeed([]),
}

export const resolveSessionEnvironment = (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly storage: StorageService
  readonly hostDeps: MakeExtensionHostContextDeps
  readonly profileCache?: SessionProfileCacheService
  readonly defaults: SessionEnvironmentDefaults
  readonly agentName?: AgentName
}): Effect.Effect<ResolvedSessionEnvironment> =>
  Effect.gen(function* () {
    const session = yield* params.storage
      .getSession(params.sessionId)
      .pipe(Effect.orElseSucceed(() => undefined))

    const profile = yield* resolveSessionProfile({
      session,
      profileCache: params.profileCache,
    })
    const bindings = resolveActiveRuntimeBindings({
      profile,
      hostDeps: params.hostDeps,
      defaults: params.defaults,
    })
    const environment = buildSessionEnvironment({
      sessionId: params.sessionId,
      branchId: params.branchId,
      agentName: params.agentName,
      session,
      bindings,
      hostDeps: params.hostDeps,
    })

    if (session === undefined) {
      return {
        _tag: "SessionMissing",
        environment,
      }
    }

    return {
      _tag: "SessionFound",
      session,
      environment,
    }
  })
