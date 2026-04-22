import { Effect } from "effect"
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

export interface SessionRuntimeContextDefaults {
  readonly driverRegistry?: DriverRegistryService
  readonly permission?: PermissionService
  readonly baseSections?: ReadonlyArray<PromptSection>
}

export interface SessionRuntimeContext {
  readonly session: Session | undefined
  readonly sessionCwd?: string
  readonly profile?: SessionProfile
  readonly extensionRegistry: ExtensionRegistryService
  readonly extensionStateRuntime: MachineEngineService
  readonly driverRegistry?: DriverRegistryService
  readonly permission?: PermissionService
  readonly baseSections?: ReadonlyArray<PromptSection>
  readonly hostCtx: ExtensionHostContext
}

interface ActiveRuntimeBindings {
  readonly extensionRegistry: ExtensionRegistryService
  readonly extensionStateRuntime: MachineEngineService
  readonly driverRegistry?: DriverRegistryService
  readonly permission?: PermissionService
  readonly baseSections?: ReadonlyArray<PromptSection>
}

interface ActiveRuntimeBindingsDraft {
  extensionRegistry: ExtensionRegistryService
  extensionStateRuntime: MachineEngineService
  driverRegistry?: DriverRegistryService
  permission?: PermissionService
  baseSections?: ReadonlyArray<PromptSection>
}

interface SessionRuntimeContextDraft {
  session: Session | undefined
  sessionCwd?: string
  profile?: SessionProfile
  extensionRegistry: ExtensionRegistryService
  extensionStateRuntime: MachineEngineService
  driverRegistry?: DriverRegistryService
  permission?: PermissionService
  baseSections?: ReadonlyArray<PromptSection>
  hostCtx: ExtensionHostContext
}

const resolveSessionProfile = (params: {
  readonly sessionCwd?: string
  readonly profileCache?: SessionProfileCacheService
}): Effect.Effect<SessionProfile | undefined> =>
  params.profileCache !== undefined && params.sessionCwd !== undefined
    ? params.profileCache.resolve(params.sessionCwd)
    : Effect.succeed(undefined)

const resolveActiveRuntimeBindings = (params: {
  readonly profile?: SessionProfile
  readonly hostDeps: MakeExtensionHostContextDeps
  readonly defaults?: SessionRuntimeContextDefaults
}): ActiveRuntimeBindings => {
  const bindings: ActiveRuntimeBindingsDraft = {
    extensionRegistry: params.profile?.registryService ?? params.hostDeps.extensionRegistry,
    extensionStateRuntime:
      params.profile?.extensionStateRuntime ?? params.hostDeps.extensionStateRuntime,
  }
  const driverRegistry = params.profile?.driverRegistryService ?? params.defaults?.driverRegistry
  const permission = params.profile?.permissionService ?? params.defaults?.permission
  const baseSections = params.profile?.baseSections ?? params.defaults?.baseSections

  if (driverRegistry !== undefined) {
    bindings.driverRegistry = driverRegistry
  }
  if (permission !== undefined) {
    bindings.permission = permission
  }
  if (baseSections !== undefined) {
    bindings.baseSections = baseSections
  }

  return bindings
}

const buildSessionRuntimeContext = (params: {
  readonly session: Session | undefined
  readonly sessionCwd?: string
  readonly profile?: SessionProfile
  readonly bindings: ActiveRuntimeBindings
  readonly hostCtx: ExtensionHostContext
}): SessionRuntimeContext => {
  const runtimeContext: SessionRuntimeContextDraft = {
    session: params.session,
    extensionRegistry: params.bindings.extensionRegistry,
    extensionStateRuntime: params.bindings.extensionStateRuntime,
    hostCtx: params.hostCtx,
  }

  if (params.sessionCwd !== undefined) {
    runtimeContext.sessionCwd = params.sessionCwd
  }
  if (params.profile !== undefined) {
    runtimeContext.profile = params.profile
  }
  if (params.bindings.driverRegistry !== undefined) {
    runtimeContext.driverRegistry = params.bindings.driverRegistry
  }
  if (params.bindings.permission !== undefined) {
    runtimeContext.permission = params.bindings.permission
  }
  if (params.bindings.baseSections !== undefined) {
    runtimeContext.baseSections = params.bindings.baseSections
  }

  return runtimeContext
}

export const resolveSessionRuntimeContext = (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly storage: StorageService
  readonly hostDeps: MakeExtensionHostContextDeps
  readonly profileCache?: SessionProfileCacheService
  readonly defaults?: SessionRuntimeContextDefaults
  readonly agentName?: AgentName
}): Effect.Effect<SessionRuntimeContext> =>
  Effect.gen(function* () {
    const session = yield* params.storage
      .getSession(params.sessionId)
      .pipe(Effect.orElseSucceed(() => undefined))
    const sessionCwd = session?.cwd

    const profile = yield* resolveSessionProfile({
      sessionCwd,
      profileCache: params.profileCache,
    })
    const bindings = resolveActiveRuntimeBindings({
      profile,
      hostDeps: params.hostDeps,
      defaults: params.defaults,
    })

    const hostCtx = makeExtensionHostContext(
      {
        sessionId: params.sessionId,
        branchId: params.branchId,
        agentName: params.agentName,
        sessionCwd,
      },
      {
        ...params.hostDeps,
        extensionRegistry: bindings.extensionRegistry,
        extensionStateRuntime: bindings.extensionStateRuntime,
      },
    )

    return buildSessionRuntimeContext({
      session,
      sessionCwd,
      profile,
      bindings,
      hostCtx,
    })
  })
