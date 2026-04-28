/** PublicCapabilityHost — dispatch over request RPCs and public action tokens. */
import { Effect, Schema } from "effect"
import { type CommandId, type ExtensionId, type RpcId } from "../../domain/ids.js"
import type { LoadedExtension } from "../../domain/extension.js"
import type { ExtensionCapabilityLeaf } from "../../domain/contribution.js"
import {
  CapabilityError,
  CapabilityNotFoundError,
  type CapabilityCoreContext,
  type Intent,
  type ModelCapabilityContext,
} from "../../domain/capability.js"
import type { RequestToken } from "../../domain/capability/request.js"
import type { ActionToken } from "../../domain/capability/action.js"
import { SCOPE_PRECEDENCE } from "./disabled.js"
import { sealErasedEffect } from "./effect-membrane.js"

type TransportCapabilityToken = RequestToken | ActionToken
type TransportCapabilityId = RpcId | CommandId | string

export interface RegisteredPublicCapability {
  readonly extensionId: ExtensionId
  readonly capability: ExtensionCapabilityLeaf
}

export interface CapabilityRunOptions {
  readonly intent?: Intent
}

export interface CompiledCapabilities {
  readonly entries: ReadonlyArray<RegisteredPublicCapability>
  readonly runRequest: (
    extensionId: ExtensionId,
    capabilityId: RpcId,
    input: unknown,
    ctx: CapabilityCoreContext,
    options?: CapabilityRunOptions,
  ) => Effect.Effect<unknown, CapabilityError | CapabilityNotFoundError>
  readonly runTransport: (
    extensionId: ExtensionId,
    capabilityId: TransportCapabilityId,
    input: unknown,
    ctx: ModelCapabilityContext,
    options?: CapabilityRunOptions,
  ) => Effect.Effect<unknown, CapabilityError | CapabilityNotFoundError>
}

const sortedExtensions = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<LoadedExtension> =>
  [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.scope] - SCOPE_PRECEDENCE[b.scope]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

const isTransportCapabilityToken = (
  capability: ExtensionCapabilityLeaf,
): capability is TransportCapabilityToken =>
  !(capability.audiences as ReadonlyArray<string>).includes("model")

/** Compile registered request RPCs and transport-public actions into a dispatcher. */
export const compileCapabilities = (
  extensions: ReadonlyArray<LoadedExtension>,
): CompiledCapabilities => {
  const sorted = sortedExtensions(extensions)
  const entries: RegisteredPublicCapability[] = []
  for (const ext of sorted) {
    for (const capability of ext.contributions.tools ?? []) {
      entries.push({ extensionId: ext.manifest.id, capability })
    }
    for (const capability of ext.contributions.commands ?? []) {
      entries.push({ extensionId: ext.manifest.id, capability })
    }
    for (const capability of ext.contributions.rpc ?? []) {
      entries.push({ extensionId: ext.manifest.id, capability })
    }
  }

  const resolveByIdentity = (
    extensionId: ExtensionId,
    capabilityId: TransportCapabilityId,
  ): RegisteredPublicCapability | undefined => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = entries[i]
      if (
        candidate !== undefined &&
        candidate.extensionId === extensionId &&
        candidate.capability.id === capabilityId
      ) {
        return candidate
      }
    }
    return undefined
  }

  const findEntry = (
    extensionId: ExtensionId,
    capabilityId: TransportCapabilityId,
    audience: "agent-protocol" | "transport-public",
    requiredIntent: Intent | undefined,
  ):
    | { readonly extensionId: ExtensionId; readonly capability: TransportCapabilityToken }
    | undefined => {
    const winner = resolveByIdentity(extensionId, capabilityId)
    if (winner === undefined) return undefined
    const capability = winner.capability
    if (!isTransportCapabilityToken(capability)) return undefined
    if (!(capability.audiences as ReadonlyArray<string>).includes(audience)) return undefined
    if (requiredIntent !== undefined && capability.intent !== requiredIntent) return undefined
    return { extensionId: winner.extensionId, capability }
  }

  const runWithAudience = (
    extensionId: ExtensionId,
    capabilityId: TransportCapabilityId,
    input: unknown,
    ctx: CapabilityCoreContext | ModelCapabilityContext,
    audience: "agent-protocol" | "transport-public",
    options?: CapabilityRunOptions,
  ) =>
    Effect.gen(function* () {
      const entry = findEntry(extensionId, capabilityId, audience, options?.intent)
      if (entry === undefined) {
        return yield* new CapabilityNotFoundError({ extensionId, capabilityId })
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
      const decodedInput = yield* Schema.decodeUnknownEffect(entry.capability.input as Schema.Any)(
        input,
      ).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new CapabilityError({
              extensionId,
              capabilityId,
              reason: `input decode failed: ${String(e)}`,
            }),
          ),
        ),
      )

      const output = yield* sealErasedEffect(
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for existential request token
        () =>
          entry.capability.effect(
            decodedInput,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- RequestToken handlers are authored against CapabilityCoreContext; base token inheritance still exposes the wider erased signature.
            ctx as Parameters<typeof entry.capability.effect>[1],
          ),
        {
          onFailure: (error) =>
            Schema.is(CapabilityError)(error)
              ? Effect.fail(error)
              : Effect.fail(
                  new CapabilityError({
                    extensionId,
                    capabilityId,
                    reason: `handler failure: ${String(error)}`,
                  }),
                ),
          onDefect: (defect) =>
            Effect.fail(
              new CapabilityError({
                extensionId,
                capabilityId,
                reason: `handler defect: ${String(defect)}`,
              }),
            ),
        },
      )

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
      yield* Schema.encodeUnknownEffect(entry.capability.output as Schema.Any)(output).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new CapabilityError({
              extensionId,
              capabilityId,
              reason: `output validation failed: ${String(e)}`,
            }),
          ),
        ),
      )
      return output
    })

  const runRequest: CompiledCapabilities["runRequest"] = (
    extensionId,
    capabilityId,
    input,
    ctx,
    options,
  ) => runWithAudience(extensionId, capabilityId, input, ctx, "agent-protocol", options)

  const runTransport: CompiledCapabilities["runTransport"] = (
    extensionId,
    capabilityId,
    input,
    ctx,
    options,
  ) => runWithAudience(extensionId, capabilityId, input, ctx, "transport-public", options)

  return { entries, runRequest, runTransport }
}
