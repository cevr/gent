import { Effect, Stream, type Context } from "effect"
import type { AuthGuardService } from "../../domain/auth-guard.js"
import type { AuthStoreService } from "../../domain/auth-store.js"
import type { EventEnvelope, EventStoreService } from "../../domain/event.js"
import type { Session } from "../../domain/message.js"
import type { ProviderAuthService } from "../../providers/provider-auth.js"
import type { ConfigServiceService } from "../../runtime/config-service.js"
import type { RuntimePlatformShape } from "../../runtime/runtime-platform.js"
import type { SessionRuntimeService } from "../../runtime/session-runtime.js"
import type { StorageService } from "../../storage/sqlite-storage.js"
import type { ConnectionTrackerService } from "../connection-tracker.js"
import type { InteractionCommandsService } from "../interaction-commands.js"
import type { ServerIdentityShape } from "../server-identity.js"
import type { SessionCommandsService } from "../session-commands.js"
import type { SessionQueriesService } from "../session-queries.js"
import type { WatchRuntimeInput } from "../transport-contract.js"
import type { DriverRegistryService } from "../../runtime/extensions/driver-registry.js"
import type { ExtensionRegistryService } from "../../runtime/extensions/registry.js"
import type { MachineEngineService } from "../../runtime/extensions/resource-host/machine-engine.js"
import type { SubscriptionEngineService } from "../../runtime/extensions/resource-host/subscription-engine.js"
import type { ModelRegistryService } from "../../runtime/model-registry.js"

export interface ResolvedSessionServices {
  readonly registry: ExtensionRegistryService
  readonly stateRuntime: MachineEngineService
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
  readonly extensionStateRuntime: MachineEngineService
  readonly extensionRegistry: ExtensionRegistryService
  readonly platform: RuntimePlatformShape
  readonly bus: SubscriptionEngineService | undefined
  readonly storage: StorageService | undefined
  readonly connectionTracker: ConnectionTrackerService | undefined
  readonly serverIdentity: ServerIdentityShape | undefined
  readonly resolveSessionServices: (
    sessionId: string | undefined,
  ) => Effect.Effect<ResolvedSessionServices>
  readonly loadSession: (sessionId: string) => Effect.Effect<Session | undefined>
}

export const isPublicTransportEvent = (envelope: EventEnvelope) =>
  envelope.event._tag !== "MachineInspected" &&
  envelope.event._tag !== "MachineTaskSucceeded" &&
  envelope.event._tag !== "MachineTaskFailed"

export const invalidateExternalDriversFor = (
  registry: DriverRegistryService,
  prev: { readonly _tag: "model" | "external"; readonly id?: string } | undefined,
  next: { readonly _tag: "model" | "external"; readonly id?: string } | undefined,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const ids = new Set<string>()
    if (prev?._tag === "external" && typeof prev.id === "string") ids.add(prev.id)
    if (next?._tag === "external" && typeof next.id === "string") ids.add(next.id)
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
