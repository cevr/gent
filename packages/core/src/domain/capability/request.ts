/**
 * `request(...)` — typed factory for extension-to-extension Capabilities.
 *
 * Authors call:
 *   - `request({ id, extensionId, input, output, intent: "read", execute })` for read RPCs
 *   - `request({ id, extensionId, input, output, intent: "write", execute })` for write RPCs
 *
 * Replaces the previous `query(...)` + `mutation(...)` pair. The lowering
 * collapses into one public request leaf plus the chosen `intent`. Extension
 * registries dispatch by factory-origin metadata; authors never write an
 * audience array.
 *
 * Read-fence: `intent: "read"` capabilities have `R extends ReadOnlyTag`
 * (a structural narrowing of the constraint to the same brand projection
 * R-channels use). Write-capable service Tags fail to compile in the
 * read-intent factory's R, mirroring the projection fence from B11.4.
 *
 * @module
 */

import { type Effect, type Schema } from "effect"
import { RpcId, type ExtensionId } from "../ids.js"
import {
  type CapabilityContext,
  type ErasedCapabilityEffect,
  type CapabilityRef,
  type CapabilityCoreContext,
  type CapabilityError,
  type ModelCapabilityContext,
} from "../capability.js"
import type { PermissionRule } from "../permission.js"
import type { PromptSection } from "../prompt.js"
import type { ReadOnlyTag } from "../read-only.js"

/**
 * `RequestToken` — `request({...})` return type. The
 * `ExtensionContributions.rpc` bucket is the discrimination; non-request
 * leaves (`tool`, `action`) cannot be slotted into `rpc:`.
 */
const REQUEST_REF: unique symbol = Symbol("@gent/core/request/ref")
declare const RequestTokenBrand: unique symbol
export interface RequestToken<Input = unknown, Output = unknown> {
  readonly [RequestTokenBrand]: true
  readonly id: RpcId
  readonly intent: "read" | "write"
  readonly public: true
  readonly slash?: RequestInputBase<Input, Output>["slash"]
  readonly description?: string
  readonly promptSnippet?: string
  readonly permissionRules?: ReadonlyArray<PermissionRule>
  readonly prompt?: PromptSection
  readonly input: Schema.Schema<Input>
  readonly output: Schema.Schema<Output>
  readonly effect: ErasedCapabilityEffect<CapabilityError>
  readonly [REQUEST_REF]: CapabilityRef<Input, Output>
}

/** Fields shared by both read- and write-intent request inputs. */
interface RequestInputBase<Input, Output> {
  /** Stable id (capability-local). Used for routing. */
  readonly id: string
  /** Owning extension id. Embedded into the typed `CapabilityRef` attached
   *  to the returned token so callers do not re-state it. */
  readonly extensionId: ExtensionId
  /** Schema for validating `input` at the boundary. */
  readonly input: Schema.Schema<Input>
  /** Schema for validating `output` at the boundary. */
  readonly output: Schema.Schema<Output>
  /** Static system-prompt section bundled with this request. */
  readonly prompt?: PromptSection
  /** Human-readable description for registry/listing surfaces. */
  readonly description?: string
  /** Optional slash-command presentation for public transport clients. */
  readonly slash?: {
    readonly name?: string
    readonly description?: string
    readonly category?: string
    readonly keybind?: string
  }
}

/** Author-facing input to `request({ intent: "read", ... })`. R is
 *  fenced read-only by `R extends ReadOnlyTag` — write Tags fail compile. */
export interface ReadRequestInput<
  Input = unknown,
  Output = unknown,
  R extends ReadOnlyTag = never,
> extends RequestInputBase<Input, Output> {
  /** `intent: "read"` → R is fenced read-only at the type level. */
  readonly intent: "read"
  /** The request handler. R must be ReadOnly-branded. */
  readonly execute: (
    input: Input,
    ctx: CapabilityCoreContext,
  ) => Effect.Effect<Output, CapabilityError, R>
}

/** Author-facing input to `request({ intent: "write", ... })`. R is
 *  unconstrained — write capabilities may yield any service. */
export interface WriteRequestInput<
  Input = unknown,
  Output = unknown,
  R = never,
> extends RequestInputBase<Input, Output> {
  /** `intent: "write"` → R is unconstrained. */
  readonly intent: "write"
  /** The request handler. */
  readonly execute: (
    input: Input,
    ctx: ModelCapabilityContext,
  ) => Effect.Effect<Output, CapabilityError, R>
}

/**
 * Lower a `ReadRequestInput | WriteRequestInput` to a typed
 * `RequestToken<Input, Output>` with the chosen `intent`. The returned token
 * also carries a typed `CapabilityRef<Input, Output>` under a local symbol,
 * read via the `ref(token)` accessor — so callers no longer hand-roll a
 * parallel `*Ref` const next to every request.
 *
 * Two overloads — one per intent. Read-intent overload constrains R to
 * `ReadOnlyTag` so the projection-style fence catches write-tagged
 * services in the read RPC's R channel.
 */
export function request<Input, Output, R extends ReadOnlyTag = never>(
  input: ReadRequestInput<Input, Output, R>,
): RequestToken<Input, Output>
export function request<Input, Output, R = never>(
  input: WriteRequestInput<Input, Output, R>,
): RequestToken<Input, Output>
export function request(input: {
  readonly id: string
  readonly extensionId: ExtensionId
  readonly intent: "read" | "write"
  readonly input: Schema.Schema<unknown>
  readonly output: Schema.Schema<unknown>
  readonly prompt?: PromptSection
  readonly description?: string
  readonly slash?: RequestInputBase<unknown, unknown>["slash"]
  readonly execute: (
    input: unknown,
    ctx: CapabilityContext,
  ) => Effect.Effect<unknown, CapabilityError, unknown>
}): RequestToken {
  const rpcId = RpcId.make(input.id)
  // CapabilityRef requires `Schema.Decoder<X, never>` for sync decoding at the
  // dispatcher boundary. Author-supplied schemas always satisfy this — the
  // overload signatures (above) constrain Input/Output to `Schema.Schema<X>`
  // which has `DecodingServices: never`. The cast is at the implementation
  // signature only; type-safety is restored by the public overloads.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- implementation-signature widening; overload signatures preserve typed ref
  const refValue = {
    extensionId: input.extensionId,
    capabilityId: rpcId,
    intent: input.intent,
    input: input.input,
    output: input.output,
  } as unknown as CapabilityRef
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- RequestToken brand applied at factory boundary
  return {
    id: rpcId,
    intent: input.intent,
    public: true,
    ...(input.slash !== undefined ? { slash: input.slash } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    input: input.input,
    output: input.output,
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    effect: input.execute,
    [REQUEST_REF]: refValue,
  } as unknown as RequestToken
}

export const ref = <Input, Output>(
  token: RequestToken<Input, Output>,
): CapabilityRef<Input, Output> => token[REQUEST_REF]
