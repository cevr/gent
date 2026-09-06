import { Context, Effect, Layer, Option, Predicate, Ref, Schema } from "effect"
import type { RequestCapability } from "./capability/request.js"
import { getToolId, type ToolCapability } from "./capability/tool.js"
import type { ExtensionId, SessionId } from "./ids.js"

export type DynamicRegistrationScope =
  | { readonly _tag: "process" }
  | { readonly _tag: "session"; readonly sessionId: SessionId }

export interface DynamicToolEntry {
  readonly extensionId: ExtensionId
  readonly scope: DynamicRegistrationScope
  readonly capability: ToolCapability
}

interface DynamicRequestEntry {
  readonly extensionId: ExtensionId
  readonly scope: DynamicRegistrationScope
  readonly capability: RequestCapability
}

type RegistrationToken = symbol

interface RegisteredToolEntry {
  readonly token: RegistrationToken
  readonly entry: DynamicToolEntry
}

interface RegisteredRequestEntry {
  readonly token: RegistrationToken
  readonly entry: DynamicRequestEntry
}

export interface DynamicExtensionRegistryService {
  readonly registerTool: (
    entry: DynamicToolEntry,
  ) => Effect.Effect<Effect.Effect<void>, DynamicRegistrationError>
  readonly registerRequest: (
    entry: DynamicRequestEntry,
  ) => Effect.Effect<Effect.Effect<void>, DynamicRegistrationError>
  readonly listTools: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<ToolCapability>>
  readonly listToolEntries: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<DynamicToolEntry>>
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
    Option.Option<{
      readonly extensionId: ExtensionId
      readonly capability: RequestCapability
    }>
  >
}

const scopeLabel = (scope: DynamicRegistrationScope) => {
  if (scope._tag === "process") return "process"
  return `session ${scope.sessionId}`
}

const sameScope = (left: DynamicRegistrationScope, right: DynamicRegistrationScope) => {
  if (left._tag === "process") return right._tag === "process"
  return right._tag === "session" && left.sessionId === right.sessionId
}

export class DynamicRegistrationError extends Schema.TaggedError<DynamicRegistrationError>(
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
  registrations: ReadonlyArray<RegisteredToolEntry>,
  sessionId: SessionId,
): ReadonlyArray<DynamicToolEntry> => {
  const winners = new Map<string, DynamicToolEntry>()
  for (const registration of registrations) {
    const entry = registration.entry
    if (entry.scope._tag === "process") winners.set(String(getToolId(entry.capability)), entry)
  }
  for (const registration of registrations) {
    const entry = registration.entry
    if (entry.scope._tag === "session" && entry.scope.sessionId === sessionId) {
      winners.set(String(getToolId(entry.capability)), entry)
    }
  }
  return [...winners.values()]
}

const visibleRequestWinners = (
  registrations: ReadonlyArray<RegisteredRequestEntry>,
  sessionId: SessionId,
): ReadonlyArray<{
  readonly extensionId: ExtensionId
  readonly capability: RequestCapability
}> => {
  const winners = new Map<
    string,
    { readonly extensionId: ExtensionId; readonly capability: RequestCapability }
  >()
  for (const registration of registrations) {
    const entry = registration.entry
    if (entry.scope._tag === "process") {
      winners.set(String(entry.capability.id), {
        extensionId: entry.extensionId,
        capability: entry.capability,
      })
    }
  }
  for (const registration of registrations) {
    const entry = registration.entry
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
      const tools = yield* Ref.make<ReadonlyArray<RegisteredToolEntry>>([])
      const requests = yield* Ref.make<ReadonlyArray<RegisteredRequestEntry>>([])

      const unregisterTool = (token: RegistrationToken) =>
        Ref.update(tools, (entries) => entries.filter((candidate) => candidate.token !== token))

      const unregisterRequest = (token: RegistrationToken) =>
        Ref.update(requests, (entries) => entries.filter((candidate) => candidate.token !== token))

      return DynamicExtensionRegistry.of({
        registerTool: (entry) =>
          Effect.gen(function* () {
            const id = String(getToolId(entry.capability))
            const token = Symbol("dynamic-tool-registration")
            const duplicate = yield* Ref.modify(tools, (registrations) => {
              const existing = registrations.find(
                (registration) =>
                  String(getToolId(registration.entry.capability)) === id &&
                  sameScope(registration.entry.scope, entry.scope),
              )
              if (!Predicate.isUndefined(existing)) {
                return [
                  Option.some(duplicateError("tool", id, entry.scope)),
                  registrations,
                ] satisfies readonly [
                  Option.Option<DynamicRegistrationError>,
                  ReadonlyArray<RegisteredToolEntry>,
                ]
              }
              return [
                Option.none<DynamicRegistrationError>(),
                [...registrations, { token, entry }],
              ] satisfies readonly [
                Option.Option<DynamicRegistrationError>,
                ReadonlyArray<RegisteredToolEntry>,
              ]
            })
            if (Option.isSome(duplicate)) return yield* duplicate.value
            return yield* Effect.succeed(unregisterTool(token))
          }),
        registerRequest: (entry) =>
          Effect.gen(function* () {
            const id = String(entry.capability.id)
            const token = Symbol("dynamic-request-registration")
            const duplicate = yield* Ref.modify(requests, (registrations) => {
              const existing = registrations.find(
                (registration) =>
                  String(registration.entry.capability.id) === id &&
                  sameScope(registration.entry.scope, entry.scope),
              )
              if (!Predicate.isUndefined(existing)) {
                return [
                  Option.some(duplicateError("request", id, entry.scope)),
                  registrations,
                ] satisfies readonly [
                  Option.Option<DynamicRegistrationError>,
                  ReadonlyArray<RegisteredRequestEntry>,
                ]
              }
              return [
                Option.none<DynamicRegistrationError>(),
                [...registrations, { token, entry }],
              ] satisfies readonly [
                Option.Option<DynamicRegistrationError>,
                ReadonlyArray<RegisteredRequestEntry>,
              ]
            })
            if (Option.isSome(duplicate)) return yield* duplicate.value
            return yield* Effect.succeed(unregisterRequest(token))
          }),
        listTools: (sessionId) =>
          Ref.get(tools).pipe(
            Effect.map((entries) =>
              visibleToolWinners(entries, sessionId).map((entry) => entry.capability),
            ),
          ),
        listToolEntries: (sessionId) =>
          Ref.get(tools).pipe(Effect.map((entries) => visibleToolWinners(entries, sessionId))),
        listRequests: (sessionId) =>
          Ref.get(requests).pipe(
            Effect.map((entries) => visibleRequestWinners(entries, sessionId)),
          ),
        findRequest: (params) =>
          Ref.get(requests).pipe(
            Effect.map((entries) =>
              Option.fromUndefinedOr(
                visibleRequestWinners(entries, params.sessionId).find(
                  (entry) =>
                    entry.extensionId === params.extensionId &&
                    String(entry.capability.id) === params.capabilityId,
                ),
              ),
            ),
          ),
      })
    }),
  )

  static Test = (): Layer.Layer<DynamicExtensionRegistry> => DynamicExtensionRegistry.Live
}
