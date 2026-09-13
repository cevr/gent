import { Effect, Option, Predicate } from "effect"
import type { PermissionService } from "../domain/permission.js"
import type { PromptSection } from "../domain/prompt.js"
import type { Branch, Session } from "../domain/message.js"
import type { BranchId, SessionId } from "../domain/ids.js"
import { StorageError } from "../domain/storage-error.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { SessionStorage } from "../storage/session-storage.js"
import type { DriverRegistryService } from "./extensions/driver-registry.js"
import { ExtensionHostContextProvider } from "./make-extension-host-context.js"
import type { SessionProfileCacheService } from "./session-profile.js"
import type { AgentLoopTurnProfile } from "./agent/agent-loop.turn-profile.js"

export interface TurnProfileDefaults {
  readonly driverRegistry: DriverRegistryService
  readonly permission: PermissionService
  readonly baseSections: ReadonlyArray<PromptSection>
}

interface ExistingSessionBranch {
  readonly session: Session
  readonly branch: Branch
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

/**
 * Resolve the turn profile for one branch: the stored session cwd selects a
 * profile from the cache; without a session or a cache, the host defaults
 * apply. A storage lookup failure falls back to the defaults as well.
 */
export const resolveTurnProfile = (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly profileCache?: SessionProfileCacheService
  readonly defaults: TurnProfileDefaults
}): Effect.Effect<AgentLoopTurnProfile, never, ExtensionHostContextProvider | SessionStorage> =>
  Effect.gen(function* () {
    const sessionStorage = yield* SessionStorage
    const hostProvider = yield* ExtensionHostContextProvider
    const sessionCwd = yield* sessionStorage.getSession(params.sessionId).pipe(
      Effect.map((session) => Option.fromUndefinedOr(session?.cwd)),
      Effect.orElseSucceed(() => Option.none<string>()),
    )
    const runInfo = {
      sessionId: params.sessionId,
      branchId: params.branchId,
      sessionCwd: Option.getOrUndefined(sessionCwd),
    }
    const profile = yield* Option.match(
      Option.all([Option.fromUndefinedOr(params.profileCache), sessionCwd]),
      {
        onNone: () => Effect.succeedNone,
        onSome: ([profileCache, cwd]) => profileCache.resolve(cwd).pipe(Effect.asSome),
      },
    )
    if (Option.isNone(profile)) {
      return {
        turnExtensionRegistry: hostProvider.defaultExtensionRegistry,
        turnDriverRegistry: params.defaults.driverRegistry,
        turnPermission: params.defaults.permission,
        turnBaseSections: params.defaults.baseSections,
        turnHostCtx: hostProvider.forRun(runInfo),
      }
    }
    return {
      turnExtensionRegistry: profile.value.registryService,
      turnDriverRegistry: profile.value.driverRegistryService,
      turnPermission: profile.value.permissionService,
      turnBaseSections: profile.value.baseSections,
      turnHostCtx: hostProvider.forRun(runInfo, profile.value.registryService),
      turnCapabilityContext: profile.value.layerContext,
      turnGenerationId: profile.value.generationId,
    }
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
