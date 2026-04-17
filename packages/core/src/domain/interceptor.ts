/**
 * InterceptorContribution — typed pipeline transformations.
 *
 * Thin re-export module that names the interceptor primitives consistently with
 * the contribution model. The underlying types (`ExtensionInterceptorMap`,
 * `ExtensionInterceptorDescriptor`) live in `extension.ts` for historical
 * reasons; this file is the canonical home going forward.
 *
 * An interceptor wraps a `base` Effect at a known pipeline key (e.g.
 * `"prompt.system"`, `"tool.execute"`). It receives `(input, next)` and may:
 *   - delegate by calling `next(input)` (possibly with a transformed input)
 *   - short-circuit with its own value
 *   - transform the result with `Effect.map`
 *   - fail with a typed error (propagates through the chain)
 *
 * Composition order: builtin (innermost) → user → project (outermost). A
 * defect in any interceptor falls through to the previous link — interceptors
 * are isolated from each other.
 *
 * @module
 */
import { Schema } from "effect"
import type {
  ExtensionInterceptorDescriptor as Descriptor,
  ExtensionInterceptorKey as Key,
  ExtensionInterceptorMap as Map,
} from "./extension.js"

/** All interceptor pipeline keys with productive callers. */
export type InterceptorKey = Key

/** Map from key to typed interceptor function. */
export type InterceptorMap = Map

/** Tagged interceptor — pairs an interceptor function with its pipeline key. */
export type InterceptorContribution<K extends InterceptorKey = InterceptorKey> = Descriptor<K>

/** Typed failure for interceptor authoring. Carries key + reason for diagnostics. */
export class InterceptorError extends Schema.TaggedErrorClass<InterceptorError>()(
  "InterceptorError",
  {
    key: Schema.String,
    reason: Schema.String,
  },
) {}

export type {
  Descriptor as ExtensionInterceptorDescriptor,
  Key as ExtensionInterceptorKey,
  Map as ExtensionInterceptorMap,
}
