import { Context, Effect, Layer, Ref } from "effect"
import type { RequestCapability } from "./capability/request.js"
import { getToolId, type ToolCapability } from "./capability/tool.js"
import type { ExtensionId, SessionId } from "./ids.js"

export type DynamicRegistrationScope =
  | { readonly _tag: "process" }
  | { readonly _tag: "session"; readonly sessionId: SessionId }

interface DynamicToolEntry {
  readonly extensionId: ExtensionId
  readonly scope: DynamicRegistrationScope
  readonly capability: ToolCapability
}

interface DynamicRequestEntry {
  readonly extensionId: ExtensionId
  readonly scope: DynamicRegistrationScope
  readonly capability: RequestCapability
}

export interface DynamicExtensionRegistryService {
  readonly registerTool: (entry: DynamicToolEntry) => Effect.Effect<Effect.Effect<void>>
  readonly registerRequest: (entry: DynamicRequestEntry) => Effect.Effect<Effect.Effect<void>>
  readonly listTools: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<ToolCapability>>
  readonly listRequests: (sessionId: SessionId) => Effect.Effect<
    ReadonlyArray<{
      readonly extensionId: ExtensionId
      readonly capability: RequestCapability
    }>
  >
  readonly findRequest: (params: {
    readonly sessionId: SessionId
    readonly extensionId: ExtensionId
    readonly capabilityId: string
  }) => Effect.Effect<
    | {
        readonly extensionId: ExtensionId
        readonly capability: RequestCapability
      }
    | undefined
  >
}

const scopeMatches = (scope: DynamicRegistrationScope, sessionId: SessionId) =>
  scope._tag === "process" || scope.sessionId === sessionId

export class DynamicExtensionRegistry extends Context.Service<
  DynamicExtensionRegistry,
  DynamicExtensionRegistryService
>()("@gent/core/src/domain/dynamic-extension-registry/DynamicExtensionRegistry") {
  static Live: Layer.Layer<DynamicExtensionRegistry> = Layer.effect(
    DynamicExtensionRegistry,
    Effect.gen(function* () {
      const tools = yield* Ref.make<ReadonlyArray<DynamicToolEntry>>([])
      const requests = yield* Ref.make<ReadonlyArray<DynamicRequestEntry>>([])

      const unregisterTool = (entry: DynamicToolEntry) =>
        Ref.update(tools, (entries) => entries.filter((candidate) => candidate !== entry))

      const unregisterRequest = (entry: DynamicRequestEntry) =>
        Ref.update(requests, (entries) => entries.filter((candidate) => candidate !== entry))

      return DynamicExtensionRegistry.of({
        registerTool: (entry) =>
          Ref.update(tools, (entries) => [...entries, entry]).pipe(
            Effect.as(unregisterTool(entry)),
          ),
        registerRequest: (entry) =>
          Ref.update(requests, (entries) => [...entries, entry]).pipe(
            Effect.as(unregisterRequest(entry)),
          ),
        listTools: (sessionId) =>
          Ref.get(tools).pipe(
            Effect.map((entries) => {
              const winners = new Map<string, ToolCapability>()
              for (const entry of entries) {
                if (scopeMatches(entry.scope, sessionId)) {
                  winners.set(String(getToolId(entry.capability)), entry.capability)
                }
              }
              return [...winners.values()]
            }),
          ),
        listRequests: (sessionId) =>
          Ref.get(requests).pipe(
            Effect.map((entries) =>
              entries.flatMap((entry) =>
                scopeMatches(entry.scope, sessionId)
                  ? [{ extensionId: entry.extensionId, capability: entry.capability }]
                  : [],
              ),
            ),
          ),
        findRequest: (params) =>
          Ref.get(requests).pipe(
            Effect.map((entries) => {
              for (let i = entries.length - 1; i >= 0; i--) {
                const entry = entries[i]
                if (
                  entry !== undefined &&
                  scopeMatches(entry.scope, params.sessionId) &&
                  entry.extensionId === params.extensionId &&
                  String(entry.capability.id) === params.capabilityId
                ) {
                  return { extensionId: entry.extensionId, capability: entry.capability }
                }
              }
              return undefined
            }),
          ),
      })
    }),
  )

  static Test = (): Layer.Layer<DynamicExtensionRegistry> => DynamicExtensionRegistry.Live
}
