import { Effect } from "effect"
import { SessionId } from "../domain/ids.js"
import { GentRpcs } from "./rpcs"
import { MachineEngine } from "../runtime/extensions/resource-host/machine-engine.js"
import { AuthGuard } from "../domain/auth-guard.js"
import { AuthStore } from "../domain/auth-store.js"
import { ConfigService } from "../runtime/config-service.js"
import { DriverRegistry } from "../runtime/extensions/driver-registry.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import { SessionQueries } from "./session-queries.js"
import { SessionCommands } from "./session-commands.js"
import { EventStore } from "../domain/event.js"
import { InteractionCommands } from "./interaction-commands.js"
import { SubscriptionEngine } from "../runtime/extensions/resource-host/subscription-engine.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"
import { Storage } from "../storage/sqlite-storage.js"
import { SessionProfileCache } from "../runtime/session-profile.js"
import { ConnectionTracker } from "./connection-tracker.js"
import { ServerIdentity } from "./server-identity.js"
import { SessionRuntime } from "../runtime/session-runtime.js"
import { buildActorRpcHandlers } from "./rpc-handler-groups/actor.js"
import { buildConfigRpcHandlers } from "./rpc-handler-groups/config.js"
import { buildExtensionRpcHandlers } from "./rpc-handler-groups/extension.js"
import { buildServerRpcHandlers } from "./rpc-handler-groups/server.js"
import { buildSessionRpcHandlers } from "./rpc-handler-groups/session.js"

// ============================================================================
// RPC Handlers Layer
// ============================================================================

export const RpcHandlersLive = GentRpcs.toLayer(
  Effect.gen(function* () {
    const queries = yield* SessionQueries
    const commands = yield* SessionCommands
    const eventStore = yield* EventStore
    const interactions = yield* InteractionCommands
    const configService = yield* ConfigService
    const sessionRuntime = yield* SessionRuntime
    const modelRegistry = yield* ModelRegistry
    const driverRegistry = yield* DriverRegistry
    const authStore = yield* AuthStore
    const authGuard = yield* AuthGuard
    const providerAuth = yield* ProviderAuth
    const extensionStateRuntime = yield* MachineEngine
    const extensionRegistry = yield* ExtensionRegistry
    const platform = yield* RuntimePlatform
    const busOpt = yield* Effect.serviceOption(SubscriptionEngine)
    const bus = busOpt._tag === "Some" ? busOpt.value : undefined
    const profileCacheOpt = yield* Effect.serviceOption(SessionProfileCache)
    const profileCache = profileCacheOpt._tag === "Some" ? profileCacheOpt.value : undefined
    const storageOpt = yield* Effect.serviceOption(Storage)
    const storage = storageOpt._tag === "Some" ? storageOpt.value : undefined
    const connectionTrackerOpt = yield* Effect.serviceOption(ConnectionTracker)
    const connectionTracker =
      connectionTrackerOpt._tag === "Some" ? connectionTrackerOpt.value : undefined
    const serverIdentityOpt = yield* Effect.serviceOption(ServerIdentity)
    const serverIdentity = serverIdentityOpt._tag === "Some" ? serverIdentityOpt.value : undefined

    const loadSession = (sessionId: string) => {
      if (storage !== undefined) {
        return storage
          .getSession(SessionId.of(sessionId))
          .pipe(Effect.orElseSucceed(() => undefined))
      }
      // @effect-diagnostics-next-line effectSucceedWithVoid:off -- this branch must preserve Effect<Session | undefined>, not collapse to Effect<void>
      return Effect.succeed(undefined)
    }

    const resolveSessionProfile = (sessionId: string) =>
      Effect.gen(function* () {
        if (profileCache === undefined || storage === undefined) {
          return { registry: extensionRegistry, stateRuntime: extensionStateRuntime }
        }
        const session = yield* loadSession(sessionId)
        if (session?.cwd === undefined) {
          return { registry: extensionRegistry, stateRuntime: extensionStateRuntime }
        }
        const profile = yield* profileCache.resolve(session.cwd)
        return {
          registry: profile.registryService,
          stateRuntime: profile.extensionStateRuntime,
        }
      })

    const deps = {
      queries,
      commands,
      eventStore,
      interactions,
      configService,
      sessionRuntime,
      modelRegistry,
      driverRegistry,
      authStore,
      authGuard,
      providerAuth,
      extensionStateRuntime,
      extensionRegistry,
      platform,
      bus,
      storage,
      connectionTracker,
      serverIdentity,
      resolveSessionProfile,
      loadSession,
    } as const

    return {
      ...buildSessionRpcHandlers(deps),
      ...buildConfigRpcHandlers(deps),
      ...buildExtensionRpcHandlers(deps),
      ...buildActorRpcHandlers(deps),
      ...buildServerRpcHandlers(deps),
    }
  }),
)
