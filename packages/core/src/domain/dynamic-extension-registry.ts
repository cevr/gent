import { Context, Effect, Layer, Ref, Schema } from "effect"
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
  readonly registerTool: (
    entry: DynamicToolEntry,
  ) => Effect.Effect<Effect.Effect<void>, DynamicRegistrationError>
  readonly registerRequest: (
    entry: DynamicRequestEntry,
  ) => Effect.Effect<Effect.Effect<void>, DynamicRegistrationError>
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

const scopeLabel = (scope: DynamicRegistrationScope) =>
  scope._tag === "process" ? "process" : `session ${scope.sessionId}`

const sameScope = (left: DynamicRegistrationScope, right: DynamicRegistrationScope) =>
  left._tag === "process"
    ? right._tag === "process"
    : right._tag === "session" && left.sessionId === right.sessionId

export class DynamicRegistrationError extends Schema.TaggedErrorClass<DynamicRegistrationError>(
  "@gent/core/src/domain/dynamic-extension-registry/DynamicRegistrationError",
)("DynamicRegistrationError", {
  kind: Schema.Literals(["tool", "request"]),
  id: Schema.String,
  message: Schema.String,
}) {}

const duplicateError = (kind: "tool" | "request", id: string, scope: DynamicRegistrationScope) =>
  new DynamicRegistrationError({
    kind,
    id,
    message: `dynamic ${kind} "${id}" is already registered for ${scopeLabel(scope)}; call the unregister finalizer before registering a replacement`,
  })

const visibleToolWinners = (
  entries: ReadonlyArray<DynamicToolEntry>,
  sessionId: SessionId,
): ReadonlyArray<ToolCapability> => {
  const winners = new Map<string, ToolCapability>()
  for (const entry of entries) {
    if (entry.scope._tag === "process")
      winners.set(String(getToolId(entry.capability)), entry.capability)
  }
  for (const entry of entries) {
    if (entry.scope._tag === "session" && entry.scope.sessionId === sessionId) {
      winners.set(String(getToolId(entry.capability)), entry.capability)
    }
  }
  return [...winners.values()]
}

const visibleRequestWinners = (
  entries: ReadonlyArray<DynamicRequestEntry>,
  sessionId: SessionId,
): ReadonlyArray<{
  readonly extensionId: ExtensionId
  readonly capability: RequestCapability
}> => {
  const winners = new Map<
    string,
    { readonly extensionId: ExtensionId; readonly capability: RequestCapability }
  >()
  for (const entry of entries) {
    if (entry.scope._tag === "process") {
      winners.set(String(entry.capability.id), {
        extensionId: entry.extensionId,
        capability: entry.capability,
      })
    }
  }
  for (const entry of entries) {
    if (entry.scope._tag === "session" && entry.scope.sessionId === sessionId) {
      winners.set(String(entry.capability.id), {
        extensionId: entry.extensionId,
        capability: entry.capability,
      })
    }
  }
  return [...winners.values()]
}

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
          Effect.gen(function* () {
            const id = String(getToolId(entry.capability))
            const existing = (yield* Ref.get(tools)).find(
              (candidate) =>
                String(getToolId(candidate.capability)) === id &&
                sameScope(candidate.scope, entry.scope),
            )
            if (existing !== undefined) return yield* duplicateError("tool", id, entry.scope)
            yield* Ref.update(tools, (entries) => [...entries, entry])
            return yield* Effect.succeed(unregisterTool(entry))
          }),
        registerRequest: (entry) =>
          Effect.gen(function* () {
            const id = String(entry.capability.id)
            const existing = (yield* Ref.get(requests)).find(
              (candidate) =>
                String(candidate.capability.id) === id && sameScope(candidate.scope, entry.scope),
            )
            if (existing !== undefined) return yield* duplicateError("request", id, entry.scope)
            yield* Ref.update(requests, (entries) => [...entries, entry])
            return yield* Effect.succeed(unregisterRequest(entry))
          }),
        listTools: (sessionId) =>
          Ref.get(tools).pipe(Effect.map((entries) => visibleToolWinners(entries, sessionId))),
        listRequests: (sessionId) =>
          Ref.get(requests).pipe(
            Effect.map((entries) => visibleRequestWinners(entries, sessionId)),
          ),
        findRequest: (params) =>
          Ref.get(requests).pipe(
            Effect.map((entries) =>
              visibleRequestWinners(entries, params.sessionId).find(
                (entry) =>
                  entry.extensionId === params.extensionId &&
                  String(entry.capability.id) === params.capabilityId,
              ),
            ),
          ),
      })
    }),
  )

  static Test = (): Layer.Layer<DynamicExtensionRegistry> => DynamicExtensionRegistry.Live
}
