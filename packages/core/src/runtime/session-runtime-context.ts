import { Effect, type Context } from "effect"
import type { PermissionService } from "../domain/permission.js"
import type { PromptSection } from "../domain/prompt.js"
import type { Branch, Session } from "../domain/message.js"
import type { AgentName } from "../domain/agent.js"
import type { BranchId, SessionId } from "../domain/ids.js"
import type { ExtensionHostContext } from "../domain/extension-host-context.js"
import { StorageError } from "../domain/storage-error.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { SessionStorage } from "../storage/session-storage.js"
import type { DriverRegistryService } from "./extensions/driver-registry.js"
import type { ExtensionRegistryService } from "./extensions/registry.js"
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
  readonly capabilityContext?: Context.Context<never>
  readonly driverRegistry: DriverRegistryService
  readonly permission: PermissionService
  readonly baseSections: ReadonlyArray<PromptSection>
  readonly hostCtx: ExtensionHostContext
}

export interface ResolvedSessionEnvironment {
  readonly session: Session | undefined
  readonly environment: SessionEnvironment
}

export interface ExistingSessionBranch {
  readonly session: Session
  readonly branch: Branch
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

interface ActiveRuntimeBindings {
  readonly extensionRegistry: ExtensionRegistryService
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
    : Effect.sync((): SessionProfile | undefined => undefined)

const resolveActiveRuntimeBindings = (params: {
  readonly profile?: SessionProfile
  readonly hostDeps: MakeExtensionHostContextDeps
  readonly defaults: SessionEnvironmentDefaults
}): ActiveRuntimeBindings => ({
  extensionRegistry: params.profile?.registryService ?? params.hostDeps.extensionRegistry,
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
      ...(params.bindings.capabilityContext !== undefined
        ? { capabilityContext: params.bindings.capabilityContext }
        : {}),
    },
  )

  return {
    cwd: hostCtx.cwd,
    extensionRegistry: params.bindings.extensionRegistry,
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
}

interface ResolveSessionEnvironmentParams {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly hostDeps: MakeExtensionHostContextDeps
  readonly profileCache?: SessionProfileCacheService
  readonly defaults: SessionEnvironmentDefaults
  readonly agentName?: AgentName
}

const buildResolvedSessionEnvironment = (
  params: ResolveSessionEnvironmentParams & { readonly session: Session | undefined },
): Effect.Effect<ResolvedSessionEnvironment> =>
  Effect.gen(function* () {
    const profile = yield* resolveSessionProfile({
      session: params.session,
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
      session: params.session,
      bindings,
      hostDeps: params.hostDeps,
    })

    return {
      session: params.session,
      environment,
    }
  })

export const resolveSessionEnvironment = (
  params: ResolveSessionEnvironmentParams,
): Effect.Effect<ResolvedSessionEnvironment, never, SessionStorage> =>
  Effect.gen(function* () {
    const sessionStorage = yield* SessionStorage
    const session = yield* sessionStorage
      .getSession(params.sessionId)
      .pipe(Effect.orElseSucceed(() => undefined))
    return yield* buildResolvedSessionEnvironment({ ...params, session })
  })

export const resolveSessionEnvironmentOrFail = (
  params: ResolveSessionEnvironmentParams,
): Effect.Effect<ResolvedSessionEnvironment, StorageError, SessionStorage> =>
  Effect.gen(function* () {
    const sessionStorage = yield* SessionStorage
    const session = yield* sessionStorage.getSession(params.sessionId)
    return yield* buildResolvedSessionEnvironment({ ...params, session })
  })

export const resolveExistingSessionBranch = (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}): Effect.Effect<ExistingSessionBranch, StorageError, SessionStorage | BranchStorage> =>
  Effect.gen(function* () {
    const sessionStorage = yield* SessionStorage
    const branchStorage = yield* BranchStorage
    const session = yield* sessionStorage.getSession(params.sessionId)
    if (session === undefined) {
      return yield* new StorageError({
        message: `Session not found: ${params.sessionId}`,
      })
    }

    const branch = yield* branchStorage.getBranch(params.branchId)
    if (branch === undefined || branch.sessionId !== params.sessionId) {
      return yield* new StorageError({
        message: `Branch not found for session: ${params.sessionId}/${params.branchId}`,
      })
    }

    return {
      session,
      branch,
      sessionId: session.id,
      branchId: branch.id,
    }
  })
