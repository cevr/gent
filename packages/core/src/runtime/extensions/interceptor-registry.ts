/**
 * InterceptorRegistry — compile interceptor contributions into per-key chains.
 *
 * Thin contribution-native facade over `compileHooks`. Both share the same
 * underlying composition algorithm (left-fold, scope-ordered, defect-isolated).
 *
 * Why a separate module: as later commits migrate authoring off the legacy
 * `ExtensionSetup.hooks` field onto `InterceptorContribution`, the registry
 * must read interceptors directly from contributions. Today the lowering
 * (api.ts → ExtensionSetup.hooks.interceptors) already collapses both paths,
 * so this registry can delegate to `compileHooks` and stay narrow.
 *
 * Invariant: this module is the canonical entry point for *contribution-side*
 * interceptor compilation. `compileHooks` remains the pipeline implementation.
 *
 * @module
 */
import type { LoadedExtension } from "../../domain/extension.js"
import { compileHooks, type CompiledHookMap } from "./hooks.js"

export interface CompiledInterceptors {
  readonly chain: CompiledHookMap
}

/**
 * Compile interceptor contributions from loaded extensions.
 *
 * Today: delegates to `compileHooks`, since the lowering already places all
 * `InterceptorContribution`s into `ExtensionSetup.hooks.interceptors`.
 *
 * Tomorrow (Commit 12): when `ExtensionSetup.hooks` is deleted, this module
 * grows the inline composition logic and becomes the single owner.
 */
export const compileInterceptors = (
  extensions: ReadonlyArray<LoadedExtension>,
): CompiledInterceptors => ({
  chain: compileHooks(extensions),
})
