import { Effect, Stream, type Context } from "effect"
import type { DriverRef } from "../../domain/agent.js"
import type { AuthGuardService } from "../../domain/auth-guard.js"
import type { AuthStoreService } from "../../domain/auth-store.js"
import type { EventEnvelope, EventStoreService } from "../../domain/event.js"
import type { ProviderAuthService } from "../../providers/provider-auth.js"
import type { ConfigServiceService } from "../../runtime/config-service.js"
import type { RuntimePlatformShape } from "../../runtime/runtime-platform.js"
import type { SessionRuntimeService } from "../../runtime/session-runtime.js"
import type { BranchStorageService } from "../../storage/branch-storage.js"
import type { SessionStorageService } from "../../storage/session-storage.js"
import type { ConnectionTrackerService } from "../connection-tracker.js"
import type { InteractionCommandsService } from "../interaction-commands.js"
import type { ServerIdentityShape } from "../server-identity.js"
import type { SessionCommandsService } from "../session-commands.js"
import type { SessionQueriesService } from "../session-queries.js"
import type { WatchRuntimeInput } from "../transport-contract.js"
import type { DriverRegistryService } from "../../runtime/extensions/driver-registry.js"
import type { ExtensionRegistryService } from "../../runtime/extensions/registry.js"
import type { ModelRegistryService } from "../../runtime/model-registry.js"

export interface ResolvedSessionServices {
  readonly registry: ExtensionRegistryService
  readonly capabilityContext?: Context.Context<never>
}

export interface RpcHandlerDeps {
  readonly queries: SessionQueriesService
  readonly commands: SessionCommandsService
  readonly eventStore: EventStoreService
  readonly interactions: InteractionCommandsService
  readonly configService: ConfigServiceService
  readonly sessionRuntime: SessionRuntimeService
  readonly modelRegistry: ModelRegistryService
  readonly driverRegistry: DriverRegistryService
  readonly authStore: AuthStoreService
  readonly authGuard: AuthGuardService
  readonly providerAuth: ProviderAuthService
  readonly extensionRegistry: ExtensionRegistryService
  readonly platform: RuntimePlatformShape
  readonly sessionStorage: SessionStorageService
  readonly branchStorage: BranchStorageService
  readonly connectionTracker: ConnectionTrackerService | undefined
  readonly serverIdentity: ServerIdentityShape
  readonly resolveSessionServices: (
    sessionId: string | undefined,
  ) => Effect.Effect<ResolvedSessionServices>
  readonly resolveProfileServices: (
    cwd: string | undefined,
  ) => Effect.Effect<ResolvedSessionServices>
}

export const isPublicTransportEvent = (envelope: EventEnvelope) =>
  envelope.event._tag !== "MachineTaskSucceeded" && envelope.event._tag !== "MachineTaskFailed"

export const invalidateExternalDriversFor = (
  registry: DriverRegistryService,
  prev: DriverRef | undefined,
  next: DriverRef | undefined,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const ids = new Set<string>()
    if (prev?._tag === "external") ids.add(prev.id)
    if (next?._tag === "external") ids.add(next.id)
    for (const id of ids) {
      const driver = yield* registry.getExternal(id)
      if (driver !== undefined) yield* driver.invalidate()
    }
  })

export const watchRuntimeStream = (
  deps: RpcHandlerDeps,
  { sessionId, branchId }: WatchRuntimeInput,
) =>
  Stream.unwrap(
    deps.sessionRuntime.watchState({ sessionId, branchId }).pipe(
      Effect.tap(() =>
        Effect.logInfo("watchRuntime.open").pipe(Effect.annotateLogs({ sessionId, branchId })),
      ),
      Effect.map((stateStream) =>
        stateStream.pipe(
          Stream.ensuring(
            Effect.logInfo("watchRuntime.close").pipe(Effect.annotateLogs({ sessionId, branchId })),
          ),
        ),
      ),
    ),
  )
