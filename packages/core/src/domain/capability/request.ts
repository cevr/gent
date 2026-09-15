/**
 * `request(...)` — typed factory for extension-to-extension Capabilities.
 *
 * Authors call `request({ id, input, output, execute })`.
 *
 * Extension registries dispatch by factory-origin metadata; authors never
 * write an audience array or read/write intent marker.
 *
 * Host/session authority is imported through `ExtensionContext`; runtime
 * dispatch provides the `ExtensionContext` facade. Request handlers receive
 * decoded params only.
 *
 * @module
 */

import { Effect, Option, Schema } from "effect"
import { ExtensionId, RpcId, type ExtensionId as ExtensionIdType } from "../ids.js"
import {
  type RequestCapability as RequestCapabilityApi,
  type ErasedCapabilityEffect,
  type CapabilityEffect,
  type CapabilityRef,
  CapabilityError,
} from "../capability.js"
import type { PromptSection } from "../prompt.js"

/**
 * `RequestCapability` — `request({...})` return type. The
 * `ExtensionContributions.requests` bucket is the discrimination; non-request
 * leaves (`tool`) cannot be slotted into `requests:`.
 */
const REQUEST_REF: unique symbol = Symbol("@gent/core/request/ref")
const REQUEST_REF_STATE: unique symbol = Symbol("@gent/core/request/ref-state")
const RequestCapabilityBrand: unique symbol = Symbol("@gent/core/RequestCapability")
declare const RequestCapabilityType: unique symbol

interface RequestRefState<Input = unknown, Output = unknown> {
  extensionId: Option.Option<ExtensionIdType>
  readonly capabilityId: RpcId
  readonly input: Schema.Codec<Input, unknown, never, never>
  readonly output: Schema.Codec<Output, unknown, never, never>
}

export type RequestCapability<Input = unknown, Output = unknown> = RequestCapabilityApi & {
  readonly [RequestCapabilityBrand]: true
  readonly [RequestCapabilityType]?: {
    readonly input: Input
    readonly output: Output
  }
  readonly id: RpcId
  readonly slash?: RequestInput<Input, Output>["slash"]
  readonly description?: string
  readonly prompt?: PromptSection
  readonly input: Schema.Codec<Input, unknown, never, never>
  readonly output: Schema.Codec<Output, unknown, never, never>
  /**
   * A bound request fails with `CapabilityError` under its ids; an unbound
   * one passes the handler's own error to the registry, which seals it.
   */
  readonly effect: ErasedCapabilityEffect<RequestFailure>
  readonly [REQUEST_REF]: CapabilityRef<Input, Output>
  readonly [REQUEST_REF_STATE]: RequestRefState<Input, Output>
}

/** What a request handler may fail with: its own tagged error, or a `CapabilityError` it built. */
interface RequestFailure {
  readonly message: string
}

/** Author-facing input to `request({...})`. */
export interface RequestInput<
  Input = unknown,
  Output = unknown,
  R = never,
  E extends RequestFailure = CapabilityError,
> {
  /** Stable id (capability-local). Used for routing. */
  readonly id: string
  /** Schema for validating `input` at the boundary. */
  readonly input: Schema.Codec<Input, unknown, never, never>
  /** Schema for validating `output` at the boundary. */
  readonly output: Schema.Codec<Output, unknown, never, never>
  /** Static system-prompt section bundled with this request. */
  readonly prompt?: PromptSection
  /** Human-readable description for registry/listing surfaces. */
  readonly description?: string
  /**
   * A read-only request answers while a turn is running: it skips the loop's
   * mutation permit, which the running turn otherwise holds until it ends. It
   * must not change loop state. Default: the request waits for the turn.
   */
  readonly readonly?: boolean
  /** Optional slash-command presentation for public transport clients. */
  readonly slash?: {
    /** Slash trigger without the leading `/`. Defaults to `id`. */
    readonly trigger?: string
    readonly name?: string
    readonly description?: string
    readonly category?: string
    readonly keybind?: string
  }
  /**
   * The request handler. It fails with its own tagged error; the factory
   * wraps that into the `CapabilityError` the wire carries, under the id
   * this input names and the extension `defineRequests`/`defineExtension` bind.
   */
  readonly execute: CapabilityEffect<Input, Output, R, E>
}

/**
 * Lower a `RequestInput` to a typed `RequestCapability<Input, Output>`.
 * The returned capability also carries a typed `CapabilityRef<Input, Output>` under a local symbol,
 * read via the `ref(capability)` accessor — so callers no longer hand-roll a
 * parallel `*Ref` const next to every request.
 */
export function request<Input, Output, R = never, E extends RequestFailure = CapabilityError>(
  input: RequestInput<Input, Output, R, E>,
): RequestCapability<Input, Output>
export function request(input: {
  readonly id: string
  readonly input: Schema.Codec<unknown, unknown, never, never>
  readonly output: Schema.Codec<unknown, unknown, never, never>
  readonly prompt?: PromptSection
  readonly description?: string
  readonly readonly?: boolean
  readonly slash?: RequestInput<unknown, unknown>["slash"]
  readonly execute: ErasedCapabilityEffect<RequestFailure>
}): RequestCapability {
  const rpcId = RpcId.make(input.id)
  const refState: RequestRefState = {
    extensionId: Option.none(),
    capabilityId: rpcId,
    input: input.input,
    output: input.output,
  }
  // CapabilityRef requires `Schema.Decoder<X, never>` for sync decoding at the
  // dispatcher boundary. Author-supplied schemas always satisfy this — the
  // overload signatures (above) constrain Input/Output to `Schema.Schema<X>`
  // which has `DecodingServices: never`. The cast is at the implementation
  // signature only; type-safety is restored by the public overloads.
  // oxlint-disable-next-line effect/noAs, effect/noChainedTypeAssertions, typescript/no-unsafe-type-assertion -- The implementation overload erases the author schema types; public overloads restore them.
  const refValue = {
    get extensionId() {
      if (Option.isNone(refState.extensionId)) {
        // oxlint-disable-next-line effect/noThrowStatement, effect/noNewError -- Reading an unbound capability reference is programmer misuse.
        throw new Error(
          `request "${String(rpcId)}" is not bound to an extension; include it in defineExtension({ id, requests }) before reading ref(...)`,
        )
      }
      return refState.extensionId.value
    },
    capabilityId: refState.capabilityId,
    input: refState.input,
    output: refState.output,
  } as unknown as CapabilityRef
  // A handler's own error becomes the wire error under the ids this factory
  // and the binding already hold; an unbound request leaves the error to the
  // registry, which names the ids it routed by.
  const asCapabilityError = (error: RequestFailure): RequestFailure =>
    Option.match(refState.extensionId, {
      onNone: () => error,
      onSome: (extensionId) => {
        if (Schema.is(CapabilityError)(error)) return error
        return new CapabilityError({ extensionId, capabilityId: rpcId, reason: error.message })
      },
    })
  const effect: ErasedCapabilityEffect<RequestFailure> = (value) =>
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — the erased handler crosses the runtime membrane; the public overloads keep authors typed.
    Effect.mapError(input.execute(value), asCapabilityError)
  const capability: RequestCapabilityApi = {
    _tag: "request",
    id: rpcId,
    slash: input.slash,
    description: input.description,
    readonly: input.readonly,
    input: input.input,
    output: input.output,
    prompt: input.prompt,
    effect,
    ref: refValue,
  }
  // oxlint-disable-next-line effect/noAs, effect/noChainedTypeAssertions, typescript/no-unsafe-type-assertion -- The factory applies its private brand and typed reference at the runtime membrane.
  return Object.assign(capability, {
    [RequestCapabilityBrand]: true,
    [REQUEST_REF]: refValue,
    [REQUEST_REF_STATE]: refState,
  }) as unknown as RequestCapability
}

export const bindRequestCapabilityExtension = <Input, Output>(
  capability: RequestCapability<Input, Output>,
  extensionId: ExtensionIdType,
): RequestCapability<Input, Output> => {
  capability[REQUEST_REF_STATE].extensionId = Option.some(extensionId)
  return capability
}

type RequestCapabilityMap = Record<string, RequestCapability>

export const defineRequests = <T extends RequestCapabilityMap>(
  extensionId: ExtensionIdType | string,
  requests: T,
): T => {
  const boundExtensionId = ExtensionId.make(extensionId)
  for (const capability of Object.values(requests)) {
    bindRequestCapabilityExtension(capability, boundExtensionId)
  }
  return requests
}

export const ref = <Input, Output>(
  capability: RequestCapability<Input, Output>,
): CapabilityRef<Input, Output> => capability[REQUEST_REF]
