/**
 * `AgentLoopBehaviorDeps` Tag — the layer-level services and config that
 * `makeAgentLoopBehavior` (in `agent-loop.behavior.ts`) needs to allocate a
 * per-entity loop. Carved out so `Actor.toLayer` build in
 * `agent-loop.actor.ts` can yield deps directly.
 *
 * Excludes `enqueueFollowUp`: that's per-entity (constructed inside the
 * actor build closure with `(sessionId, branchId)` already known).
 *
 * @module
 */

import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { EventStorage } from "../../storage/event-storage.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { AgentLoopQueueStorage } from "../../storage/agent-loop-queue-storage.js"
import { SessionStorage } from "../../storage/session-storage.js"
import { makeStorageTransaction } from "../../storage/sqlite-storage.js"
import { ModelResolver } from "../../providers/model-resolver.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "../extensions/registry.js"
import { DriverRegistry } from "../extensions/driver-registry.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import { ToolRunner } from "./tool-runner.js"
import { ResourceManager, type ResourceManagerService } from "../resource-manager.js"
import { ConfigService } from "../config-service.js"
import { ModelRegistry } from "../model-registry.js"
import type { PromptSection } from "../../domain/prompt.js"
import type { PricingLookup, TurnStorage } from "./turn-helpers.js"
import type { ExtensionHostPlatform } from "../../domain/extension.js"
import { makeExtensionHostPlatform } from "../extensions/host-platform.js"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { GentPlatform } from "../gent-platform.js"

/**
 * Snapshot of layer-level dependencies and configuration captured at runtime
 * setup time. Excludes the per-entity `enqueueFollowUp` callback (built
 * inside the actor's per-entity scope).
 */
export type AgentLoopBehaviorDepsShape = {
  readonly turnStorage: TurnStorage
  readonly modelResolver: typeof ModelResolver.Service
  readonly extensionRegistry: ExtensionRegistryService
  readonly driverRegistry: typeof DriverRegistry.Service
  readonly eventPublisher: typeof EventPublisher.Service
  readonly toolRunner: typeof ToolRunner.Service
  readonly resourceManager: ResourceManagerService
  readonly messageStorage: typeof MessageStorage.Service
  readonly queueStorage: typeof AgentLoopQueueStorage.Service
  readonly sessionStorage: typeof SessionStorage.Service
  readonly configServiceForRun: typeof ConfigService.Service
  readonly getPricing: PricingLookup
  readonly baseSections: ReadonlyArray<PromptSection>
  readonly host: ExtensionHostPlatform
}

export class AgentLoopBehaviorDeps extends Context.Service<
  AgentLoopBehaviorDeps,
  AgentLoopBehaviorDepsShape
>()("@gent/core/src/runtime/agent/agent-loop.behavior-deps/AgentLoopBehaviorDeps") {
  /**
   * Builds deps from ambient services. Layer is parameterized over
   * `baseSections` since it is runtime config, not a Tag.
   */
  static Live = (config: {
    readonly baseSections: ReadonlyArray<PromptSection>
  }): Layer.Layer<
    AgentLoopBehaviorDeps,
    never,
    | SessionStorage
    | MessageStorage
    | AgentLoopQueueStorage
    | EventStorage
    | SqlClient.SqlClient
    | ModelResolver
    | ExtensionRegistry
    | DriverRegistry
    | EventPublisher
    | ToolRunner
    | ResourceManager
    | ConfigService
    | ModelRegistry
    | ChildProcessSpawner
    | GentPlatform
  > =>
    Layer.effect(
      AgentLoopBehaviorDeps,
      Effect.gen(function* () {
        const sessionStorage = yield* SessionStorage
        const messageStorage = yield* MessageStorage
        const queueStorage = yield* AgentLoopQueueStorage
        const eventStorage = yield* EventStorage
        const sql = yield* SqlClient.SqlClient
        const storageTransaction = makeStorageTransaction(sql)
        const turnStorage: TurnStorage = {
          transaction: storageTransaction,
          events: eventStorage,
          messages: messageStorage,
          sessions: sessionStorage,
        }
        const modelResolver = yield* ModelResolver
        const extensionRegistry = yield* ExtensionRegistry
        const driverRegistry = yield* DriverRegistry
        const eventPublisher = yield* EventPublisher
        const toolRunner = yield* ToolRunner
        const resourceManager = yield* ResourceManager
        const configServiceForRun = yield* ConfigService
        const modelRegistryForRun = yield* ModelRegistry
        const host = yield* makeExtensionHostPlatform
        const getPricing: PricingLookup = (modelId) =>
          modelRegistryForRun.get(modelId).pipe(
            Effect.map((m) => m?.pricing),
            Effect.catchEager(() =>
              Effect.sync(
                (): { readonly input: number; readonly output: number } | undefined => undefined,
              ),
            ),
          )
        return {
          turnStorage,
          modelResolver,
          extensionRegistry,
          driverRegistry,
          eventPublisher,
          toolRunner,
          resourceManager,
          messageStorage,
          queueStorage,
          sessionStorage,
          configServiceForRun,
          getPricing,
          baseSections: config.baseSections,
          host,
        }
      }),
    )
}
