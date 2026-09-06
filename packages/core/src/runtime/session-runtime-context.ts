import { Effect, Option, Predicate } from "effect"
import type { Context } from "effect"
import type { PermissionService } from "../domain/permission.js"
import type { PromptSection } from "../domain/prompt.js"
import type { Branch, Session } from "../domain/message.js"
import type { AgentName } from "../domain/agent.js"
import type { BranchId, SessionId } from "../domain/ids.js"
import type { ExtensionHostContext } from "../domain/extension-host-context.js"
import { StorageError } from "../domain/storage-error.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { SessionStorage } from "../storage/session-storage.js"
import type { ResourceGraphPublication } from "./extensions/resource-host/resource-graph-host.js"
import type { DriverRegistryService } from "./extensions/driver-registry.js"
import type { ExtensionRegistryService } from "./extensions/registry.js"
import { ExtensionHostContextProvider } from "./make-extension-host-context.js"
import type { SessionProfile, SessionProfileCacheService } from "./session-profile.js"
import type { RuntimeProfileCatalog } from "./profile.js"

export const SessionEnvironmentHostProvider = ExtensionHostContextProvider

export interface SessionEnvironmentDefaults {
  readonly driverRegistry: DriverRegistryService
  readonly permission: PermissionService
  readonly baseSections: ReadonlyArray<PromptSection>
}

export interface SessionEnvironment {
  readonly cwd: string
  readonly extensionRegistry: ExtensionRegistryService
  /** Resource authority for the exact profile generation resolved for this run. */
  readonly publication?: ResourceGraphPublication<RuntimeProfileCatalog>
  readonly capabilityContext?: Context.Context<never>
  readonly driverRegistry: DriverRegistryService
  readonly permission: PermissionService
  readonly baseSections: ReadonlyArray<PromptSection>
  readonly hostCtx: ExtensionHostContext
}

export interface ResolvedSessionEnvironment {
  // oxlint-disable-next-line effect/noNullish -- Environment resolution preserves the public absent-session result.
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
  readonly publication?: ResourceGraphPublication<RuntimeProfileCatalog>
  readonly capabilityContext?: Context.Context<never>
  readonly driverRegistry: DriverRegistryService
  readonly permission: PermissionService
  readonly baseSections: ReadonlyArray<PromptSection>
}

const resolveSessionProfile = (params: {
  readonly session?: Session
  readonly profileCache?: SessionProfileCacheService
}): Effect.Effect<Option.Option<SessionProfile>> =>
  Option.match(Option.fromUndefinedOr(params.profileCache), {
    onNone: () => Effect.succeedNone,
    onSome: (profileCache) =>
      Option.match(Option.fromUndefinedOr(params.session?.cwd), {
        onNone: () => Effect.succeedNone,
        onSome: (cwd) => profileCache.resolve(cwd).pipe(Effect.asSome),
      }),
  })

const resolveActiveRuntimeBindings = (params: {
  readonly profile: Option.Option<SessionProfile>
  readonly defaults: SessionEnvironmentDefaults
}): Effect.Effect<ActiveRuntimeBindings, never, ExtensionHostContextProvider> =>
  Effect.gen(function* () {
    const hostProvider = yield* SessionEnvironmentHostProvider
    if (Option.isNone(params.profile)) {
      return {
        extensionRegistry: hostProvider.defaultExtensionRegistry,
        capabilityContext: hostProvider.defaultCapabilityContext,
        driverRegistry: params.defaults.driverRegistry,
        permission: params.defaults.permission,
        baseSections: params.defaults.baseSections,
      }
    }
    const profile = params.profile.value
    return {
      extensionRegistry: profile.registryService,
      publication: profile.publication,
      capabilityContext: profile.layerContext,
      driverRegistry: profile.driverRegistryService,
      permission: profile.permissionService,
      baseSections: profile.baseSections,
    }
  })

const buildSessionEnvironment = (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName?: AgentName
  readonly session?: Session
  readonly bindings: ActiveRuntimeBindings
}): Effect.Effect<SessionEnvironment, never, ExtensionHostContextProvider> =>
  Effect.gen(function* () {
    const hostProvider = yield* SessionEnvironmentHostProvider
    const runParams = Option.match(Option.fromUndefinedOr(params.session?.cwd), {
      onNone: () => ({
        sessionId: params.sessionId,
        branchId: params.branchId,
        agentName: params.agentName,
      }),
      onSome: (sessionCwd) => ({
        sessionId: params.sessionId,
        branchId: params.branchId,
        agentName: params.agentName,
        sessionCwd,
      }),
    })
    const capabilityContext = Option.fromUndefinedOr(params.bindings.capabilityContext)
    const hostCtx = Option.match(capabilityContext, {
      onNone: () =>
        hostProvider.forRun(runParams, {
          extensionRegistry: params.bindings.extensionRegistry,
        }),
      onSome: (value) =>
        hostProvider.forRun(runParams, {
          extensionRegistry: params.bindings.extensionRegistry,
          capabilityContext: value,
        }),
    })
    const environment = {
      cwd: hostCtx.cwd,
      extensionRegistry: params.bindings.extensionRegistry,
      publication: params.bindings.publication,
      driverRegistry: params.bindings.driverRegistry,
      permission: params.bindings.permission,
      baseSections: params.bindings.baseSections,
      hostCtx,
    }
    return Option.match(capabilityContext, {
      onNone: () => environment,
      onSome: (value) => ({ ...environment, capabilityContext: value }),
    })
  })

export const AllowAllPermission: PermissionService = {
  check: () => Effect.succeed("allowed"),
}

interface ResolveSessionEnvironmentParams {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly profileCache?: SessionProfileCacheService
  readonly defaults: SessionEnvironmentDefaults
  readonly agentName?: AgentName
}

const buildResolvedSessionEnvironment = (
  params: ResolveSessionEnvironmentParams & { readonly session?: Session },
): Effect.Effect<ResolvedSessionEnvironment, never, ExtensionHostContextProvider> =>
  Effect.gen(function* () {
    const profile = yield* resolveSessionProfile({
      session: params.session,
      profileCache: params.profileCache,
    })
    const bindings = yield* resolveActiveRuntimeBindings({
      profile,
      defaults: params.defaults,
    })
    const environment = yield* buildSessionEnvironment({
      sessionId: params.sessionId,
      branchId: params.branchId,
      agentName: params.agentName,
      session: params.session,
      bindings,
    })

    return {
      session: params.session,
      environment,
    }
  })

export const resolveSessionEnvironment = (
  params: ResolveSessionEnvironmentParams,
): Effect.Effect<
  ResolvedSessionEnvironment,
  never,
  ExtensionHostContextProvider | SessionStorage
> =>
  Effect.gen(function* () {
    const sessionStorage = yield* SessionStorage
    const session = yield* sessionStorage.getSession(params.sessionId).pipe(
      Effect.map((value): Option.Option<Session> => Option.fromUndefinedOr(value)),
      Effect.orElseSucceed(() => Option.none<Session>()),
    )
    return yield* Option.match(session, {
      onNone: () => buildResolvedSessionEnvironment(params),
      onSome: (value) => buildResolvedSessionEnvironment({ ...params, session: value }),
    })
  })

export const resolveSessionEnvironmentOrFail = (
  params: ResolveSessionEnvironmentParams,
): Effect.Effect<
  ResolvedSessionEnvironment,
  StorageError,
  ExtensionHostContextProvider | SessionStorage
> =>
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
    if (Predicate.isUndefined(session)) {
      return yield* new StorageError({
        message: `Session not found: ${params.sessionId}`,
      })
    }

    const branch = yield* branchStorage.getBranch(params.branchId)
    if (Predicate.isUndefined(branch) || branch.sessionId !== params.sessionId) {
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
